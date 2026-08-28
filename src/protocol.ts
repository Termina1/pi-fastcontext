export const MAX_FINAL_CITATIONS = 5;

export const repositoryTools = [
  {
    type: "function",
    function: {
      name: "GLOB",
      description: "List repository files matching a relative glob such as **/*.py or src/**/*auth*. Absolute paths are rejected.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "GREP",
      description: "Case-insensitive regex search over repository text. path may be a relative file or directory; omit it for the repository root.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Optional relative file or directory." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "READ",
      description: "Read a relative repository file with line numbers. Use a narrow offset and limit around relevant matches.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "1-based starting line." },
          limit: { type: "integer", description: "Number of lines, capped at 120." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
] as const;

export const systemPrompt = `You locate source code relevant to a query and return precise file:line evidence.

Use GLOB, GREP, and READ against the repository root. Issue independent searches in the same response when useful.

Rules:
- Tool paths are relative to the repository root. Absolute paths and parent traversal are invalid.
- Search first, then read only likely source files and narrow line ranges.
- Prefer production code. Include tests or fixtures only when requested or essential.
- Stop after enough evidence; do not broaden a solved search.
- Never invent paths or line numbers.
- Return at most ${MAX_FINAL_CITATIONS} concrete citations, ordered most relevant first.
- The final response must be exactly:
<final_answer>
relative/path:START-END — reason in at most 8 words
</final_answer>`;
