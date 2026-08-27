import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { SearchConfig, SearchConfigOverrides } from "./types.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8770/v1";
export const DEFAULT_MODEL = "qwen38-flash-next-q4-nothink-p1";
export const DEFAULT_MAX_TURNS = 3;
export const DEFAULT_MAX_TOKENS = 512;

const USER_CONFIG_PATH = path.join(
  process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
  "fastcontext.json",
);

export async function readConfigFile(file: string): Promise<SearchConfigOverrides> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const config: SearchConfigOverrides = {};
    if (typeof parsed.baseUrl === "string") config.baseUrl = parsed.baseUrl;
    if (typeof parsed.model === "string") config.model = parsed.model;
    if (typeof parsed.maxTurns === "number") config.maxTurns = parsed.maxTurns;
    if (typeof parsed.maxTokens === "number") config.maxTokens = parsed.maxTokens;
    return config;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read search config ${file}: ${message}`);
  }
}

function requireLoopbackBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid local model base URL: ${value}`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error(`Local model base URL must use HTTP loopback without credentials: ${value}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function integerFromEnvironment(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

export async function resolveConfig(
  cwd: string,
  overrides: SearchConfigOverrides = {},
  options: { allowProjectConfig?: boolean } = {},
): Promise<SearchConfig> {
  const config: SearchConfig = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    maxTurns: DEFAULT_MAX_TURNS,
    maxTokens: DEFAULT_MAX_TOKENS,
  };

  Object.assign(config, await readConfigFile(USER_CONFIG_PATH));
  if (options.allowProjectConfig !== false) {
    Object.assign(config, await readConfigFile(path.join(cwd, CONFIG_DIR_NAME, "fastcontext.json")));
  }

  Object.assign(config, {
    baseUrl: process.env.FASTCONTEXT_BASE_URL || config.baseUrl,
    model: process.env.FASTCONTEXT_MODEL || config.model,
    maxTurns: integerFromEnvironment("FASTCONTEXT_MAX_TURNS") ?? config.maxTurns,
    maxTokens: integerFromEnvironment("FASTCONTEXT_MAX_TOKENS") ?? config.maxTokens,
  });
  Object.assign(config, Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)));

  config.baseUrl = requireLoopbackBaseUrl(config.baseUrl);
  config.maxTurns = Math.max(1, Math.min(6, Math.floor(config.maxTurns || DEFAULT_MAX_TURNS)));
  config.maxTokens = Math.max(128, Math.min(1_400, Math.floor(config.maxTokens || DEFAULT_MAX_TOKENS)));
  return config;
}
