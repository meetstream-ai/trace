export const integrationCatalog = [
  {
    id: "linear",
    name: "Linear",
    description: "Create issues from approved action items.",
    tag: "Issue tracking",
    url: "https://linear.app/settings/account/security",
    help: "Paste an API key. Choose your team. Matching meeting speakers to members is optional.",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Keep discussions and owned work close to the code.",
    tag: "Development",
    url: "https://github.com/settings/personal-access-tokens",
    help: "Use a token with Issues write access, then enter the repository as owner/name.",
  },
  {
    id: "jira",
    name: "Jira",
    description: "Create Jira Cloud issues from approved action items.",
    tag: "Issue tracking",
    url: "https://id.atlassian.com/manage-profile/security/api-tokens",
    help: "Use an Atlassian API token with your email, site, and project.",
  },
  {
    id: "trello",
    name: "Trello",
    description: "Create cards in a list from approved action items.",
    tag: "Task tracking",
    url: "https://trello.com/apps/admin",
    help: "Use a Trello API key and token with write access, and enter the destination list ID.",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Send a meeting summary to the channel your team uses.",
    tag: "Communication",
    url: "https://api.slack.com/apps",
    help: "Paste an incoming webhook for your channel. Connection is confirmed on the first delivery.",
  },
  {
    id: "webhook",
    name: "Signed webhook",
    description: "Deliver approved discussions and tasks to your system.",
    tag: "Automation",
    url: "/workspace/settings",
    help: "Use an endpoint allowed for this workspace and a shared secret of at least 32 characters.",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Add accepted ADRs to your shared knowledge base.",
    tag: "Documentation",
    url: "https://www.notion.so/profile/integrations",
    help: "Share a parent page with your Notion integration, then paste its link and integration key.",
  },
  {
    id: "meetstream",
    name: "MeetStream",
    description: "Import speaker-labelled, timestamped meeting transcripts.",
    tag: "Meeting infrastructure",
    url: "https://app.meetstream.ai/api-key",
    help: "Paste your MeetStream API key. It is checked when you import a transcript.",
  },
  {
    id: "ai",
    name: "Claude",
    description: "Extract contextual discussions and commitments with Claude.",
    tag: "Intelligence",
    url: "https://console.anthropic.com/",
    help: "Paste your Anthropic key. Explicit discussion extraction also works without AI.",
  },
] as const;
export type IntegrationId = (typeof integrationCatalog)[number]["id"];
export type IntegrationConfig = {
  token?: string;
  site?: string;
  email?: string;
  projectKey?: string;
  issueType?: string;
  apiKey?: string;
  listId?: string;
  teamId?: string;
  repository?: string;
  assignees?: Record<string, string>;
  webhookUrl?: string;
  parentPageId?: string;
  model?: string;
  disabled?: boolean;
};
export type IntegrationState = {
  configured: boolean;
  verified: boolean;
  source: "saved" | "environment" | "none";
  updatedAt: string;
  config: Omit<IntegrationConfig, "token" | "webhookUrl" | "apiKey">;
};
export type IntegrationStates = Record<IntegrationId, IntegrationState>;
export type IntegrationOptions = {
  account: string;
  teams: { id: string; name: string }[];
  users: { id: string; name: string }[];
  repository?: string;
};

export function isGithubRepository(value: string) {
  const [owner, repository, ...extra] = value.split("/");
  return (
    !extra.length &&
    /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner || "") &&
    /^[a-z0-9_.-]{1,100}$/i.test(repository || "") &&
    repository !== "." &&
    repository !== ".."
  );
}
