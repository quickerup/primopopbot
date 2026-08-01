#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-shot setup for the Telegram Bot Factory Cloudflare Worker.
#
# Idempotent-ish: safe to re-run. Steps that already look done (KV ids
# already in wrangler.toml, secrets already set, etc.) are skipped with a
# note, though wrangler secret put / kv namespace create will just prompt
# again if you want to force it — this script doesn't try to be clever
# about detecting "already configured" beyond the wrangler.toml placeholder
# check.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

WRANGLER_TOML="wrangler.toml"

info()  { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m✔ %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m⚠ %s\033[0m\n' "$1"; }
die()   { printf '\033[1;31m✘ %s\033[0m\n' "$1"; exit 1; }

ask() {
  # ask "prompt" -> echoes the answer
  local prompt="$1"
  local answer
  read -r -p "$prompt" answer
  echo "$answer"
}

# ---------------------------------------------------------------------------
# 0. Prerequisites
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is required (https://nodejs.org). Install it and re-run."
command -v npm  >/dev/null 2>&1 || die "npm is required alongside Node.js."

info "Installing npm dependencies (this also installs wrangler locally)…"
npm install
ok "Dependencies installed."

WRANGLER="npx wrangler"

info "Checking Cloudflare login state…"
if ! $WRANGLER whoami >/dev/null 2>&1; then
  info "Not logged in — opening the Cloudflare login flow…"
  $WRANGLER login
fi
ok "Logged in to Cloudflare."

# ---------------------------------------------------------------------------
# 1. KV namespace
# ---------------------------------------------------------------------------
if grep -q "REPLACE_WITH_KV_ID" "$WRANGLER_TOML"; then
  info "Creating BOT_KV namespace…"
  KV_OUT="$($WRANGLER kv namespace create BOT_KV 2>&1)"
  echo "$KV_OUT"
  KV_ID="$(echo "$KV_OUT" | grep -oE 'id = "[a-f0-9]+"' | head -1 | grep -oE '[a-f0-9]{32}')"
  [ -n "$KV_ID" ] || die "Couldn't parse KV namespace id from wrangler output above — patch wrangler.toml by hand."

  info "Creating BOT_KV preview namespace…"
  KV_PREVIEW_OUT="$($WRANGLER kv namespace create BOT_KV --preview 2>&1)"
  echo "$KV_PREVIEW_OUT"
  KV_PREVIEW_ID="$(echo "$KV_PREVIEW_OUT" | grep -oE 'preview_id = "[a-f0-9]+"' | head -1 | grep -oE '[a-f0-9]{32}')"
  [ -n "$KV_PREVIEW_ID" ] || die "Couldn't parse KV preview namespace id from wrangler output above — patch wrangler.toml by hand."

  sed -i.bak "s/REPLACE_WITH_KV_ID/${KV_ID}/" "$WRANGLER_TOML"
  sed -i.bak "s/REPLACE_WITH_PREVIEW_KV_ID/${KV_PREVIEW_ID}/" "$WRANGLER_TOML"
  rm -f "${WRANGLER_TOML}.bak"
  ok "wrangler.toml updated with KV namespace ids."
else
  ok "BOT_KV ids already present in wrangler.toml — skipping."
fi

# ---------------------------------------------------------------------------
# 2. Factory owner id
# ---------------------------------------------------------------------------
if grep -q "REPLACE_WITH_YOUR_TELEGRAM_USER_ID" "$WRANGLER_TOML"; then
  echo
  warn "You need your numeric Telegram user id (NOT your @username)."
  warn "Get it by messaging @userinfobot on Telegram."
  OWNER_ID="$(ask "Your numeric Telegram user id: ")"
  [[ "$OWNER_ID" =~ ^[0-9]+$ ]] || die "That doesn't look like a numeric id."
  sed -i.bak "s/REPLACE_WITH_YOUR_TELEGRAM_USER_ID/${OWNER_ID}/" "$WRANGLER_TOML"
  rm -f "${WRANGLER_TOML}.bak"
  ok "FACTORY_OWNER_ID set in wrangler.toml."
else
  ok "FACTORY_OWNER_ID already set — skipping."
fi

# ---------------------------------------------------------------------------
# 3. Worker secrets
# ---------------------------------------------------------------------------
random_secret() {
  # 48 random bytes, base64url-ish (Telegram's secret_token only allows
  # A-Z a-z 0-9 _ -, so translate + / into - _ and strip padding).
  openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-64
}

info "Setting Worker secrets (SECRET_PASSPHRASE, TELEGRAM_WEBHOOK_SECRET)."
echo "Press Enter to auto-generate a strong random value, or type your own."

read -r -p "SECRET_PASSPHRASE (used to encrypt child-bot API keys at rest) [auto-generate]: " PASSPHRASE
PASSPHRASE="${PASSPHRASE:-$(random_secret)}"
echo "$PASSPHRASE" | $WRANGLER secret put SECRET_PASSPHRASE
ok "SECRET_PASSPHRASE set."

read -r -p "TELEGRAM_WEBHOOK_SECRET (Telegram echoes this back on every call) [auto-generate]: " WEBHOOK_SECRET
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(random_secret)}"
echo "$WEBHOOK_SECRET" | $WRANGLER secret put TELEGRAM_WEBHOOK_SECRET
ok "TELEGRAM_WEBHOOK_SECRET set."

# ---------------------------------------------------------------------------
# 4. Deploy
# ---------------------------------------------------------------------------
info "Deploying the Worker…"
DEPLOY_OUT="$($WRANGLER deploy 2>&1)"
echo "$DEPLOY_OUT"
WORKER_URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"
if [ -z "$WORKER_URL" ]; then
  warn "Couldn't auto-detect your Worker URL from deploy output."
  WORKER_URL="$(ask "Paste your Worker's URL (e.g. https://telegram-bot-factory.YOURNAME.workers.dev): ")"
fi
ok "Deployed at ${WORKER_URL}"

# ---------------------------------------------------------------------------
# 5. Register the factory bot itself
# ---------------------------------------------------------------------------
echo
info "Now let's register your FACTORY bot (the one only you talk to)."
warn "Create it with @BotFather on Telegram first if you haven't, then paste its token here."
FACTORY_TOKEN="$(ask "Factory bot token: ")"
[ -n "$FACTORY_TOKEN" ] || die "A token is required."

info "Validating token with getMe…"
ME_JSON="$(curl -sf "https://api.telegram.org/bot${FACTORY_TOKEN}/getMe")" || die "getMe failed — check the token."
echo "$ME_JSON"

info "Registering webhook…"
HOOK_URL="${WORKER_URL}/hook/factory"
SET_HOOK_JSON="$(curl -sf "https://api.telegram.org/bot${FACTORY_TOKEN}/setWebhook" \
  -d "url=${HOOK_URL}" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d "drop_pending_updates=true")" || die "setWebhook failed."
echo "$SET_HOOK_JSON"

info "Saving factory bot record into KV…"
OWNER_ID_FROM_TOML="$(grep 'FACTORY_OWNER_ID' "$WRANGLER_TOML" | head -1 | grep -oE '[0-9]+')"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RECORD_JSON=$(cat <<EOF
{"botId":"factory","token":"${FACTORY_TOKEN}","ownerId":"${OWNER_ID_FROM_TOML}","visibility":"private","createdAt":"${NOW}"}
EOF
)
$WRANGLER kv key put --binding=BOT_KV "bot:factory" "$RECORD_JSON" --remote

ok "Factory bot is live at ${HOOK_URL}"
echo
echo "  Open a chat with your factory bot on Telegram and send /start."
echo
