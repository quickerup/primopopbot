// ---------------------------------------------------------------------------
// /ai <botId> <description> — draft a DSL command from natural language
// using the Workers AI binding directly (env.AI.run(...)), no external
// CF_API_TOKEN/CF_ACCOUNT_ID HTTP round trip needed since the Worker
// already has native edge access to Workers AI.
//
// The generated JSON is validated against the same schema used for
// /setconfig and /json before it's ever shown as "ready to save" — and
// even then the factory command handler requires an explicit confirm
// button press, it never auto-saves.
// ---------------------------------------------------------------------------

import { CommandDef } from "./dsl/types";
import { validateConfigShape, SchemaError } from "./dsl/schema";

const SYSTEM_PROMPT = `You generate a single JSON object describing one Telegram bot command for a fixed action DSL. Output ONLY the raw JSON object, no markdown fences, no commentary, no explanation.

Top-level shape (ALL fields required unless marked optional):
{ "command": "lowercase_name", "admin_only": false, "actions": [ ...action objects... ] }

ACTION TYPES — use ONLY these exact shapes:

send_message:
{ "type": "send_message", "text": "Hello {user.first_name}!" }

request (HTTP fetch — use this for any API call):
{ "type": "request", "url": "https://example.com/api", "method": "GET", "headers": { "User-Agent": "PrimoPopBot/1.0" }, "json_key": "dot.path.to.field", "assign": "varname" }
  - "url" is REQUIRED. "method" defaults to GET. "json_key" extracts a nested field. "assign" saves result to a variable.
  - NEVER use "name", "text", "required", or any other fields not listed above.

set_variable:
{ "type": "set_variable", "name": "myvar", "value": "some value" }

ask (prompt user for free-text input):
{ "type": "ask", "prompt": "What topic?", "assign": "topic" }

send_photo:
{ "type": "send_photo", "photo": "https://example.com/img.jpg", "caption": "optional" }

send_location:
{ "type": "send_location", "latitude": 40.7128, "longitude": -74.0060 }

send_dice:
{ "type": "send_dice", "emoji": "🎲" }

send_poll:
{ "type": "send_poll", "question": "Pick one", "options": ["A", "B", "C"] }

send_inline_keyboard:
{ "type": "send_inline_keyboard", "text": "Choose:", "buttons": [[{ "text": "Option A", "callback_data": "a" }]] }

send_keyboard:
{ "type": "send_keyboard", "text": "Choose:", "buttons": [["Option A", "Option B"]] }

condition:
{ "type": "condition", "var": "varname", "equals": "expected", "then": [...actions...], "else": [...actions...] }

ton_connect (TON Connect wallet link; network defaults to mainnet):
{ "type": "ton_connect", "network": "mainnet", "manifest_url": "https://example.com/tonconnect-manifest.json", "ton_proof": "login:{user.id}", "text": "Connect your TON wallet", "button_text": "Connect wallet" }

ton_sign (open your HTTPS signing page with a payload for wallet-side signing):
{ "type": "ton_sign", "network": "testnet", "signing_url": "https://example.com/ton-sign", "payload_type": "text", "payload": "Sign this for {user.id}", "state": "telegram:{chat.id}", "text": "Sign with your TON wallet", "button_text": "Sign" }

Placeholders usable in any string field: {user.id}, {user.first_name}, {chat.id}, {vars.NAME}

EXAMPLE — Wikipedia summary command:
{
  "command": "wiki",
  "admin_only": false,
  "actions": [
    { "type": "request", "url": "https://en.wikipedia.org/api/rest_v1/page/summary/Telegram_(software)", "method": "GET", "headers": { "User-Agent": "PrimoPopBot/1.0" }, "json_key": "extract", "assign": "summary" },
    { "type": "send_message", "text": "{vars.summary}" }
  ]
}

RULES:
- Never use "shell", "python", "eval", or any code-execution action — they do not exist.
- Never invent fields. Use only the exact field names shown above per action type.
- "url" is REQUIRED for "request" actions.`;


export interface AiGenerateResult {
  ok: boolean;
  command?: CommandDef;
  rawText: string;
  error?: string;
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

export async function generateCommandFromDescription(
  ai: Ai,
  description: string
): Promise<AiGenerateResult> {
  const response = (await ai.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Description: ${description}\n\nJSON:` },
    ],
    max_tokens: 800,
  })) as { response?: string };

  const rawText = response.response ?? "";
  const cleaned = stripFences(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, rawText, error: "Model did not return valid JSON." };
  }

  // Wrap as a single-command config for shape validation, then unwrap.
  const wrapped = { version: 1, commands: [parsed] };
  try {
    validateConfigShape(wrapped);
  } catch (err) {
    const msg = err instanceof SchemaError ? err.message : "Schema validation failed.";
    return { ok: false, rawText, error: msg };
  }

  return { ok: true, command: parsed as CommandDef, rawText: cleaned };
}
