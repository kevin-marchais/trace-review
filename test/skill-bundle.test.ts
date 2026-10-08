import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSkillBundle,
  listZipEntries,
  readZipEntries,
  SKILL_BUNDLE_FILES,
  SKILL_BUNDLE_RUNTIME_FILES,
  stageSkillDistribution,
} from "../scripts/lib/skill-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp", ".zip"]);

function expectedDistributionData(file: string): Buffer {
  return binaryExtensions.has(path.extname(file).toLowerCase())
    ? fs.readFileSync(file)
    : Buffer.from(fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n"));
}

test("release skill distribution is staged outside the source tree", (t) => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-stage-test-"));
  t.after(() => fs.rmSync(stageRoot, { recursive: true, force: true }));

  assert.deepEqual(stageSkillDistribution({ root, skillRoot: stageRoot }), [...SKILL_BUNDLE_FILES]);
  assert.ok(fs.existsSync(path.join(stageRoot, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(stageRoot, "scripts", "trace-review.mjs")));
});

test("skill documents composable LM and pull-request shortcuts", () => {
  const skill = fs.readFileSync(path.join(root, "SKILL.source.md"), "utf8");

  assert.match(skill, /\| `lm`, `ai`, "with findings" \| add `--lm` \|/);
  assert.match(skill, /`pr 8`, `pr #8`, a PR URL \| `trace-review\.mjs pr 8`/);
  assert.match(skill, /`lm pr 8`, `pr 8 ai`, `pr #8 lm` \| `trace-review\.mjs pr 8 --lm`/);
  assert.match(skill, /"deep audit" \(explicit request only\) \| add `--deep-audit`/);
  assert.match(skill, /trace-review\.mjs pr 8 --lm --llm none/);
  assert.match(skill, /trace-review\.mjs finish/);
  assert.match(skill, /do not call `git`, `gh`, or the lower-level scripts/);
  assert.match(skill, /write `\.review\/lm\/result\.json`/);
  assert.ok(Buffer.byteLength(skill) < 9_000, "the skill stays near 2k tokens");
});

test("skill examples use the result contract consistently", () => {
  const skill = fs.readFileSync(path.join(root, "SKILL.source.md"), "utf8");
  assert.doesNotMatch(skill, /"comments":/);
  assert.doesNotMatch(skill, /Default `comment`/);
  assert.match(skill, /"findings": \[/);
});

test("skill preserves the user's language and marks code in generated review prose", () => {
  const skill = fs.readFileSync(path.join(root, "SKILL.source.md"), "utf8");

  assert.match(skill, /same language as the user's request/i);
  assert.match(skill, /preserve its Unicode spelling, including diacritics\s+and apostrophes/i);
  assert.match(skill, /wrap every\s+code identifier, symbol, command, and literal in backticks/i);
});

test("minimal skill bundle is complete, runnable, and excludes repository-only files", (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-bundle-test-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const result = buildSkillBundle({ root, outDir });
  const archive = fs.readFileSync(result.archive);
  const expected = SKILL_BUNDLE_FILES.map((file) => `trace-review/${file}`).sort();
  const entries = readZipEntries(archive);

  assert.deepEqual(listZipEntries(archive).sort(), expected);
  for (const relativePath of SKILL_BUNDLE_FILES) {
    const sourceRoot = SKILL_BUNDLE_RUNTIME_FILES.includes(
      relativePath as (typeof SKILL_BUNDLE_RUNTIME_FILES)[number],
    )
      ? path.join(root, "dist", "runtime")
      : root;
    const sourcePath =
      relativePath === "SKILL.md"
        ? path.join(root, "SKILL.source.md")
        : path.join(sourceRoot, relativePath);
    assert.deepEqual(
      entries.get(`trace-review/${relativePath}`),
      expectedDistributionData(sourcePath),
      `${relativePath} should round-trip through the archive`,
    );
  }
  assert.ok(archive.length > 0);
  for (const excluded of [
    "README.md",
    "package.json",
    "docs/assets/review-interface.png",
    "docs/assets/review-interface-dark.png",
    "test/build-review.test.ts",
    "scripts/build-skill-bundle.mts",
    "scripts/lib/skill-bundle.mts",
  ]) {
    assert.ok(
      !expected.includes(`trace-review/${excluded}`),
      `${excluded} must stay out of the bundle`,
    );
  }
});
