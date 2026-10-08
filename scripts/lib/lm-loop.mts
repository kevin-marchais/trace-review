// Runs a provider, validates its result in-process, and re-prompts with the
// structured diagnostics until the result is valid or retries run out.

import fs from "node:fs";
import path from "node:path";
import { formatDiagnostics, type Diagnostic } from "./diagnostics.mjs";
import { ProviderError, type Provider, type ProviderRequest, type ProviderUsage } from "./llm.mjs";

export interface AttemptRecord {
  attempt: number;
  provider: string;
  durationMs: number;
  valid: boolean;
  diagnostics: Diagnostic[];
  usage?: ProviderUsage;
  costUsd?: number;
  error?: string;
}

export interface ReviewLoopOptions {
  provider: Provider;
  request: Omit<ProviderRequest, "prompt" | "outputPath">;
  prompt: string;
  /** Directory receiving attempt-N.json files. */
  dir: string;
  maxRetries: number;
  validate: (value: unknown) => { valid: boolean; diagnostics: Diagnostic[] };
  log?: (message: string) => void;
}

export interface ReviewLoopResult {
  valid: boolean;
  value?: unknown;
  attempts: AttemptRecord[];
  diagnostics: Diagnostic[];
}

export function retryPrompt(
  basePrompt: string,
  previous: unknown,
  diagnostics: Diagnostic[],
): string {
  return `${basePrompt}

## Correct your previous result

Your previous result was rejected. Fix every problem below and return the
complete corrected JSON object only.

${formatDiagnostics(diagnostics)}

Previous result:

${JSON.stringify(previous ?? null)}
`;
}

export async function runReviewLoop(options: ReviewLoopOptions): Promise<ReviewLoopResult> {
  const attempts: AttemptRecord[] = [];
  const log = options.log ?? (() => {});
  fs.mkdirSync(options.dir, { recursive: true });
  let prompt = options.prompt;
  let diagnostics: Diagnostic[] = [];
  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt++) {
    const outputPath = path.join(options.dir, `attempt-${attempt}.output.json`);
    const record: AttemptRecord = {
      attempt,
      provider: String(options.provider.name),
      durationMs: 0,
      valid: false,
      diagnostics: [],
    };
    let raw = "";
    let value: unknown;
    try {
      log(`Attempt ${attempt}: running ${options.provider.name}…`);
      const output = await options.provider.run({ ...options.request, prompt, outputPath });
      raw = output.raw;
      value = output.value;
      record.durationMs = output.durationMs;
      if (output.usage) record.usage = output.usage;
      if (output.costUsd !== undefined) record.costUsd = output.costUsd;
    } catch (error: unknown) {
      record.error = error instanceof Error ? error.message : String(error);
      attempts.push(record);
      writeAttempt(options.dir, record, raw, value);
      if (error instanceof ProviderError && !error.retryable) throw error;
      diagnostics = [
        {
          code: "provider-error",
          path: "$",
          message: record.error,
          hint: "Return one JSON object.",
        },
      ];
      continue;
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
    const validation =
      value === undefined
        ? {
            valid: false,
            diagnostics: [
              {
                code: "not-json",
                path: "$",
                message: "The output did not contain a JSON object.",
                hint: "Return only the JSON object, without prose or code fences.",
              },
            ],
          }
        : options.validate(value);
    record.valid = validation.valid;
    record.diagnostics = validation.diagnostics;
    attempts.push(record);
    writeAttempt(options.dir, record, raw, value);
    if (validation.valid) return { valid: true, value, attempts, diagnostics: [] };
    diagnostics = validation.diagnostics;
    log(`Attempt ${attempt} rejected:\n${formatDiagnostics(diagnostics)}`);
    prompt = retryPrompt(options.prompt, value, diagnostics);
  }
  return { valid: false, attempts, diagnostics };
}

function writeAttempt(dir: string, record: AttemptRecord, raw: string, value: unknown): void {
  fs.writeFileSync(
    path.join(dir, `attempt-${record.attempt}.json`),
    `${JSON.stringify({ ...record, result: value ?? null, raw }, null, 2)}\n`,
    "utf8",
  );
}
