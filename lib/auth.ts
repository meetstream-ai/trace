import { timingSafeEqual } from "node:crypto";
export const SESSION_COOKIE = "trace_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 7;
const bytes = (s: string) => new TextEncoder().encode(s);
function base64(data: Uint8Array) {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function unbase64(text: string) {
  return Uint8Array.from(
    atob(text.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
async function key(secret: string, password: string) {
  return crypto.subtle.importKey(
    "raw",
    bytes(`${secret}\0${password}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function passwordMatches(input: string, expected: string) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", bytes(input)),
    crypto.subtle.digest("SHA-256", bytes(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
export async function createSession(
  secret: string,
  password: string,
  now = Date.now(),
  owner = "local_seedy",
) {
  const session = {
    id: crypto.randomUUID(),
    owner,
    expires: Math.floor(now / 1000) + SESSION_SECONDS,
  };
  const payload = base64(bytes(JSON.stringify(session)));
  const signature = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(secret, password),
        bytes(payload),
      ),
    ),
  );
  return { token: `${payload}.${signature}`, session };
}
export async function verifySession(
  token: string,
  secret: string,
  password: string,
  now = Date.now(),
) {
  try {
    if (!secret || !password || token.length > 1500) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret, password),
        unbase64(parts[1]),
        bytes(parts[0]),
      ))
    )
      return null;
    const session = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    if (
      typeof session.id !== "string" ||
      session.id.length > 100 ||
      typeof session.owner !== "string" ||
      !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(session.owner) ||
      !Number.isInteger(session.expires) ||
      session.expires <= now / 1000
    )
      return null;
    return session as { id: string; owner: string; expires: number };
  } catch {
    return null;
  }
}
export function readSessionCookie(cookie: string | null) {
  return (
    cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1) || ""
  );
}
export function sessionCookie(token: string, secure: boolean, logout = false) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${logout ? 0 : SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}
export function safeReturnTo(path: string | null | undefined) {
  return typeof path === "string" &&
    path &&
    /^\/workspace(?:\/|\?|$)/.test(path) &&
    !/[\\\r\n]/.test(path)
    ? path
    : "/workspace/meetings";
}
