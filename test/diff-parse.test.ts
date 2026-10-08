import assert from "node:assert/strict";
import test from "node:test";
import { decodeGitPath, parseDiffPaths, parseUnifiedDiff } from "../scripts/lib/diff-parse.mjs";

test("content lines that look like ---/+++ headers stay inside the hunk", () => {
  const patch = [
    "diff --git a/query.sql b/query.sql",
    "index 1111111..2222222 100644",
    "--- a/query.sql",
    "+++ b/query.sql",
    "@@ -1,3 +1,3 @@",
    " select 1;",
    "--- comment",
    "+++ b;",
    " select 2;",
    "",
  ].join("\n");

  const [file] = parseUnifiedDiff(patch);

  assert.equal(file.path, "query.sql");
  assert.equal(file.oldPath, "query.sql");
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.deepEqual(
    file.hunks[0].lines.map((line) => [line.kind, line.text, line.oldNo, line.newNo]),
    [
      ["ctx", "select 1;", 1, 1],
      ["del", "-- comment", 2, undefined],
      ["add", "++ b;", undefined, 2],
      ["ctx", "select 2;", 3, 3],
    ],
  );
});

test("quoted non-ASCII paths are decoded in headers and markers", () => {
  assert.equal(decodeGitPath('"caf\\303\\251.txt"'), "café.txt");
  assert.deepEqual(parseDiffPaths('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"'), {
    oldPath: "café.txt",
    path: "café.txt",
  });
  const [file] = parseUnifiedDiff(
    [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
  );
  assert.equal(file.path, "café.txt");
  assert.equal(file.oldPath, "café.txt");
});

test("rename and marker lines are authoritative for paths containing ' b/'", () => {
  const [renamed, modified] = parseUnifiedDiff(
    [
      "diff --git a/x b/y.txt b/z b/w.txt",
      "similarity index 90%",
      "rename from x b/y.txt",
      "rename to z b/w.txt",
      "--- a/x b/y.txt",
      "+++ b/z b/w.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/dir b/file.txt b/dir b/file.txt",
      "--- a/dir b/file.txt\t",
      "+++ b/dir b/file.txt\t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n"),
  );

  assert.equal(renamed.oldPath, "x b/y.txt");
  assert.equal(renamed.path, "z b/w.txt");
  assert.equal(renamed.renamed, true);
  assert.equal(modified.oldPath, "dir b/file.txt");
  assert.equal(modified.path, "dir b/file.txt");
  assert.equal(modified.renamed, false);
});

test("binary, mode, new, deleted, copy, and no-newline sections are recognised", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+fresh",
      "\\ No newline at end of file",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/src.txt b/copy.txt",
      "similarity index 100%",
      "copy from src.txt",
      "copy to copy.txt",
    ].join("\n"),
  );

  assert.deepEqual(
    files.map((file) => [file.path, file.binary, file.isNew, file.isDeleted, file.renamed]),
    [
      ["logo.png", true, false, false, false],
      ["run.sh", false, false, false, false],
      ["new.txt", false, true, false, false],
      ["old.txt", false, false, true, false],
      ["copy.txt", false, false, false, false],
    ],
  );
  assert.equal(files[1].oldMode, "100644");
  assert.equal(files[1].newMode, "100755");
  assert.equal(files[2].oldPath, "new.txt");
  assert.equal(files[2].hunks[0].lines[0].noNewlineAtEnd, true);
  assert.equal(files[3].path, "old.txt");
  assert.equal(files[4].copied, true);
  assert.equal(files[4].oldPath, "src.txt");
});

test("lines split on LF only so bare CR and CRLF content are preserved", () => {
  const [file] = parseUnifiedDiff(
    [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      "-one\r",
      "-two\rthree",
      "+one",
      "+two\rthree",
    ].join("\n"),
  );

  assert.deepEqual(
    file.hunks[0].lines.map((line) => line.text),
    ["one\r", "two\rthree", "one", "two\rthree"],
  );
});

test("a plain unified diff without a git header is still parsed", () => {
  const [file] = parseUnifiedDiff(
    "--- a/x.txt\t2026-01-01 00:00:00\n+++ b/x.txt\t2026-01-02 00:00:00\n@@ -1 +1 @@\n-a\n+b\n",
  );
  assert.equal(file.gitHeader, false);
  assert.equal(file.path, "x.txt");
  assert.equal(file.additions, 1);
});
