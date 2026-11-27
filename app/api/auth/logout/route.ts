import { db, secret, guard, failure } from "@/lib/server";
import { readSessionCookie, verifySession, sessionCookie } from "@/lib/auth";
export async function POST(req: Request) {
  try {
    guard(req);
    const token = readSessionCookie(req.headers.get("cookie"));
    const key = secret("APP_SESSION_SECRET");
    const session =
      (await verifySession(token, key, secret("APP_PASSWORD"))) ??
      (await verifySession(token, key, "account-session-v1"));
    if (session && key.length >= 32)
      await db().batch([
        db()
          .prepare(
            "INSERT INTO audit_log(id,workspace,actor,action,target,created_at) SELECT ?,owner,COALESCE(actor,'local-bootstrap'),'session.signed_out',owner,? FROM sessions WHERE id=? AND owner=?",
          )
          .bind(crypto.randomUUID(), Date.now(), session.id, session.owner),
        db()
          .prepare("DELETE FROM sessions WHERE id=? AND owner=?")
          .bind(session.id, session.owner),
      ]);
    return Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": sessionCookie(
            "",
            new URL(req.url).protocol === "https:",
            true,
          ),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
