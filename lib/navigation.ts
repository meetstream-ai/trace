export const workspaceViews = [
  "meetings",
  "discussions",
  "actions",
  "integrations",
  "settings",
  "profile",
] as const;
export type WorkspaceView = (typeof workspaceViews)[number];
export function workspaceRoute(
  pathname: string,
): { view: WorkspaceView; meetingId: string | null } | null {
  const parts = pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts[0] !== "workspace") return null;
  const view = parts[1] === "decisions" ? "discussions" : parts[1] || "meetings";
  if (!workspaceViews.includes(view as WorkspaceView)) return null;
  if (parts.length > 2 && (view !== "meetings" || parts.length !== 3))
    return null;
  try {
    return {
      view: view as WorkspaceView,
      meetingId: parts[2] ? decodeURIComponent(parts[2]) : null,
    };
  } catch {
    return null;
  }
}
export function meetingPath(id: string) {
  return `/workspace/meetings/${encodeURIComponent(id)}`;
}

// Vinext can supply encoded route params; normalize once before building a return URL.
export function canonicalWorkspacePath(parts?: string[]) {
  return (
    "/workspace/" +
    (parts?.length
      ? parts
          .map((part, index) => {
            if (index === 0 && part === "decisions") return "discussions";
            try {
              return encodeURIComponent(decodeURIComponent(part));
            } catch {
              return encodeURIComponent(part);
            }
          })
          .join("/")
      : "meetings")
  );
}
