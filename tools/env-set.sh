#!/bin/sh
# Take the value from the clipboard, store it as KEY in ~/dst/.env and in the
# Vercel production environment of this project. The value is never printed.
#   sh tools/env-set.sh PORKBUN_API_KEY
set -eu
key="${1:?usage: env-set.sh KEY_NAME}"
ENV="${ENV_FILE:-$HOME/dst/.env}"
cd "$(dirname "$0")/.."
value="$(pbpaste | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
[ -n "$value" ] || { echo "clipboard is empty"; exit 1; }
case "$value" in *[!A-Za-z0-9_.:@/+=-]*) echo "clipboard does not look like a key"; exit 1;; esac
touch "$ENV"
grep -v "^${key}=" "$ENV" > "$ENV.tmp" || true
printf '%s=%s\n' "$key" "$value" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"
echo "$key saved to $ENV (${#value} chars)"
vercel env rm "$key" production --yes >/dev/null 2>&1 || true
printf '%s' "$value" | vercel env add "$key" production >/dev/null && echo "$key set in Vercel production"
