import {
  access,
  accessWithSession,
  ACTIVE_ADMIN,
  audit,
  db,
  guard,
  body,
  failure,
  HttpError,
} from "@/lib/server";
import { preferencesSchema } from "@/lib/preferences";
export async function PUT(req: Request) {
  try {
    guard(req);
    const a = await accessWithSession(req, "manage");
    const owner = a.workspace;
    const p = preferencesSchema.safeParse(await body(req));
    if (!p.success)
      throw new HttpError(
        400,
        "Use a name, workspace name and valid email address.",
      );
    const next = { ...p.data, revision: p.data.revision + 1 };
    const [result] = await db().batch([
      db()
        .prepare(
          "INSERT INTO preferences(owner,data,revision) SELECT ?,?,? WHERE " + ACTIVE_ADMIN +
            " ON CONFLICT(owner) DO UPDATE SET data=excluded.data,revision=excluded.revision WHERE preferences.revision=?",
        )
        .bind(owner, JSON.stringify(next), next.revision, a.sessionId, owner, p.data.revision),
      audit(a, "workspace.settings_changed", owner, true),
    ]);
    if (!result.meta.changes) {
      await access(req, "manage");
      throw new HttpError(
        409,
        "Settings changed in another tab. Reload and try again.",
      );
    }
    return Response.json({ preferences: next });
  } catch (e) {
    return failure(e);
  }
}
