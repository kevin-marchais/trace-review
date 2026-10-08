import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

test("CLI writes validated local context and patch files", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-context-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.js"), "const value = 1;\n");
  git(repo, "add", "app.js");
  git(
    repo,
    "-c",
    "user.name=Trace Review Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  fs.writeFileSync(path.join(repo, "app.js"), "const value = 2;\n");

  const out = path.join(repo, "facts", "context.json");
  const diffOut = path.join(repo, "facts", "changes.patch");
  execFileSync(
    process.execPath,
    [
      path.join(root, "dist", "runtime", "scripts", "collect-pr-context.mjs"),
      "--repo",
      repo,
      "--pr",
      "none",
      "--base",
      "HEAD",
      "--out",
      out,
      "--diff-out",
      diffOut,
    ],
    { encoding: "utf8" },
  );

  const context = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(context.source, "local");
  assert.deepEqual(context.diff, {
    path: "changes.patch",
    source: "local",
    bytes: fs.statSync(diffOut).size,
  });
  assert.equal(context.preflight.totals.files, 1);
  assert.equal(context.validation.valid, true);
  assert.deepEqual(context.fileContents, { path: "context.files.json" });
  const fullFiles = JSON.parse(
    fs.readFileSync(path.join(repo, "facts", "context.files.json"), "utf8"),
  );
  assert.equal(fullFiles.files[0].path, "app.js");
  assert.equal(fullFiles.files[0].revision, "head");
  assert.equal(fullFiles.files[0].content, "const value = 2;\n");
  assert.match(fs.readFileSync(diffOut, "utf8"), /diff --git a\/app\.js b\/app\.js/);
});

const collector = path.join(root, "dist", "runtime", "scripts", "collect-pr-context.mjs");

function commitAll(repo, message) {
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Trace Review Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "-m",
    message,
  );
}

function collect(repo, ...args) {
  const out = path.join(repo, ".facts", "context.json");
  execFileSync(process.execPath, [collector, "--repo", repo, "--out", out, ...args], {
    encoding: "utf8",
  });
  return {
    context: JSON.parse(fs.readFileSync(out, "utf8")),
    patch: fs.readFileSync(path.join(repo, ".facts", "context.patch"), "utf8"),
    files: JSON.parse(fs.readFileSync(path.join(repo, ".facts", "context.files.json"), "utf8")),
  };
}

test("the default local base is the merge-base, not the base branch tip", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-merge-base-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".facts/\n");
  fs.writeFileSync(path.join(repo, "feature.txt"), "one\n");
  fs.writeFileSync(path.join(repo, "main.txt"), "one\n");
  commitAll(repo, "initial");
  const forkPoint = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "feature.txt"), "two\n");
  commitAll(repo, "feature work");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "main.txt"), "advanced\n");
  commitAll(repo, "main moves on");
  git(repo, "update-ref", "refs/remotes/origin/main", "main");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(repo, "checkout", "-q", "feature");

  const { context, patch } = collect(repo, "--pr", "none");

  assert.equal(context.git.baseRef, "origin/main");
  assert.equal(context.git.baseSha, forkPoint);
  assert.deepEqual(
    context.preflight.files.map((file) => file.path),
    ["feature.txt"],
  );
  assert.doesNotMatch(patch, /main\.txt/);
});

test("user diff configuration cannot change the collected patch format", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-config-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".facts/\n");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "café.txt"), "old\n");
  fs.writeFileSync(path.join(repo, "src", "plain.txt"), "old\n");
  commitAll(repo, "initial");
  git(repo, "config", "diff.noprefix", "true");
  git(repo, "config", "diff.mnemonicPrefix", "true");
  git(repo, "config", "color.diff", "always");
  git(repo, "config", "color.ui", "always");
  git(repo, "config", "diff.relative", "true");
  fs.writeFileSync(path.join(repo, "src", "café.txt"), "new\n");
  fs.writeFileSync(path.join(repo, "src", "plain.txt"), "new\n");

  const { context, patch, files } = collect(repo, "--pr", "none", "--base", "HEAD");

  assert.equal(patch.includes("\u001b["), false);
  assert.match(patch, /^diff --git a\/src\/café\.txt b\/src\/café\.txt$/m);
  assert.equal(context.validation.valid, true);
  assert.deepEqual(
    context.preflight.files.map((file) => file.path),
    ["src/café.txt", "src/plain.txt"],
  );
  assert.deepEqual(
    files.files.map((file) => [file.path, file.content]),
    [
      ["src/café.txt", "new\n"],
      ["src/plain.txt", "new\n"],
    ],
  );
});

test("an option without its value reports a usage error", () => {
  const result = spawnSync(process.execPath, [collector, "--repo"], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--repo requires a value/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});
