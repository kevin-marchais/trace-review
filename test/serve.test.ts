import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCliArgs, UsageError } from "../scripts/lib/cli-args.mjs";
import { createGhPublisher, type GhResult } from "../scripts/lib/github-publisher.mjs";
import { ReviewStateStore, stateFileStem } from "../scripts/lib/review-state.mjs";
import {
  AskRunner,
  buildAskPrompt,
  createFakeAskProvider,
  parseAskRequest,
} from "../scripts/lib/serve-ask.mjs";
import {
  loopbackBindAddress,
  startReviewServer,
  type ReviewServer,
  type ReviewServerOptions,
} from "../scripts/lib/serve.mjs";
import { mergeReviewStates, parseServerSentEvents, readServeToken } from "../src/review-sync.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "runtime", "scripts", "trace-review.mjs");
const REVIEW_ID = "acme-widgets-pr-42-abc123";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

function reviewDirectory(t: TestContext, github = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-serve-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "spec.json"),
    JSON.stringify({
      schemaVersion: 1,
      reviewId: REVIEW_ID,
      prs: [
        {
          id: "pr-42",
          ...(github
            ? { github: { repository: "acme/widgets", pullRequest: 42, headSha: "abc123" } }
            : {}),
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "review.html"),
    "<!doctype html><html><head></head><body>Review</body></html>",
  );
  return dir;
}

async function serve(
  t: TestContext,
  dir: string,
  overrides: Partial<ReviewServerOptions> = {},
): Promise<ReviewServer> {
  const server = await startReviewServer({
    reviewDir: dir,
    specPath: path.join(dir, "spec.json"),
    htmlPath: path.join(dir, "review.html"),
    ask: new AskRunner({
      provider: createFakeAskProvider(20),
      repo: dir,
      workDir: path.join(dir, "state", "ask"),
      timeoutMs: 5_000,
    }),
    token: "test-token",
    ...overrides,
  });
  t.after(() => server.close());
  return server;
}

function call(
  server: ReviewServer,
  options: {
    method?: string;
    path?: string;
    body?: unknown;
    headers?: Record<string, string | undefined>;
  } = {},
): Promise<Reply> {
  const origin = `http://127.0.0.1:${server.port}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    host: `127.0.0.1:${server.port}`,
    "x-trace-review-token": server.token,
    ...(method !== "GET" ? { origin, "content-type": "application/json" } : {}),
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: server.port, method, path: options.path ?? "/", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {}
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
        });
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("the server only binds loopback addresses", () => {
  assert.equal(loopbackBindAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(loopbackBindAddress("localhost"), "127.0.0.1");
  assert.equal(loopbackBindAddress("::1"), "::1");
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
    assert.throws(() => loopbackBindAddress(host), /only listens on/);
  }
});

test("requests with a wrong host, origin, token, or content type are rejected", async (t) => {
  const server = await serve(t, reviewDirectory(t));
  const state = { baseRevision: 0, state: {} };

  const page = await call(server);
  assert.equal(page.status, 200);
  assert.match(page.text, /<meta name="trace-review-serve" content="1">/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal((await call(server, { headers: { host: "localhost:" + server.port } })).status, 200);

  const rebound = await call(server, { path: "/api/session", headers: { host: "evil.example" } });
  assert.equal(rebound.status, 403);
  assert.equal(
    (await call(server, { headers: { host: "evil.example:" + server.port } })).status,
    403,
  );

  const missing = await call(server, {
    path: "/api/session",
    headers: { "x-trace-review-token": undefined },
  });
  assert.equal(missing.status, 401);
  const wrong = await call(server, {
    path: "/api/state",
    headers: { "x-trace-review-token": "nope" },
  });
  assert.equal(wrong.status, 401);

  const foreign = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { origin: "https://evil.example" },
  });
  assert.equal(foreign.status, 403);
  const noOrigin = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { origin: undefined },
  });
  assert.equal(noOrigin.status, 403);
  const crossSite = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  const form = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: state,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(form.status, 415);
  const text = await call(server, {
    method: "POST",
    path: "/api/ask",
    body: {},
    headers: { "content-type": "text/plain" },
  });
  assert.equal(text.status, 415);

  const session = await call(server, { path: "/api/session" });
  assert.equal(session.status, 200);
  assert.equal(session.json.reviewId, REVIEW_ID);
  assert.equal(session.json.provider, "fake");
});

test("state round-trips with revisions and conflicts answer 409", async (t) => {
  const dir = reviewDirectory(t);
  const server = await serve(t, dir);
  const initial = await call(server, { path: "/api/state" });
  assert.equal(initial.json.revision, 0);

  const first = {
    general: { "pr-42": "Looks good overall." },
    lines: {
      "pr-42\0src/a.ts\x0012": { pr: "pr-42", file: "src/a.ts", key: "12", text: "Rename this." },
    },
  };
  const saved = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: {
      baseRevision: 0,
      state: first,
      feedback: { markdown: "# Review\n\n- **L12** — Rename this.", items: [] },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.revision, 1);
  const loaded = await call(server, { path: "/api/state" });
  assert.deepEqual(loaded.json.state, first);
  assert.equal(loaded.json.revision, 1);

  const stale = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: { baseRevision: 0, state: { general: { "pr-42": "Overwrite" } } },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.revision, 1);
  assert.deepEqual(stale.json.state, first);

  const files = new ReviewStateStore(path.join(dir, "state")).files(REVIEW_ID);
  const document = JSON.parse(fs.readFileSync(files.state, "utf8"));
  assert.equal(document.revision, 1);
  assert.match(fs.readFileSync(files.feedback, "utf8"), /Rename this/);
  assert.deepEqual(
    fs.readdirSync(path.dirname(files.state)).filter((name) => name.endsWith(".tmp")),
    [],
    "atomic writes leave no temporary files",
  );
  const feedback = await call(server, { path: "/api/feedback" });
  assert.equal(feedback.json.revision, 1);
  assert.match(String(feedback.json.markdown), /Rename this/);

  const cleared = await call(server, {
    method: "POST",
    path: "/api/state/clear",
    body: { baseRevision: 1 },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await call(server, { path: "/api/state" })).json.state, {});
});

test("pasted images are stored as files, never inline in the state", async (t) => {
  const dir = reviewDirectory(t);
  const server = await serve(t, dir);
  const uploaded = await call(server, {
    method: "POST",
    path: "/api/attachments",
    body: {
      name: "shot.png",
      type: "image/png",
      data: `data:image/png;base64,${PNG.toString("base64")}`,
    },
  });
  assert.equal(uploaded.status, 201);
  const file = String(uploaded.json.file);
  assert.match(file, /^[a-f0-9]{24}\.png$/);
  const stored = path.join(dir, "state", stateFileStem(REVIEW_ID), "attachments", file);
  assert.deepEqual(fs.readFileSync(stored), PNG);

  const image = await call(server, { path: `/api/attachments/${file}` });
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal((await call(server, { path: "/api/attachments/..%2Fspec.json" })).status, 404);

  const svg = await call(server, {
    method: "POST",
    path: "/api/attachments",
    body: { name: "x.svg", type: "image/svg+xml", data: "PHN2Zy8+" },
  });
  assert.equal(svg.status, 400);

  const inline = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: {
      baseRevision: 0,
      state: {
        attachments: { a: [{ name: "x", type: "image/png", data: "data:image/png;base64,AA" }] },
      },
    },
  });
  assert.equal(inline.status, 400);
  const referenced = await call(server, {
    method: "PUT",
    path: "/api/state",
    body: {
      baseRevision: 0,
      state: { attachments: { a: [{ name: "x", type: "image/png", file }] } },
    },
  });
  assert.equal(referenced.status, 200);
  const raw = fs.readFileSync(path.join(dir, "state", `${stateFileStem(REVIEW_ID)}.json`), "utf8");
  assert.doesNotMatch(raw, /base64/);
});

test("feedback prints the reviewer comments for the agent", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-feedback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ReviewStateStore(path.join(dir, "state"));
  store.write("older-review", {
    baseRevision: 0,
    state: { general: { local: "old" } },
    feedback: { markdown: "# Older review", items: [] },
  });
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(store.files("older-review").state, new Date(0), new Date(0));
  store.write(REVIEW_ID, {
    baseRevision: 0,
    state: { general: { "pr-42": "Ship it after the rename." } },
    feedback: {
      markdown: "# Review: widgets\n\n**My overall:** Ship it after the rename.",
      items: [{ kind: "general", pr: "pr-42", text: "Ship it after the rename." }],
    },
  });
  fs.utimesSync(store.files(REVIEW_ID).state, later, later);

  const latest = spawnSync(process.execPath, [cli, "feedback", "--latest", "--dir", dir], {
    encoding: "utf8",
  });
  assert.equal(latest.status, 0, latest.stderr);
  assert.match(latest.stdout, new RegExp(`Review ${REVIEW_ID} · revision 1`));
  assert.match(latest.stdout, /\*\*My overall:\*\* Ship it after the rename\./);

  const json = spawnSync(process.execPath, [cli, "feedback", REVIEW_ID, "--json", "--dir", dir], {
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.reviewId, REVIEW_ID);
  assert.deepEqual(report.items, [
    { kind: "general", pr: "pr-42", text: "Ship it after the rename." },
  ]);

  const older = spawnSync(process.execPath, [cli, "feedback", "older-review", "--dir", dir], {
    encoding: "utf8",
  });
  assert.match(older.stdout, /# Older review/);
  const missing = spawnSync(process.execPath, [cli, "feedback", "--dir", path.join(dir, "none")], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No served review state/);
});

function nextEvent(server: ReviewServer, name: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name} event`)), 10_000);
    const request = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/api/events",
        headers: { host: `127.0.0.1:${server.port}`, "x-trace-review-token": server.token },
      },
      (response) => {
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const parsed = parseServerSentEvents(buffer);
          buffer = parsed.rest;
          const event = parsed.events.find((candidate) => candidate.event === name);
          if (event) {
            clearTimeout(timer);
            request.destroy();
            resolve(event.data);
          }
        });
      },
    );
    request.on("error", () => {});
    request.end();
  });
}

test("a rewritten result file rebuilds the page and sends a reload event", async (t) => {
  const dir = reviewDirectory(t);
  const result = path.join(dir, "lm", "result.json");
  fs.mkdirSync(path.dirname(result), { recursive: true });
  fs.writeFileSync(result, '{"summary":"first"}');
  const rebuilt: string[][] = [];
  const server = await serve(t, dir, {
    watch: {
      files: [result, path.join(dir, "spec.json")],
      pollMs: 25,
      debounceMs: 50,
      async rebuild(changed) {
        rebuilt.push(changed.map((file) => path.basename(file)));
        fs.writeFileSync(
          path.join(dir, "review.html"),
          "<html><head></head><body>Rebuilt</body></html>",
        );
        return {};
      },
    },
  });
  const reload = nextEvent(server, "reload");
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(result, '{"summary":"second"}');
  assert.deepEqual(await reload, { reviewId: REVIEW_ID });
  assert.deepEqual(rebuilt, [["result.json"]]);
  assert.match((await call(server)).text, /Rebuilt/);

  // Touching a file without changing it does not rebuild.
  const now = new Date();
  fs.utimesSync(result, now, now);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(rebuilt.length, 1);
});

test("ask runs one provider request at a time and returns the answer", async (t) => {
  const dir = reviewDirectory(t);
  const server = await serve(t, dir);
  const body = {
    action: "fix",
    question: "",
    file: "src/a.ts",
    side: "new",
    rows: [
      { line: "11", kind: "ctx", code: "const a = 1;" },
      { line: "12", kind: "add", code: "const b = a + 1;" },
    ],
  };
  const started = await call(server, { method: "POST", path: "/api/ask", body });
  assert.equal(started.status, 202);
  const busy = await call(server, { method: "POST", path: "/api/ask", body });
  assert.equal(busy.status, 429);

  let job = started.json;
  for (let attempt = 0; job.status === "pending" && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = (await call(server, { path: `/api/ask/${String(started.json.id)}` })).json;
  }
  assert.equal(job.status, "done");
  assert.equal(job.provider, "fake");
  assert.equal(job.suggestion, "const a = 1; // reviewed\nconst b = a + 1; // reviewed");

  const invalid = await call(server, {
    method: "POST",
    path: "/api/ask",
    body: { ...body, action: "ask", question: " " },
  });
  assert.equal(invalid.status, 400);

  const offline = await serve(t, dir, {
    token: "other",
    ask: new AskRunner({ provider: null, repo: dir, workDir: dir, timeoutMs: 1_000 }),
  });
  const unavailable = await call(offline, { method: "POST", path: "/api/ask", body });
  assert.equal(unavailable.status, 503);
});

test("ask prompts carry the file, numbered rows, finding, and question", () => {
  const request = parseAskRequest({
    action: "ask",
    question: "Can this overflow?",
    file: "src/a.ts",
    side: "new",
    rows: [{ line: "12", kind: "add", code: "total += price * quantity;" }],
    finding: { severity: "concern", body: "Overflow risk.", rationale: "Unbounded." },
  });
  assert.equal(typeof request, "object");
  const prompt = buildAskPrompt(request as Exclude<typeof request, string>);
  assert.match(prompt, /File: src\/a\.ts \(new side\)/);
  assert.ok(prompt.includes("   12 |+total += price * quantity;"));
  assert.match(prompt, /Finding \(concern\): Overflow risk\./);
  assert.match(prompt, /Reviewer question: Can this overflow\?/);
  assert.match(prompt, /must not modify anything/);
  assert.equal(
    parseAskRequest({ action: "delete", file: "a", rows: [{}] }),
    "action must be ask, explain, or fix.",
  );
});

test("publishing goes through gh after an explicit confirmation", async (t) => {
  const dir = reviewDirectory(t, true);
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  let head = "abc123";
  const run = (args: readonly string[], input?: string): GhResult => {
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    if (args[0] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (args.includes("POST")) {
      return {
        status: 0,
        stdout: "https://github.com/acme/widgets/pull/42#pullrequestreview-7\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: `${head}\n`, stderr: "" };
  };
  const server = await serve(t, dir, { publisher: createGhPublisher(run) });
  const plan = {
    schemaVersion: 1,
    target: {
      repository: "acme/widgets",
      pullRequest: 42,
      headSha: "abc123",
      url: "https://github.com/acme/widgets/pull/42",
    },
    summary: "Approved with one note.",
    nativeComments: [{ path: "src/a.ts", body: "Nice.", side: "RIGHT", line: 3 }],
    fallbackComments: [],
  };

  const unconfirmed = await call(server, { method: "POST", path: "/api/publish", body: { plan } });
  assert.equal(unconfirmed.status, 400);
  const elsewhere = await call(server, {
    method: "POST",
    path: "/api/publish",
    body: { plan: { ...plan, target: { ...plan.target, pullRequest: 7 } }, confirm: true },
  });
  assert.equal(elsewhere.status, 400);
  assert.equal(calls.length, 0, "nothing reaches gh before the checks pass");

  const published = await call(server, {
    method: "POST",
    path: "/api/publish",
    body: { plan, event: "APPROVE", confirm: true },
  });
  assert.equal(published.status, 200, published.text);
  assert.equal(published.json.url, "https://github.com/acme/widgets/pull/42#pullrequestreview-7");
  const post = calls.find((entry) => entry.args.includes("POST"));
  const request = JSON.parse(post?.input || "{}");
  assert.equal(request.event, "APPROVE");
  assert.equal(request.commit_id, "abc123");
  assert.equal(request.comments[0].path, "src/a.ts");
  assert.doesNotMatch(published.text, /token/i);

  head = "def456";
  const stale = await call(server, {
    method: "POST",
    path: "/api/publish",
    body: { plan, event: "COMMENT", confirm: true },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale-head");
});

test("served pages merge concurrent edits and detect the server only over http", () => {
  const base = { lines: { a: { text: "one" } }, viewed: {} };
  const remote = { lines: { a: { text: "one" }, b: { text: "from another tab" } }, viewed: {} };
  const local = { lines: { a: { text: "edited here" } }, viewed: { f: true } };
  const { merged, remoteChanged } = mergeReviewStates(remote, base, local);
  assert.deepEqual(merged, {
    lines: { a: { text: "edited here" }, b: { text: "from another tab" } },
    viewed: { f: true },
  });
  assert.equal(remoteChanged, true);
  const deleted = mergeReviewStates(remote, remote, { lines: { a: { text: "one" } }, viewed: {} });
  assert.deepEqual(deleted.merged.lines, { a: { text: "one" } });

  const { events, rest } = parseServerSentEvents(
    'retry: 2000\nevent: hello\ndata: {"reviewId":"x"}\n\n: ping\n\nevent: reload\ndata: {"reviewId":"y"}\n\nevent: par',
  );
  assert.deepEqual(events, [
    { event: "hello", data: { reviewId: "x" } },
    { event: "reload", data: { reviewId: "y" } },
  ]);
  assert.equal(rest, "event: par");

  const storage = new Map<string, string>();
  const sessionStore = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  };
  const page = { pathname: "/", search: "", hash: "" };
  assert.equal(
    readServeToken({ ...page, protocol: "file:", hash: "#token=x" }, sessionStore),
    null,
  );
  let replaced = "";
  assert.equal(
    readServeToken({ ...page, protocol: "http:", hash: "#token=abc%2B1" }, sessionStore, (url) => {
      replaced = url;
    }),
    "abc+1",
  );
  assert.equal(replaced, "/");
  assert.equal(readServeToken({ ...page, protocol: "http:" }, sessionStore), "abc+1");
});

test("serve and feedback parse like the review command", () => {
  const serveArgs = parseCliArgs(["serve", "main..feature", "--lm", "--port", "8123"], "/repo");
  assert.equal(serveArgs.command, "review");
  assert.equal(serveArgs.serve, true);
  assert.equal(serveArgs.port, 8123);
  assert.deepEqual(serveArgs.revisions, ["main..feature"]);
  assert.equal(serveArgs.mode, "lm-analysis");
  assert.equal(parseCliArgs(["pr", "42", "--serve"], "/repo").serve, true);
  assert.equal(parseCliArgs([], "/repo").serve, false);

  const latest = parseCliArgs(["feedback", "--latest", "--json"], "/repo");
  assert.equal(latest.command, "feedback");
  assert.equal(latest.reviewId, undefined);
  assert.equal(latest.json, true);
  assert.equal(parseCliArgs(["feedback", "abc"], "/repo").reviewId, "abc");
  assert.throws(() => parseCliArgs(["feedback", "abc", "--latest"], "/repo"), UsageError);
  assert.throws(() => parseCliArgs(["serve", "--port", "70000"], "/repo"), UsageError);
  assert.throws(() => parseCliArgs(["finish", "--serve"], "/repo"), UsageError);
});
