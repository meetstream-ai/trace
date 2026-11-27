import { readResponseJson } from "./response-body.ts";
import { isGithubRepository } from "./integration-catalog.ts";
import { HttpError } from "./errors.ts";
import type {
  IntegrationConfig,
  IntegrationOptions,
} from "./integration-catalog.ts";
export async function providerRead(
  url: string,
  headers: Record<string, string>,
) {
  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
      // Workerd supports manual/follow; reject redirects through the status check below.
      redirect: "manual",
    });
  } catch {
    throw new HttpError(
      502,
      "The service did not respond. Check your connection and try again.",
    );
  }
  if (!response.ok)
    throw new HttpError(
      400,
      response.status === 401 || response.status === 403
        ? "The service rejected these credentials. Check the key and permissions."
        : `The service returned HTTP ${response.status}. Check your settings and try again.`,
    );
  return readResponseJson(response) as Promise<Record<string, unknown>>;
}
export async function linearOptions(
  c: IntegrationConfig,
): Promise<IntegrationOptions> {
  let response: Response;
  try {
    response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: c.token || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query:
          "query TraceConnect { viewer { name } teams(first:100) { nodes { id name } } users(first:100) { nodes { id name } pageInfo { hasNextPage } } }",
      }),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
  } catch {
    throw new HttpError(502, "Linear did not respond. Try again.");
  }
  if (!response.ok)
    throw new HttpError(
      400,
      "Linear rejected this key. Check the key and its permissions.",
    );
  const result = (await readResponseJson(response)) as {
    errors?: unknown[];
    data?: {
      viewer: { name: string };
      teams: { nodes: { id: string; name: string }[] };
      users: {
        nodes: { id: string; name: string }[];
        pageInfo?: { hasNextPage: boolean };
      };
    };
  };
  if (result.errors?.length || !result.data)
    throw new HttpError(
      400,
      "Linear could not read your teams and members. Check the key permissions.",
    );
  if (result.data.users.pageInfo?.hasNextPage)
    throw new HttpError(
      400,
      "This reference supports up to 100 Linear members. Use a key scoped to a smaller workspace.",
    );
  return {
    account: result.data.viewer.name,
    teams: result.data.teams.nodes,
    users: result.data.users.nodes,
  };
}
export async function githubOptions(
  c: IntegrationConfig,
): Promise<IntegrationOptions> {
  if (!isGithubRepository(c.repository || ""))
    throw new HttpError(400, "Enter a repository as owner/name.");
  const headers = {
    Authorization: `Bearer ${c.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Trace-Discussion-Agent",
  };
  const [repo, account] = await Promise.all([
    providerRead(`https://api.github.com/repos/${c.repository}`, headers),
    providerRead("https://api.github.com/user", headers),
  ]);
  if (repo.has_issues === false)
    throw new HttpError(400, "Enable Issues in this repository first.");
  const users: { id: string; name: string }[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = (await providerRead(
      `https://api.github.com/repos/${c.repository}/assignees?per_page=100&page=${page}`,
      headers,
    )) as unknown as { login: string }[];
    if (!Array.isArray(result))
      throw new HttpError(502, "GitHub returned an unexpected member list.");
    users.push(...result.map((u) => ({ id: u.login, name: u.login })));
    if (result.length < 100) break;
    if (page === 5)
      throw new HttpError(
        400,
        "This reference supports up to 500 repository assignees.",
      );
  }
  return {
    account: String(account.name || account.login),
    teams: [],
    users,
    repository: String(repo.full_name || c.repository),
  };
}
