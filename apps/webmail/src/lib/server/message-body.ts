import type { DatabaseSync } from "node:sqlite";
import type { api } from "@webmail/shared";
import type { z } from "zod";
import type { SanitizePool } from "./sanitize-pool.ts";

type Body = z.infer<typeof api.messageDetail>["body"];

const TEXT_STYLE =
  "body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Inline and !important: the email's own CSS must not hide it. */
function notice(text: string): string {
  return `<p style="white-space:normal !important;margin:0 0 12px !important;padding:8px !important;background:#fff4ce !important;color:#3b2e00 !important;font:13px/1.4 system-ui,sans-serif !important;display:block !important">${escapeHtml(text)}</p>`;
}

/** Plain text, escaped, line breaks kept. Links in the text are not made clickable (Etapa 6). */
function textDocument(text: string, warning?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${TEXT_STYLE}</style></head><body>${warning ? notice(warning) : ""}${escapeHtml(text)}</body></html>`;
}

/**
 * Puts the notice right after the real <body ...> tag of DOMPurify's output. The head holds only
 * <style>, whose text has no "<" (cleanCss), so the first "<body" is the real one; its attributes
 * are serialized as name="value" with quotes escaped, so the tag ends at the first ">" outside quotes.
 */
export function withNotice(html: string, text: string): string {
  const start = html.indexOf("<body");
  const tag =
    start < 0
      ? null
      : /^<body(?:\s[^\s="'>/]+(?:="[^"]*")?)*>/.exec(html.slice(start));
  if (!tag) return html;
  const end = start + tag[0].length;
  return html.slice(0, end) + notice(text) + html.slice(end);
}

export type BodyResult = { status: 200; html: string } | { status: 503 };

const TOO_LARGE =
  "Esta mensagem é grande demais para ser exibida formatada. Abaixo, a versão em texto; o original está no botão do .eml.";
const FAILED =
  "Não foi possível exibir esta mensagem formatada. Abaixo, a versão em texto; o original está no botão do .eml.";

/**
 * A message whose sanitization timed out or ran out of memory goes straight to the text version
 * for this long: reopening it must not hold a worker for 10 s each time (only its id is kept).
 */
export const FAILED_FOR = 6 * 60 * 60 * 1000;

/** The document served by /mensagens/[id]/corpo, inside the sandboxed iframe. */
export async function renderBody(
  id: string,
  body: Body,
  { sanitizer, db }: { sanitizer: SanitizePool; db: DatabaseSync },
  now = Date.now(),
): Promise<BodyResult> {
  const text = body?.text ?? "";
  if (!body?.html)
    return {
      status: 200,
      html: textDocument(
        text,
        body
          ? undefined
          : "O conteúdo desta mensagem não pôde ser lido. O original está no botão do .eml.",
      ),
    };
  const failedBefore = db
    .prepare("SELECT 1 FROM sanitize_failed WHERE message_id = ? AND until > ?")
    .get(id, now);
  if (failedBefore) return { status: 200, html: textDocument(text, FAILED) };
  const result = await sanitizer.run(body.html);
  if (result.ok) {
    const html = `<!doctype html>${result.html}`;
    return {
      status: 200,
      html:
        result.blockedImages > 0
          ? withNotice(
              html,
              `Imagens remotas bloqueadas (${result.blockedImages}).`,
            )
          : html,
    };
  }
  if (result.reason === "busy") return { status: 503 };
  // Not "unavailable": that is the webmail's fault, not the message's.
  if (result.reason === "failed") {
    db.prepare("DELETE FROM sanitize_failed WHERE until <= ?").run(now);
    db.prepare(
      "INSERT OR REPLACE INTO sanitize_failed (message_id, until) VALUES (?, ?)",
    ).run(id, now + FAILED_FOR);
  }
  return {
    status: 200,
    html: textDocument(
      text,
      result.reason === "too_large" ? TOO_LARGE : FAILED,
    ),
  };
}
