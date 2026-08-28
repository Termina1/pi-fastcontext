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
  {
    type: "function",
    function: {
      name: "FINAL_ANSWER",
      description: "Finish the search with the most relevant concrete source citations. Call only after enough repository evidence has been read.",
      parameters: {
        type: "object",
        properties: {
          citations: {
            type: "array",
            maxItems: MAX_FINAL_CITATIONS,
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Repository-relative file path." },
                start: { type: "integer", description: "1-based first relevant line." },
                end: { type: "integer", description: "1-based last relevant line." },
                reason: { type: "string", description: "Relevance in at most 8 words." },
              },
              required: ["path", "start", "end", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["citations"],
        additionalProperties: false,
      },
    },
  },
] as const;

export const systemPrompt = `You locate source code relevant to a query and return precise file:line evidence.

Use GLOB, GREP, and READ against the repository root. Issue independent searches in the same response when useful. When enough evidence has been read, call FINAL_ANSWER.

Rules:
- Tool paths are relative to the repository root. Absolute paths and parent traversal are invalid.
- Search first, then read only likely source files and narrow line ranges.
- Prefer production code. Include tests or fixtures only when requested or essential.
- Stop after enough evidence; do not broaden a solved search.
- Never invent paths or line numbers.
- Submit at most ${MAX_FINAL_CITATIONS} concrete citations, ordered most relevant first.
- Finish by calling FINAL_ANSWER. Do not print citations as ordinary assistant text.`;
