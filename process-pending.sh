#!/bin/bash
# AI auto-reply worker poke.
#
# The inbound webhook only *enqueues* a reply (sets contacts.automation_pending_at
# after a short debounce). This script pokes /api/automation/process-pending,
# which actually runs the LLM + sends. Cron fires this once a minute; the inner
# loop hits the worker every ~5s to fill the gap (cron's min granularity is 1
# minute), so replies stay snappy.
#
# Install (VPS): keep this file at the repo root and add to crontab:
#   * * * * * /opt/QHT-Messaging/process-pending.sh >/dev/null 2>&1
#
# Token + base URL are read from .env.local next to this script (never hardcoded).

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env.local"

TOKEN=$(grep '^WEBHOOK_INTERNAL_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
BASE=$(grep '^NEXT_PUBLIC_APP_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
BASE="${BASE:-https://wa.americanhairline.com}"
URL="$BASE/api/automation/process-pending"

if [ -z "$TOKEN" ]; then
  echo "[process-pending] WEBHOOK_INTERNAL_TOKEN missing in $ENV_FILE" >&2
  exit 1
fi

for _ in $(seq 1 11); do
  curl -fsS -X POST -H "Content-Type: application/json" \
    -d "{\"token\":\"$TOKEN\"}" "$URL" >/dev/null 2>&1
  sleep 5
done
