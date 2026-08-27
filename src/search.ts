import { Repository } from "./repository.ts";
import { MAX_FINAL_CITATIONS, repositoryTools, systemPrompt } from "./protocol.ts";
import type { ChatMessage, Citation, SearchRunOptions, SearchRunResult, SearchUsage, ToolCall } from "./types.ts";

const CITATION_PATTERN = /(\/?(?:[A-Za-z0-9_.+@ -]+\/)*[A-Za-z0-9_.+@ -]+):(\d+)(?:-(\d+))?/g;

type ExtractedFinal = { final: string; partial: boolean };

function extractFinal(content: string): ExtractedFinal {
  const complete = content.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
  if (complete) return { final: complete[1].trim(), partial: false };
  const partial = content.match(/<final_answer>\s*([\s\S]*)/i);
  return partial ? { final: partial[1].trim(), partial: true } : { final: "", partial: false };
}

function normalizeToolCalls(message: Record<string, unknown>): ToolCall[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.map((raw: unknown, index: number) => {
    const call = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const fn = (call.function && typeof call.function === "object" ? call.function : {}) as Record<string, unknown>;
    let arguments_: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try {
        const parsed = fn.arguments.trim() ? JSON.parse(fn.arguments) as unknown : {};
        arguments_ = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : { _parseError: "tool arguments must be a JSON object" };
      } catch {
        arguments_ = { _parseError: fn.arguments };
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      arguments_ = fn.arguments as Record<string, unknown>;
    }
    return {
      id: typeof call.id === "string" ? call.id : `call_${index}`,
      name: String(fn.name ?? ""),
      arguments: arguments_,
    };
  });
}

async function validateFinal(repository: Repository, rawFinal: string): Promise<{ final: string; citations: Citation[]; dropped: number }> {
  const keptLines: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const sourceLine of rawFinal.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const matches = [...sourceLine.matchAll(CITATION_PATTERN)];
    if (matches.length !== 1) {
      dropped += 1;
      continue;
    }

    let normalizedLine = sourceLine;
    const lineCitations: Citation[] = [];
    let validLine = true;
    for (const match of matches.reverse()) {
      const start = Number(match[2]);
      const end = Number(match[3] ?? match[2]);
      const validation = await repository.validateRange(match[1], start, end);
      const citation: Citation = {
        path: validation.path,
        start,
        end,
        line: sourceLine,
        exists: validation.exists,
        inBounds: validation.inBounds,
      };
      lineCitations.unshift(citation);
      if (!citation.exists || !citation.inBounds) validLine = false;
      const replacement = `${citation.path}:${start}${end === start ? "" : `-${end}`}`;
      const position = match.index ?? 0;
      normalizedLine = `${normalizedLine.slice(0, position)}${replacement}${normalizedLine.slice(position + match[0].length)}`;
    }

    if (!validLine) {
      dropped += 1;
      continue;
    }
    const citation = lineCitations[0];
    const key = `${citation.path}:${citation.start}-${citation.end}`;
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    keptLines.push(normalizedLine);
    citations.push({ ...citation, line: normalizedLine });
    if (keptLines.length >= MAX_FINAL_CITATIONS) break;
  }

  return { final: keptLines.join("\n"), citations, dropped };
}

async function chat(
  options: Pick<SearchRunOptions, "baseUrl" | "model" | "maxTokens" | "signal">,
  messages: ChatMessage[],
  tools: typeof repositoryTools | undefined,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    temperature: 0,
    max_tokens: options.maxTokens,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer local",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Local model HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function firstChoice(response: Record<string, unknown>): { message: Record<string, unknown>; usage: Record<string, unknown> } {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choice = (choices[0] && typeof choices[0] === "object" ? choices[0] : {}) as Record<string, unknown>;
  const message = (choice.message && typeof choice.message === "object" ? choice.message : {}) as Record<string, unknown>;
  const usage = (response.usage && typeof response.usage === "object" ? response.usage : {}) as Record<string, unknown>;
  return { message, usage };
}

function addUsage(total: SearchUsage, usage: Record<string, unknown>): void {
  total.promptTokens += Number(usage.prompt_tokens ?? 0);
  total.completionTokens += Number(usage.completion_tokens ?? 0);
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  total.cachedTokens += Number(details.cached_tokens ?? 0);
  total.modelPasses += 1;
}

export async function runSearch(options: SearchRunOptions): Promise<SearchRunResult> {
  const repository = await Repository.open(options.cwd, options.signal);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Query: ${options.query}` },
  ];
  const transcript: unknown[] = [];
  const warnings: string[] = [];
  const usage: SearchUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, modelPasses: 0 };
  let toolCalls = 0;
  let failedTools = 0;
  let rawFinal = "";
  let partialFinal = false;
  const started = performance.now();

  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    options.signal?.throwIfAborted();
    options.onUpdate?.({
      content: [{ type: "text", text: `Repository search ${turn}/${options.maxTurns}…` }],
      details: { phase: "search", turn, maxTurns: options.maxTurns },
    });
    const response = await chat(options, messages, repositoryTools);
    const { message, usage: responseUsage } = firstChoice(response);
    addUsage(usage, responseUsage);
    transcript.push({ turn, response: options.includeTranscript ? response : undefined });
    messages.push(message);

    const extracted = extractFinal(String(message.content ?? ""));
    if (extracted.final) {
      rawFinal = extracted.final;
      partialFinal = extracted.partial;
      break;
    }

    const calls = normalizeToolCalls(message);
    if (!calls.length) {
      warnings.push(`Turn ${turn} returned neither tools nor a final answer`);
      break;
    }

    const results = await Promise.all(calls.map(async (call) => {
      toolCalls += 1;
      let result: string;
      if (call.arguments._parseError !== undefined) {
        result = `ERR: invalid JSON tool arguments: ${String(call.arguments._parseError).slice(0, 500)}`;
      } else {
        result = await repository.execute(call);
      }
      if (result.startsWith("ERR:")) failedTools += 1;
      return { call, result };
    }));

    for (const { call, result } of results) {
      transcript.push({ turn, tool: call, result: options.includeTranscript ? result : result.slice(0, 500) });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  if (!rawFinal) {
    options.onUpdate?.({
      content: [{ type: "text", text: "Formatting repository evidence…" }],
      details: { phase: "final" },
    });
    messages.push({
      role: "user",
      content: `Stop searching. Using only evidence already returned, produce <final_answer> with at most ${MAX_FINAL_CITATIONS} concrete relative file:START-END citations, ordered most relevant first. Close </final_answer>.`,
    });
    const response = await chat(options, messages, undefined);
    const { message, usage: responseUsage } = firstChoice(response);
    addUsage(usage, responseUsage);
    transcript.push({ turn: "final", response: options.includeTranscript ? response : undefined });
    const extracted = extractFinal(String(message.content ?? ""));
    rawFinal = extracted.final;
    partialFinal = extracted.partial;
    if (!rawFinal) warnings.push("Final response did not contain <final_answer>");
  }

  const validated = rawFinal
    ? await validateFinal(repository, rawFinal)
    : { final: "", citations: [] as Citation[], dropped: 0 };
  if (validated.dropped) warnings.push(`Dropped ${validated.dropped} invalid citation line(s)`);
  if (partialFinal) warnings.push("Final answer tag was not closed");
  if (!validated.final) warnings.push("No valid final answer produced");

  const elapsedMs = performance.now() - started;
  const text = [
    "# FastContext Result",
    "",
    validated.final ? `<final_answer>\n${validated.final}\n</final_answer>` : "(no valid final answer)",
    "",
    "## Validation",
    `- Valid citations: ${validated.citations.length}`,
    `- Tool calls: ${toolCalls} (${failedTools} failed)`,
    `- Model passes: ${usage.modelPasses}`,
    `- Time: ${(elapsedMs / 1_000).toFixed(1)}s`,
    `- Tokens: prompt ${usage.promptTokens}, completion ${usage.completionTokens}, cached ${usage.cachedTokens}`,
    warnings.length ? `\n## Warnings\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  return {
    text,
    details: {
      root: repository.root,
      baseUrl: options.baseUrl,
      model: options.model,
      final: validated.final,
      citations: validated.citations,
      validCitations: validated.citations.length,
      toolCalls,
      failedTools,
      elapsedMs,
      usage,
      warnings,
      transcript: options.includeTranscript ? transcript : undefined,
    },
  };
}
