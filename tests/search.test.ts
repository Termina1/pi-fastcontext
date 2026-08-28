import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runSearch } from "../src/search.ts";

test("search executes sibling repository tools and forces a validated final answer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-fastcontext-search-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "auth.ts"), "export class AuthManager {}\nexport function login() {}\n");

  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const first = requests.length === 1;
      const payload = first
        ? {
            choices: [{ message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "grep_1", type: "function", function: { name: "GREP", arguments: JSON.stringify({ pattern: "AuthManager" }) } },
                { id: "read_1", type: "function", function: { name: "READ", arguments: JSON.stringify({ path: "src/auth.ts", offset: 1, limit: 2 }) } },
                { id: "bad_1", type: "function", function: { name: "READ", arguments: "null" } },
              ],
            } }],
            usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } },
          }
        : {
            choices: [{ message: { role: "assistant", content: "<final_answer>\nsrc/auth.ts:1-2 — authentication implementation\n</final_answer>" } }],
            usage: { prompt_tokens: 150, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 80 } },
          };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const result = await runSearch({
      query: "find authentication",
      cwd: root,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      maxTurns: 1,
      maxTokens: 512,
      includeTranscript: true,
    });

    assert.equal(result.details.toolCalls, 3);
    assert.equal(result.details.failedTools, 1);
    assert.equal(result.details.validCitations, 1);
    assert.equal(result.details.final, "src/auth.ts:1-2 — authentication implementation");
    assert.equal(result.details.usage.modelPasses, 2);
    assert.equal(result.details.usage.cachedTokens, 90);
    assert.equal(result.details.modelPasses.length, 2);
    assert.equal(result.details.modelPasses[0].requestedToolCalls, 3);
    assert(result.details.modelPasses[0].toolResultChars > 0);
    assert.equal(result.details.modelPasses[1].phase, "final");
    assert.equal(result.details.toolDiagnostics.length, 3);
    assert.match(result.text, /## Model passes/);
    assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: false });
    assert(Array.isArray(requests[0].tools));
    assert.equal(requests[1].tools, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("search rejects absolute citation paths instead of correcting them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-fastcontext-citation-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "auth.ts"), "export class AuthManager {}\n");

  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "<final_answer>\n/src/auth.ts:1 — invalid absolute citation\nsrc/auth.ts:1 and src/auth.ts:1 — too many citations on one line\n</final_answer>" } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const result = await runSearch({
      query: "find authentication",
      cwd: root,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      maxTurns: 1,
      maxTokens: 128,
      includeTranscript: false,
    });
    assert.equal(result.details.validCitations, 0);
    assert.equal(result.details.final, "");
    assert(result.details.warnings.some((warning) => warning.includes("invalid citation")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
