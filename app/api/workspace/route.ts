import { meetingAgentConfig } from "@/lib/meetstream/agent-config";
import { integrationStates } from "@/lib/integration-service";
import { defaultPreferences } from "@/lib/preferences";
import { db, access, failure, getDeliveries } from "@/lib/server";
import { meetingPreview, readStoredMeeting } from "@/lib/types";
import { can } from "@/lib/access";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const a = await access(req);
    const owner = a.workspace;
    const workspace = await db()
      .prepare("SELECT name FROM workspaces WHERE id=?")
      .bind(owner)
      .first<{ name: string }>();
    const rows = await db()
      .prepare(
        `SELECT data,revision,id,EXISTS (
          SELECT 1 FROM meetstream_bots WHERE workspace=meetings.owner AND meeting_id=meetings.id
        ) AS recording FROM meetings WHERE owner=? AND fingerprint NOT LIKE 'sample:%'`,
      )
      .bind(owner)
      .all<{ data: string; revision: number; id: string; recording: number }>();
    const states = await integrationStates(owner);
    const prefs = await db()
      .prepare("SELECT data,revision FROM preferences WHERE owner=?")
      .bind(owner)
      .first<{ data: string; revision: number }>();
    return Response.json(
      {
        meetings: rows.results
          .map(
            (r) => meetingPreview(readStoredMeeting(r.data, r.revision)),
          )
          .sort((a, b) => b.date.localeCompare(a.date)),
        deliveries: await getDeliveries(owner),
        meetingAgentEnabled: Boolean(meetingAgentConfig(owner)),
        recordingMeetingIds: can(a.role, "review")
          ? rows.results.filter((row) => row.recording).map((row) => row.id)
          : [],
        integrations: Object.fromEntries(
          Object.entries(states).map(([id, state]) => [id, state.configured]),
        ),
        integrationStates: states,
        preferences: prefs
          ? { ...JSON.parse(prefs.data), revision: prefs.revision }
          : {
              ...defaultPreferences,
              workspaceName:
                workspace?.name ?? defaultPreferences.workspaceName,
            },
        signedIn: true,
        access: a,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
