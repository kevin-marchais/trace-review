import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createReviewData,
  ensureFingerprints,
  rowKey,
  sha256Hex,
  type EmbeddedReviewData,
} from "../src/review-data.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

test("the browser SHA-256 matches Node for ASCII, Unicode, and block boundaries", () => {
  for (const value of [
    "",
    "abc",
    "é → 漢字 🙂",
    "x".repeat(55),
    "y".repeat(56),
    "z".repeat(1000),
  ]) {
    assert.equal(sha256Hex(value), sha(value), JSON.stringify(value.slice(0, 12)));
  }
});

const data: EmbeddedReviewData = {
  files: [
    {
      reviewTarget: "pr-1",
      path: "src/a.js",
      oldPath: "src/a.js",
      add: 2,
      del: 1,
      lang: "javascript",
      fullFile: { revision: "head", content: "one\ntwo\n" },
      hunks: [
        {
          header: "function a()",
          o: 10,
          n: 20,
          rows: [" keep", "-old", "+new", "+extra", " tail"],
          w: { "1": [0, 3], "2": [0, 3] },
        },
      ],
    },
  ],
  views: {
    whole: { f: 0 },
    filtered: { f: 0, h: [[0, 0, 2, 3, 5]] },
  },
};

test("rows decode with implied line numbers and views share stored rows", () => {
  const store = createReviewData(data);
  const whole = store.view("whole");
  const filtered = store.view("filtered");
  assert.ok(whole && filtered);
  assert.deepEqual(
    whole.hunks[0].rows.map((row) => [row.t, row.c, row.o, row.n]),
    [
      ["c", "keep", 10, 20],
      ["d", "old", 11, undefined],
      ["a", "new", undefined, 21],
      ["a", "extra", undefined, 22],
      ["c", "tail", 12, 23],
    ],
  );
  assert.deepEqual(whole.hunks[0].rows[1].w, [0, 3]);
  assert.deepEqual(whole.hunks[0].rows.map(rowKey), ["20", "o11", "21", "22", "23"]);
  assert.deepEqual(
    filtered.hunks[0].rows.map((row) => row.c),
    ["keep", "old", "extra", "tail"],
  );
  assert.equal(filtered.hunks[0].base, whole.hunks[0]);
  assert.equal(filtered.hunks[0].rows[0], whole.hunks[0].rows[0]);
  assert.equal(filtered.add, 1);
  assert.equal(filtered.del, 1);
  assert.equal(store.view("missing"), undefined);
  assert.equal(store.filesFor("pr-1", "src/a.js")[0], whole);
});

test("client fingerprints reproduce the values saved by earlier builds", () => {
  const file = createReviewData(data).file(0);
  assert.ok(file);
  ensureFingerprints(file);
  const fp = (value: string): string => sha(value).slice(0, 20);
  const [keep, old, added] = file.hunks[0].rows;
  assert.equal(keep.f, fp("src/a.js\0ctx\0\0keep\0old"));
  assert.equal(old.f, fp("src/a.js\0del\0keep\0old\0new"));
  assert.equal(added.cf, fp("src/a.js\0add\0new"));
  assert.equal(
    file.fingerprint,
    fp(
      [
        "src/a.js",
        "src/a.js",
        "function a()",
        "ctx:10:20:keep",
        "del:11::old",
        "add::21:new",
        "add::22:extra",
        "ctx:12:23:tail",
      ].join("\n"),
    ),
  );
});
