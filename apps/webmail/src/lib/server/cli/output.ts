/**
 * Control and format characters (ANSI escapes, bidi overrides) become visible \u{…} text, so
 * nothing stored in D1 or SQLite can move the cursor or rewrite lines in the admin's terminal.
 */
export function clean(value: unknown): string {
  const text = value === null || value === undefined ? "-" : String(value);
  return text.replace(
    /[\p{Cc}\p{Cf}]/gu,
    (c) => `\\u{${c.codePointAt(0)?.toString(16)}}`,
  );
}

/** Aligned columns; every cell goes through clean(). */
export function table(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  const cells = rows.map((row) => columns.map((c) => clean(row[c])));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const line = (values: string[]) =>
    values
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(columns), ...cells.map(line)].join("\n");
}

export function time(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}
