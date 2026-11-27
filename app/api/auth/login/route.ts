import { z } from "zod";
import { verifyPassword } from "@/lib/password";
import { db, secret, guard, body, failure, HttpError } from "@/lib/server";
import { createSession, passwordMatches, sessionCookie } from "@/lib/auth";
export async function POST(req: Request) {
  try {
    guard(req);
    const p = z
      .object({
        password: z.string().min(1).max(200),
        workspace: z
          .string()
          .trim()
          .regex(/^[a-z0-9_][a-z0-9_-]{0,63}$/)
          .default("local_seedy"),
        username: z.string().trim().toLowerCase().max(80).optional(),
      })
      .safeParse(await body(req));
    if (!p.success)
      throw new HttpError(400, "Enter your workspace and password.");
    const password = secret("APP_PASSWORD"),
      key = secret("APP_SESSION_SECRET");
    if (key.length < 32)
      throw new HttpError(
        503,
        "Set APP_SESSION_SECRET in app/.env, then restart the app.",
      );
    const now = Date.now();
    const { workspace, username } = p.data;
    const store = db();
    const member = username
      ? await store
          .prepare(
            "SELECT id,password_hash FROM members WHERE workspace=? AND username=?",
          )
          .bind(workspace, username)
          .first<{ id: string; password_hash: string }>()
      : null;
    const url = new URL(req.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const bootstrapAllowed =
      (loopback && secret("TRACE_LOCAL_BOOTSTRAP") === "1") ||
      (url.protocol === "https:" && password.length >= 20);
    // Cloudflare supplies the client address for hosted requests. Local preview
    // deliberately uses one fixed client identity.
    const client =
      !loopback && req.cf ? req.headers.get("CF-Connecting-IP") : null;
    const bucket = JSON.stringify([
      client || "local",
      member?.id ?? (username ? "unknown" : "bootstrap"),
    ]);
    const [, attempt] = await store.batch([
      store.prepare("DELETE FROM login_limits WHERE reset_at<=?").bind(now),
      store
        .prepare(
          "INSERT INTO login_limits(id,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=min(attempts+1,11) RETURNING attempts",
        )
        .bind(bucket, now + 60000),
    ]);
    const limit = attempt.results[0] as { attempts: number } | undefined;
    if (limit && limit.attempts > 10)
      return Response.json(
        { error: "Too many attempts. Try again in one minute." },
        {
          status: 429,
          headers: { "Retry-After": "60", "Cache-Control": "no-store" },
        },
      );
    const claimed =
      !username &&
      workspace === "local_seedy" &&
      (await db()
        .prepare(
          "SELECT id FROM members WHERE workspace=? AND role='admin' LIMIT 1",
        )
        .bind(workspace)
        .first());
    const valid = username
      ? (await verifyPassword(
          p.data.password,
          member?.password_hash ?? "missing." + "0".repeat(64),
        )) && !!member
      : bootstrapAllowed &&
        !!password &&
        workspace === "local_seedy" &&
        !claimed &&
        (await passwordMatches(p.data.password, password));
    if (!valid)
      throw new HttpError(401, "The sign-in details are incorrect. Try again.");
    const { token, session } = await createSession(
      key,
      member ? "account-session-v1" : password,
      now,
      workspace,
    );
    await db().batch([
      db()
        .prepare("DELETE FROM sessions WHERE expires<=?")
        .bind(Math.floor(now / 1000)),
      db()
        .prepare("INSERT INTO sessions(id,owner,expires,actor) VALUES(?,?,?,?)")
        .bind(session.id, session.owner, session.expires, member?.id ?? null),
      db()
        .prepare(
          "INSERT INTO audit_log(id,workspace,actor,action,target,created_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          workspace,
          member?.id ?? "local-bootstrap",
          "session.signed_in",
          workspace,
          now,
        ),
      store.prepare("DELETE FROM login_limits WHERE id=?").bind(bucket),
    ]);
    return Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": sessionCookie(
            token,
            new URL(req.url).protocol === "https:",
          ),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
