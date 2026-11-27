import { readResponseJson } from "./response-body.ts";
import { HttpError } from "./errors.ts";
import type { LinearStatus } from "./types.ts";

async function graph<T>(token: string, query: string, variables: Record<string, unknown>) {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(12000),
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error("Linear did not confirm the request.");
  const result = await readResponseJson(response) as { errors?: unknown[]; data?: T };
  if (!result.data || result.errors?.length) throw new Error("Linear did not confirm the request.");
  return result.data;
}

type State = { id: string; type: string; position: number };
type Issue = { id: string; archivedAt: string | null; team: { id: string }; state: State };
const terminal = new Set(["completed", "canceled", "duplicate"]);

export async function readLinearFollowup(
  config: Record<string, string>, identifier: string, status: LinearStatus | null,
) {
  if (!config.LINEAR_API_KEY || !config.LINEAR_TEAM_ID)
    throw new HttpError(409, "Connect the original Linear team first.");
  const statesQuery = status ? `team(id:$teamId){states(first:100,filter:{type:{eq:$type}}){
    nodes{id type position} pageInfo{hasNextPage}
  }}` : "";
  const data = await graph<{
    issue?: Issue | null;
    team?: { states: { nodes: State[]; pageInfo: { hasNextPage: boolean } } };
  }>(config.LINEAR_API_KEY, `query TraceFollowup($issueId:String!${status ? ",$teamId:String!,$type:String!" : ""}){
    issue(id:$issueId){id archivedAt team{id} state{id type}}
    ${statesQuery}
  }`, { issueId: identifier, ...(status ? { teamId: config.LINEAR_TEAM_ID, type: status } : {}) });
  const issue = data.issue;
  if (!issue?.id || !issue.state?.id || issue.team?.id !== config.LINEAR_TEAM_ID)
    throw new HttpError(409, "The original issue is unavailable in the connected Linear team.");
  if (!status || issue.state.type === status) return { issue, stateId: "" };
  if (issue.archivedAt || terminal.has(issue.state.type))
    throw new HttpError(409, "This issue is archived or already closed in Linear. Verify its status before making further changes.");
  const states = data.team?.states;
  const target = states?.nodes.filter((state) => state.type === status)
    .sort((a, b) => a.position - b.position)[0];
  if (!target?.id || states?.pageInfo.hasNextPage)
    throw new HttpError(409, "The connected Linear team has no selectable state for this update.");
  return { issue, stateId: target.id };
}

export async function setLinearFollowupStatus(
  config: Record<string, string>, issueId: string, stateId: string,
) {
  if (!stateId) return;
  const data = await graph<{ issueUpdate?: { success: boolean; issue?: { id: string; state?: { id: string } } } }>(
    config.LINEAR_API_KEY,
    "mutation TraceIssueStatus($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{id state{id}}}}",
    { id: issueId, input: { stateId } },
  );
  if (!data.issueUpdate?.success || data.issueUpdate.issue?.id !== issueId ||
      data.issueUpdate.issue.state?.id !== stateId)
    throw new Error("Linear did not confirm the status change.");
}
