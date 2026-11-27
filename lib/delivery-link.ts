import type { Destination } from "./types.ts";

export function safeDeliveryLink(value: string, destination: Destination) {
  if (
    destination !== "linear" &&
    destination !== "github" &&
    destination !== "jira" && destination !== "trello" &&
    destination !== "notion"
  )
    return "";
  try {
    const url = new URL(value);
    const host =
      destination === "linear"
        ? "linear.app"
        : destination === "github"
          ? "github.com"
          : destination === "jira" ? "atlassian.net"
            : destination === "trello" ? "trello.com" : "";
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (!host || url.hostname === host || url.hostname.endsWith("." + host))
    )
      return url.href;
  } catch {
    // A missing or malformed URL is rendered without a link.
  }
  return "";
}
