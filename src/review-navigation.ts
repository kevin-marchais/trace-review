export interface NavigationItem {
  id: string;
  path: string;
  content: string;
  lines: Array<{ key: string; text: string }>;
  findingText: string;
  findings: Array<{ key: string; text: string }>;
  viewed: boolean;
  hasOpenFinding: boolean;
  severities: string[];
  test: boolean;
  generated: boolean;
  risks: string[];
  groups: string[];
}

export interface NavigationQuery {
  text?: string;
  unread?: boolean;
  openFindings?: boolean;
  tests?: boolean;
  generated?: boolean;
  severity?: string;
  risk?: string;
  group?: string;
}

function searchable(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function searchTerms(value: string | undefined): string[] {
  return searchable(value || "")
    .split(/\s+/)
    .filter(Boolean);
}

function containsTerms(value: string, terms: string[]): boolean {
  const haystack = searchable(value);
  return terms.every((term) => haystack.includes(term));
}

export function findingsWithinNavigationLines<T extends { key: string }>(
  lines: ReadonlyArray<{ key: string }>,
  findings: readonly T[],
): T[] {
  const keys = new Set(lines.map((line) => line.key));
  return findings.filter((finding) => keys.has(finding.key));
}

export function firstNavigationLineMatch(
  item: NavigationItem,
  text: string | undefined,
): string | undefined {
  const terms = searchTerms(text);
  if (!terms.length) return undefined;
  const exactLine = item.lines.find((line) => containsTerms(line.text, terms));
  if (exactLine) return exactLine.key;
  const exactFinding = item.findings.find((finding) => containsTerms(finding.text, terms));
  if (exactFinding) return exactFinding.key;
  if (containsTerms(item.content, terms)) {
    return item.lines.find((line) => terms.some((term) => searchable(line.text).includes(term)))
      ?.key;
  }
  if (containsTerms(item.findingText, terms)) {
    return item.findings.find((finding) =>
      terms.some((term) => searchable(finding.text).includes(term)),
    )?.key;
  }
  return undefined;
}

// Normalising every file's content is the expensive part of a search, so it
// is done once per item object and reused for every later query.
const haystacks = new WeakMap<NavigationItem, string>();
function itemHaystack(item: NavigationItem): string {
  let haystack = haystacks.get(item);
  if (haystack === undefined) {
    haystack = searchable([item.path, item.content, item.findingText].join("\n"));
    haystacks.set(item, haystack);
  }
  return haystack;
}

export function filterNavigationItems(
  items: readonly NavigationItem[],
  query: NavigationQuery,
): NavigationItem[] {
  const terms = searchTerms(query.text);
  return items.filter((item) => {
    const haystack = terms.length ? itemHaystack(item) : "";
    return (
      terms.every((term) => haystack.includes(term)) &&
      (!query.unread || !item.viewed) &&
      (!query.openFindings || item.hasOpenFinding) &&
      (!query.tests || item.test) &&
      (!query.generated || item.generated) &&
      (!query.severity || item.severities.includes(query.severity)) &&
      (!query.risk || item.risks.includes(query.risk)) &&
      (!query.group || item.groups.includes(query.group))
    );
  });
}
