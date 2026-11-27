import { z } from "zod";
import { roles } from "@/lib/access";
import { hashPassword } from "@/lib/password";
import {
  access,
  accessWithSession,
  ACTIVE_ADMIN,
  audit,
  body,
  db,
  failure,
  guard,
  HttpError,
} from "@/lib/server";

const credentials = {
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/),
  password: z.string().min(12).max(200),
};
const input = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("workspace"),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    name: z.string().trim().min(1).max(100),
    ...credentials,
  }),
  z.object({
    action: z.literal("member"),
    ...credentials,
    role: z.enum(roles),
  }),
  z.object({ action: z.literal("remove"), id: z.string().uuid() }),
]);

export async function GET(req: Request) {
  try {
    const a = await access(req, "manage");
    const [members, events] = await db().batch([
      db()
        .prepare(
          "SELECT id,username,role FROM members WHERE workspace=? ORDER BY username",
        )
        .bind(a.workspace),
      db()
        .prepare(
          "SELECT actor,action,target,created_at AS createdAt FROM audit_log WHERE workspace=? ORDER BY created_at DESC,id DESC LIMIT 100",
        )
        .bind(a.workspace),
    ]);
    return Response.json(
      {
        workspace: a.workspace,
        actor: a.actor,
        members: members.results,
        events: events.results,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request) {
  try {
    guard(req);
    const a = await accessWithSession(req, "manage");
    const authority = [a.sessionId, a.workspace] as const;
    const parsed = input.safeParse(await body(req));
    if (!parsed.success)
      throw new HttpError(
        400,
        "Enter a valid workspace ID or username and a password of at least 12 characters.",
      );
    const p = parsed.data;
    if (p.action === "remove") {
      if (p.id === a.actor)
        throw new HttpError(400, "You cannot remove your own account.");
      const [removed] = await db().batch([
        db()
          .prepare(
            "DELETE FROM members WHERE workspace=? AND id=? AND (role!='admin' OR EXISTS (SELECT 1 FROM members AS other WHERE other.workspace=members.workspace AND other.role='admin' AND other.id!=members.id)) AND " + ACTIVE_ADMIN,
          )
          .bind(a.workspace, p.id, ...authority),
        audit(a, "member.removed", p.id, true),
      ]);
      if (!removed.meta.changes) {
        await access(req, "manage");
        throw new HttpError(404, "Member not found.");
      }
      return Response.json({ ok: true });
    }

    const hash = await hashPassword(p.password);
    const id = crypto.randomUUID();
    if (p.action === "workspace") {
      const [created] = await db().batch([
        db()
          .prepare(
            "INSERT INTO workspaces(id,name) SELECT ?,? WHERE " + ACTIVE_ADMIN + " ON CONFLICT DO NOTHING",
          )
          .bind(p.id, p.name, ...authority),
        db()
          .prepare(
            "INSERT INTO members(id,workspace,username,password_hash,role) SELECT ?,?,?,?,'admin' WHERE changes()=1",
          )
          .bind(id, p.id, p.username, hash),
        audit(
          { workspace: p.id, actor: id, role: "admin" },
          "workspace.created",
          p.id,
          true,
        ),
      ]);
      if (!created.meta.changes) {
        await access(req, "manage");
        throw new HttpError(409, "That workspace ID is already in use.");
      }
    } else {
      if (a.actor === "local-bootstrap" && p.role !== "admin")
        throw new HttpError(
          400,
          "Create the first admin account to finish setup.",
        );
      const [created] = await db().batch([
        db()
          .prepare(
            "INSERT INTO members(id,workspace,username,password_hash,role) SELECT ?,?,?,?,? WHERE " +
              ACTIVE_ADMIN + " ON CONFLICT DO NOTHING",
          )
          .bind(id, a.workspace, p.username, hash, p.role, ...authority),
        audit(a, "member.created", id, true),
      ]);
      if (!created.meta.changes) {
        await access(req, "manage");
        throw new HttpError(409, "That account already exists or initial setup has finished.");
      }
    }
    return Response.json({
      ok: true,
      signInRequired: p.action === "member" && a.actor === "local-bootstrap",
    });
  } catch (e) {
    return failure(e);
  }
}
