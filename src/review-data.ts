// The review data embedded in the generated HTML, and its decoded form.
//
// Each changed file is stored once: its parsed hunks (rows as marker-prefixed
// strings, line numbers implied by the hunk start) and its full contents.
// Group occurrences and the Git-order list are views that reference a file
// by index and, when filtered, select hunks and row ranges from it. Kept free
// of DOM access so it can be unit-tested with `bun test`.

export type RowType = "a" | "d" | "c";

export interface FullFile {
  revision: "head" | "base";
  content?: string;
  unavailable?: "binary" | "too-large" | "missing";
  svgPreview?: string;
}

export interface EmbeddedHunk {
  header: string;
  /** First old-side and new-side line numbers of the hunk. */
  o: number;
  n: number;
  /** One string per row: "+", "-" or " " followed by the line text. */
  rows: string[];
  /** Row index -> word-diff ranges as flat [start, end, start, end, ...] offsets. */
  w?: Record<string, number[]>;
}

export interface EmbeddedFile {
  reviewTarget: string;
  path: string;
  oldPath: string;
  renamed?: boolean;
  isNew?: boolean;
  isDeleted?: boolean;
  binary?: boolean;
  add: number;
  del: number;
  lang: string;
  note?: string;
  fullFile: FullFile;
  hunks: EmbeddedHunk[];
}

/**
 * A rendered occurrence of a file. Without `h` the whole file is shown;
 * otherwise each entry is [hunkIndex, start, end, start, end, ...] where the
 * optional pairs are half-open row ranges kept from that hunk.
 */
export interface EmbeddedView {
  f: number;
  h?: number[][];
}

export interface EmbeddedReviewData {
  files: EmbeddedFile[];
  views: Record<string, EmbeddedView>;
}

export interface ClientRow {
  t: RowType;
  c: string;
  o?: number;
  n?: number;
  /** Word-diff ranges, see EmbeddedHunk.w. */
  w?: number[];
  /** Line fingerprint (content plus neighbours), computed on demand. */
  f?: string;
  /** Content fingerprint, computed on demand. */
  cf?: string;
  /** Highlighted HTML, filled when the hunk is first rendered. */
  _hl?: string;
}

export interface ClientHunk {
  header: string;
  rows: ClientRow[];
  /** The unfiltered hunk when this one only keeps some of its rows. */
  base?: ClientHunk;
  highlighted?: boolean;
}

export interface ClientFile {
  /** Index of the stored file this file or view reads from. */
  index: number;
  reviewTarget: string;
  path: string;
  oldPath: string;
  renamed: boolean;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  add: number;
  del: number;
  lang: string;
  note?: string;
  fullFile: FullFile;
  hunks: ClientHunk[];
  fingerprint?: string;
}

const ROW_TYPES: Readonly<Record<string, RowType>> = { "+": "a", "-": "d", " ": "c" };
const LONG_TYPES: Readonly<Record<RowType, string>> = { a: "add", d: "del", c: "ctx" };

export function decodeHunk(hunk: EmbeddedHunk): ClientHunk {
  let oldNo = hunk.o;
  let newNo = hunk.n;
  const rows = hunk.rows.map((source, index): ClientRow => {
    const t = ROW_TYPES[source[0]] ?? "c";
    const row: ClientRow = { t, c: source.slice(1) };
    if (t !== "a") row.o = oldNo++;
    if (t !== "d") row.n = newNo++;
    const ranges = hunk.w?.[index];
    if (ranges?.length) row.w = ranges;
    return row;
  });
  return { header: hunk.header, rows };
}

export function decodeFile(file: EmbeddedFile, index: number): ClientFile {
  return {
    index,
    reviewTarget: file.reviewTarget,
    path: file.path,
    oldPath: file.oldPath,
    renamed: !!file.renamed,
    isNew: !!file.isNew,
    isDeleted: !!file.isDeleted,
    binary: !!file.binary,
    add: file.add,
    del: file.del,
    lang: file.lang,
    ...(file.note === undefined ? {} : { note: file.note }),
    fullFile: file.fullFile,
    hunks: file.hunks.map(decodeHunk),
  };
}

/** Apply a view's hunk and row selection to its decoded file. */
export function decodeView(file: ClientFile, view: EmbeddedView): ClientFile {
  if (!view.h) return file;
  const hunks = view.h.flatMap(([hunkIndex, ...ranges]): ClientHunk[] => {
    const hunk = hunkIndex === undefined ? undefined : file.hunks[hunkIndex];
    if (!hunk) return [];
    if (!ranges.length) return [hunk];
    const rows: ClientRow[] = [];
    for (let index = 0; index + 1 < ranges.length; index += 2) {
      rows.push(...hunk.rows.slice(ranges[index], ranges[index + 1]));
    }
    return [{ header: hunk.header, rows, base: hunk }];
  });
  const rows = hunks.flatMap((hunk) => hunk.rows);
  return {
    ...file,
    hunks,
    add: rows.filter((row) => row.t === "a").length,
    del: rows.filter((row) => row.t === "d").length,
  };
}

/** The comment anchor of a row: "o<line>" on the old side, "<line>" otherwise. */
export function rowKey(row: ClientRow): string {
  return row.t === "d" ? "o" + row.o : String(row.n);
}

/**
 * Lazily decoded access to the embedded data. Files are decoded once and
 * shared by every view, so a row object is the same in all occurrences.
 */
export function createReviewData(raw: Partial<EmbeddedReviewData>) {
  const embedded = Array.isArray(raw.files) ? raw.files : [];
  const views = raw.views && typeof raw.views === "object" ? raw.views : {};
  const decoded: Array<ClientFile | undefined> = [];
  const viewCache = new Map<string, ClientFile | null>();
  const byPath = new Map<string, number[]>();
  embedded.forEach((file, index) => {
    const key = file.reviewTarget + "\0" + file.path;
    const indexes = byPath.get(key) ?? [];
    indexes.push(index);
    byPath.set(key, indexes);
  });
  const file = (index: number): ClientFile | undefined => {
    const source = embedded[index];
    if (!source) return undefined;
    return (decoded[index] ??= decodeFile(source, index));
  };
  return {
    file,
    /** The file shown by a diff mount, or undefined for an unknown id. */
    view(fid: string | undefined): ClientFile | undefined {
      if (!fid || !Object.hasOwn(views, fid)) return undefined;
      if (!viewCache.has(fid)) {
        const view = views[fid];
        const base = file(view.f);
        viewCache.set(fid, base ? decodeView(base, view) : null);
      }
      return viewCache.get(fid) ?? undefined;
    },
    /** Every stored file with this path in a review target. */
    filesFor(reviewTarget: string, path: string): ClientFile[] {
      return (byPath.get(reviewTarget + "\0" + path) || []).flatMap((index) => file(index) ?? []);
    },
  };
}

export type ReviewDataStore = ReturnType<typeof createReviewData>;

// ---- fingerprints (stable across builds, used to relocate saved comments) ----

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const encoder = new TextEncoder();
const W = new Uint32Array(64);
const ror = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** SHA-256 of the UTF-8 encoding of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  const data = encoder.encode(text);
  const length = ((data.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(length);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bits = data.length * 8;
  view.setUint32(length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(length - 4, bits >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15];
      const b = W[i - 2];
      const s0 = ror(a, 7) ^ ror(a, 18) ^ (a >>> 3);
      const s1 = ror(b, 17) ^ ror(b, 19) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = hash[0],
      b = hash[1],
      c = hash[2],
      d = hash[3],
      e = hash[4],
      f = hash[5],
      g = hash[6],
      h = hash[7];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export const fingerprint = (value: string): string => sha256Hex(value).slice(0, 20);

/**
 * Fill the line, content, and diff fingerprints of a stored file. Line
 * fingerprints include the neighbouring rows of the unfiltered hunk, so every
 * view of the file shares the same values.
 */
export function ensureFingerprints(file: ClientFile): void {
  if (file.fingerprint !== undefined) return;
  const parts = [file.path, file.oldPath];
  for (const hunk of file.hunks) {
    parts.push(hunk.header);
    hunk.rows.forEach((row, index) => {
      const type = LONG_TYPES[row.t];
      const before = hunk.rows[index - 1]?.c || "";
      const after = hunk.rows[index + 1]?.c || "";
      row.f = fingerprint(`${file.path}\0${type}\0${before}\0${row.c}\0${after}`);
      row.cf = fingerprint(`${file.path}\0${type}\0${row.c}`);
      parts.push(`${type}:${row.o ?? ""}:${row.n ?? ""}:${row.c}`);
    });
  }
  file.fingerprint = fingerprint(parts.join("\n"));
}
