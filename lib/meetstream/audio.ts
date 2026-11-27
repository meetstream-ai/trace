import { HttpError } from "../errors.ts";
import { readResponseJson } from "../response-body.ts";

export function meetStreamAudioUrl(metadata: unknown) {
  if (typeof metadata !== "object" || metadata === null || !("audio_url" in metadata) ||
    typeof metadata.audio_url !== "string") return null;
  try {
    const url = new URL(metadata.audio_url);
    if (url.protocol === "https:" && url.hostname.endsWith(".amazonaws.com") &&
      !url.port && !url.username && !url.password)
      return url;
  } catch {
    // Invalid recording URLs are unavailable.
  }
  return null;
}

export async function getMeetStreamAudioUrl(key: string, botId: string, signal: AbortSignal) {
  const response = await fetch(
    `https://api.meetstream.ai/api/v1/bots/${encodeURIComponent(botId)}/get_audio`,
    { headers: { Authorization: `Token ${key}` }, redirect: "manual", signal },
  );
  if ([202, 404, 410].includes(response.status))
    throw new HttpError(response.status === 202 ? 409 : 404, "The recording is not available.");
  if (!response.ok) throw new HttpError(502, "MeetStream could not return the recording.");
  const url = meetStreamAudioUrl(await readResponseJson(response, 65536));
  if (!url) throw new HttpError(404, "The recording is not available.");
  return url;
}
