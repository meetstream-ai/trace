import { z } from "zod";
import { accessWithSession, guard, body, failure, HttpError } from "@/lib/server";
import {
  integrationCatalog,
  type IntegrationId,
} from "@/lib/integration-catalog";
import {
  saveIntegration,
  discoverIntegration,
  disconnectIntegration,
} from "@/lib/integration-service";
async function target(req: Request, params: Promise<{ id: string }>) {
  guard(req);
  const a = await accessWithSession(req, "manage");
  const owner = a.workspace;
  const { id } = await params;
  if (!integrationCatalog.some((x) => x.id === id))
    throw new HttpError(404, "Integration not found.");
  return { a, owner, id: id as IntegrationId };
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { a, owner, id } = await target(req, params);
    const p = z
      .object({ action: z.enum(["discover", "save"]), config: z.unknown(), updatedAt: z.string().max(32).optional() })
      .safeParse(await body(req));
    if (!p.success) throw new HttpError(400, "Choose a connection action.");
    if (p.data.action === "discover")
      return Response.json(
        { options: await discoverIntegration(owner, id, p.data.config) },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (p.data.updatedAt === undefined) throw new HttpError(400, "Reload the page to get the connection version.");
    const state = await saveIntegration(a, id, p.data.config, p.data.updatedAt);
    return Response.json(
      { state },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { a, id } = await target(req, params);
    const updatedAt = new URL(req.url).searchParams.get("updatedAt");
    if (updatedAt === null || updatedAt.length > 32)
      throw new HttpError(400, "Reload the page to get the connection version.");
    await disconnectIntegration(a, id, updatedAt);
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
