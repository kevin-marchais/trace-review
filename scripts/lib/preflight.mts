import path from "node:path";
import { normalizePatchText, parseUnifiedDiff } from "./diff-parse.mjs";

export { decodeGitPath, parseDiffPaths } from "./diff-parse.mjs";

export type DiagnosticLevel = "error" | "warning";

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  file?: string;
}

export interface PreflightFile {
  path: string;
  oldPath: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generated: boolean;
  type: string;
}

export interface WhitespaceError {
  file: string;
  line: number;
  kind: "trailing-whitespace";
}

export interface PatchAnalysis {
  schemaVersion: 1;
  totals: {
    files: number;
    additions: number;
    deletions: number;
    bytes: number;
  };
  patch: {
    valid: boolean;
    diagnostics: Diagnostic[];
    gitApply?: { valid: boolean; numstat: string };
  };
  files: PreflightFile[];
  whitespaceErrors: WhitespaceError[];
}

export interface RunOptions {
  cwd?: string;
  input?: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => string;

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".h": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".m": "objectivec",
  ".mm": "objectivec",
  ".vb": "vbnet",
  ".vbs": "vbnet",
  ".wat": "wasm",
  ".wasm": "wasm",
  ".diff": "diff",
  ".patch": "diff",
  ".html": "xml",
  ".htm": "xml",
  ".xml": "xml",
  ".svg": "xml",
  ".vue": "xml",
  ".svelte": "xml",
  ".astro": "xml",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".properties": "ini",
};

const GENERATED_PATHS = [
  /(^|\/)(dist|build|coverage|vendor|generated|gen)(\/|$)/i,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|composer\.lock)$/i,
  /\.(min\.(js|css)|generated\.[^.]+)$/i,
];

function fileType(file: string): string {
  const basename = path.posix.basename(file).toLowerCase();
  if (basename === "cmakelists.txt" || basename.endsWith(".cmake")) return "cmake";
  if (basename === "makefile") return "makefile";
  return TYPE_BY_EXTENSION[path.posix.extname(basename)] || "other";
}

function isGenerated(file: string, addedLines: readonly string[]): boolean {
  if (GENERATED_PATHS.some((pattern) => pattern.test(file))) return true;
  return addedLines
    .slice(0, 5)
    .some((line) =>
      /(@generated|generated (file|code)|do not edit|automatically generated)/i.test(line),
    );
}

export function analyzePatch(text: string): PatchAnalysis {
  const source = String(text);
  const parsed = parseUnifiedDiff(source);
  const whitespaceErrors: WhitespaceError[] = [];
  const diagnostics: Diagnostic[] = [];
  const files = parsed.map((file): PreflightFile => {
    const addedLines: string[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue;
        addedLines.push(line.text);
        if (/[ \t]+$/.test(line.text)) {
          whitespaceErrors.push({
            file: file.path,
            line: line.newNo ?? 0,
            kind: "trailing-whitespace",
          });
        }
      }
    }
    return {
      path: file.path,
      oldPath: file.oldPath,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      generated: isGenerated(file.path, addedLines),
      type: fileType(file.path),
    };
  });

  if (source.trim() && !parsed.some((file) => file.gitHeader)) {
    diagnostics.push({
      level: "error",
      code: "invalid-patch",
      message: "No Git 'diff --git' file headers were found.",
    });
  }
  for (const file of files) {
    if (
      !file.binary &&
      file.additions === 0 &&
      file.deletions === 0 &&
      file.oldPath === file.path
    ) {
      diagnostics.push({
        level: "warning",
        code: "empty-file-diff",
        file: file.path,
        message: "The file has no hunks, binary marker, or rename.",
      });
    }
  }

  return {
    schemaVersion: 1,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      bytes: Buffer.byteLength(text),
    },
    patch: {
      valid: !diagnostics.some((item) => item.level === "error"),
      diagnostics,
    },
    files,
    whitespaceErrors,
  };
}

export function preflightPatch(text: string, run: CommandRunner, cwd: string): PatchAnalysis {
  const source = normalizePatchText(String(text));
  const result = analyzePatch(source);
  try {
    const numstat = run("git", ["apply", "--numstat", "-"], { cwd, input: source });
    result.patch.gitApply = {
      valid: true,
      numstat: String(numstat || "").trim(),
    };
  } catch (error: unknown) {
    result.patch.valid = false;
    result.patch.gitApply = { valid: false, numstat: "" };
    result.patch.diagnostics.push({
      level: "error",
      code: "git-apply-check-failed",
      message: error instanceof Error ? error.message : "Git rejected the patch.",
    });
  }
  return result;
}
