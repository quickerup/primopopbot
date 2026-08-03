// ---------------------------------------------------------------------------
// Action DSL type definitions.
//
// Deliberately mirrors the shape of the original Python action DSL, minus
// `shell` and `python`. Those two action types executed arbitrary code on
// the host process (subprocess / exec()) — there is no privileged host
// process here to sandbox them in, and porting them would turn any public
// child bot into a remote-code-execution endpoint. `compute` and
// `transform` below provide the same "custom data shaping" outcome through
// a whitelisted, non-Turing-complete evaluator instead.
// ---------------------------------------------------------------------------

export type ActionType =
  | "send_message"
  | "send_photo"
  | "send_document"
  | "send_location"
  | "send_dice"
  | "send_poll"
  | "send_inline_keyboard"
  | "send_keyboard"
  | "request"
  | "set_variable"
  | "transform"
  | "compute"
  | "sort_slice"
  | "condition"
  | "ask"
  | "log_event"
  | "pick_random"
  | "pick_unseen"
  | "format_list"
  | "aggregate"
  | "telegram_api"
  | "ton_connect"
  | "ton_sign";

// Action types that are never allowed in a config saved against a PUBLIC
// bot. `request` is conditionally dangerous (SSRF/open-proxy risk) so it's
// not in this hard-block list — it's instead constrained at runtime by the
// per-chat rate limiting and by requiring `compute` formulas on public bots
// to come from the fixed whitelist only.
export const PUBLIC_BOT_FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  "shell",
  "python",
  "exec",
  "eval",
]);

export interface BaseAction {
  type: ActionType;
  // Optional condition-of-execution; if present and falsy, action is skipped.
  when?: { var: string; equals?: string | number | boolean; not_equals?: string | number | boolean };
}

export interface SendMessageAction extends BaseAction {
  type: "send_message";
  text: string;
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  disable_web_page_preview?: boolean;
}

export interface SendPhotoAction extends BaseAction {
  type: "send_photo";
  photo: string; // URL or file_id
  caption?: string;
}

export interface SendDocumentAction extends BaseAction {
  type: "send_document";
  document: string;
  caption?: string;
}

export interface SendLocationAction extends BaseAction {
  type: "send_location";
  latitude: number;
  longitude: number;
}

export interface SendDiceAction extends BaseAction {
  type: "send_dice";
  emoji?: "🎲" | "🎯" | "🏀" | "⚽" | "🎳" | "🎰";
}

export interface SendPollAction extends BaseAction {
  type: "send_poll";
  question: string;
  options: string[];
  is_anonymous?: boolean;
  allows_multiple_answers?: boolean;
}

export interface KeyboardButtonSpec {
  text: string;
  // inline-only:
  url?: string;
  callback_data?: string;
}

export interface SendInlineKeyboardAction extends BaseAction {
  type: "send_inline_keyboard";
  text: string;
  buttons: KeyboardButtonSpec[][]; // rows of buttons
}

export interface SendKeyboardAction extends BaseAction {
  type: "send_keyboard";
  text: string;
  buttons: string[][]; // rows of plain reply-keyboard labels
  one_time?: boolean;
}

export interface RequestAction extends BaseAction {
  type: "request";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  json_key?: string; // dot-path into the response JSON to extract, e.g. "data.items"
  assign?: string;   // variable name to store the (possibly extracted) result into
  on_error?: "throw" | "ignore"; // default: "throw"
}

export interface SetVariableAction extends BaseAction {
  type: "set_variable";
  name: string;
  value: unknown; // may contain {placeholders}
}

export interface TransformAction extends BaseAction {
  type: "transform";
  source: string; // variable name, must hold an array
  assign: string; // variable name to write the result to
  op: "map" | "filter" | "pluck";
  // map: { field: "newField", from: "sourceField" } pairs
  fields?: Record<string, string>;
  // filter: keep items where item[field] compares to value
  filter?: { field: string; op: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains"; value: unknown };
  // pluck: extract a single field into a flat array
  field?: string;
}

export interface ComputeAction extends BaseAction {
  type: "compute";
  // If `source` is set, `expression` is evaluated once per item of that
  // array variable, with each item's fields available as bare identifiers
  // (plus `index`), and the result assigned to `as` on each item (in a new
  // array written to `assign`). If `source` is omitted, `expression` is
  // evaluated once against the full `vars` bag and the scalar result is
  // written directly to `assign`.
  source?: string;
  expression: string; // e.g. "(a - b) / b * 100", whitelisted-evaluator only
  as?: string;
  assign: string;
}

export interface SortSliceAction extends BaseAction {
  type: "sort_slice";
  source: string;
  assign: string;
  key: string; // numeric field to sort by
  order?: "asc" | "desc";
  top?: number;
  divide_by?: number;
  divide_as?: string;
}

export interface ConditionAction extends BaseAction {
  type: "condition";
  var: string;
  equals?: string | number | boolean | null;
  not_equals?: string | number | boolean | null;
  gt?: number;
  lt?: number;
  then: Action[];
  else?: Action[];
}

export interface AskAction extends BaseAction {
  type: "ask";
  prompt: string;
  assign: string; // variable name the next free-text reply gets written to
}

export interface LogEventAction extends BaseAction {
  type: "log_event";
  name: string;  // event name, e.g. "wiki_search"
  value: string; // value to record — supports {vars.*} placeholders
}

export interface PickRandomAction extends BaseAction {
  type: "pick_random";
  source: string; // variable holding an array
  assign: string;
}

export interface PickUnseenAction extends BaseAction {
  type: "pick_unseen";
  source: string;       // var holding the full candidate array
  key: string;           // field used as the unique id, e.g. "id"
  seen_key: string;      // var name that persists the array of already-picked ids
  assign: string;        // var to receive the chosen item (or null)
  exhausted_flag?: string; // var set true/false; defaults to `${assign}_exhausted`
}

export interface FormatListAction extends BaseAction {
  type: "format_list";
  source: string;
  item_template: string; // {field} pulls from each item; {index} is 1-based position
  join_with?: string;    // default "\n"
  assign: string;        // receives the joined string
}

export interface AggregateAction extends BaseAction {
  type: "aggregate";
  source: string;
  field: string;
  op: "max" | "min" | "sum" | "avg" | "count";
  assign: string;
}

export interface TelegramApiAction extends BaseAction {
  type: "telegram_api";
  // Calls any Telegram Bot API method with a templated JSON payload. The
  // current chat id is injected automatically when payload.chat_id is omitted.
  method: string;
  payload?: Record<string, unknown>;
  assign?: string;
}

export interface TonConnectAction extends BaseAction {
  type: "ton_connect";
  network?: "mainnet" | "testnet";
  manifest_url: string;
  ton_proof?: string;
  wallet_universal_url?: string;
  return_url?: string;
  text?: string;
  button_text?: string;
  assign?: string;
}

export interface TonSignAction extends BaseAction {
  type: "ton_sign";
  network?: "mainnet" | "testnet";
  signing_url: string;
  payload: string;
  payload_type?: "text" | "binary" | "cell";
  return_url?: string;
  state?: string;
  text?: string;
  button_text?: string;
  assign?: string;
}

export type Action =
  | SendMessageAction
  | SendPhotoAction
  | SendDocumentAction
  | SendLocationAction
  | SendDiceAction
  | SendPollAction
  | SendInlineKeyboardAction
  | SendKeyboardAction
  | RequestAction
  | SetVariableAction
  | TransformAction
  | ComputeAction
  | SortSliceAction
  | ConditionAction
  | AskAction
  | LogEventAction
  | PickRandomAction
  | PickUnseenAction
  | FormatListAction
  | AggregateAction
  | TelegramApiAction
  | TonConnectAction
  | TonSignAction;

export interface CommandDef {
  command: string; // without leading slash
  description?: string;
  admin_only?: boolean;
  actions: Action[];
}

export interface BotConfig {
  version: number;
  // If set, plain-text messages that don't start with / (and aren't mid-ask)
  // are dispatched to this command with the raw text available as {vars.text}.
  default_command?: string;
  commands: CommandDef[];
}

export interface BotRecord {
  botId: string; // @username
  token: string;
  ownerId: string;
  visibility: "public" | "private";
  createdAt: string;
}
