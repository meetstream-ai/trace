import { meetingAgentConfig } from "@/lib/meetstream/agent-config";
import { integrationConfig } from "@/lib/integration-service";
import {
  getMeetStreamBotStatus,
  meetStreamBotId,
  meetStreamBotInput,
  sendMeetStreamBot,
  stopMeetStreamBot,
} from "@/lib/meetstream/bot";
import { access, audit, body, db, failure, guard, HttpError } from "@/lib/server";
import { botStopRetryMs, type MeetStreamBot } from "@/lib/types";

const botFields = "id,label,created_at AS createdAt,stop_requested_at AS stopRequestedAt,meeting_id AS meetingId";
const findBot = (workspace: string, id: string) =>
  db().prepare(`SELECT ${botFields} FROM meetstream_bots WHERE workspace=? AND id=?`)
    .bind(workspace, id).first<MeetStreamBot>();

async function meetStreamKey(workspace: string) {
  const config = await integrationConfig(workspace, "meetstream");
  return config.disabled ? "" : config.token || "";
}

export async function GET(req: Request) {
  try {
    const { workspace } = await access(req, "edit");
    const id = new URL(req.url).searchParams.get("botId");
    if (id !== null) {
      const parsed = meetStreamBotId.safeParse(id);
      if (!parsed.success) throw new HttpError(400, "Enter a valid MeetStream bot ID.");
      if (!(await findBot(workspace, parsed.data)))
        throw new HttpError(404, "This bot is not tracked by your workspace.");
      return Response.json({ status: await getMeetStreamBotStatus(await meetStreamKey(workspace), parsed.data) },
        { headers: { "Cache-Control": "no-store" } });
    }
    const { results: bots } = await db().prepare(
      `SELECT ${botFields} FROM meetstream_bots WHERE workspace=? ORDER BY created_at DESC,id`,
    ).bind(workspace).all<MeetStreamBot>();
    return Response.json({ bots }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request) {
  try {
    guard(req);
    const a = await access(req, "edit");
    const { workspace } = a;
    const payload = await body(req);
    if (payload?.action === "stop" || payload?.action === "track") {
      const parsed = meetStreamBotId.safeParse(payload.botId);
      if (!parsed.success)
        throw new HttpError(400, "Enter a valid MeetStream bot ID.");
      const botId = parsed.data;
      const bot = await findBot(workspace, botId);
      if (payload.action === "track") {
        if (!bot) {
          await getMeetStreamBotStatus(await meetStreamKey(workspace), botId);
          await db().batch([
            db().prepare(
              "INSERT INTO meetstream_bots(id,workspace,label,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
            ).bind(botId, workspace, "Existing MeetStream bot", Date.now()),
            audit(a, "meetstream.bot.tracked", botId, true),
          ]);
          if (!(await findBot(workspace, botId)))
            throw new HttpError(409, "This bot is already tracked by another workspace.");
        }
        return Response.json({ botId });
      }
      if (!bot)
        throw new HttpError(404, "This bot is not tracked by your workspace.");
      if (!bot.meetingId && (!bot.stopRequestedAt || Date.now() - bot.stopRequestedAt >= botStopRetryMs)) {
        await stopMeetStreamBot(await meetStreamKey(workspace), botId);
        await db().batch([
          db().prepare(
            "UPDATE meetstream_bots SET stop_requested_at=? WHERE workspace=? AND id=? AND stop_requested_at IS ?",
          ).bind(Date.now(), workspace, botId, bot.stopRequestedAt),
          audit(a, "meetstream.bot.stop_requested", botId, true),
        ]);
      }
      return Response.json({ botId });
    }
    const input = meetStreamBotInput.safeParse(payload);
    if (!input.success)
      throw new HttpError(
        400,
        input.error.issues.some((issue) => issue.path[0] === "settings")
          ? "Check the bot name, transcription provider, language, model, and video settings."
          : "Enter a valid HTTPS Google Meet, Zoom, or Microsoft Teams meeting link.",
      );
    const { meetingLink, requestId, settings } = input.data;
    const agent = settings?.runAgent ? meetingAgentConfig(workspace) : null;
    if (settings?.runAgent && !agent)
      throw new HttpError(409, "The meeting agent is not configured for this workspace.");
    const prior = await db().prepare("SELECT id FROM meetstream_bots WHERE workspace=? AND request_id=?")
      .bind(workspace, requestId).first<{ id: string }>();
    if (prior) return Response.json({ botId: prior.id });
    const { botId } = await sendMeetStreamBot(await meetStreamKey(workspace), input.data, agent ?? undefined);
    const link = new URL(meetingLink);
    await db().batch([
      db().prepare(
        "INSERT INTO meetstream_bots(id,workspace,request_id,label,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      ).bind(botId, workspace, requestId, (link.hostname + link.pathname).slice(0, 200), Date.now()),
      audit(a, "meetstream.bot.sent", botId, true),
    ]);
    if (!(await findBot(workspace, botId)))
      throw new HttpError(409, "MeetStream returned a bot that is already tracked by another workspace.");
    return Response.json({ botId });
  } catch (error) {
    return failure(error);
  }
}
