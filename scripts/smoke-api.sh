#!/usr/bin/env bash
# Smoke test of the mail-core internal API against production. Run it after every deploy
# (docs/cloudflare.md, section 8.5).
#
# - Reads ~/.config/webmail/api.env (or $WEBMAIL_API_ENV) and never prints its values. Secrets go
#   to curl through a file descriptor, never through the command line.
# - Finds mailbox, message and attachment ids through the API itself.
# - Leaves the data as it found it: the read flag it flips is restored.
# - Optional: with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID loaded, also checks that
#   workers.dev stays off.
set -uo pipefail

env_file=${WEBMAIL_API_ENV:-$HOME/.config/webmail/api.env}
base=${MAIL_API_URL:-https://mail-api.survivus.com.br}
user=${SMOKE_USER_ID:-}
# shellcheck disable=SC1090
. "$env_file" || exit 2
user=${user:-${SMOKE_USER_ID:-}}
for v in INTERNAL_API_TOKEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET; do
  [ -n "${!v:-}" ] || { echo "Missing $v in $env_file"; exit 2; }
done
[ -n "$user" ] || { echo "Missing SMOKE_USER_ID (UUID of a user who reads at least one mailbox)"; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
skip() { echo "SKIP $1"; }

# headers <none|access|nouser|user> [uuid]: the request headers for each level of credentials.
headers() {
  case $1 in
    none) ;;
    access) printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" ;;
    *)
      printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\nAuthorization: Bearer %s\n' \
        "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" "$INTERNAL_API_TOKEN"
      [ "$1" = nouser ] || printf 'X-Webmail-User: %s\n' "$2"
      ;;
  esac
  return 0
}

# req <mode> <uuid|-> <method> <path> [curl args...]: prints the status; body and headers go to $tmp.
req() {
  local mode=$1 who=$2 method=$3 path=$4
  shift 4
  curl -sS --max-time 60 -X "$method" --header @<(headers "$mode" "$who") \
    -D "$tmp/head" -o "$tmp/body" -w '%{http_code}' "$@" "$base$path"
}
header() { grep -i "^$1:" "$tmp/head" | head -n 1 | cut -d' ' -f2- | tr -d '\r'; }
# json <python expression over d>: evaluated against the last response body.
json() { python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print($1)" "$tmp/body" 2>/dev/null; }
worker_401() { [ "$1" = 401 ] && header content-type | grep -q '^application/json' && [ "$(json 'd["error"]')" = unauthorized ]; }
patch_json() { req user "$user" PATCH "$1" -H 'Content-Type: application/json' --data "$2"; }
unread() {
  [ "$(req user "$user" GET /v1/mailboxes)" = 200 ] || return 1
  json "[m['unread']['$2'] for m in d['mailboxes'] if m['id'] == $1][0]"
}

# 1. Authentication layers.
s=$(req none - GET /v1/mailboxes)
if [ "$s" = 401 ] && header content-type | grep -q '^text/html' && [ -n "$(header cf-access-domain)" ]; then
  pass "no headers: 401 from Access"
else fail "no headers: expected the Access 401, got $s"; fi

s=$(req access - GET /v1/mailboxes)
if worker_401 "$s"; then pass "Service Token without bearer: 401 from the Worker"
else fail "Service Token without bearer: expected the Worker 401, got $s"; fi

s=$(req nouser - GET /v1/mailboxes)
if worker_401 "$s"; then pass "no X-Webmail-User: 401"; else fail "no X-Webmail-User: expected 401, got $s"; fi

s=$(req user "$(cat /proc/sys/kernel/random/uuid)" GET /v1/mailboxes)
if worker_401 "$s"; then pass "unknown user: 401"; else fail "unknown user: expected 401, got $s"; fi

# 2. Mailboxes.
s=$(req user "$user" GET /v1/mailboxes)
mailboxes=$(json '" ".join(str(m["id"]) for m in d["mailboxes"])')
if [ "$s" = 200 ] && [ -n "$mailboxes" ] && [ "$(header x-content-type-options)" = nosniff ] && [ -z "$(header access-control-allow-origin)" ]; then
  pass "GET /v1/mailboxes: $(wc -w <<<"$mailboxes") mailbox(es), nosniff, no CORS"
else
  fail "GET /v1/mailboxes: expected 200 with at least one mailbox, got $s"
  echo "$fails check(s) failed"
  exit 1
fi

# 3. Pick a message, preferring one with an attachment (first page of each folder).
msg="" any="" mb="" folder=""
for m in $mailboxes; do
  for f in inbox archive spam trash; do
    [ "$(req user "$user" GET "/v1/mailboxes/$m/messages?folder=$f&limit=100")" = 200 ] || continue
    hit=$(json 'next((x["id"] for x in d["messages"] if x["hasAttachments"]), "")')
    first=$(json 'd["messages"][0]["id"] if d["messages"] else ""')
    [ -z "$any" ] && [ -n "$first" ] && any=$first mb=$m folder=$f
    if [ -n "$hit" ]; then msg=$hit mb=$m folder=$f; break 2; fi
  done
done
msg=${msg:-$any}
if [ -z "$msg" ]; then
  skip "message, attachment and PATCH checks: no message in any readable mailbox"
else
  s=$(req user "$user" GET "/v1/messages/$msg")
  if [ "$s" = 200 ] && [ "$(json 'd["id"]')" = "$msg" ] && [ "$(json 'd["parseStatus"] == "failed" or d["body"] is not None')" = True ]; then
    pass "GET /v1/messages/:id: metadata and body"
  else fail "GET /v1/messages/:id: expected 200 with metadata and body, got $s"; fi
  was_read=$(json 'str(d["isRead"]).lower()')
  att=$(json 'd["attachments"][0]["id"] if d["attachments"] else ""')
  att_size=$(json 'd["attachments"][0]["size"] if d["attachments"] else ""')

  # 4. Attachment download.
  if [ -z "$att" ]; then
    skip "attachment download: no message with an attachment on the first pages"
  else
    s=$(req user "$user" GET "/v1/messages/$msg/attachments/$att")
    got=$(stat -c %s "$tmp/body")
    if [ "$s" = 200 ] && [ "$(header content-type)" = application/octet-stream ] \
      && header content-disposition | grep -q '^attachment;' && [ "$(header x-content-type-options)" = nosniff ] \
      && header cache-control | grep -q 'no-store' && [ "$got" = "$att_size" ]; then
      pass "attachment download: octet-stream, attachment, nosniff, no-store, $got bytes as in D1"
    else fail "attachment download: got $s, $got bytes (D1 says $att_size)"; fi
  fi

  # 5. PATCH: flip the read flag, check the unread count, then restore it.
  before=$(unread "$mb" "$folder")
  if [ "$was_read" = true ]; then flip=false want=$((before + 1)); else flip=true want=$((before - 1)); fi
  s=$(patch_json "/v1/messages/$msg" "{\"isRead\":$flip}")
  after=$(unread "$mb" "$folder")
  if [ "$s" = 200 ] && [ "$after" = "$want" ]; then pass "PATCH isRead: unread count $before -> $after"
  else fail "PATCH isRead: got $s, unread count $before -> $after (expected $want)"; fi
  s=$(patch_json "/v1/messages/$msg" "{\"isRead\":$was_read}")
  restored=$(unread "$mb" "$folder")
  if [ "$s" = 200 ] && [ "$restored" = "$before" ]; then pass "PATCH isRead restored: unread count $restored"
  else fail "PATCH isRead restore: got $s, unread count $restored (expected $before)"; fi

  s=$(patch_json "/v1/messages/$msg" '{"folder":"sent"}')
  if [ "$s" = 400 ]; then pass "PATCH folder=sent: 400"; else fail "PATCH folder=sent: expected 400, got $s"; fi
fi

# 6. workers.dev stays off (needs the Wrangler token loaded, docs/cloudflare.md section 1).
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  sub=$(curl -sS --max-time 30 --header @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" |
    python3 -I -c 'import json,sys; print(json.load(sys.stdin)["result"]["subdomain"])' 2>/dev/null)
  if [ -z "$sub" ]; then
    fail "workers.dev: could not read the account subdomain"
  else
    s=$(curl -sS --max-time 30 -o "$tmp/body" -w '%{http_code}' "https://mail-core.$sub.workers.dev/v1/mailboxes")
    if [[ $s != 2* ]] && ! grep -q '"error"' "$tmp/body"; then pass "workers.dev: off ($s)"
    else fail "workers.dev: the Worker answered ($s)"; fi
  fi
else
  skip "workers.dev: load the Wrangler token to check it"
fi

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "All checks passed"
