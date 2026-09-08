import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The dashboard session, and why it is a signed cookie rather than a table.
 *
 * There is one user and one password. A sessions table would be a table with
 * one row in it, plus a migration and a cleanup job to maintain it. Instead
 * the cookie carries its own expiry with an HMAC over it, keyed by the
 * dashboard password itself — which buys two things for free: changing the
 * password invalidates every outstanding session, and forging a cookie
 * requires the password you were trying to avoid typing.
 *
 * Not a JWT. There are no claims to carry beyond "this browser typed the
 * password, until this time", and a library would be more attack surface than
 * value for one boolean.
 *
 * Its own module so it can be tested without starting an HTTP server.
 */

export const SESSION_COOKIE = 'bp_session';
export const SESSION_DAYS = 30;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length is not a secret, and timingSafeEqual throws on a mismatch.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const sign = (value: string, secret: string) =>
  createHmac('sha256', secret).update(value).digest('base64url');

/** A token good for SESSION_DAYS, or from `now` when a test needs to pin it. */
export function mintSession(secret: string, now = Date.now()): string {
  const body = String(now + SESSION_DAYS * 864e5);
  return `${body}.${sign(body, secret)}`;
}

/**
 * Whether a token is both untampered and unexpired.
 *
 * The signature is checked before the expiry is trusted, because the expiry
 * is inside the signed payload: reading it first would be believing a number
 * an attacker chose.
 */
export function sessionValid(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(body, secret))) return false;
  const expires = Number(body);
  return Number.isFinite(expires) && expires > now;
}

/** Cookie header to name/value pairs. Absent header is simply no cookies. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape is a malformed cookie, not a crash.
    }
  }
  return out;
}

/**
 * Where to send someone after they sign in.
 *
 * Only ever inside this app. An open redirect on a login form is how a
 * phishing link borrows a real domain: the victim checks the host, signs in
 * for real, and is handed straight to the attacker's page. `//evil.com` is
 * the case worth naming — it is protocol-relative, so it leaves the site
 * while still starting with a slash.
 */
export function safeNext(raw: string | null | undefined, fallback = '/board'): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;
  return raw;
}
