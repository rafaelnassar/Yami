/**
 * Minimal, dependency-free runtime validation with static type inference.
 *
 * Used at every trust boundary: renderer → main (IPC), main → host (protocol),
 * disk → memory (settings/state files). Schemas are composable values:
 *
 *   const StartSchema = v.object({ urls: v.array(v.httpUrl(), { min: 1, max: 500 }) });
 *   type Start = Infer<typeof StartSchema>;
 *   const result = StartSchema.parse(input);
 */
import { err, ok, type Result } from '../kernel/result.ts';

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `urls.3`. Empty for the root. */
  readonly path: string;
  readonly reason: string;
}

export interface Schema<T> {
  parse(input: unknown, path?: string): Result<T, ValidationIssue>;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function joinPath(base: string, key: string | number): string {
  return base ? `${base}.${key}` : String(key);
}

function schema<T>(parse: (input: unknown, path: string) => Result<T, ValidationIssue>): Schema<T> {
  return { parse: (input, path = '') => parse(input, path) };
}

function fail(path: string, reason: string): Result<never, ValidationIssue> {
  return err({ path, reason });
}

interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  readonly trim?: boolean;
  readonly pattern?: RegExp;
  /** Rejects NUL and other C0 control characters (except tab). Default true. */
  readonly noControlChars?: boolean;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F]/;

function string(options: StringOptions = {}): Schema<string> {
  const { min = 0, max = 10_000, trim = false, pattern, noControlChars = true } = options;
  return schema((input, path) => {
    if (typeof input !== 'string') return fail(path, 'expected string');
    const value = trim ? input.trim() : input;
    if (value.length < min) return fail(path, `min length ${min}`);
    if (value.length > max) return fail(path, `max length ${max}`);
    if (noControlChars && CONTROL_CHARS.test(value)) return fail(path, 'control characters');
    if (pattern && !pattern.test(value)) return fail(path, 'invalid format');
    return ok(value);
  });
}

interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly int?: boolean;
}

function number(options: NumberOptions = {}): Schema<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, int = false } = options;
  return schema((input, path) => {
    if (typeof input !== 'number' || !Number.isFinite(input)) return fail(path, 'expected number');
    if (int && !Number.isInteger(input)) return fail(path, 'expected integer');
    if (input < min) return fail(path, `min ${min}`);
    if (input > max) return fail(path, `max ${max}`);
    return ok(input);
  });
}

function boolean(): Schema<boolean> {
  return schema((input, path) => (typeof input === 'boolean' ? ok(input) : fail(path, 'expected boolean')));
}

function literal<const T extends string | number | boolean | null>(expected: T): Schema<T> {
  return schema((input, path) =>
    input === expected ? ok(expected) : fail(path, `expected ${JSON.stringify(expected)}`)
  );
}

function enumeration<const T extends readonly [string, ...string[]]>(values: T): Schema<T[number]> {
  const allowed = new Set<string>(values);
  return schema((input, path) =>
    typeof input === 'string' && allowed.has(input)
      ? ok(input as T[number])
      : fail(path, `expected one of ${values.join('|')}`)
  );
}

interface ArrayOptions {
  readonly min?: number;
  readonly max?: number;
}

function array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
  const { min = 0, max = 10_000 } = options;
  return schema((input, path) => {
    if (!Array.isArray(input)) return fail(path, 'expected array');
    if (input.length < min) return fail(path, `min items ${min}`);
    if (input.length > max) return fail(path, `max items ${max}`);
    const out: T[] = [];
    for (let i = 0; i < input.length; i += 1) {
      const parsed = item.parse(input[i], joinPath(path, i));
      if (!parsed.ok) return parsed;
      out.push(parsed.value);
    }
    return ok(out);
  });
}

type Shape = Record<string, Schema<unknown>>;

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];

type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

type ObjectOutput<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};

interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

interface ObjectOptions {
  /** Reject unknown keys (default true — trust boundaries should be strict). */
  readonly strict?: boolean;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const proto = Object.getPrototypeOf(input) as unknown;
  return proto === Object.prototype || proto === null;
}

function object<S extends Shape>(shape: S, options: ObjectOptions = {}): Schema<Simplify<ObjectOutput<S>>> {
  const { strict = true } = options;
  const keys = Object.keys(shape);
  return schema((input, path) => {
    if (!isPlainObject(input)) return fail(path, 'expected object');
    if (strict) {
      for (const key of Object.keys(input)) {
        if (!(key in shape)) return fail(joinPath(path, key), 'unknown key');
      }
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const field = shape[key] as Schema<unknown>;
      const parsed = field.parse(input[key], joinPath(path, key));
      if (!parsed.ok) return parsed;
      if (parsed.value !== undefined) out[key] = parsed.value;
    }
    return ok(out as Simplify<ObjectOutput<S>>);
  });
}

function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    optional: true,
    parse: (input, path = '') => (input === undefined ? ok(undefined) : inner.parse(input, path))
  };
}

function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return schema((input, path) => (input === null ? ok(null) : inner.parse(input, path)));
}

function record<T>(
  value: Schema<T>,
  options: { maxKeys?: number; key?: Schema<string> } = {}
): Schema<Record<string, T>> {
  const { maxKeys = 1_000, key = string({ min: 1, max: 256 }) } = options;
  return schema((input, path) => {
    if (!isPlainObject(input)) return fail(path, 'expected object');
    const entries = Object.entries(input);
    if (entries.length > maxKeys) return fail(path, `max keys ${maxKeys}`);
    const out: Record<string, T> = {};
    for (const [k, raw] of entries) {
      const parsedKey = key.parse(k, joinPath(path, k));
      if (!parsedKey.ok) return parsedKey;
      const parsed = value.parse(raw, joinPath(path, k));
      if (!parsed.ok) return parsed;
      out[parsedKey.value] = parsed.value;
    }
    return ok(out);
  });
}

function union<T extends readonly Schema<unknown>[]>(...options: T): Schema<Infer<T[number]>> {
  return schema((input, path) => {
    for (const option of options) {
      const parsed = option.parse(input, path);
      if (parsed.ok) return parsed as Result<Infer<T[number]>, ValidationIssue>;
    }
    return fail(path, 'no union member matched');
  });
}

/** Absolute http(s) URL, trimmed, max 4096 chars. */
function httpUrl(): Schema<string> {
  const base = string({ min: 1, max: 4096, trim: true });
  return schema((input, path) => {
    const parsed = base.parse(input, path);
    if (!parsed.ok) return parsed;
    let url: URL;
    try {
      url = new URL(parsed.value);
    } catch {
      return fail(path, 'invalid url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail(path, 'protocol not allowed');
    if (!url.hostname) return fail(path, 'missing host');
    return ok(parsed.value);
  });
}

/** Non-empty filesystem path string (no NUL). Semantic checks happen in the path sandbox. */
function fsPath(): Schema<string> {
  return string({ min: 1, max: 32_767 });
}

/** Stable identifier (conversation ids, batch ids, cookie ids): [A-Za-z0-9_-], 1..128. */
function id(): Schema<string> {
  return string({ min: 1, max: 128, pattern: /^[A-Za-z0-9_-]+$/ });
}

/** Accepts only an empty object (or undefined → {}). Used for commands without payload. */
function empty(): Schema<Record<string, never>> {
  return schema((input, path) => {
    if (input === undefined) return ok({});
    if (!isPlainObject(input) || Object.keys(input).length > 0) return fail(path, 'expected empty object');
    return ok({});
  });
}

/** Escape hatch for values already validated elsewhere (use sparingly). */
function unknownValue(): Schema<unknown> {
  return schema((input) => ok(input));
}

export const v = {
  string,
  number,
  boolean,
  literal,
  enum: enumeration,
  array,
  object,
  optional,
  nullable,
  record,
  union,
  httpUrl,
  fsPath,
  id,
  empty,
  unknown: unknownValue
} as const;

export function formatIssue(issue: ValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.reason}` : issue.reason;
}
