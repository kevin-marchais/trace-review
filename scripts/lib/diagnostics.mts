/** A machine-readable validation problem with a JSON path and an optional fix. */
export interface Diagnostic {
  code: string;
  path: string;
  message: string;
  hint?: string;
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map(
      (item) => `- ${item.path || "$"}: ${item.message}${item.hint ? ` Hint: ${item.hint}` : ""}`,
    )
    .join("\n");
}

/** An error that carries the structured diagnostics that caused it. */
export class DiagnosticError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(summary: string, diagnostics: readonly Diagnostic[]) {
    super(diagnostics.length ? `${summary}\n${formatDiagnostics(diagnostics)}` : summary);
    this.name = "DiagnosticError";
    this.diagnostics = [...diagnostics];
  }
}
