export type SearchConfig = {
  baseUrl: string;
  model: string;
  maxTurns: number;
  maxTokens: number;
};

export type SearchConfigOverrides = Partial<SearchConfig>;

export type ChatMessage = Record<string, unknown>;

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Citation = {
  path: string;
  start: number;
  end: number;
  line: string;
  exists: boolean;
  inBounds: boolean;
};

export type SearchUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  modelPasses: number;
};

export type ModelPassDiagnostic = {
  pass: number;
  phase: "search" | "final";
  turn: number | "final";
  elapsedMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  messageCount: number;
  requestedToolCalls: number;
  toolResultChars: number;
};

export type ToolCallDiagnostic = {
  turn: number;
  name: string;
  elapsedMs: number;
  resultChars: number;
  failed: boolean;
  repeatedRead: boolean;
};

export type SearchRunOptions = SearchConfig & {
  query: string;
  cwd: string;
  includeTranscript: boolean;
  signal?: AbortSignal;
  onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
};

export type SearchRunResult = {
  text: string;
  details: {
    root: string;
    baseUrl: string;
    model: string;
    final: string;
    citations: Citation[];
    validCitations: number;
    toolCalls: number;
    failedTools: number;
    elapsedMs: number;
    usage: SearchUsage;
    modelPasses: ModelPassDiagnostic[];
    toolDiagnostics: ToolCallDiagnostic[];
    warnings: string[];
    transcript?: unknown[];
  };
};
