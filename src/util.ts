import type { Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const now = () => Date.now();
export const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const yesterday = () => today(Date.now() - DAY);
export const pick = <T>(arr: readonly T[]): T | undefined => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined);
export const snip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt;
};

export function newId(bytes = 6) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Errors thrown from handlers become JSON responses: { error, hint }. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public hint?: string, public retryAfter?: number) {
    super(message);
  }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new ApiError(400, `Invalid ${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return r.data;
}

const MAX_BODY = 32_768;

/** Reads a JSON body. An empty body counts as {}. */
export async function jsonBody(c: Context): Promise<unknown> {
  if (Number(c.req.header('content-length') || 0) > MAX_BODY) throw new ApiError(413, 'Body too large. Even swole agents have limits.');
  const text = await c.req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, 'Body too large. Even swole agents have limits.');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Body is not valid JSON', 'Send Content-Type: application/json');
  }
}
