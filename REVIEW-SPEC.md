# Review specification schema v1

Every generated review is driven by a validated JSON specification. Version 1
uses two required top-level fields:

When `generated` is omitted, the header shows the local generation date and
time as `YYYY-MM-DD HH:mm`. An explicit `generated` string is displayed
unchanged.

- `schemaVersion`: always `1`.
- `mode`: one of `workspace`, `lm-analysis`, or `deep-audit`.

The portable JSON Schema is
[`schemas/review-spec.v1.schema.json`](schemas/review-spec.v1.schema.json).
The dependency-free runtime validator adds repository-aware checks and
human-oriented diagnostics.

## Modes

| Mode | When to use it | LM contract |
|---|---|---|
| `workspace` | Default. The reviewer inspects the facts and writes their own comments. | `prs[].review` is forbidden. |
| `lm-analysis` | The user explicitly asks for language-model findings. | Every PR has a `review` object; `comments` may be empty. |
| `deep-audit` | The user explicitly requests a deep audit, or accepts it for a high-risk change. | Same rendered contract as LM analysis, but the producing agent performs broader dependency, failure-mode, and test analysis. |

Deep audit is deliberately not selected automatically by the generator.
Choosing it changes the analysis workflow, not the meaning of a finding.

## Model result (`review-result.v1`)

A language model, or an agent using `--llm none`, writes one result that
`finish` validates before it generates the spec. Its contract is
[`schemas/review-result.v1.schema.json`](schemas/review-result.v1.schema.json);
the per-run copy in `.review/lm/result.schema.json` also fixes the mode and the
finding budget. Validation applies the schema first, then the semantic rules
below, and reports a list of diagnostics, each with `code`, JSON `path`,
`message`, and usually a `hint`.

- `summary` (Markdown) and a non-empty `groups` array are required.
- Each group needs `title`, `intent`, `risk`, `confidence`, `evidence`,
  `reviewerChecks`, and `titleEvidence`, plus at least one of `from` and
  `changeIds`. `from` lists deterministic candidate group IDs (`g1`, `g2`, …)
  whose changes all join the group; `changeIds` lists single change IDs and
  moves them even when their candidate group is referenced elsewhere. A change
  assigned nowhere is placed in its candidate group and recorded under
  `placement.autoPlaced` in `groups.json`. The older form that lists every
  change in `changeIds` remains valid.
- Titles must be unique and change-specific; `titleEvidence.changeIds` must
  belong to the group; repeated-pattern units stay together in a group of
  their own; `readAfter` names other group titles and must not form a cycle.
- Workspace results omit `review`. LM-analysis and deep-audit results require
  `review: { verdict, global, findings }`.
- A finding is anchored either by `row`, a row ID from the patch such as
  `src/a.ts#h0:a12` (added new line 12) or `src/a.ts#h0:d7` (removed old line
  7), or by `file` plus `line`. Anchors are checked against the rows the diff
  actually shows: added, removed, and context lines. A line that only falls
  inside a change unit's coarse range is rejected.

`finish` converts findings to the spec's `review.comments` (always `file` plus
`line`). The result calls them `findings`; the spec calls them `comments`.

Adaptive detector rules have their own contract,
[`schemas/detector-rules.v1.schema.json`](schemas/detector-rules.v1.schema.json),
described in [docs/ADAPTIVE-DETECTORS.md](docs/ADAPTIVE-DETECTORS.md).

## Required structure

```json
{
  "schemaVersion": 1,
  "mode": "workspace",
  "title": "Review: harden authentication",
  "reviewId": "harden-authentication",
  "prs": [
    {
      "title": "Reject incomplete credentials",
      "diffFile": "changes.patch",
      "fileContentsFile": "context.files.json",
      "groupFile": "groups.json"
    }
  ]
}
```

`prs` must be non-empty. Each entry requires `title` and exactly one of
`diffFile` or `diff`. Relative files are resolved from the specification file.
An optional `fileContentsFile` points to the collector's bounded text bundle
and enables the per-file whole-file viewer. Deleted entries contain their base
version; binary, oversized, or unavailable entries carry an explanation
instead of content. SVG entries offer a sanitized Image view alongside their
exact Code view.
Reviewer-facing skill output uses a finalized `groupFile` (or embedded
`changeGroups`). Model-authored grouping has `provenance: "lm"` and may show a
suggested reading order and dependency cues. Quick workspace grouping has
`provenance: "deterministic"` and preserves classifier order without presenting
it as a recommendation. Group files are resolved relative to the specification
and revalidated against the patch when the review is built. `autoGroups: true`
and the legacy file-level `groups` array remain low-level compatibility inputs
for direct builder users; they are not the skill's review-generation workflow
and may expose deterministic or hand-authored labels.
PR ids and group ids must be unique.

### Field reference

| Field | Where | Meaning |
|-------|-------|---------|
| `schemaVersion` | top | Required. Always `1`; unknown versions are rejected. |
| `mode` | top | Required. `workspace`, `lm-analysis`, or `deep-audit`. |
| `title` | top | Document title (default `Code Review`). |
| `reviewId` | top | localStorage key for comments (default: slug of title). Keep stable. |
| `generated` | top | Free-text date/context line (default: local generation date and time). |
| `prs[].title` | per PR | Tab label and summary heading. |
| `prs[].url` | per PR | Optional link to the PR or branch. |
| `prs[].github` | per PR | Optional publication target: `{ repository, pullRequest, headSha }`. |
| `prs[].summary` | per PR | Markdown. Ignored if `blocks` is set. |
| `prs[].diagrams[]` | per PR | `{ title?, svgFile\|svg\|mermaid }`. Ignored if `blocks` is set. |
| `prs[].blocks[]` | per PR | Summary blocks; see [docs/REVIEW-INTERFACE.md](docs/REVIEW-INTERFACE.md). |
| `prs[].diffFile` | per PR | Path to a unified-diff file (relative to the spec). |
| `prs[].diff` | per PR | Inline unified-diff string (alternative to `diffFile`). |
| `prs[].fileContentsFile` | per PR | Bounded whole-file bundle for the file viewer. |
| `prs[].groupFile` | per PR | Finalized grouping fact pack (relative to the spec). |
| `prs[].changeGroups` | per PR | Inline grouping fact pack. |
| `prs[].autoGroups` | per PR | Detect and validate groups while building. |
| `prs[].groups` | per PR | Legacy file-level groups: `[{ id, title, kind?, note?, collapsed?, files[] }]`. |
| `prs[].review` | per PR | Required in `lm-analysis` and `deep-audit`: `{ verdict?, global?, comments[] }`. Forbidden in `workspace`. |

One PR renders without tabs; two or more get a tab bar with per-PR comment
counts.

## Optional GitHub publication context

A PR collected from GitHub may include the validated publication target:

```json
{
  "github": {
    "repository": "acme/widgets",
    "pullRequest": 42,
    "headSha": "abc123"
  }
}
```

All three fields are required when `github` is present. The generated review
uses them to prepare a structured publication plan. The packaged publisher
checks GitHub CLI authentication and compares `headSha` with the live PR before
showing its confirmation prompt and submitting one review. Local-only reviews
omit this object and retain Markdown copy/download.

Workspace specs cannot contain `review`. LM-analysis and deep-audit specs
require one per PR:

```json
{
  "verdict": "comment",
  "global": "The change is coherent, with one edge case to resolve.",
  "comments": [
    {
      "file": "src/auth.js",
      "line": 42,
      "severity": "concern",
      "body": "The null path reaches this dereference.",
      "confidence": 0.94,
      "rationale": "The preceding branch permits null and this line dereferences it.",
      "options": ["Add a null guard", "Keep the current precondition"],
      "suggestedChange": "if (!session) return null;"
    }
  ]
}
```

Removed-line anchors use `o` plus the old line number, such as `"o7"`.
Severity is `nit`, `suggestion`, `concern`, `question`, `praise`, or `comment`.
Every finding requires numeric `confidence` between 0 and 1 and a concise,
verifiable `rationale`. Focused analysis also requires two to four short,
finding-specific response `options`; `suggestedChange` is optional and contains
a concrete replacement when one is justified. Reviewers may select one option
and Reply independently. Focused analysis also enforces the fact-derived budget
written by `prepare` (`analysis-input.json`, `findingContract.maxFindings`).

## Validation

Validate without generating HTML:

```bash
bun run validate -- --spec .review/spec.json
```

Add `--json` for machine-readable diagnostics. Generation runs the same
validator and stops before writing output when the specification is invalid.
Each diagnostic includes a stable code, JSON path, explanation, and—where
useful—a corrective hint. Unknown schema versions are rejected.
