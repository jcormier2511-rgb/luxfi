import crypto from "crypto";
import { config } from "../config";

/**
 * Signed, self-contained admin-panel session — no server-side session store. GET /admin needs a
 * login form rather than a token in the URL (unlike every other /admin/* JSON route), but the
 * spec is explicit the panel still authenticates against WEBHOOK_TOKEN, the same single shared
 * secret every other /admin/* route already trusts. The cookie is signed WITH that token, so
 * possessing a valid cookie is exactly as strong a proof as knowing the token was at issue time
 * — and rotating WEBHOOK_TOKEN (like any other env var here, taking effect on the next restart)
 * invalidates every outstanding session, which is the right behavior for a secret rotation.
 */

export const SESSION_COOKIE_NAME = "luxfi_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload: string): string {
  return crypto.createHmac("sha256", config.admin.sessionSecret).update(payload).digest("hex");
}
function signLegacy(payload:string):string {
  return crypto.createHmac("sha256",config.server.webhookToken).update(payload).digest("hex");
}

/**
 * Constant-time string comparison. Buffers of different lengths still run a same-cost dummy
 * comparison rather than returning immediately, so a length mismatch can't be distinguished by
 * timing from a same-length mismatch.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True only when `candidate` matches the configured WEBHOOK_TOKEN, checked in constant time. */
export function isValidAdminToken(candidate: string): boolean {
  return candidate.length > 0 && safeEqual(candidate, config.server.webhookToken);
}

/** `<expiresAtMs>.<hmac-of-expiresAtMs>` — the whole cookie value, nothing else needed to verify it. */
export function createSessionToken(now = Date.now()): string {
  const expiresAt = String(now + SESSION_TTL_MS);
  return `${expiresAt}.${signLegacy(expiresAt)}`;
}

export interface AdminSession { administratorId:number; csrfToken:string; expiresAt:number }
export function createAdministratorSession(administratorId:number, now=Date.now()):string {
  const payload=Buffer.from(JSON.stringify({ administratorId, csrfToken:crypto.randomBytes(24).toString("hex"), expiresAt:now+SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
export function readAdministratorSession(token:string|undefined|null,now=Date.now()):AdminSession|null {
  if(!token)return null;const dot=token.lastIndexOf(".");if(dot<1)return null;const payload=token.slice(0,dot),signature=token.slice(dot+1);if(!safeEqual(signature,sign(payload)))return null;
  try { const value=JSON.parse(Buffer.from(payload,"base64url").toString()); return Number.isInteger(value.administratorId)&&typeof value.csrfToken==='string'&&now<value.expiresAt?value:null; } catch{return null}
}

/** Verifies the signature before ever trusting the embedded expiry, so a tampered cookie can't extend its own life. */
export function isValidSessionToken(token: string | undefined | null, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const expiresAtRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!sig || !safeEqual(sig, signLegacy(expiresAtRaw))) return false;
  const expiresAt = Number(expiresAtRaw);
  return Number.isFinite(expiresAt) && now < expiresAt;
}

/** Minimal manual Cookie-header parser — this is the only route family in the app that needs one, so no new dependency. */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      cookies[name] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

/**
 * HttpOnly (unreachable from page JS) + SameSite=Strict (never sent on a cross-site request,
 * which is what keeps the panel's state-changing routes safe from CSRF without a separate
 * token) + Secure whenever the request itself arrived over HTTPS, directly or via a
 * TLS-terminating proxy's X-Forwarded-Proto (e.g. Railway) — never forced on for local
 * http://localhost dev, where a Secure-only cookie would just silently never be sent.
 */
export function buildSessionCookieHeader(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure || process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

export function buildLogoutCookieHeader(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, "Path=/admin", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure || process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

/** Works whether or not Express's own `trust proxy` is configured — reads the forwarded-proto header directly. */
export function isHttpsRequest(req: { secure?: boolean; headers: Record<string, unknown> }): boolean {
  return Boolean(req.secure) || req.headers["x-forwarded-proto"] === "https";
}
