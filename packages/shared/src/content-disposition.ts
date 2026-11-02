/**
 * RFC 6266: an ASCII fallback plus the UTF-8 name, both free of controls, paths and quotes.
 * Same rules as the Worker's downloads (docs/api.md); the webmail builds its own download headers
 * and never passes the Worker's on. shortcut: apps/mail-core keeps its own copy, until the next
 * Worker change moves it to this one (Etapa 6 does not change the Worker).
 */
export function contentDisposition(
  filename: string | null,
  fallback: string,
): string {
  const cleaned = (filename ?? "")
    .normalize("NFC")
    // Lone surrogates, control and bidirectional characters (which can disguise an extension).
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    )
    .replace(/[/\\]/g, "_")
    .replace(/^[\s.]+/, "")
    .trim();
  const name = Array.from(cleaned).slice(0, 200).join("") || fallback;
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
