import { secret } from "../server";

export function meetingAgentConfig(workspace: string) {
  if (workspace !== (secret("TRACE_MEETING_AGENT_WORKSPACE") || "local_seedy"))
    return null;
  const agentId = secret("TRACE_MEETING_AGENT_ID");
  const token = secret("TRACE_MEETING_AGENT_LIVE_TOKEN");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId) || !/^[a-zA-Z0-9_-]{32,128}$/.test(token))
    return null;

  try {
    const url = new URL(secret("TRACE_MEETING_AGENT_ORIGIN"));
    if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) return null;
    return { agentId, liveWebhookUrl: `${url.origin}/webhooks/live/${token}` };
  } catch {
    return null;
  }
}
