import { readResponseJson } from "../response-body.ts";
import { HttpError } from "../errors.ts";
import { parseTranscript } from "../extract.ts";
import { correctTranscript, recordingActivity } from "./transcript-audio.ts";
import type { Segment } from "../types.ts";
import { meetStreamAudioUrl } from "./audio.ts";

const api = "https://api.meetstream.ai/api/v1";
type Word = {
  text: string;
  start_timestamp?: { relative?: number };
  end_timestamp?: { relative?: number };
};

export function splitTimedSentences(
  turns: Segment[],
  wordsByTurn: ReadonlyMap<string, Word[]>,
  audioWindows: { start: number; end: number }[] = [],
): Segment[] {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
  const split = turns.flatMap((turn) => {
    const words = wordsByTurn.get(turn.id);
    if (!words?.length || normalize(words.map((word) => word.text.trim()).join(" ")) !== normalize(turn.text))
      return [turn];
    const parts: Segment[] = [];
    let pieces: string[] = [];
    let start = turn.start;
    for (const word of words) {
      const nextStart = word.start_timestamp?.relative;
      if (pieces.length && /[.!?]$/.test(pieces.at(-1)!) &&
        typeof nextStart === "number" && Number.isFinite(nextStart) &&
        nextStart > start && nextStart < turn.end &&
        (!audioWindows.length || audioWindows.some((window) =>
          window.start <= nextStart + 0.4 && window.end >= nextStart - 0.2,
        ))) {
        parts.push({ ...turn, start, end: nextStart, text: pieces.join(" ") });
        start = nextStart;
        pieces = [];
      }
      pieces.push(word.text.trim());
    }
    if (!parts.length) return [turn];
    parts.push({ ...turn, start, text: pieces.join(" ") });
    return parts.map((part, index) => index ? { ...part, id: `${part.id}-${index + 1}` } : part);
  });
  return split.length <= 5000 ? split.sort((a, b) => a.start - b.start) : turns;
}

export async function importMeetStream(
  key: string,
  transcriptId?: string,
  botId?: string,
) {
  if (!key)
    throw new HttpError(409, "Connect MeetStream in Integrations first.");
  const request = (path: string, timeout = 12000) =>
    fetch(api + path, {
      headers: { Authorization: `Token ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
  const bot = botId ? "/bots/" + encodeURIComponent(botId) : "";
  if (bot && transcriptId) {
    const response = await request(bot + "/detail");
    const data = response.ok
      ? ((await readResponseJson(response)) as {
          bot_details?: { transcript_id?: string };
        })
      : null;
    if (data?.bot_details?.transcript_id !== transcriptId)
      throw new HttpError(
        400,
        "This bot does not match the selected transcript. Use the bot ID by itself.",
      );
  }
  const path = transcriptId
    ? `/transcript/${encodeURIComponent(transcriptId)}/get_transcript`
    : bot + "/get_transcript";
  const r = await request(path + "?raw=false", 30000);
  if (r.status === 202 || r.status === 409)
    throw new HttpError(
      409,
      "The transcript is still processing. Try again when it is ready.",
    );
  if (!r.ok)
    throw new HttpError(
      502,
      `MeetStream could not return the transcript (HTTP ${r.status}).`,
    );
  const data = (await readResponseJson(r, 8 * 1024 * 1024)) as unknown;
  const original = parseTranscript(data);
  const rows = Array.isArray(data) ? data : (data as { transcript?: unknown[]; segments?: unknown[] }).transcript ??
    (data as { segments?: unknown[] }).segments;
  const wordsByTurn = new Map<string, Word[]>();
  const tails = new Map<string, { start: number; end: number }>();
  rows?.forEach((row, index) => {
    const words = (row as { words?: Word[] })?.words;
    if (!Array.isArray(words) || !words.every((word) => typeof word?.text === "string")) return;
    const id = `s${index + 1}`;
    wordsByTurn.set(id, words);
    const last = words.at(-1);
    if (!last || !/^thank you[.!?]?$/i.test(last.text.trim())) return;
    const start = last.start_timestamp?.relative, end = last.end_timestamp?.relative;
    if (typeof start === "number" && typeof end === "number") tails.set(id, { start, end });
  });
  const providerSegments = splitTimedSentences(original, wordsByTurn);
  if (!bot) return { original, segments: providerSegments, audioChecked: false };

  let segments: Segment[] = providerSegments;
  let audioChecked = false;
  try {
    const [metadata, timeline] = await Promise.all([
      request(bot + "/get_audio"),
      request(bot + "/get_speaker_timeline").catch(() => null),
    ]);
    if (!metadata.ok) return { original, segments, audioChecked };
    const url = meetStreamAudioUrl(await readResponseJson(metadata, 65536));
    if (!url) return { original, segments, audioChecked };
    const audio = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(75000),
    });
    if (!audio.ok) return { original, segments, audioChecked };
    const activity = await recordingActivity(audio);
    const speakers = new Map<string, { start: number; end: number }[]>();
    if (timeline?.ok) {
      const data = (await readResponseJson(
        timeline,
        8 * 1024 * 1024,
      ).catch(() => null)) as {
        chunks?: {
          speakerName: string;
          timestamp: string;
          sampleRate?: number;
          startByte: number;
          endByte: number;
        }[];
      } | null;
      for (const chunk of data?.chunks ?? []) {
        if (!chunk.speakerName || chunk.speakerName === "NoSpeaker") continue;
        const start = Number(chunk.timestamp) / 1_000_000;
        const end = start + (chunk.endByte - chunk.startByte) / ((chunk.sampleRate || 48_000) * 2);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
          continue;
        const windows = speakers.get(chunk.speakerName) ?? [];
        windows.push({ start, end });
        speakers.set(chunk.speakerName, windows);
      }
    }
    const corrected = correctTranscript(original, activity, tails, speakers);
    if (!corrected.some((turn) => turn.end < turn.start)) {
      segments = splitTimedSentences(corrected, wordsByTurn, activity.windows);
      audioChecked = activity.windows.length > 0;
    }
  } catch {
    // Missing, expired, unsupported or oversized audio leaves the transcript usable.
  }
  return { original, segments, audioChecked };
}
