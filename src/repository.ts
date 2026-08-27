import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type { ToolCall } from "./types.ts";

const MAX_TOOL_CHARS = 5_000;
const MAX_READ_LINES = 120;
const MAX_GREP_RESULTS = 40;
const MAX_GLOB_RESULTS = 80;

const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".venv", "venv", "node_modules", "build", "dist", "target",
  "__pycache__", ".mypy_cache", ".pytest_cache", ".next", ".turbo", "DerivedData",
]);

const TEXT_EXTENSIONS = new Set([
  "", ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".m", ".mm", ".metal",
  ".go", ".rs", ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".java", ".kt", ".swift",
  ".rb", ".php", ".json", ".toml", ".yaml", ".yml", ".md", ".txt", ".sh", ".sql",
  ".css", ".scss", ".html", ".xml", ".cmake", ".gradle",
]);

function truncate(text: string, maximum = MAX_TOOL_CHARS): string {
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum)}\n... [truncated to ${maximum} chars]`;
}

function globToRegularExpression(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/") || "**/*";
  let output = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const following = normalized[index + 1];
    if (character === "*" && following === "*") {
      if (normalized[index + 2] === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
    } else if (character === "*") {
      output += "[^/]*";
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${output}$`);
}

function isSkipped(relative: string): boolean {
  return relative.split("/").some((part) => SKIP_DIRECTORIES.has(part));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Repository {
  readonly root: string;
  private readonly signal?: AbortSignal;
  private fileListPromise?: Promise<string[]>;
  private readonly lineCache = new Map<string, Promise<string[]>>();

  private constructor(root: string, signal?: AbortSignal) {
    this.root = root;
    this.signal = signal;
  }

  static async open(root: string, signal?: AbortSignal): Promise<Repository> {
    const canonical = await fs.realpath(path.resolve(root));
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error(`Repository path is not a directory: ${root}`);
    return new Repository(canonical, signal);
  }

  private checkCancelled(): void {
    this.signal?.throwIfAborted();
  }

  private normalizeRelative(raw: unknown, options: { allowEmpty?: boolean } = {}): string {
    let value = String(raw ?? "").trim();
    if (value.startsWith("@")) value = value.slice(1);
    if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
      throw new Error(`path must be relative to repository root: ${value}`);
    }
    value = value.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!value && options.allowEmpty) return "";
    if (!value) throw new Error("path must not be empty");
    if (value.includes("\0")) throw new Error("NUL byte in path");
    if (value.split("/").includes("..")) throw new Error("path must not contain '..'");
    return value.replace(/\/$/, "");
  }

  private ensureInsideRoot(absolute: string): void {
    const relative = path.relative(this.root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("path escapes repository root");
    }
  }

  private async resolveExisting(raw: unknown, options: { allowEmpty?: boolean } = {}): Promise<{ absolute: string; relative: string; stat: import("node:fs").Stats }> {
    this.checkCancelled();
    const relative = this.normalizeRelative(raw, options);
    const lexical = path.resolve(this.root, relative || ".");
    this.ensureInsideRoot(lexical);
    const linkStat = await fs.lstat(lexical);
    if (linkStat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relative}`);
    const absolute = await fs.realpath(lexical);
    this.ensureInsideRoot(absolute);
    return { absolute, relative, stat: await fs.stat(absolute) };
  }

  private async listFiles(): Promise<string[]> {
    this.fileListPromise ??= (async () => {
      const output: string[] = [];
      const walk = async (directory: string): Promise<void> => {
        this.checkCancelled();
        let entries: Array<import("node:fs").Dirent>;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          this.checkCancelled();
          if (entry.isSymbolicLink()) continue;
          const absolute = path.join(directory, entry.name);
          const relative = path.relative(this.root, absolute).split(path.sep).join("/");
          if (isSkipped(relative)) continue;
          if (entry.isDirectory()) await walk(absolute);
          else if (entry.isFile()) output.push(relative);
        }
      };
      await walk(this.root);
      return output.sort();
    })();
    return this.fileListPromise;
  }

  private async loadLines(relative: string, absolute: string): Promise<string[]> {
    let promise = this.lineCache.get(relative);
    if (!promise) {
      promise = (async () => {
        if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error(`unsupported text extension: ${relative}`);
        const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
        const handle = await fs.open(absolute, fsConstants.O_RDONLY | noFollow);
        try {
          const openedStat = await handle.stat();
          if (!openedStat.isFile()) throw new Error(`not a regular file: ${relative}`);
          if (openedStat.size > 2_000_000) throw new Error(`file is larger than 2 MB: ${relative}`);

          const canonical = await fs.realpath(absolute);
          this.ensureInsideRoot(canonical);
          const currentStat = await fs.stat(canonical);
          if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
            throw new Error(`file changed while opening: ${relative}`);
          }

          const text = await handle.readFile({ encoding: "utf8" });
          if (text.includes("\0")) throw new Error(`binary file refused: ${relative}`);
          const lines = text.split(/\r?\n/);
          if (lines.at(-1) === "") lines.pop();
          return lines;
        } finally {
          await handle.close();
        }
      })();
      this.lineCache.set(relative, promise);
    }
    return promise;
  }

  async read(arguments_: Record<string, unknown>): Promise<string> {
    try {
      const { absolute, relative, stat } = await this.resolveExisting(arguments_.path);
      if (!stat.isFile()) return `ERR: not a file: ${relative}`;
      if (isSkipped(relative)) return `ERR: skipped path: ${relative}`;
      const lines = await this.loadLines(relative, absolute);
      const offset = Math.max(1, Math.floor(Number(arguments_.offset ?? 1) || 1));
      const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(Number(arguments_.limit ?? 80) || 80)));
      const end = Math.min(lines.length, offset + limit - 1);
      const body = lines.slice(offset - 1, end).map((line, index) => `${offset + index}:${line}`).join("\n");
      return truncate(`FILE ${relative} lines ${offset}-${end}/${lines.length}\n${body}`);
    } catch (error) {
      if (this.signal?.aborted) throw error;
      return `ERR: ${errorMessage(error)}`;
    }
  }

  async glob(arguments_: Record<string, unknown>): Promise<string> {
    try {
      const pattern = this.normalizeRelative(arguments_.pattern);
      const expression = globToRegularExpression(pattern);
      const matches = (await this.listFiles()).filter((relative) => expression.test(relative));
      if (!matches.length) return `No files matched ${pattern}.`;
      const shown = matches.slice(0, MAX_GLOB_RESULTS);
      const suffix = matches.length > shown.length ? `\n... [${matches.length - shown.length} more]` : "";
      return truncate(`${shown.join("\n")}${suffix}`);
    } catch (error) {
      if (this.signal?.aborted) throw error;
      return `ERR: ${errorMessage(error)}`;
    }
  }

  async grep(arguments_: Record<string, unknown>): Promise<string> {
    try {
      const pattern = String(arguments_.pattern ?? "");
      if (!pattern) return "ERR: pattern must not be empty";
      const requestedPath = this.normalizeRelative(arguments_.path, { allowEmpty: true });
      let target = ".";
      if (requestedPath) {
        const resolved = await this.resolveExisting(requestedPath);
        if (!resolved.stat.isFile() && !resolved.stat.isDirectory()) {
          return `ERR: not a file or directory: ${resolved.relative}`;
        }
        target = resolved.relative;
      }

      const argumentsList = [
        "--json",
        "--ignore-case",
        "--hidden",
        "--no-follow",
        "--max-filesize=2M",
      ];
      for (const directory of SKIP_DIRECTORIES) {
        argumentsList.push("--glob", `!**/${directory}/**`);
      }
      argumentsList.push("-e", pattern, "--", target);

      const results = await new Promise<{ lines: string[]; limited: boolean; timedOut: boolean }>((resolve, reject) => {
        const child = spawn("rg", argumentsList, {
          cwd: this.root,
          stdio: ["ignore", "pipe", "pipe"],
          signal: this.signal,
        });
        const lines: string[] = [];
        let stdoutBuffer = "";
        let stderr = "";
        let limited = false;
        let timedOut = false;
        let settled = false;

        const consume = (line: string): void => {
          if (!line || lines.length >= MAX_GREP_RESULTS) return;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type !== "match" || !event.data || typeof event.data !== "object") return;
            const data = event.data as Record<string, unknown>;
            const pathData = data.path && typeof data.path === "object" ? data.path as Record<string, unknown> : {};
            const linesData = data.lines && typeof data.lines === "object" ? data.lines as Record<string, unknown> : {};
            const relative = String(pathData.text ?? "").replace(/^\.\//, "");
            const lineNumber = Number(data.line_number ?? 0);
            const text = String(linesData.text ?? "").trim().slice(0, 220);
            if (relative && lineNumber > 0) lines.push(`${relative}:${lineNumber}:${text}`);
            if (lines.length >= MAX_GREP_RESULTS) {
              limited = true;
              child.kill("SIGTERM");
            }
          } catch {
            // Ignore non-JSON diagnostics; rg errors are handled from stderr/exit status.
          }
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdoutBuffer += chunk;
          const complete = stdoutBuffer.split("\n");
          stdoutBuffer = complete.pop() ?? "";
          for (const line of complete) consume(line);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, 5_000);
        timer.unref();

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.signal?.aborted) reject(error);
          else reject(new Error(errorMessage(error)));
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (stdoutBuffer) consume(stdoutBuffer);
          if (code === 2 && !limited && !timedOut) {
            reject(new Error(stderr.trim() || `ripgrep exited with status ${code}`));
            return;
          }
          resolve({ lines, limited, timedOut });
        });
      });

      if (!results.lines.length) {
        return results.timedOut ? `No matches for ${pattern} before the 5s search deadline.` : `No matches for ${pattern}.`;
      }
      const suffix = results.limited
        ? `\n... [stopped after ${MAX_GREP_RESULTS} matches]`
        : results.timedOut
          ? "\n... [search stopped after 5s]"
          : "";
      return truncate(`${results.lines.join("\n")}${suffix}`);
    } catch (error) {
      if (this.signal?.aborted) throw error;
      return `ERR: ${errorMessage(error)}`;
    }
  }

  async execute(call: ToolCall): Promise<string> {
    switch (call.name.toUpperCase()) {
      case "READ": return this.read(call.arguments);
      case "GLOB": return this.glob(call.arguments);
      case "GREP": return this.grep(call.arguments);
      default: return `ERR: unknown tool ${call.name}; use READ, GLOB, or GREP`;
    }
  }

  async validateRange(rawPath: string, start: number, end: number): Promise<{ path: string; exists: boolean; inBounds: boolean }> {
    try {
      const { absolute, relative, stat } = await this.resolveExisting(rawPath);
      if (!stat.isFile()) return { path: relative, exists: false, inBounds: false };
      const lines = await this.loadLines(relative, absolute);
      return {
        path: relative,
        exists: true,
        inBounds: start >= 1 && end >= start && end <= lines.length,
      };
    } catch {
      let pathValue = String(rawPath || "").trim();
      if (pathValue.startsWith("@")) pathValue = pathValue.slice(1);
      return { path: pathValue, exists: false, inBounds: false };
    }
  }
}
