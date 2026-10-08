// Shared unified-diff parser. Every consumer (preflight, change groups,
// repeated-change detection, PR context, and the HTML builder) reads patches
// through this module so they agree on paths, hunks, and line numbers.

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content without the leading marker. A trailing "\r" is preserved. */
  text: string;
  oldNo?: number;
  newNo?: number;
  noNewlineAtEnd?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the closing "@@", trimmed (usually the enclosing function). */
  section: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string;
  /** True when the file section started with a `diff --git` header. */
  gitHeader: boolean;
  isNew: boolean;
  isDeleted: boolean;
  renamed: boolean;
  copied: boolean;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  /** Extended header lines (index, mode, similarity, rename, copy). */
  meta: string[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Decode a Git C-quoted path (core.quotePath octal escapes); unquoted input is returned as is. */
export function decodeGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return token;
  const input = token.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Readonly<Record<string, number>> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
  };
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== "\\") {
      const codePoint = input.codePointAt(index);
      if (codePoint === undefined) break;
      bytes.push(...textEncoder.encode(String.fromCodePoint(codePoint)));
      if (codePoint > 0xffff) index++;
      continue;
    }
    index++;
    const octal = /^[0-7]{1,3}/.exec(input.slice(index));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length - 1;
    } else {
      const escaped = input[index] ?? "";
      const escapedByte = escapes[escaped];
      if (escapedByte !== undefined) bytes.push(escapedByte);
      else bytes.push(...textEncoder.encode(escaped));
    }
  }
  return textDecoder.decode(Uint8Array.from(bytes));
}

/** End index (exclusive) of a C-quoted token starting at `start`, or -1. */
function quotedEnd(value: string, start: number): number {
  if (value[start] !== '"') return -1;
  for (let index = start + 1; index < value.length; index++) {
    if (value[index] === "\\") index++;
    else if (value[index] === '"') return index + 1;
  }
  return -1;
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Parse the paths of a `diff --git` header. Unquoted headers are ambiguous when
 * a path contains " b/"; the ---/+++ and rename/copy lines that follow are
 * authoritative and override this best guess.
 */
export function parseDiffPaths(line: string): { oldPath: string; path: string } | null {
  const header = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!header.startsWith("diff --git ")) return null;
  const rest = header.slice("diff --git ".length);
  let oldToken: string | undefined;
  let newToken: string | undefined;
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest, 0);
    if (end > 0 && rest[end] === " ") {
      oldToken = decodeGitPath(rest.slice(0, end));
      const second = rest.slice(end + 1);
      newToken = second.startsWith('"') ? decodeGitPath(second) : second;
    }
  } else if (rest.endsWith('"')) {
    for (let index = rest.indexOf(' "'); index >= 0; index = rest.indexOf(' "', index + 1)) {
      if (quotedEnd(rest, index + 1) === rest.length) {
        oldToken = rest.slice(0, index);
        newToken = decodeGitPath(rest.slice(index + 1));
        break;
      }
    }
  } else {
    const half = (rest.length - 1) / 2;
    if (
      Number.isInteger(half) &&
      rest[half] === " " &&
      rest.startsWith("a/") &&
      rest.startsWith("b/", half + 1) &&
      rest.slice(2, half) === rest.slice(half + 3)
    ) {
      oldToken = rest.slice(0, half);
      newToken = rest.slice(half + 1);
    } else {
      const split = rest.indexOf(" b/");
      if (split > 0) {
        oldToken = rest.slice(0, split);
        newToken = rest.slice(split + 1);
      }
    }
  }
  if (oldToken === undefined || newToken === undefined) return null;
  return { oldPath: stripPrefix(oldToken, "a/"), path: stripPrefix(newToken, "b/") };
}

function markerPath(raw: string, prefix: string): string {
  if (raw.startsWith('"')) {
    const end = quotedEnd(raw, 0);
    if (end > 0) {
      const decoded = decodeGitPath(raw.slice(0, end));
      return decoded === "/dev/null" ? decoded : stripPrefix(decoded, prefix);
    }
  }
  // Git appends a tab after names containing spaces; other diff tools append
  // "\t<timestamp>". Tabs inside real names are always quoted by Git.
  const tab = raw.indexOf("\t");
  const value = tab >= 0 ? raw.slice(0, tab) : raw;
  return value === "/dev/null" ? value : stripPrefix(value, prefix);
}

/**
 * Undo a whole-file CRLF conversion (every line, headers included, ends in
 * CRLF, as when an editor re-saves a patch). Patches with LF headers keep
 * their CRs because those belong to the file content.
 */
export function normalizePatchText(text: string): string {
  const source = String(text ?? "");
  if (!source.includes("\r\n")) return source;
  const terminated = source.split("\n").slice(0, -1);
  return terminated.length > 0 && terminated.every((line) => line.endsWith("\r"))
    ? source.replace(/\r\n/g, "\n")
    : source;
}

/** Split patch text on "\n" only, keeping any "\r" in file content. */
export function splitPatchLines(text: string): string[] {
  const lines = normalizePatchText(text).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let sawOldMarker = false;

  const startFile = (oldPath: string, newPath: string, gitHeader: boolean): FileDiff => {
    const next: FileDiff = {
      path: newPath,
      oldPath,
      gitHeader,
      isNew: false,
      isDeleted: false,
      renamed: false,
      copied: false,
      binary: false,
      meta: [],
      hunks: [],
      additions: 0,
      deletions: 0,
    };
    files.push(next);
    hunk = null;
    sawOldMarker = false;
    return next;
  };

  for (const line of splitPatchLines(text)) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      const content = line.slice(1);
      const current: DiffHunk = hunk;
      if (marker === "+" && newLeft > 0) {
        current.lines.push({ kind: "add", text: content, newNo: newNo++ });
        newLeft--;
        if (file) file.additions++;
        continue;
      }
      if (marker === "-" && oldLeft > 0) {
        current.lines.push({ kind: "del", text: content, oldNo: oldNo++ });
        oldLeft--;
        if (file) file.deletions++;
        continue;
      }
      if ((marker === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        current.lines.push({ kind: "ctx", text: content, oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (marker === "\\") {
        const last = current.lines[current.lines.length - 1];
        if (last) last.noNewlineAtEnd = true;
        continue;
      }
      // Malformed hunk (counts disagree with the body): fall through to headers.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("\\")) {
      const lines = (hunk as DiffHunk | null)?.lines;
      const last = lines?.[lines.length - 1];
      if (last) last.noNewlineAtEnd = true;
      continue;
    }

    const header = line.endsWith("\r") ? line.slice(0, -1) : line;
    const gitPaths = parseDiffPaths(header);
    if (gitPaths) {
      file = startFile(gitPaths.oldPath, gitPaths.path, true);
      continue;
    }
    if (header.startsWith("--- ") && (!file || file.hunks.length > 0 || sawOldMarker)) {
      file = startFile("", "", false);
    }
    if (!file) continue;

    let match: RegExpExecArray | null;
    if ((match = HUNK_RE.exec(header))) {
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      hunk = {
        oldStart: Number(match[1]),
        oldCount,
        newStart: Number(match[3]),
        newCount,
        section: match[5].trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldLeft = oldCount;
      newLeft = newCount;
      continue;
    }
    if (header.startsWith("--- ")) {
      sawOldMarker = true;
      const value = markerPath(header.slice(4), "a/");
      if (value === "/dev/null") file.isNew = true;
      else file.oldPath = value;
    } else if (header.startsWith("+++ ")) {
      const value = markerPath(header.slice(4), "b/");
      if (value === "/dev/null") file.isDeleted = true;
      else file.path = value;
    } else if (header.startsWith("rename from ")) {
      file.oldPath = decodeGitPath(header.slice("rename from ".length));
      file.renamed = true;
      file.meta.push(header);
    } else if (header.startsWith("rename to ")) {
      file.path = decodeGitPath(header.slice("rename to ".length));
      file.renamed = true;
      file.meta.push(header);
    } else if (header.startsWith("copy from ")) {
      file.oldPath = decodeGitPath(header.slice("copy from ".length));
      file.copied = true;
      file.meta.push(header);
    } else if (header.startsWith("copy to ")) {
      file.path = decodeGitPath(header.slice("copy to ".length));
      file.copied = true;
      file.meta.push(header);
    } else if (header.startsWith("new file mode ")) {
      file.isNew = true;
      file.newMode = header.slice("new file mode ".length);
    } else if (header.startsWith("deleted file mode ")) {
      file.isDeleted = true;
      file.oldMode = header.slice("deleted file mode ".length);
    } else if (header.startsWith("old mode ")) {
      file.oldMode = header.slice("old mode ".length);
      file.meta.push(header);
    } else if (header.startsWith("new mode ")) {
      file.newMode = header.slice("new mode ".length);
      file.meta.push(header);
    } else if (/^(index|similarity index|dissimilarity index) /.test(header)) {
      file.meta.push(header);
    } else if (/^(GIT binary patch|Binary files .* differ$)/.test(header)) {
      file.binary = true;
    }
  }

  for (const parsed of files) {
    if (!parsed.oldPath) parsed.oldPath = parsed.path;
    if (!parsed.path) parsed.path = parsed.oldPath;
    if (parsed.oldPath !== parsed.path && !parsed.copied && !parsed.isNew && !parsed.isDeleted) {
      parsed.renamed = true;
    }
  }
  return files;
}
