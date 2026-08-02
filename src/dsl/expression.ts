// ---------------------------------------------------------------------------
// Sandboxed arithmetic expression evaluator for the `compute` action.
//
// This replaces the Python original's `eval()`-based formula action. It is
// a hand-rolled recursive-descent parser over a tiny grammar: numbers,
// identifiers (resolved from a supplied scope object), + - * / % ^,
// unary -, parentheses, and a small whitelist of pure math functions
// (abs, round, floor, ceil, min, max, sqrt). There is no way to reach
// `Function`, `eval`, property access into arbitrary objects, method
// calls, loops, or assignment from this grammar — it cannot execute
// arbitrary JavaScript, which is the entire point.
//
// Never pass user-supplied strings to `eval` or `new Function(...)`
// anywhere in this file or its callers.
// ---------------------------------------------------------------------------

type Scope = Record<string, number>;

const WHITELISTED_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  round: (x: number) => Math.round(x),
  floor: Math.floor,
  ceil: Math.ceil,
  min: (...xs: number[]) => Math.min(...xs),
  max: (...xs: number[]) => Math.max(...xs),
  sqrt: Math.sqrt,
};

type Token =
  | { kind: "num"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

export class ExpressionError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const numStr = src.slice(i, j);
      if ((numStr.match(/\./g) || []).length > 1) {
        throw new ExpressionError(`Malformed number literal: ${numStr}`);
      }
      tokens.push({ kind: "num", value: Number(numStr) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character in expression: '${c}'`);
  }
  return tokens;
}

// Recursive-descent parser + evaluator, combined (parses and evaluates in
// one pass since the grammar is small and side-effect-free).
class Evaluator {
  private tokens: Token[];
  private pos = 0;
  private scope: Scope;

  constructor(tokens: Token[], scope: Scope) {
    this.tokens = tokens;
    this.scope = scope;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new ExpressionError("Unexpected end of expression");
    this.pos++;
    return t;
  }

  run(): number {
    const result = this.parseAddSub();
    if (this.pos !== this.tokens.length) {
      throw new ExpressionError("Unexpected trailing input in expression");
    }
    return result;
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (this.peek()?.kind === "op" && ["+", "-"].includes((this.peek() as any).value)) {
      const op = (this.next() as any).value;
      const right = this.parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parsePow();
    while (this.peek()?.kind === "op" && ["*", "/", "%"].includes((this.peek() as any).value)) {
      const op = (this.next() as any).value;
      const right = this.parsePow();
      if (op === "*") left = left * right;
      else if (op === "/") {
        if (right === 0) throw new ExpressionError("Division by zero");
        left = left / right;
      } else {
        if (right === 0) throw new ExpressionError("Division by zero");
        left = left % right;
      }
    }
    return left;
  }

  private parsePow(): number {
    const base = this.parseUnary();
    if (this.peek()?.kind === "op" && (this.peek() as any).value === "^") {
      this.next();
      const exp = this.parsePow(); // right-associative
      return Math.pow(base, exp);
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peek()?.kind === "op" && (this.peek() as any).value === "-") {
      this.next();
      return -this.parseUnary();
    }
    if (this.peek()?.kind === "op" && (this.peek() as any).value === "+") {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const t = this.next();
    if (t.kind === "num") return t.value;
    if (t.kind === "lparen") {
      const v = this.parseAddSub();
      const close = this.next();
      if (close.kind !== "rparen") throw new ExpressionError("Expected ')'");
      return v;
    }
    if (t.kind === "ident") {
      // function call?
      if (this.peek()?.kind === "lparen") {
        const fn = WHITELISTED_FUNCTIONS[t.value];
        if (!fn) throw new ExpressionError(`Unknown function: ${t.value}`);
        this.next(); // consume lparen
        const args: number[] = [];
        if (this.peek()?.kind !== "rparen") {
          args.push(this.parseAddSub());
          while (this.peek()?.kind === "comma") {
            this.next();
            args.push(this.parseAddSub());
          }
        }
        const close = this.next();
        if (close.kind !== "rparen") throw new ExpressionError("Expected ')' after function args");
        return fn(...args);
      }
      if (!Object.prototype.hasOwnProperty.call(this.scope, t.value)) {
        throw new ExpressionError(`Unknown variable in expression: ${t.value}`);
      }
      const v = this.scope[t.value];
      if (typeof v !== "number" || Number.isNaN(v)) {
        throw new ExpressionError(`Variable '${t.value}' is not a number`);
      }
      return v;
    }
    throw new ExpressionError("Unexpected token in expression");
  }
}

/**
 * Safely evaluate a restricted arithmetic expression against a flat numeric
 * scope. Never uses eval/Function. Throws ExpressionError on anything it
 * doesn't recognize (undefined identifiers, unsupported syntax, etc.) —
 * callers should catch and surface a clean error to the bot user rather
 * than letting a bad formula crash the whole action sequence.
 */
export function evaluateExpression(expression: string, scope: Scope): number {
  if (expression.length > 500) {
    throw new ExpressionError("Expression too long");
  }
  const tokens = tokenize(expression);
  return new Evaluator(tokens, scope).run();
}
