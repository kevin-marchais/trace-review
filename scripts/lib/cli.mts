export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the value that follows an option. A missing value (or another option in
 * its place) is reported through `fail` when given, otherwise thrown.
 */
export function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
  fail?: (message: string) => never,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    const message = `${option} requires a value`;
    if (fail) fail(message);
    throw new Error(message);
  }
  return value;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
