import { z } from "zod";
import { safeDeliveryLink } from "./delivery-link.ts";
import { HttpError } from "./errors.ts";
import { isGithubRepository } from "./integration-catalog.ts";
import { deliveryMarker } from "./publish.ts";
import { readResponseJson } from "./response-body.ts";

const linearIssues = z.object({
  data: z.object({
    issues: z.object({
      nodes: z.array(z.object({ id: z.string(), description: z.string().nullable(), url: z.string() })),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
  errors: z.array(z.unknown()).max(0).optional(),
});
const githubIssues = z.array(z.object({
  html_url: z.string(),
  body: z.string().nullable(),
  pull_request: z.unknown().optional(),
}));

export async function findDeliveredIssue(
  delivery: { id: string; meetingId: string; itemId: string; destination: "linear" | "github"; createdAt: string },
  config: Record<string, string>,
): Promise<string | null> {
  const { destination } = delivery;
  const marker = deliveryMarker(delivery.meetingId, delivery.itemId, destination);
  const matches = new Set<string>();
  const signal = AbortSignal.timeout(18000);
  let complete = false;
  const hasMarker = (body: string | null) =>
    body?.split(/\r?\n/).some((line) => line.trim() === marker);
  function record(url: string) {
    const link = safeDeliveryLink(url, destination);
    if (!link) throw new Error("Missing issue link");
    const parsed = new URL(link);
    if (destination === "github") {
      const repository = config.GITHUB_REPOSITORY.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      const prefix = "/" + repository + "/issues/";
      if (parsed.hostname !== "github.com" || !path.startsWith(prefix) ||
        !/^\d+$/.test(path.slice(prefix.length)))
        throw new Error("Unexpected issue repository");
    }
    matches.add(link);
  }
  async function lookup(url: string, init: RequestInit) {
    const response = await fetch(url, { ...init, signal, redirect: "manual" });
    if (!response.ok) throw new Error("Issue lookup failed");
    return response;
  }
  try {
    if (destination === "linear") {
      if (!config.LINEAR_API_KEY || !config.LINEAR_TEAM_ID)
        throw new HttpError(409, "Connect Linear before checking this delivery.");
      let after: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const response = await lookup("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: config.LINEAR_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query FindTraceIssue($filter: IssueFilter!, $after: String) {
              issues(filter: $filter, first: 50, after: $after, includeArchived: true) {
                nodes { id url description } pageInfo { hasNextPage endCursor }
              }
            }`,
            variables: { after, filter: { or: [{ id: { eq: delivery.id } }, { description: { contains: marker } }] } },
          }),
        });
        const { nodes, pageInfo } = linearIssues.parse(await readResponseJson(response, 8 * 1024 * 1024)).data.issues;
        for (const node of nodes)
          if (node.id === delivery.id || hasMarker(node.description)) record(node.url);
        if (!pageInfo.hasNextPage) { complete = true; break; }
        if (!pageInfo.endCursor || seen.has(pageInfo.endCursor)) break;
        after = pageInfo.endCursor;
        seen.add(after);
      }
    } else {
      const repository = config.GITHUB_REPOSITORY || "";
      if (!config.GITHUB_TOKEN || !isGithubRepository(repository))
        throw new HttpError(409, "Connect GitHub before checking this delivery.");
      const since = new Date(Date.parse(delivery.createdAt) - 300_000).toISOString();
      for (let page = 1; page <= 10; page++) {
        const query = new URLSearchParams({ state: "all", since, per_page: "100", page: String(page) });
        const response = await lookup(`https://api.github.com/repos/${repository}/issues?${query}`, {
          headers: {
            Authorization: `Bearer ${config.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Trace-Discussion-Agent",
          },
        });
        const nodes = githubIssues.parse(await readResponseJson(response, 8 * 1024 * 1024));
        for (const node of nodes)
          if (!node.pull_request && hasMarker(node.body)) record(node.html_url);
        if (nodes.length < 100 && !/rel="next"/.test(response.headers.get("link") ?? "")) {
          complete = true;
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not check the destination. Check the connection and try again.");
  }
  if (!complete)
    throw new HttpError(409, "The issue check was incomplete. Open the destination to verify the delivery.");
  if (matches.size > 1)
    throw new HttpError(409, "Multiple issues match this delivery. Open the destination to resolve them.");
  return matches.values().next().value ?? null;
}
