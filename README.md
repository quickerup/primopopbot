```markdown
<div align="center">

<a target="_top" href="https://www.flamingtext.com/" ><img src="https://blog.flamingtext.com/blog/2026/08/03/flamingtext_com_1785727597_2804487.png" border="0" alt="Logo Design by FlamingText.com" title="Logo Design by FlamingText.com"></a>

# ⚡ PrimoPopBot
## Premium Telegram Bot Factory on Cloudflare Workers

*Craft unlimited Telegram bots with a single DSL. Serverless. Webhook-driven. Zero maintenance.*

[![TypeScript](https://img.shields.io/badge/TypeScript-95.5%25-3178c6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

</div>

---

## 🚀 What is PrimoPopBot?

A **single Cloudflare Worker** that runs one factory bot (controlled only by you) plus **unlimited child bots**, each entirely defined by a JSON action DSL you upload through the factory bot. Everything is **webhook-driven** — no polling, no persistent process, no infrastructure headaches.

This is a from-scratch Workers reimplementation of an earlier `python-telegram-bot` long-polling project, preserving the same powerful DSL philosophy while re-deriving every mechanism for the serverless Workers runtime.

### ✨ Key Features

- 🤖 **Unlimited Child Bots** — One factory, infinite possibilities
- 📝 **JSON DSL** — Define bot behavior with simple, expressive action declarations
- ⚡ **Webhook-Driven** — No polling loops, instant response times
- 🔐 **Military-Grade Security** — AES-GCM encryption at rest, sandboxed evaluators
- 🌐 **TON Wallet Integration** — Built-in TON Connect v2 and signing helpers
- 🧠 **AI-Powered** — Workers AI integration for intelligent bot generation
- 📊 **GitHub Actions Gateway** — Control workflows from Telegram
- 🚫 **Impossible to Pwn** — No `shell`, no `eval`, no RCE vectors

---

## ⚡ Quick Start

```bash
./setup.sh
```

The script will automatically:
1. ✅ Check for / install `wrangler` and log you in
2. ✅ Create the `BOT_KV` KV namespace (prod + preview) and patch `wrangler.toml`
3. ✅ Prompt for your Telegram numeric user id and write it into `wrangler.toml`
4. ✅ Prompt for and set the two Worker secrets (`SECRET_PASSPHRASE`, `TELEGRAM_WEBHOOK_SECRET`)
5. ✅ Deploy the Worker
6. ✅ Register your **factory bot** and store it in KV as `bot:factory`

After that, open a chat with your factory bot on Telegram and send `/start`.

### 🛠️ Manual Setup (if you'd rather not use setup.sh)

```bash
npm install
npx wrangler login
npx wrangler kv namespace create BOT_KV
npx wrangler kv namespace create BOT_KV --preview
# paste the two ids into wrangler.toml under [[kv_namespaces]]

# edit wrangler.toml: set FACTORY_OWNER_ID to your numeric Telegram user id
# (get it from @userinfobot on Telegram)

npx wrangler secret put SECRET_PASSPHRASE
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# (any long random strings; TELEGRAM_WEBHOOK_SECRET must be 1-256 chars,
#  A-Z a-z 0-9 _ - only, per Telegram's setWebhook requirements)

npx wrangler deploy

# Register the factory bot itself (one-time):
curl -s "https://api.telegram.org/bot<FACTORY_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/hook/factory" \
  -d "secret_token=<same value you put in TELEGRAM_WEBHOOK_SECRET>"

# Put the factory bot's record into KV:
npx wrangler kv key put --binding=BOT_KV "bot:factory" \
  '{"botId":"factory","token":"<FACTORY_TOKEN>","ownerId":"<your-id>","visibility":"private","createdAt":"2026-07-31T00:00:00Z"}'
```

---

## 💡 Usage Examples

### Creating a New Child Bot

Open your factory bot on Telegram and send `/help` for the full command list. Typical flow:

```
/newbot 123456:AA...            → validate token, then tap Public/Private
/setconfig mychildbot           → attach examples/simple-public-bot.json
```

Or define it inline:

```
/json mychildbot {"version":1,"commands":[{"command":"start","actions":[{"type":"send_message","text":"hi {user.first_name}"}]}]}
```

### 📦 Starter Configs

Pre-built examples in `examples/`:

| Config | Purpose |
|--------|---------|
| `simple-public-bot.json` | Dice, polls, and ask-based name capture |
| `price-tracker-bot.json` | Real-time data requests and margin calculator |
| `interface-anything-bot.json` | Generic Telegram API calls for unlimited flexibility |
| `ton-wallet-bot.json` | TON wallet connections and signing flows |

### 🔐 Managing Secrets

Store API keys, tokens, and sensitive data per-bot, encrypted at rest with AES-GCM:

```
/set_secret mychildbot
> (bot asks for the name) API_KEY
> (bot asks for the value) sk-abc123...
✅ Saved secret API_KEY for mychildbot. I deleted your message containing the value.
```

Reference in your config with `{secrets.API_KEY}` — resolved server-side only, never exposed unless you explicitly include it.

### 🚀 GitHub Actions Gateway

Enable GitHub workflow control directly from Telegram:

```
/set_secret factory   → GITHUB_TOKEN
/set_secret factory   → GITHUB_OWNER
/set_secret factory   → GITHUB_REPO
```

Then use `/gh_workflows`, `/gh_runs`, `/gh_dispatch <workflow> [ref]`, etc.

### 🌐 Generic Telegram Interfaces

For features not yet wrapped as DSL actions, use `telegram_api`:

```json
{
  "type": "telegram_api",
  "method": "sendVenue",
  "payload": {
    "latitude": 40.758,
    "longitude": -73.9855,
    "title": "Meet here",
    "address": "Times Square, New York"
  }
}
```

### 💰 TON Wallet & Signing

Built-in TON-specific helpers for mainnet and testnet:

- **`ton_connect`** — Build TON Connect v2 links, send as inline buttons, request `ton_proof` for authentication
- **`ton_sign`** — Build signing URLs for your HTTPS signing page with network, payload type, and state

Both support placeholders like `{user.id}`, `{chat.id}`, `{vars.some_value}` and reject secret placeholders for external transmission.

---

## 🏗️ Architecture

```
Telegram ──POST /hook/factory──▶  Worker  ──▶ factory.ts (owner-only commands)
Telegram ──POST /hook/:botId───▶  Worker  ──▶ dsl/interpreter.ts (runActions)
                                       │
                     ┌─────────────────┼──────────────────────┐
                     ▼                 ▼                      ▼
                  BOT_KV        ChatSession DO           Workers AI / fetch()
          (bot registry,     (vars, paused "ask"          (compute doesn't
           configs, secrets   flows, rate limits           reach these —
           blobs)             — per botId:chatId)          sandboxed evaluator)
```

### 📚 Component Breakdown

| Component | Purpose |
|-----------|---------|
| **KV (`BOT_KV`)** | Bot registry, configs, encrypted secrets, transient factory-flow state |
| **ChatSession DO** | Per-chat conversational state, paused ask flows, token-bucket rate limiting |
| **`dsl/expression.ts`** | Sandboxed compute evaluator (arithmetic + whitelisted functions only) |
| **`dsl/interpreter.ts`** | DSL execution engine (runActions) |

---

## 🔒 Security Model

✅ **Factory Bot**: Hardcoded owner check (`FACTORY_OWNER_ID`) gates all access  
✅ **Private Bots**: Only the owner can interact; silent 200 OK for probes  
✅ **Public Bots**: Configs validated at save time, rejected if unsafe; rate-limited requests  
✅ **No Shell/Python**: No `shell` or `python` actions exist in the type system — impossible RCE vector  
✅ **Sandboxed Compute**: Custom formulas run in a non-Turing-complete whitelist evaluator, never reaching `eval` or `Function`

---

## 🔄 Differences from Python Original

This reimplementation deliberately changes:

1. **No `shell`/`python` actions** — Completely absent from type system, schema, and interpreter. Replaced with `compute`/`transform` using a whitelisted evaluator.

2. **Session state in Durable Objects** — Not in-process memory. Workers isolates are ephemeral, so `vars` and paused flows live externally in a DO (trades memory for network round-trip, gains durability).

3. **Web Crypto AES-GCM** — Same goal as Fernet (symmetric encryption), different primitive (Fernet unavailable in workerd).

4. **Native `env.AI` binding** — Direct Workers AI integration instead of authenticated HTTP calls. One fewer secret to manage.

5. **Nested `condition` + `ask` resume behavior** — Resume continues the inner branch only, not sibling actions after the condition (interpreter simplicity tradeoff).

6. **Webhooks instead of long-polling** — No `getUpdates` loop, no persistent process. Every update routes to your Worker, verified via `X-Telegram-Bot-Api-Secret-Token` header.

---

## 📂 Repository Layout

```
wrangler.toml              Worker config: KV, DO, AI bindings
package.json / tsconfig.json
src/
  ├── index.ts             Hono app: /hook/factory & /hook/:botId routes
  ├── telegram.ts          Telegram Bot API client (fetch-based)
  ├── env.ts               Shared Env (bindings + vars) interface
  ├── secrets.ts           Web Crypto AES-GCM encrypt/decrypt
  ├── session.do.ts        ChatSession Durable Object
  ├── session-client.ts    DO communication wrapper
  ├── factory.ts           Factory-bot command handlers
  ├── github.ts            GitHub Actions gateway
  ├── ai.ts                Workers AI-backed command generator
  └── dsl/
      ├── types.ts         Action & config type definitions
      ├── schema.ts        Shape validator & public-bot safety checks
      ├── expression.ts    Sandboxed compute evaluator
      ├── template.ts      {user.x}/{vars.x}/{secrets.x} interpolation
      └── interpreter.ts   DSL execution engine (runActions)
examples/
  ├── simple-public-bot.json
  ├── price-tracker-bot.json
  ├── interface-anything-bot.json
  └── ton-wallet-bot.json
assets/                    Images & logos
setup.sh                   One-shot wrangler setup + deploy script
```

---

## ⚠️ Known Limitations

- 📥 **Large Configs**: `getFile` downloads capped at 20MB by Telegram; use `/json` in chunks or host externally
- 📦 **GitHub Logs**: `/gh_logs` returns a signed, time-limited download URL (not proxied through Worker)
- 🔀 **Nested Conditionals**: `condition` + nested `ask` resume only the inner branch (see differences #5)

---

## 🎯 Next Steps

- 📖 Read `/help` in your factory bot for detailed command reference
- 🔍 Explore the `examples/` directory for real-world config templates
- 🚀 Check `wrangler.toml` for available bindings and environment variables
- 💬 Open an issue for feature requests or bug reports

---

<div align="center">

**Built with ⚡ on [Cloudflare Workers](https://workers.cloudflare.com/)**

Made by [quickerup](https://github.com/quickerup) • [MIT License](LICENSE)

</div>
```
