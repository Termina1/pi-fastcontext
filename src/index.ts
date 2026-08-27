import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveConfig } from "./config.ts";
import { runSearch } from "./search.ts";

function nestedUsage(usage: { promptTokens: number; completionTokens: number; cachedTokens: number }) {
  const input = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return {
    input,
    output: usage.completionTokens,
    cacheRead: usage.cachedTokens,
    cacheWrite: 0,
    totalTokens: usage.promptTokens + usage.completionTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fast_context_search",
    label: "Local Repository Search",
    description: "Search a local repository with Qwen3.8 Flash and bounded read-only GLOB/GREP/READ tools. Returns validated file:line citations.",
    promptSnippet: "Fast local repository search with validated file:line citations",
    promptGuidelines: [
      "Use fast_context_search for quick repository facts and precise file:line evidence before planning or editing.",
      "Do not use fast_context_search to modify code; it is read-only.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language repository search query." }),
      includeTranscript: Type.Optional(Type.Boolean({ description: "Include the complete nested model/tool transcript in result details." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const config = await resolveConfig(cwd, {}, { allowProjectConfig: ctx.isProjectTrusted() });
      const result = await runSearch({
        ...config,
        query: params.query,
        cwd,
        includeTranscript: params.includeTranscript ?? false,
        signal,
        onUpdate,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: result.details,
        usage: nestedUsage(result.details.usage),
      };
    },
  });

  pi.registerCommand("fastcontext", {
    description: "Search the current repository with the local Qwen context model",
    handler: async (arguments_, ctx) => {
      const query = arguments_.trim();
      if (!query) {
        ctx.ui.notify("Usage: /fastcontext <repository question>", "warning");
        return;
      }
      const config = await resolveConfig(ctx.cwd, {}, { allowProjectConfig: ctx.isProjectTrusted() });
      const result = await runSearch({
        ...config,
        query,
        cwd: ctx.cwd,
        includeTranscript: false,
        signal: ctx.signal,
      });
      ctx.ui.notify(result.text, "info");
    },
  });
}
