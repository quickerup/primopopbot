# Telegram Bot Factory (Cloudflare Workers)

A single Cloudflare Worker that runs one "factory" bot (controlled only by
you) plus unlimited child bots, each entirely defined by a JSON action DSL
you upload through the factory bot. Everything is webhook-driven — no
polling, no persistent process.

This is a from-scratch Workers reimplementation of an earlier
`python-telegram-bot` long-polling project. It keeps the same DSL
philosophy and command surface but re-derives every mechanism for the
Workers runtime. See "What's different from the Python original" below.

## Quick start

```bash
./setup.sh
```

The script will:
1. Check for / install `wrangler` and log you in.
2. Create the `BOT_KV` KV namespace (prod + preview) and patch `wrangler.toml`.
3. Prompt for your Telegram numeric user id and write it into `wrangler.toml`.
4. Prompt for and set the two Worker secrets (`SECRET_PASSPHRASE`,
   `TELEGRAM_WEBHOOK_SECRET`) via `wrangler secret put`.
5. Deploy the Worker.
6. Prompt for your **factory bot's** BotFather token, call `setWebhook`
   against the deployed Worker URL, and register it in KV as `bot:factory`.

After that, open a chat with your factory bot on Telegram and send `/start`.

### Manual setup (if you'd rather not use setup.sh)

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

# Register the factory bot itself (one-time, not through /newbot since the
# factory bot talks to itself):
curl -s "https://api.telegram.org/bot<FACTORY_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/hook/factory" \
  -d "secret_token=<same value you put in TELEGRAM_WEBHOOK_SECRET>"

# Then put the factory bot's record into KV so the Worker can send replies:
npx wrangler kv key put --binding=BOT_KV "bot:factory" \
  '{"botId":"factory","token":"<FACTORY_TOKEN>","ownerId":"<your-id>","visibility":"private","createdAt":"2026-07-31T00:00:00Z"}'
```

## Using it

Open your factory bot on Telegram and send `/help` for the full command
list. Typical flow for a new child bot:

```
/newbot 123456:AA...            → validate token, then tap Public/Private
/setconfig mychildbot           → attach examples/simple-public-bot.json
```

or without a file:

```
/json mychildbot {"version":1,"commands":[{"command":"start","actions":[{"type":"send_message","text":"hi {user.first_name}"}]}]}
```

Starter configs are in `examples/`:
- `simple-public-bot.json` — dice, poll, and an `ask`-based name-capture flow.
- `price-tracker-bot.json` — `request` + `transform` + `sort_slice` for a
  top-movers list, and `compute` for a two-question margin calculator.
- `interface-anything-bot.json` — shows the generic `telegram_api` action, which lets a bot config call Telegram Bot API methods that do not yet have first-class DSL wrappers.
- `ton-wallet-bot.json` — shows TON Connect links for mainnet/testnet wallet connection and a wallet-side signing flow.

Secrets (e.g. an API key a child bot's `request` actions need) are stored
per-bot, AES-GCM-encrypted at rest:

```
/set_secret mychildbot
> (bot asks for the name) API_KEY
> (bot asks for the value) sk-abc123...
✅ Saved secret API_KEY for mychildbot. I deleted your message containing the value.
```

Reference it in a config with `{secrets.API_KEY}` — resolved server-side
only, never echoed back unless an action's own text explicitly includes it
(don't do that in a public bot's config).

GitHub Actions gateway needs three secrets on the special `factory` botId:

```
/set_secret factory   → GITHUB_TOKEN
/set_secret factory   → GITHUB_OWNER
/set_secret factory   → GITHUB_REPO
```
then `/gh_workflows`, `/gh_runs`, `/gh_dispatch <workflow> [ref]`, etc. work.

### Generic Telegram interfaces

For Telegram features that are not yet first-class DSL actions, use
`telegram_api`. It calls any Telegram Bot API method with a templated JSON
payload, automatically filling `chat_id` with the current chat unless you
provide one yourself:

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

If you set `assign`, the Telegram API result is stored in `vars` for later
actions. This keeps the factory extensible: new Bot API surfaces can be used
from JSON immediately, while common ones can still get friendly wrappers over
time.

### TON wallet and signing helpers

The DSL includes TON-specific helpers for bots that need wallet UX on mainnet
or testnet:

- `ton_connect` builds a TON Connect v2 link, sends it as an inline button,
  and can request `ton_proof` for wallet authentication. Use `network:
  "mainnet"` or `network: "testnet"`; if omitted, mainnet is used.
- `ton_sign` builds a signing URL for your HTTPS TON signing page with the
  selected network, payload type (`text`, `binary`, or `cell`), payload,
  return URL, and state. The wallet performs the signature; the bot never
  receives or stores private keys.

Both actions support placeholders such as `{user.id}`, `{chat.id}`, and
`{vars.some_value}` in URL and payload fields. Secret placeholders are rejected
for externally transmitted TON link fields. Set `assign` to keep the generated
link in `vars` for later actions.

## Architecture

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

- **KV (`BOT_KV`)** — `bot:<botId>`, `config:<botId>`, `secrets:<botId>`
  (AES-GCM ciphertext), `pending:<chatId>` (short-TTL factory-flow state).
- **Durable Object (`ChatSession`, one per `botId:chatId`)** — the
  conversational variable bag (`vars`), any paused `ask` flow (remaining
  actions + resume index), and a token-bucket rate limiter for public bots.
  This has to be a Durable Object rather than a global variable or KV
  entry: Workers gives no guarantee an isolate's in-memory state survives
  between requests, and KV's eventual consistency is too slow/racy for a
  hot conversational loop where two updates for the same chat could arrive
  close together.
- **`dsl/expression.ts`** — the sandboxed `compute` evaluator: a hand-rolled
  recursive-descent parser over arithmetic + a small function whitelist
  (`abs round floor ceil min max sqrt`). It cannot reach `eval`/`Function`,
  arbitrary property access, method calls, or loops — this is what replaces
  the Python original's `eval()`-based formula action and its
  `shell`/`python` action types.

## Security model

- **Factory bot**: hardcoded owner check (`FACTORY_OWNER_ID`) runs first,
  before any command dispatch, on every update. If it's unset, everyone is
  refused (fail closed).
- **Private child bots**: only the registering owner may interact; all
  other updates get a silent `200 OK` with no reply, so probing reveals
  nothing.
- **Public child bots**:
  - Configs are validated at `/setconfig`/`/json`/`/ai`-save time and
    **rejected outright** (not silently stripped) if they contain any
    action type disallowed on public bots.
  - `request` actions are constrained to `PUBLIC_REQUEST_ALLOWLIST`
    (comma-separated hostnames in `wrangler.toml [vars]`) to prevent a
    public bot being repurposed as an open HTTP proxy / SSRF vector. Empty
    allowlist = all `request` actions blocked on public bots by default.
  - All `request` actions on public bots are token-bucket rate-limited per
    chat via the `ChatSession` Durable Object.
- **`shell` and `python` action types do not exist in this DSL at all** —
  not "disabled", not "admin-only", genuinely absent from the type system,
  the schema validator, and the interpreter's switch statement. There is no
  code path that reaches `eval`/`Function`/`subprocess` anywhere in this
  codebase.

## What's different from the Python original

The build prompt asked for these to be flagged explicitly rather than
silently diverged on:

1. **No `shell`/`python` actions, at all.** The Python version could run
   arbitrary shell/Python via `subprocess`/`exec()` inside a process it
   fully controlled. A Worker has no privileged host process to sandbox
   that in, and a public bot with that capability is an instant RCE
   vector. `compute`/`transform` cover the "custom data shaping" use case
   through a whitelisted, non-Turing-complete evaluator instead.
2. **Session state lives in a Durable Object, not in-process memory.**
   `context.user_data` in `python-telegram-bot` was just a dict living in
   the bot process's memory for the process's lifetime. Workers isolates
   are ephemeral and possibly-concurrent, so the equivalent state (`vars`,
   paused `ask` flows) has to be externalized into a DO, which also means
   it costs a network round trip per read/write instead of being free.
3. **Fernet → Web Crypto AES-GCM.** Same goal (symmetric encryption of
   secrets at rest, keyed by a passphrase), different primitive, because
   Fernet isn't available in `workerd` and Web Crypto is the native,
   audited option.
4. **Cloudflare AI HTTP API → native `env.AI` binding.** The Python
   original had to make an authenticated HTTP call out to Cloudflare's AI
   API. Since the Worker already runs on Cloudflare's edge, `/ai` calls
   `env.AI.run(...)` directly — no `CF_API_TOKEN`/`CF_ACCOUNT_ID` needed at
   all, one fewer secret to manage.
5. **Nested `condition` branches with a pause inside them resume the inner
   branch only.** If an `ask` sits inside a `condition`'s `then`/`else`,
   resuming continues that branch to completion but does not return to any
   sibling actions that were scheduled to run *after* the `condition`
   action in the outer list. This is a deliberate interpreter-simplicity
   tradeoff (see the comment in `dsl/interpreter.ts`), not a Workers
   platform constraint — flagged here in case a config relies on it.
6. **Long-polling → webhooks.** The single biggest structural change: no
   `getUpdates` loop, no persistent process. Every update is a `POST`
   Cloudflare routes to your Worker, verified via the
   `X-Telegram-Bot-Api-Secret-Token` header instead of trusting an
   outbound-initiated connection.

## Repo layout

```
wrangler.toml           Worker config: KV binding, DO binding, AI binding, vars
package.json / tsconfig.json
src/
  index.ts              Hono app: /hook/factory and /hook/:botId routes
  telegram.ts           fetch()-based Telegram Bot API client
  env.ts                shared Env (bindings + vars) interface
  secrets.ts             Web Crypto AES-GCM encrypt/decrypt
  session.do.ts          ChatSession Durable Object
  session-client.ts       thin fetch wrapper for talking to the DO
  factory.ts             all factory-bot commands
  github.ts               GitHub Actions gateway
  ai.ts                    Workers AI-backed command generator
  dsl/
    types.ts               action + config type definitions
    schema.ts               shape validator + public-bot safety checks
    expression.ts            sandboxed `compute` evaluator
    template.ts              {user.x}/{vars.x}/{secrets.x} interpolation
    interpreter.ts           runActions — the DSL execution engine
examples/
  simple-public-bot.json
  price-tracker-bot.json
setup.sh                 one-shot wrangler setup + deploy script
```

## Limitations / known gaps

- `getFile`-based downloads for `/setconfig` are capped by Telegram's own
  20MB bot-API file size limit; large config files should go through
  `/json` in chunks or be hosted and pulled via a `request` step instead.
- The GitHub gateway's `/gh_logs` returns a signed, time-limited download
  URL rather than proxying the (potentially large) zip through the Worker.
- `condition` + nested `ask` resume behavior — see point 5 above.
