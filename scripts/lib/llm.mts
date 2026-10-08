// Provider adapters for the language-model CLIs. Commands are spawned with
// argument arrays and no shell; Windows npm `.cmd` shims are resolved to the
// Node script they wrap so arguments never pass through cmd.exe.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type ProviderName = "claude" | "codex";
export const PROVIDERS: readonly ProviderName[] = Object.freeze(["claude", "codex"]);

export interface SpawnOptions {
  cwd: string;
  input: string;
  timeoutMs: number;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
}

export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

export interface ResolvedCommand {
  command: string;
  prefixArgs: string[];
}

export interface ProviderRequest {
  prompt: string;
  repo: string;
  /** Path of the strict JSON Schema the provider must follow. */
  schemaPath: string;
  /** Where the provider's final message is written (codex) or copied (claude). */
  outputPath: string;
  model?: string;
  timeoutMs: number;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ProviderOutput {
  /** Raw provider stdout (and final message for codex). */
  raw: string;
  /** The model's final answer text. */
  text: string;
  /** The parsed JSON object, when one could be extracted. */
  value?: unknown;
  usage?: ProviderUsage;
  costUsd?: number;
  durationMs: number;
}

export interface Provider {
  name: ProviderName | string;
  run(request: ProviderRequest): Promise<ProviderOutput>;
}

/** A provider failure; `retryable` is false for missing CLIs, auth problems, and timeouts. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

const READ_ONLY_TOOLS = "Read,Grep,Glob";
const DENIED_TOOLS = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent";

export const defaultSpawner: Spawner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const finish = (status: number | null, error?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut, ...(error ? { error } : {}) });
    };
    child.on("error", (error: NodeJS.ErrnoException) => finish(null, error));
    child.on("close", (status) => finish(status));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input, "utf8");
  });

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Find an executable on PATH. On Windows, `.exe`/`.com` run directly and npm
 * `.cmd` shims are unwrapped to `node <script>`; other batch files are refused
 * because running them would require a shell.
 */
export function resolveExecutable(
  name: string,
  options: ResolveOptions = {},
): ResolvedCommand | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? isFile;
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathValue = env.PATH ?? env.Path ?? "";
  const directories = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform !== "win32") {
    for (const directory of directories) {
      const candidate = pathApi.join(directory, name);
      if (exists(candidate)) return { command: candidate, prefixArgs: [] };
    }
    return null;
  }
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.toLowerCase())
    .filter((extension) => [".com", ".exe", ".cmd", ".bat"].includes(extension));
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${name}${extension}`);
      if (!exists(candidate)) continue;
      if (extension === ".exe" || extension === ".com")
        return { command: candidate, prefixArgs: [] };
      const shim = /"%(?:~)?dp0%?\\?([^"%]+\.(?:c|m)?js)"/i.exec(readFile(candidate));
      if (!shim) {
        throw new ProviderError(
          `${candidate} is a batch file that cannot run without a shell. Use --llm none instead.`,
        );
      }
      const script = pathApi.join(directory, shim[1].replace(/^\\+/, ""));
      const bundledNode = pathApi.join(directory, "node.exe");
      const node = exists(bundledNode)
        ? bundledNode
        : (resolveExecutable("node", options)?.command ?? "node");
      return { command: node, prefixArgs: [script] };
    }
  }
  return null;
}

export function claudeArgs(request: ProviderRequest, schema: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--tools",
    READ_ONLY_TOOLS,
    "--allowedTools",
    READ_ONLY_TOOLS,
    "--disallowedTools",
    DENIED_TOOLS,
    "--no-session-persistence",
    "--json-schema",
    schema,
    ...(request.model ? ["--model", request.model] : []),
  ];
}

export function codexArgs(request: ProviderRequest): string[] {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "--json",
    "--cd",
    request.repo,
    "--output-schema",
    request.schemaPath,
    "-o",
    request.outputPath,
    ...(request.model ? ["--model", request.model] : []),
    "-",
  ];
}

/** Parse a JSON object from model text, tolerating code fences and surrounding prose. */
export function extractJsonObject(text: string): unknown {
  const trimmed = String(text || "").trim();
  const attempts = [trimmed];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(trimmed);
  if (fenced) attempts.push(fenced[1]);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  return undefined;
}

const AUTH_RE =
  /not logged in|please run \/login|\/login|invalid api key|authenticat|unauthori[sz]ed|\b401\b|login required/i;

function failure(name: string, result: SpawnResult, timeoutMs: number): ProviderError {
  if (result.error?.code === "ENOENT") {
    return new ProviderError(`The ${name} CLI was not found. Install it or use --llm none.`);
  }
  if (result.timedOut) {
    return new ProviderError(`${name} did not finish within ${Math.round(timeoutMs / 1000)} s.`);
  }
  const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-2_000);
  if (AUTH_RE.test(detail)) {
    return new ProviderError(`${name} is not logged in or lacks credentials: ${detail}`);
  }
  return new ProviderError(
    `${name} exited with status ${result.status ?? "unknown"}${result.error ? ` (${result.error.message})` : ""}${detail ? `: ${detail}` : ""}`,
    true,
  );
}

interface ProviderDependencies {
  spawner?: Spawner;
  resolve?: (name: string) => ResolvedCommand | null;
}

function claudeProvider(dependencies: Required<ProviderDependencies>): Provider {
  return {
    name: "claude",
    async run(request) {
      const executable = dependencies.resolve("claude");
      if (!executable)
        throw new ProviderError(
          "The claude CLI was not found on PATH. Install it or use --llm none.",
        );
      const schema = fs.readFileSync(request.schemaPath, "utf8").trim();
      const started = performance.now();
      const result = await dependencies.spawner(
        executable.command,
        [...executable.prefixArgs, ...claudeArgs(request, schema)],
        { cwd: request.repo, input: request.prompt, timeoutMs: request.timeoutMs },
      );
      const durationMs = Math.round(performance.now() - started);
      let envelope: Record<string, unknown> | undefined;
      try {
        envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      } catch {}
      if (!envelope || result.status !== 0 || envelope.is_error === true) {
        const message = typeof envelope?.result === "string" ? envelope.result : "";
        throw failure("claude", { ...result, stdout: message || result.stdout }, request.timeoutMs);
      }
      const text = typeof envelope.result === "string" ? envelope.result : "";
      const structured = envelope.structured_output;
      const value =
        structured && typeof structured === "object" ? structured : extractJsonObject(text);
      const usage = (envelope.usage || {}) as Record<string, number | undefined>;
      fs.writeFileSync(request.outputPath, `${JSON.stringify(value ?? null, null, 2)}\n`, "utf8");
      return {
        raw: result.stdout,
        text,
        ...(value !== undefined ? { value } : {}),
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
        },
        ...(typeof envelope.total_cost_usd === "number"
          ? { costUsd: envelope.total_cost_usd }
          : {}),
        durationMs,
      };
    },
  };
}

function codexProvider(dependencies: Required<ProviderDependencies>): Provider {
  return {
    name: "codex",
    async run(request) {
      const executable = dependencies.resolve("codex");
      if (!executable)
        throw new ProviderError(
          "The codex CLI was not found on PATH. Install it or use --llm none.",
        );
      try {
        fs.rmSync(request.outputPath, { force: true });
      } catch {}
      const started = performance.now();
      const result = await dependencies.spawner(
        executable.command,
        [...executable.prefixArgs, ...codexArgs(request)],
        { cwd: request.repo, input: request.prompt, timeoutMs: request.timeoutMs },
      );
      const durationMs = Math.round(performance.now() - started);
      const usage: ProviderUsage = {};
      let streamError = "";
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            usage?: Record<string, number>;
            message?: string;
            error?: { message?: string };
          };
          if (event.type === "turn.completed" && event.usage) {
            usage.inputTokens = (usage.inputTokens ?? 0) + (event.usage.input_tokens ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (event.usage.output_tokens ?? 0);
            usage.cacheReadTokens =
              (usage.cacheReadTokens ?? 0) + (event.usage.cached_input_tokens ?? 0);
          }
          if (event.type === "error" || event.type === "turn.failed") {
            streamError = event.message || event.error?.message || streamError;
          }
        } catch {}
      }
      let text = "";
      try {
        text = fs.readFileSync(request.outputPath, "utf8");
      } catch {}
      if (result.status !== 0 || (!text.trim() && streamError)) {
        throw failure(
          "codex",
          { ...result, stderr: `${streamError}\n${result.stderr}` },
          request.timeoutMs,
        );
      }
      const value = extractJsonObject(text);
      return {
        raw: `${result.stdout}\n${text}`,
        text,
        ...(value !== undefined ? { value } : {}),
        usage,
        durationMs,
      };
    },
  };
}

export function createProvider(
  name: ProviderName,
  dependencies: ProviderDependencies = {},
): Provider {
  const resolved: Required<ProviderDependencies> = {
    spawner: dependencies.spawner ?? defaultSpawner,
    resolve: dependencies.resolve ?? ((command) => resolveExecutable(command)),
  };
  return name === "claude" ? claudeProvider(resolved) : codexProvider(resolved);
}

/** Pick claude, then codex, from PATH; null when neither is installed. */
export function detectProvider(
  resolve: (name: string) => ResolvedCommand | null = (command) => resolveExecutable(command),
): ProviderName | null {
  for (const name of PROVIDERS) {
    try {
      if (resolve(name)) return name;
    } catch {}
  }
  return null;
}
