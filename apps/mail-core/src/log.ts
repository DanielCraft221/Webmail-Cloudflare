// Only these fields may be logged. Never the subject, body, attachment names or a full sender address.
export type LogEntry = {
  event: string;
  messageId?: string;
  mailbox?: string;
  senderDomain?: string;
  size?: number;
  status?: string;
  attempt?: number;
  error?: string;
  /** SHA-256 dedupe key: a hash, never the headers it was computed from. */
  dedupeKey?: string;
};

export function log(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1
    ? "unknown"
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Error name only: messages from the parser or the bindings may echo message content. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
