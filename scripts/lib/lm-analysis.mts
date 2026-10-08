import type { ChangeGrouping } from "./change-groups.mjs";
import type { PatchAnalysis } from "./preflight.mjs";
import { parseUnifiedDiff } from "./diff-parse.mjs";
import { DiagnosticError, type Diagnostic } from "./diagnostics.mjs";

export const ANALYSIS_INPUT_VERSION = 1;
export const ANALYSIS_MODES = Object.freeze(["lm-analysis", "deep-audit"] as const);
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
export type AnalysisRiskLevel = "low" | "medium" | "high";
export type FindingSeverity = "nit" | "suggestion" | "concern" | "question" | "praise" | "comment";
export type ReviewVerdict = "approve" | "comment" | "request-changes";

interface RepositoryContext {
  nameWithOwner?: string;
  owner?: string;
  name?: string;
  branch?: string;
  headSha?: string;
}

interface PullRequestContext {
  number?: number;
  url?: string;
  title?: string;
  body?: string;
  description?: string;
  headSha?: string;
  labels?: unknown[];
  checks?: unknown[];
  reviews?: unknown[];
  comments?: unknown[];
  reviewComments?: unknown[];
}

export interface ReviewContext {
  source?: string;
  repository?: RepositoryContext;
  git?: { branch?: string; headSha?: string; diffLabel?: string };
  pullRequest?: PullRequestContext | null;
  diff?: { path?: string; source?: string; bytes?: number };
  preflight: PatchAnalysis;
  changeGroups: ChangeGrouping;
}

export interface AnalysisOptions {
  mode?: AnalysisMode;
  explicitDeepAudit?: boolean;
  diffPath?: string;
}

export interface AnalysisRisk {
  level: AnalysisRiskLevel;
  reasons: string[];
}

export interface AnalysisInput {
  schemaVersion: 1;
  mode: AnalysisMode;
  risk: AnalysisRisk;
  deepAuditAdmission?: "high-risk" | "explicit-request";
  target: ReturnType<typeof compactTarget>;
  diff: ReturnType<typeof diffReference>;
  facts: {
    preflight: PatchAnalysis;
    changeGroups: ChangeGrouping;
  };
  findingContract: {
    maxFindings: number;
    required: string[];
    guidance: string;
  };
}

export interface AnalysisFinding {
  /** Row ID from the patch (`file#h0:a12` or `file#h0:d7`); an alternative to file plus line. */
  row?: string;
  file?: string;
  line?: number | `o${number}`;
  severity: FindingSeverity;
  body: string;
  confidence: number;
  rationale: string;
  options: string[];
  suggestedChange?: string;
}

export interface AnalysisResult {
  verdict: ReviewVerdict;
  global: string;
  findings: AnalysisFinding[];
}

export interface AnalysisDiagnostic extends Diagnostic {
  level: "error";
}

export interface ReviewFinding extends Omit<AnalysisFinding, "row" | "file" | "line"> {
  file: string;
  line: number | `o${number}`;
}

/** Every line a finding may anchor to: changed rows by ID plus new/old line numbers per file. */
export interface DiffAnchors {
  rows: Set<string>;
  newLines: Map<string, Set<number>>;
  oldLines: Map<string, Set<number>>;
}

function addLine(map: Map<string, Set<number>>, file: string, line: number): void {
  const lines = map.get(file) ?? new Set<number>();
  lines.add(line);
  map.set(file, lines);
}

/** Build the anchor set from the actual patch: added, deleted, and context rows. */
export function diffAnchorsFromPatch(patch: string): DiffAnchors {
  const anchors: DiffAnchors = { rows: new Set(), newLines: new Map(), oldLines: new Map() };
  for (const parsed of parseUnifiedDiff(patch)) {
    const file = parsed.path.replaceAll("\\", "/");
    parsed.hunks.forEach((hunk, hunkIndex) => {
      for (const line of hunk.lines) {
        if (line.newNo !== undefined) addLine(anchors.newLines, file, line.newNo);
        if (line.oldNo !== undefined) addLine(anchors.oldLines, file, line.oldNo);
        if (line.kind === "add") anchors.rows.add(`${file}#h${hunkIndex}:a${line.newNo}`);
        if (line.kind === "del") anchors.rows.add(`${file}#h${hunkIndex}:d${line.oldNo}`);
      }
    });
  }
  return anchors;
}

const ROW_ID_RE = /^(.+)#h(\d+):([ad])([1-9]\d*)$/;

export function parseRowId(
  row: string,
): { file: string; hunk: number; side: "a" | "d"; line: number } | null {
  const match = ROW_ID_RE.exec(String(row));
  if (!match) return null;
  return {
    file: match[1],
    hunk: Number(match[2]),
    side: match[3] as "a" | "d",
    line: Number(match[4]),
  };
}

/** Fall back to the inventory's changed rows when the patch text is unavailable. */
function diffAnchorsFromInventory(
  inventory: ChangeGrouping["inventory"] | undefined,
): DiffAnchors | null {
  if (!(inventory || []).some((change) => Array.isArray(change.rows))) return null;
  const anchors: DiffAnchors = { rows: new Set(), newLines: new Map(), oldLines: new Map() };
  for (const change of inventory || []) {
    for (const row of change.rows || []) {
      const parsed = parseRowId(row);
      if (!parsed) continue;
      anchors.rows.add(row);
      addLine(parsed.side === "a" ? anchors.newLines : anchors.oldLines, parsed.file, parsed.line);
    }
  }
  return anchors;
}

/** Resolve a finding's row reference to the file/line form the review spec uses. */
export function findingAnchor(
  finding: AnalysisFinding,
): { file: string; line: number | `o${number}` } | null {
  if (typeof finding.row === "string") {
    const parsed = parseRowId(finding.row);
    if (!parsed) return null;
    return { file: parsed.file, line: parsed.side === "a" ? parsed.line : `o${parsed.line}` };
  }
  if (typeof finding.file !== "string" || finding.line === undefined) return null;
  return { file: finding.file, line: finding.line };
}
const REQUIRED_FINDING_FIELDS = Object.freeze([
  "file",
  "line",
  "severity",
  "body",
  "confidence",
  "rationale",
  "options",
]);
const FINDING_FIELDS = new Set([...REQUIRED_FINDING_FIELDS, "row", "suggestedChange"]);
const FINDING_SEVERITIES = new Set([
  "nit",
  "suggestion",
  "concern",
  "question",
  "praise",
  "comment",
]);
const VERDICTS = new Set(["approve", "comment", "request-changes"]);

function compactTarget(context: ReviewContext): {
  repository: string;
  branch: string;
  headSha: string;
  number: number | null;
  url: string;
  title: string;
  description: string;
  labels: unknown[];
  checks: unknown[];
  reviews: unknown[];
  comments: unknown[];
  reviewComments: unknown[];
} {
  const pullRequest = context.pullRequest || {};
  // A PR's base repository comes from its URL; the local origin may be a fork.
  const pullRequestRepository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/.exec(
    pullRequest.url || "",
  )?.[1];
  return {
    repository:
      pullRequestRepository ||
      context.repository?.nameWithOwner ||
      [context.repository?.owner, context.repository?.name].filter(Boolean).join("/"),
    branch: context.git?.diffLabel || context.repository?.branch || context.git?.branch || "",
    headSha: pullRequest.headSha || context.repository?.headSha || context.git?.headSha || "",
    number: pullRequest.number ?? null,
    url: pullRequest.url || "",
    title:
      pullRequest.title ||
      context.git?.diffLabel ||
      context.repository?.branch ||
      context.git?.branch ||
      "Local changes",
    description: pullRequest.body || pullRequest.description || "",
    labels: pullRequest.labels || [],
    checks: pullRequest.checks || [],
    reviews: pullRequest.reviews || [],
    comments: pullRequest.comments || [],
    reviewComments: pullRequest.reviewComments || [],
  };
}

function diffReference(
  context: ReviewContext,
  options: AnalysisOptions,
): { path: string | undefined; source: string | undefined; bytes: number } {
  if (context.diff && typeof context.diff === "object") {
    return {
      path: options.diffPath || context.diff.path,
      source: context.diff.source || context.source,
      bytes: context.diff.bytes ?? context.preflight?.totals?.bytes ?? 0,
    };
  }
  return {
    path: options.diffPath || "context.patch",
    source: context.source || "local",
    bytes: context.preflight?.totals?.bytes ?? 0,
  };
}

function requireDeterministicFacts(
  context: Pick<ReviewContext, "preflight" | "changeGroups">,
): void {
  const preflight = context?.preflight;
  if (
    !preflight ||
    preflight.patch?.valid !== true ||
    !preflight.totals ||
    !Array.isArray(preflight.files)
  ) {
    throw new Error("Focused analysis requires a valid preflight fact pack.");
  }
  const groups = context?.changeGroups;
  if (
    !groups ||
    groups.schemaVersion !== 1 ||
    groups.validation?.valid !== true ||
    !Array.isArray(groups.groups) ||
    !Array.isArray(groups.inventory)
  ) {
    throw new Error("Focused analysis requires valid candidate groups.");
  }
}

export function assessAnalysisRisk(context: ReviewContext): AnalysisRisk {
  const reasons: string[] = [];
  const groups = context.changeGroups?.groups || [];
  const files = context.preflight?.files || [];
  const totals = context.preflight?.totals || {};
  if (context.preflight?.patch?.valid === false) reasons.push("Patch validation failed.");
  if (groups.some((group) => group.risk === "high"))
    reasons.push("At least one candidate group is high risk.");
  if (files.some((file) => file.binary)) reasons.push("The change includes binary content.");
  if (files.some((file) => file.generated)) reasons.push("The change includes generated content.");
  if ((totals.files || 0) > 100) reasons.push("The change touches more than 100 files.");
  if ((totals.additions || 0) + (totals.deletions || 0) > 3000)
    reasons.push("The textual change exceeds 3,000 lines.");
  if (reasons.length) return { level: "high", reasons };
  const medium: string[] = [];
  if (groups.some((group) => group.risk === "medium"))
    medium.push("At least one candidate group is medium risk.");
  if ((totals.files || 0) > 30) medium.push("The change touches more than 30 files.");
  return { level: medium.length ? "medium" : "low", reasons: medium };
}

function findingBudget(context: Pick<ReviewContext, "changeGroups">): number {
  return Math.min(12, Math.max(3, Math.ceil((context.changeGroups?.inventory?.length || 0) / 5)));
}

export function prepareAnalysisInput(
  context: ReviewContext,
  options: AnalysisOptions = {},
): AnalysisInput {
  const mode = options.mode || "lm-analysis";
  if (!ANALYSIS_MODES.includes(mode)) {
    throw new Error(`Analysis mode must be one of: ${ANALYSIS_MODES.join(", ")}.`);
  }
  requireDeterministicFacts(context);
  const risk = assessAnalysisRisk(context);
  if (mode === "deep-audit" && !options.explicitDeepAudit && risk.level !== "high") {
    throw new Error("Deep-audit mode requires --explicit or a high-risk fact pack.");
  }
  return {
    schemaVersion: ANALYSIS_INPUT_VERSION,
    mode,
    risk,
    ...(mode === "deep-audit"
      ? { deepAuditAdmission: risk.level === "high" ? "high-risk" : "explicit-request" }
      : {}),
    target: compactTarget(context),
    diff: diffReference(context, options),
    facts: {
      preflight: context.preflight,
      changeGroups: context.changeGroups,
    },
    findingContract: {
      maxFindings: findingBudget(context),
      required: [...REQUIRED_FINDING_FIELDS],
      guidance:
        "Emit only actionable, verifiable findings. Keep body and rationale to one precise sentence each. Provide 2-4 short, finding-specific response options. Include suggestedChange only when a concrete replacement is justified. An empty findings array is valid.",
    },
  };
}

function requireValidAnalysisInput(input: AnalysisInput): void {
  const problems: string[] = [];
  if (input?.schemaVersion !== ANALYSIS_INPUT_VERSION) {
    problems.push(`schemaVersion must be ${ANALYSIS_INPUT_VERSION}`);
  }
  if (!ANALYSIS_MODES.includes(input?.mode)) {
    problems.push(`mode must be one of: ${ANALYSIS_MODES.join(", ")}`);
  }
  if (problems.length) {
    throw new Error(`Invalid analysis input: ${problems.join("; ")}.`);
  }
  const context = {
    preflight: input.facts?.preflight,
    changeGroups: input.facts?.changeGroups,
  };
  requireDeterministicFacts(context);
  const expectedBudget = findingBudget(context);
  if (input.findingContract?.maxFindings !== expectedBudget) {
    problems.push(`findingContract.maxFindings must be ${expectedBudget}`);
  }
  if (input.mode === "deep-audit") {
    const risk = assessAnalysisRisk(context);
    const expectedAdmission = risk.level === "high" ? "high-risk" : "explicit-request";
    if (input.deepAuditAdmission !== expectedAdmission) {
      problems.push(`deep-audit admission must be '${expectedAdmission}'`);
    }
  }
  if (problems.length) {
    throw new Error(`Invalid analysis input: ${problems.join("; ")}.`);
  }
}

export interface AnalysisValidationOptions {
  /** The reviewed patch; enables exact anchors including context rows. */
  patch?: string;
  anchors?: DiffAnchors;
}

export function validateAnalysisResult(
  result: AnalysisResult,
  input: AnalysisInput,
  options: AnalysisValidationOptions = {},
): { valid: boolean; diagnostics: AnalysisDiagnostic[] } {
  const diagnostics: AnalysisDiagnostic[] = [];
  const add = (code: string, path: string, message: string, hint?: string): number =>
    diagnostics.push({
      level: "error",
      code,
      path,
      message,
      ...(hint ? { hint } : {}),
    });
  const anchors =
    options.anchors ??
    (options.patch !== undefined
      ? diffAnchorsFromPatch(options.patch)
      : diffAnchorsFromInventory(input?.facts?.changeGroups?.inventory));
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  if (!VERDICTS.has(result?.verdict)) {
    add("invalid-verdict", "verdict", "Use approve, comment, or request-changes.");
  }
  if (typeof result?.global !== "string" || !result.global.trim()) {
    add("missing-global-assessment", "global", "Analysis results require a global assessment.");
  }
  if (!Array.isArray(result?.findings)) {
    add("expected-findings", "findings", "Analysis results must include a findings array.");
  }
  const maxFindings = input?.findingContract?.maxFindings;
  if (Number.isInteger(maxFindings) && findings.length > maxFindings) {
    add(
      "finding-budget-exceeded",
      "findings",
      `Focused analysis allows at most ${maxFindings} findings for this change set; received ${findings.length}.`,
    );
  }
  findings.forEach((finding, index) => {
    const root = `findings[${index}]`;
    for (const field of Object.keys(finding || {})) {
      if (!FINDING_FIELDS.has(field)) {
        add(
          "unknown-finding-field",
          `${root}.${field}`,
          `Finding field '${field}' is not part of the review-spec contract.`,
        );
      }
    }
    if (finding?.row !== undefined) {
      if (finding.file !== undefined || finding.line !== undefined) {
        add(
          "ambiguous-anchor",
          `${root}.row`,
          "Use either row or file plus line, not both.",
          "Keep row and remove file and line.",
        );
      }
      const parsed = typeof finding.row === "string" ? parseRowId(finding.row) : null;
      if (!parsed) {
        add(
          "invalid-row-anchor",
          `${root}.row`,
          `Row '${String(finding.row)}' is not a row ID.`,
          "Copy a row ID such as 'src/a.ts#h0:a12' from the patch.",
        );
      } else if (anchors && !anchors.rows.has(finding.row)) {
        add(
          "anchor-not-in-diff",
          `${root}.row`,
          `Row '${finding.row}' is not an added or removed row in the diff.`,
          "Copy an existing row ID, or anchor a context line with file and line.",
        );
      }
    } else {
      if (typeof finding?.file !== "string" || !finding.file.trim()) {
        add(
          "missing-finding-field",
          `${root}.file`,
          "A finding must identify a file.",
          "Use row, or file plus line.",
        );
      }
      const validLine =
        (typeof finding?.line === "number" && Number.isInteger(finding.line) && finding.line > 0) ||
        (typeof finding?.line === "string" && /^o[1-9]\d*$/.test(finding.line));
      if (!validLine) {
        add(
          "invalid-line-anchor",
          `${root}.line`,
          "Use a positive new line or an old-line anchor such as 'o7'.",
        );
      } else if (typeof finding.file === "string") {
        const oldSide = typeof finding.line === "string";
        const line =
          typeof finding.line === "string" ? Number(finding.line.slice(1)) : Number(finding.line);
        const anchored = anchors
          ? Boolean((oldSide ? anchors.oldLines : anchors.newLines).get(finding.file)?.has(line))
          : (input?.facts?.changeGroups?.inventory || []).some((change) => {
              const range = change[oldSide ? "oldRange" : "newRange"];
              return (
                change.file === finding.file &&
                range !== null &&
                range.count !== 0 &&
                line >= range.start &&
                line <= range.end
              );
            });
        if (!anchored) {
          add(
            "anchor-not-in-diff",
            `${root}.line`,
            `Finding anchor '${finding.file}:${finding.line}' is not a line shown in the diff.`,
            "Anchor to an added, removed ('o' + old line), or context line of that file's hunks.",
          );
        }
      }
    }
    if (!FINDING_SEVERITIES.has(finding?.severity)) {
      add("invalid-severity", `${root}.severity`, "A finding must use a supported severity.");
    }
    if (typeof finding?.body !== "string" || !finding.body.trim()) {
      add("missing-finding-field", `${root}.body`, "A finding must explain the actionable issue.");
    } else if (finding.body.length > 280) {
      add("finding-too-long", `${root}.body`, "Keep the finding body to 280 characters or fewer.");
    }
    if (
      typeof finding?.confidence !== "number" ||
      finding.confidence < 0 ||
      finding.confidence > 1
    ) {
      add(
        "invalid-confidence",
        `${root}.confidence`,
        "Finding confidence must be a number from 0 to 1.",
      );
    }
    if (typeof finding?.rationale !== "string" || !finding.rationale.trim()) {
      add(
        "missing-rationale",
        `${root}.rationale`,
        "A finding must include a brief, verifiable rationale.",
      );
    } else if (finding.rationale.length > 180) {
      add(
        "finding-too-long",
        `${root}.rationale`,
        "Keep the rationale to 180 characters or fewer.",
      );
    }
    if (
      !Array.isArray(finding?.options) ||
      finding.options.length < 2 ||
      finding.options.length > 4 ||
      finding.options.some(
        (option) => typeof option !== "string" || !option.trim() || option.length > 64,
      ) ||
      new Set(finding.options.map((option) => option.trim().toLowerCase())).size !==
        finding.options.length
    ) {
      add(
        "invalid-finding-options",
        `${root}.options`,
        "Provide 2-4 distinct, non-empty response options of at most 64 characters each.",
      );
    }
    if (
      finding?.suggestedChange !== undefined &&
      (typeof finding.suggestedChange !== "string" || !finding.suggestedChange.trim())
    ) {
      add(
        "invalid-suggested-change",
        `${root}.suggestedChange`,
        "A suggested change must be a non-empty code replacement.",
      );
    }
  });
  return { valid: diagnostics.length === 0, diagnostics };
}

export function analysisResultToReview(
  result: AnalysisResult,
  input: AnalysisInput,
  options: AnalysisValidationOptions = {},
): { verdict: ReviewVerdict; global: string; comments: ReviewFinding[] } {
  requireValidAnalysisInput(input);
  const validation = validateAnalysisResult(result, input, options);
  if (!validation.valid) {
    throw new DiagnosticError("Invalid LM analysis result:", validation.diagnostics);
  }
  return {
    verdict: result.verdict,
    global: result.global,
    comments: result.findings.map((finding) => {
      const { row: _row, file: _file, line: _line, ...rest } = finding;
      const anchor = findingAnchor(finding);
      if (!anchor) throw new Error("Validated finding anchor is missing.");
      return { file: anchor.file, line: anchor.line, ...rest };
    }),
  };
}
