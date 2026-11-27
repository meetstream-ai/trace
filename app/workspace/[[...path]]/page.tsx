import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { workspaceRoute, canonicalWorkspacePath } from "@/lib/navigation";
import { sessionUser, HttpError } from "@/lib/server";
export const dynamic = "force-dynamic";
export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path } = await params;
  const pathname = canonicalWorkspacePath(path);
  let needsRedirect = path?.[0] === "decisions";
  if (!workspaceRoute(pathname)) notFound();
  const search = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      const legacyTab = key === "tab" && item === "decisions";
      query.append(key, legacyTab ? "discussions" : item);
      if (legacyTab) needsRedirect = true;
    }
  }
  const target = pathname + (query.size ? `?${query}` : "");
  if (needsRedirect) redirect(target);
  try {
    await sessionUser((await headers()).get("cookie"));
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 503))
      redirect(
        `/login?next=${encodeURIComponent(target)}`,
      );
    throw e;
  }
  if (!path?.length) redirect("/workspace/meetings");
  return null;
}
