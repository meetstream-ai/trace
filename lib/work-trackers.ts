import type { IntegrationConfig } from "./integration-catalog.ts";

export function jiraSite(value = "") {
  return /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net\/?$/i.test(value)
    ? new URL(value).origin : "";
}

export function jiraConnection(config: IntegrationConfig) {
  const site = jiraSite(config.site);
  const project = config.projectKey?.toUpperCase() || "";
  const issueType = config.issueType?.trim() || "Task";
  if (!site || !/^[A-Z][A-Z0-9]{0,30}$/.test(project) || !config.email || !config.token)
    throw new Error("Enter an Atlassian Cloud site, email, API token, and project key.");
  const credentials = new TextEncoder().encode(config.email + ":" + config.token);
  const authorization = "Basic " + btoa(Array.from(credentials, (byte) => String.fromCharCode(byte)).join(""));
  return { site, project, issueType, authorization };
}

export function trelloConnection(config: IntegrationConfig) {
  const { apiKey, token, listId } = config;
  if (!apiKey || !/^[a-z0-9]+$/i.test(apiKey) ||
    !token || !/^[a-z0-9_-]+$/i.test(token) || !listId || !/^[a-f0-9]{24}$/i.test(listId))
    throw new Error("Enter a Trello API key, token, and list ID.");
  return { listId, authorization: `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"` };
}
