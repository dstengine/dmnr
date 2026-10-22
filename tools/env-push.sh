#!/bin/sh
# Copy the registrar keys from ~/dst/.env into the Vercel production environment.
# Values are piped straight into `vercel env add` and never printed.
set -eu
ENV="${1:-$HOME/dst/.env}"
cd "$(dirname "$0")/.."
for key in GODADDY_API_KEY NAMESILO_API_KEY NAMECOM_USERNAME NAMECOM_TOKEN \
           PORKBUN_API_KEY PORKBUN_SECRET_KEY SPACESHIP_API_KEY SPACESHIP_API_SECRET \
           DYNADOT_API_KEY GANDI_PAT; do
  value="$(grep "^${key}=" "$ENV" | head -n 1 | cut -d= -f2- | tr -d '\r\n')"
  [ -n "$value" ] || continue
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$key" production >/dev/null && echo "set $key"
done
vercel env ls production | sed -n '1,20p'
