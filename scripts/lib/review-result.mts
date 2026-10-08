// Validates and resolves the one combined result a language model (or agent)
// writes: schema checks first, then candidate-group expansion, auto-placement
// of unassigned changes, grouping rules, and diff-anchored findings.

import type { ChangeGroup, ChangeGroupKind, ChangeGrouping } from "./change-groups.mjs";
import type { Diagnostic } from "./diagnostics.mjs";
import { loadSchema, stripNulls, validateJsonSchema, type JsonSchema } from "./json-schema.mjs";
import {
  findingAnchor,
  validateAnalysisResult,
  type AnalysisFinding,
  type AnalysisInput,
  type AnalysisResult,
} from "./lm-analysis.mjs";
import { groupingPathDiagnostics, validateLmGroupingResult, type LmGroup } from "./lm-groups.mjs";

export type ReviewMode = "workspace" | "lm-analysis" | "deep-audit";

export const REVIEW_RESULT_SCHEMA = "review-result.v1.schema.json";
export const DETECTOR_RULES_SCHEMA = "detector-rules.v1.schema.json";

export interface ResultGroup extends Omit<LmGroup, "changeIds" | "changes"> {
  from?: string[];
  changeIds?: string[];
}

export interface AutoPlacement {
  change: string;
  candidateGroup: string;
  group: string;
}

export interface ResolvedReviewResult {
  summary: string;
  groups: LmGroup[];
  groupingProvenance?: "deterministic";
  review?: AnalysisResult;
  autoPlaced: AutoPlacement[];
}

export interface ResultValidation {
  valid: boolean;
  diagnostics: Diagnostic[];
  resolved?: ResolvedReviewResult;
}

export interface ResultContext {
  mode: ReviewMode;
  candidates: ChangeGrouping;
  /** Required for lm-analysis and deep-audit. */
  analysisInput?: AnalysisInput;
  /** The reviewed patch; finding anchors are checked against its rows. */
  patch?: string;
}

/** The canonical schema, optionally narrowed to one mode and finding budget. */
export function reviewResultSchema(mode?: ReviewMode, maxFindings?: number): JsonSchema {
  const schema = structuredClone(loadSchema(REVIEW_RESULT_SCHEMA));
  if (!mode) return schema;
  const properties = schema.properties as Record<string, JsonSchema>;
  if (mode === "workspace") {
    delete properties.review;
  } else {
    delete properties.groupingProvenance;
    schema.required = [...(schema.required || []), "review"];
    const findings = (schema.$defs?.review?.properties as Record<string, JsonSchema>).findings;
    if (maxFindings !== undefined) findings.maxItems = maxFindings;
  }
  return schema;
}

function scopeLabel(files: readonly string[]): string {
  if (files.length <= 1) return files[0] || "changes";
  return `${files[0]} and ${files.length - 1} other file${files.length === 2 ? "" : "s"}`;
}

/** Expand `from` references, apply per-change moves, and auto-place unassigned changes. */
export function resolveGroups(
  input: readonly ResultGroup[],
  candidates: Pick<ChangeGrouping, "groups" | "inventory">,
): { groups: LmGroup[]; autoPlaced: AutoPlacement[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const candidateGroups = new Map((candidates.groups || []).map((group) => [group.id, group]));
  const candidateOf = new Map<string, ChangeGroup>();
  for (const group of candidates.groups || []) {
    for (const change of group.changes || []) candidateOf.set(change.id, group);
  }
  const explicit = new Set(input.flatMap((group) => group.changeIds || []));
  const referencedBy = new Map<string, number>();
  const groups: LmGroup[] = input.map((group, index) => {
    const { from = [], changeIds = [], ...rest } = group;
    const assigned = [...changeIds];
    from.forEach((candidateId, fromIndex) => {
      const candidate = candidateGroups.get(candidateId);
      const path = `groups[${index}].from[${fromIndex}]`;
      if (!candidate) {
        diagnostics.push({
          code: "unknown-candidate-group",
          path,
          message: `Candidate group '${candidateId}' does not exist.`,
          hint: "Use a candidate group ID from the input, such as 'g1'.",
        });
        return;
      }
      const owner = referencedBy.get(candidateId);
      if (owner !== undefined) {
        diagnostics.push({
          code: "duplicate-candidate-group",
          path,
          message: `Candidate group '${candidateId}' is already used by groups[${owner}].`,
          hint: "Reference each candidate group from one group; move single changes with changeIds.",
        });
        return;
      }
      referencedBy.set(candidateId, index);
      for (const change of candidate.changes || []) {
        if (!explicit.has(change.id) && !assigned.includes(change.id)) assigned.push(change.id);
      }
    });
    const firstCandidate = from.map((id) => candidateGroups.get(id)).find(Boolean);
    const kind: ChangeGroupKind | undefined = rest.kind ?? firstCandidate?.kind;
    return { ...rest, ...(kind ? { kind } : {}), changeIds: assigned };
  });

  const placed = new Set(groups.flatMap((group) => group.changeIds));
  const leftovers = new Map<string, string[]>();
  for (const change of candidates.inventory || []) {
    if (placed.has(change.id)) continue;
    const candidateId = candidateOf.get(change.id)?.id ?? "";
    leftovers.set(candidateId, [...(leftovers.get(candidateId) || []), change.id]);
  }
  const autoPlaced: AutoPlacement[] = [];
  const titles = new Set(groups.map((group) => String(group.title || "").toLowerCase()));
  for (const [candidateId, changeIds] of leftovers) {
    const candidate = candidateGroups.get(candidateId);
    const siblings = new Set(
      (candidate?.changes || [])
        .map((change) => groups.findIndex((group) => group.changeIds.includes(change.id)))
        .filter((index) => index >= 0),
    );
    let target: LmGroup;
    if (siblings.size === 1) {
      target = groups[[...siblings][0]];
      target.changeIds.push(...changeIds);
    } else {
      const files = [...new Set(changeIds.map((id) => id.slice(0, id.lastIndexOf("#"))))];
      const label = String(candidate?.title || "remaining changes").toLowerCase();
      let title = `${scopeLabel(files)}: ${label}`;
      if (titles.has(title.toLowerCase())) title = `${title} (${candidateId || "unassigned"})`;
      titles.add(title.toLowerCase());
      target = {
        title,
        kind: candidate?.kind ?? "other",
        intent: candidate?.intent || "Review changes the model did not assign.",
        risk: candidate?.risk ?? "medium",
        confidence: candidate?.confidence ?? 0.5,
        evidence: candidate?.evidence?.length
          ? candidate.evidence
          : ["The deterministic classifier grouped these changes."],
        reviewerChecks: candidate?.reviewerChecks?.length
          ? candidate.reviewerChecks
          : ["Confirm the changes have the intended behavior."],
        titleEvidence: {
          changeIds: [changeIds[0]],
          rationale: `Auto-placed from deterministic candidate group ${candidateId || "(none)"} because the result did not assign these changes.`,
        },
        changeIds: [...changeIds],
        readAfter: [],
      };
      groups.push(target);
    }
    for (const change of changeIds) {
      autoPlaced.push({ change, candidateGroup: candidateId, group: target.title });
    }
  }
  return { groups, autoPlaced, diagnostics };
}

function prefixed(prefix: string, diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((item) => ({
    code: item.code,
    path: item.path && item.path !== "$" ? `${prefix}.${item.path}` : prefix,
    message: item.message,
    ...(item.hint ? { hint: item.hint } : {}),
  }));
}

/**
 * Drop `file`/`line` from findings that also give a `row` they agree with;
 * providers forced to fill every field often repeat the anchor. Disagreeing
 * anchors are left for validation to reject.
 */
export function dropRedundantAnchors(value: unknown): unknown {
  const findings = (value as { review?: { findings?: unknown } })?.review?.findings;
  if (!Array.isArray(findings)) return value;
  for (const finding of findings as Array<Record<string, unknown>>) {
    if (!finding || typeof finding.row !== "string") continue;
    const anchor = findingAnchor({ row: finding.row } as AnalysisFinding);
    if (
      anchor &&
      (finding.file === undefined || finding.file === anchor.file) &&
      (finding.line === undefined || finding.line === anchor.line)
    ) {
      delete finding.file;
      delete finding.line;
    }
  }
  return value;
}

/** Validate a raw combined result and resolve it to the finalizers' input form. */
export function validateReviewResult(raw: unknown, context: ResultContext): ResultValidation {
  const value = dropRedundantAnchors(stripNulls(raw));
  const maxFindings = context.analysisInput?.findingContract?.maxFindings;
  const schemaDiagnostics = validateJsonSchema(
    reviewResultSchema(context.mode, context.mode === "workspace" ? undefined : maxFindings),
    value,
  );
  if (schemaDiagnostics.length) return { valid: false, diagnostics: schemaDiagnostics };

  const result = value as {
    summary: string;
    groups: ResultGroup[];
    groupingProvenance?: "deterministic";
    review?: AnalysisResult;
  };
  const { groups, autoPlaced, diagnostics } = resolveGroups(result.groups, context.candidates);
  diagnostics.push(
    ...groupingPathDiagnostics(
      validateLmGroupingResult({ groups }, context.candidates).diagnostics,
      groups,
    ),
  );
  if (context.mode !== "workspace") {
    if (!context.analysisInput)
      throw new Error(`${context.mode} validation requires the analysis input.`);
    const analysis = validateAnalysisResult(
      result.review as AnalysisResult,
      context.analysisInput,
      { patch: context.patch },
    );
    diagnostics.push(...prefixed("review", analysis.diagnostics));
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    resolved: {
      summary: result.summary,
      groups,
      ...(result.groupingProvenance ? { groupingProvenance: result.groupingProvenance } : {}),
      ...(result.review ? { review: result.review } : {}),
      autoPlaced,
    },
  };
}
