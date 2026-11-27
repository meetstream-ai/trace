import { z } from "zod";
import { access, accessWithSession, ACTIVE_ADMIN, body, db, failure, guard, HttpError } from "@/lib/server";

export async function DELETE(req: Request) {
  try {
    guard(req);
    const actor = await accessWithSession(req, "manage");
    const authority = [actor.sessionId, actor.workspace] as const;
    const parsed = z
      .object({ name: z.string().trim().min(1).max(100) })
      .safeParse(await body(req));
    if (!parsed.success)
      throw new HttpError(400, "Choose a project to remove.");
    const { name } = parsed.data;
    const store = db();
    const [removed] = await store.batch([
      store
        .prepare(
          "INSERT INTO audit_log(id,workspace,actor,action,target,created_at) SELECT ?,?,?,'project.removed',?,? WHERE (EXISTS (SELECT 1 FROM meetings WHERE owner=? AND json_extract(data,'$.project')=?) OR EXISTS (SELECT 1 FROM preferences WHERE owner=? AND json_extract(data,'$.defaultProject')=?)) AND " + ACTIVE_ADMIN,
        )
        .bind(
          crypto.randomUUID(),
          actor.workspace,
          actor.actor,
          name,
          Date.now(),
          actor.workspace,
          name,
          actor.workspace,
          name,
          ...authority,
        ),
      store
        .prepare(
          "UPDATE meetings SET data=json_set(data,'$.project',''),revision=revision+1 WHERE owner=? AND json_extract(data,'$.project')=? AND " + ACTIVE_ADMIN,
        )
        .bind(actor.workspace, name, ...authority),
      store
        .prepare(
          "UPDATE preferences SET data=json_set(data,'$.defaultProject',''),revision=revision+1 WHERE owner=? AND json_extract(data,'$.defaultProject')=? AND " + ACTIVE_ADMIN,
        )
        .bind(actor.workspace, name, ...authority),
    ]);
    if (!removed.meta.changes) {
      await access(req, "manage");
      throw new HttpError(404, "Project not found.");
    }
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
