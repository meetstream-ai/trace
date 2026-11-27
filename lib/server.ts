import { safeDeliveryLink } from "./delivery-link";
import { can, roles, type Access, type Permission, type Role } from "./access";
import { HttpError } from "./errors";
import { readSessionCookie, verifySession } from "./auth";
import { env } from "cloudflare:workers";
import {
  readStoredMeeting,
  type Meeting,
  type IntegrationStatus,
  type Delivery,
} from "./types";
export function db() {
  if (!env.DB) throw new Error("Database is not configured.");
  return env.DB;
}
export function secret(name: string): string {
  return (
    (env as unknown as Record<string, string>)[name] || process.env[name] || ""
  );
}
export type SessionAccess = Access & { sessionId: string };

// Use inside a write statement so revocation and the write have a defined order.
export const ACTIVE_ADMIN = `EXISTS (
  SELECT 1 FROM sessions AS s
  LEFT JOIN members AS m ON m.id=s.actor AND m.workspace=s.owner
  WHERE s.id=? AND s.owner=? AND s.expires>unixepoch()
    AND (m.role='admin' OR (s.actor IS NULL AND s.owner='local_seedy'
      AND NOT EXISTS (SELECT 1 FROM members WHERE workspace=s.owner AND role='admin')))
)`;

export async function sessionAccess(
  cookie: string | null,
): Promise<SessionAccess> {
  const password = secret("APP_PASSWORD"),
    sessionSecret = secret("APP_SESSION_SECRET");
  if (sessionSecret.length < 32)
    throw new HttpError(
      503,
      "Set APP_SESSION_SECRET in app/.env, then restart the app.",
    );
  const token = readSessionCookie(cookie);
  const accountSession = await verifySession(
    token,
    sessionSecret,
    "account-session-v1",
  );
  const session =
    accountSession ?? (await verifySession(token, sessionSecret, password));
  if (!session)
    throw new HttpError(401, "Your workspace is locked. Sign in to continue.");
  const row = await db()
    .prepare(
      "SELECT sessions.actor, members.role FROM sessions LEFT JOIN members ON members.id=sessions.actor AND members.workspace=sessions.owner WHERE sessions.id=? AND sessions.owner=? AND sessions.expires>?",
    )
    .bind(session.id, session.owner, Math.floor(Date.now() / 1000))
    .first<{ actor: string | null; role: Role | null }>();
  if (!row) throw new HttpError(401, "Your session has ended. Sign in again.");
  if (!accountSession && !row.actor && session.owner === "local_seedy") {
    const claimed = await db()
      .prepare(
        "SELECT id FROM members WHERE workspace=? AND role='admin' LIMIT 1",
      )
      .bind(session.owner)
      .first();
    if (!claimed)
      return {
        workspace: session.owner,
        actor: "local-bootstrap",
        role: "admin",
        sessionId: session.id,
      };
  }
  if (!accountSession || !row.actor || !row.role || !roles.includes(row.role))
    throw new HttpError(401, "Your session has ended. Sign in again.");
  return {
    workspace: session.owner,
    actor: row.actor,
    role: row.role,
    sessionId: session.id,
  };
}
export async function sessionUser(cookie: string | null) {
  return (await sessionAccess(cookie)).workspace;
}
export async function accessWithSession(
  req: Request,
  permission: Permission = "read",
) {
  const a = await sessionAccess(req.headers.get("cookie"));
  if (!can(a.role, permission))
    throw new HttpError(403, "Your workspace role does not allow this action.");
  return a;
}
export async function access(
  req: Request,
  permission: Permission = "read",
): Promise<Access> {
  const { workspace, actor, role } = await accessWithSession(req, permission);
  return { workspace, actor, role };
}
export async function user(req: Request, permission: Permission = "read") {
  return (await access(req, permission)).workspace;
}
export function audit(
  a: Access,
  action: string,
  target: string,
  afterChange = false,
) {
  return db()
    .prepare(
      "INSERT INTO audit_log(id,workspace,actor,action,target,created_at) SELECT ?,?,?,?,?,?" +
        (afterChange ? " WHERE changes()=1" : ""),
    )
    .bind(
      crypto.randomUUID(),
      a.workspace,
      a.actor,
      action,
      target,
      Date.now(),
    );
}
export { HttpError } from "./errors";
export function guard(req: Request) {
  const origin = req.headers.get("Origin");
  if (
    req.headers.get("Sec-Fetch-Site") === "cross-site" ||
    (origin && origin !== new URL(req.url).origin)
  )
    throw new HttpError(403, "Cross-origin requests are not allowed.");
}
export async function body(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > 650000)
    throw new HttpError(413, "Request is too large.");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 650000) {
        await reader.cancel();
        throw new HttpError(413, "Request is too large.");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request must be valid JSON.");
  }
}
export function failure(error: unknown) {
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError)
    return Response.json({ error: "Invalid input." }, { status: 400 });
  console.error(
    "Trace request failed",
    error instanceof Error ? error.name : "Unknown error",
  );
  return Response.json(
    { error: "The request could not be completed. Please try again." },
    { status: 500 },
  );
}
export async function getMeeting(owner: string, id: string): Promise<Meeting> {
  const row = await db()
    .prepare("SELECT data,revision FROM meetings WHERE owner=? AND id=?")
    .bind(owner, id)
    .first<{ data: string; revision: number }>();
  if (!row) throw new HttpError(404, "Meeting not found.");
  return readStoredMeeting(row.data, row.revision);
}
export async function getDeliveries(owner: string): Promise<Delivery[]> {
  const rows = await db()
    .prepare(
      "SELECT id,meeting_id AS meetingId,item_id AS itemId,destination,status,url,created_at AS createdAt,followup_of AS followupOf FROM deliveries WHERE owner=? ORDER BY created_at DESC",
    )
    .bind(owner)
    .all<Omit<Delivery, "error">>();
  return rows.results.map((delivery) => ({
    ...delivery,
    url: safeDeliveryLink(delivery.url, delivery.destination),
    error:
      delivery.status === "uncertain"
        ? "Delivery could not be confirmed. Check the destination before reconciling."
        : "",
  }));
}
export async function fingerprint(segments: Meeting["segments"]) {
  const text = JSON.stringify(
    segments.map((s) => [
      s.speaker.trim().toLowerCase(),
      s.start,
      s.text.replace(/\s+/g, " ").trim().toLowerCase(),
    ]),
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
