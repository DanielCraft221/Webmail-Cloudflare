#!/usr/bin/env bash
# Sends one plain-text test message through the Cloudflare SMTP endpoint (docs/smtp-servicos.md).
#
# Usage: scripts/smtp-test.sh <token-file> <from> <to>
#   token-file: a chmod 600 file with a line SMTP_TOKEN=<API token with Email Sending: Edit>
#
# - The token reaches curl through a file descriptor (-K), never the command line (visible in ps),
#   and is never printed.
# - No -v: curl's verbose output shows the AUTH PLAIN line, which is the token in base64.
# - Prints curl's exit code and the last SMTP reply code (250 = accepted, 535 = bad token,
#   550 = sender domain not onboarded for Email Sending).
set -uo pipefail

[ $# -eq 3 ] || { echo "Usage: $0 <token-file> <from> <to>"; exit 2; }
token_file=$1 from=$2 to=$3

[ -r "$token_file" ] || { echo "Cannot read $token_file"; exit 2; }
mode=$(stat -c %a "$token_file")
case $mode in 600 | 400) ;; *) echo "Refusing: $token_file must be chmod 600 (is $mode)"; exit 2 ;; esac
# Parsed, not sourced: the file is data, not a script.
token=$(sed -n 's/^SMTP_TOKEN=//p' "$token_file" | head -n 1)
[ -n "$token" ] || { echo "No SMTP_TOKEN= line in $token_file"; exit 2; }
# Cloudflare tokens use only these characters; anything else could break out of the quoted curl config line.
[[ $token =~ ^[A-Za-z0-9_-]+$ ]] || { echo "SMTP_TOKEN in $token_file has unexpected characters"; exit 2; }

# One plain address each: no spaces, no line breaks (they would inject headers).
for addr in "$from" "$to"; do
  [[ $addr =~ ^[^@[:space:][:cntrl:]\"\<\>]+@[A-Za-z0-9.-]+$ ]] || { echo "Invalid address: $addr"; exit 2; }
done

msg=$(mktemp)
trap 'rm -f "$msg"' EXIT
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# No Message-ID: Cloudflare replaces any Message-ID with its own (tested 2026-10-31). Date is kept as sent.
printf 'From: %s\r\nTo: %s\r\nSubject: Teste SMTP %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nMensagem de teste do scripts/smtp-test.sh, enviada em %s.\r\n' \
  "$from" "$to" "$stamp" "$(LC_ALL=C date -u -R)" "$stamp" >"$msg"

code=$(curl -sS --max-time 60 --ssl-reqd --url "smtps://smtp.mx.cloudflare.net:465" \
  -K <(printf 'user = "api_token:%s"\n' "$token") \
  --mail-from "$from" --mail-rcpt "$to" --upload-file "$msg" -w '%{response_code}')
status=$?
echo "curl exit $status, last SMTP reply ${code:-none} ($stamp)"
exit "$status"
