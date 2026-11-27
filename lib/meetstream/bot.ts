import { botRecordingConfig, botSettingsSchema, defaultBotSettings, transcriptionProviders } from "./bot-settings.ts";
import { z } from "zod";
import { HttpError } from "../errors.ts";
import { readResponseJson } from "../response-body.ts";
import type { MeetStreamBotStatus } from "../types.ts";
import { parseTranscript } from "../extract.ts";

export const meetStreamBotInput = z.object({
  meetingLink: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        const host = url.hostname;
        return (
          url.protocol === "https:" &&
          !url.port &&
          !url.username &&
          !url.password &&
          url.pathname !== "/" &&
          (host === "meet.google.com" ||
            host === "zoom.us" ||
            host.endsWith(".zoom.us") ||
            host === "teams.microsoft.com" ||
            host === "teams.live.com")
        );
      } catch {
        return false;
      }
    }),
  requestId: z.uuid(),
  settings: botSettingsSchema.optional(),
});
export const meetStreamBotId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const botResult = z.object({ bot_id: meetStreamBotId });

export async function getMeetStreamBotStatus(key: string, botId: string): Promise<MeetStreamBotStatus> {
  if (!key)
    throw new HttpError(409, "Connect MeetStream in Integrations first.");
  const endpoint = `https://api.meetstream.ai/api/v1/bots/${encodeURIComponent(botId)}`;
  const request = (path: string) =>
    fetch(endpoint + path, {
      headers: { Authorization: `Token ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
  try {
    const response = await request("/status");
    if (response.status === 404)
      throw new HttpError(404, "MeetStream could not find this bot in the connected account.");
    if (!response.ok) throw new Error();
    const data = await readResponseJson(response, 65536) as { status?: string };
    const status = data.status?.toLowerCase();
    switch (status) {
      case "active":
      case "scheduled":
      case "joining":
        return { label: "Joining meeting", canStop: true, ready: false, settled: false };
      case "inwaitingroom":
        return { label: "Waiting to join", canStop: true, ready: false, settled: false };
      case "inmeeting":
      case "recording":
      case "recordingpermissionallowed":
      case "recordingpermissiondenied":
        return { label: "In meeting", canStop: true, ready: false, settled: false };
      case "leaving":
        return { label: "Leaving meeting", canStop: false, ready: false, settled: false };
      case "stopped":
      case "kicked":
      case "mediaprocessing":
      case "audioprocessing":
      case "uploading":
        return { label: "Bot left · Processing transcript", canStop: false, ready: false, settled: false };
      case "done":
      case "transcriptionready": {
        const transcript = await request("/get_transcript?raw=false");
        if (transcript.status === 200) {
          const data = await readResponseJson(transcript, 8 * 1024 * 1024) as {
            transcript?: unknown[];
            segments?: unknown[];
          } | null;
          const rows = Array.isArray(data) ? data : data?.transcript ?? data?.segments;
          if (Array.isArray(rows) && rows.length) {
            try {
              parseTranscript(rows);
            } catch {
              return { label: "MeetStream returned an unusable transcript", canStop: false, ready: false, settled: true };
            }
            return { label: "Transcript ready", canStop: false, ready: true, settled: true };
          }
          return { label: "No speech transcribed", canStop: false, ready: false, settled: true };
        }
        await transcript.body?.cancel().catch(() => {});
        if (transcript.status === 202 || transcript.status === 409 || transcript.status === 404)
          return { label: "Bot left · Waiting for transcript", canStop: false, ready: false, settled: false };
        if (transcript.status === 500)
          return { label: "MeetStream could not transcribe this recording", canStop: false, ready: false, settled: true };
        throw new Error();
      }
      case "failed":
      case "error":
      case "notallowed":
      case "denied":
        return { label: "Bot could not join or record", canStop: false, ready: false, settled: true };
      case "mediaexpired":
        return { label: "Recording expired", canStop: false, ready: false, settled: true };
      case "cancelled":
        return { label: "Bot cancelled", canStop: false, ready: false, settled: true };
      default:
        return { label: "Waiting for MeetStream status", canStop: true, ready: false, settled: false };
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "MeetStream status is unavailable. Try again shortly.");
  }
}

export async function sendMeetStreamBot(
  key: string,
  input: z.infer<typeof meetStreamBotInput>,
  agent?: { agentId: string; liveWebhookUrl: string },
) {
  if (!key)
    throw new HttpError(409, "Connect MeetStream in Integrations first.");
  const settings = input.settings ?? defaultBotSettings;
  const recording = botRecordingConfig(settings);
  const recordingConfig = agent ? {
    ...recording,
    transcript: { provider: {
      ...recording.transcript.provider,
      meetstream_streaming: { transcription_mode: "sentence" },
    } },
  } : recording;
  let response: Response;
  try {
    response = await fetch("https://api.meetstream.ai/api/v1/bots/create_bot", {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.requestId,
      },
      body: JSON.stringify({
        meeting_link: input.meetingLink,
        bot_name: settings.name,
        audio_required: true,
        video_required: settings.recordVideo,
        recording_config: recordingConfig,
        ...(agent ? {
          custom_attributes: { trace_agent: agent.agentId },
          live_transcription_required: { webhook_url: agent.liveWebhookUrl },
        } : {}),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new HttpError(
      502,
      "Trace did not receive a response from MeetStream. Retry using the same meeting link.",
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new HttpError(
      403,
      "MeetStream refused to send the bot. Check your API key and workspace permissions.",
    );
  if (response.status === 400)
    throw new HttpError(
      400,
      settings.provider === "meetstream"
        ? "MeetStream rejected the request. Check the meeting link and bot settings."
        : `MeetStream rejected the request. Check the meeting link and bot settings, and confirm your ${transcriptionProviders[settings.provider].label} key is configured in MeetStream.`,
    );
  if (response.status === 402)
    throw new HttpError(
      402,
      "Check your MeetStream balance before sending the bot.",
    );
  if (response.status === 429)
    throw new HttpError(
      429,
      "MeetStream is limiting bot requests. Wait a minute and retry.",
    );
  if (!response.ok && response.status !== 507)
    throw new HttpError(
      502,
      "MeetStream could not confirm the bot. Retry using the same meeting link.",
    );
  const result = botResult.safeParse(
    await readResponseJson(response, 65536).catch(() => null),
  );
  if (!result.success)
    throw new HttpError(
      502,
      "MeetStream did not return a bot ID. Retry using the same meeting link.",
    );
  return { botId: result.data.bot_id };
}

export async function stopMeetStreamBot(key: string, botId: string) {
  if (!key)
    throw new HttpError(409, "Connect MeetStream in Integrations first.");
  let response: Response;
  try {
    response = await fetch(
      `https://api.meetstream.ai/api/v1/bots/${encodeURIComponent(botId)}/remove_bot`,
      {
        method: "POST",
        headers: { Authorization: `Token ${key}` },
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
      },
    );
  } catch {
    throw new HttpError(
      502,
      "MeetStream did not confirm the stop request. Try stopping the bot again.",
    );
  }
  if (response.status === 404)
    throw new HttpError(
      404,
      "MeetStream could not find this bot in the connected account.",
    );
  if (response.status === 401 || response.status === 403)
    throw new HttpError(
      403,
      "MeetStream refused to stop this bot. Check your connection permissions.",
    );
  if (!response.ok)
    throw new HttpError(502, "MeetStream could not stop the bot. Try again.");
  return { botId };
}
