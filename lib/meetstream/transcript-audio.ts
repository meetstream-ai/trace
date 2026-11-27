import type { Segment } from "../types.ts";

type Window = { start: number; end: number };
type Activity = { duration: number; windows: Window[] };
const maxBytes = 768 * 1024 * 1024;
const maxDuration = 2 * 60 * 60;

export async function recordingActivity(response: Response): Promise<Activity> {
  if (!response.body || Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("Recording exceeds the supported size.");
  const reader = response.body.getReader();
  let chunk = new Uint8Array();
  let offset = 0;
  let consumed = 0;
  async function consume(size: number, visit?: (part: Uint8Array) => void) {
    consumed += size;
    if (consumed > maxBytes) throw new Error("Recording exceeds the supported size.");
    while (size > 0) {
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) throw new Error("Incomplete WAV recording.");
        chunk = next.value;
        if (!chunk.length) continue;
        offset = 0;
      }
      const length = Math.min(size, chunk.length - offset);
      visit?.(chunk.subarray(offset, offset + length));
      offset += length;
      size -= length;
    }
  }
  async function header(size: number) {
    const bytes = new Uint8Array(size);
    let position = 0;
    await consume(size, (part) => {
      bytes.set(part, position);
      position += part.length;
    });
    return new DataView(bytes.buffer);
  }
  try {
    const riff = await header(12);
    if (riff.getUint32(0) !== 0x52494646 || riff.getUint32(8) !== 0x57415645)
      throw new Error("Expected a PCM WAV recording.");
    const end = riff.getUint32(4, true) + 8;
    let rate = 0;
    let channels = 0;
    while (consumed + 8 <= end) {
      const part = await header(8);
      const tag = part.getUint32(0);
      const size = part.getUint32(4, true);
      if (consumed + size > end) throw new Error("Incomplete WAV recording.");
      if (tag === 0x666d7420 && size >= 16) { // fmt
        const format = await header(16);
        if (format.getUint16(0, true) !== 1 || format.getUint16(14, true) !== 16)
          throw new Error("Expected 16-bit PCM audio.");
        channels = format.getUint16(2, true);
        rate = format.getUint32(4, true);
        await consume(size - 16 + size % 2);
      } else if (tag === 0x64617461) { // data
        if (channels < 1 || channels > 2 || rate < 8000 || rate > 96000 ||
          size % (2 * channels) || size > 2 * channels * rate * maxDuration)
          throw new Error("Invalid or oversized PCM recording.");
        const frame = Math.floor(rate / 100) * channels;
        const levels = new Float32Array(Math.ceil(size / (2 * frame)));
        let index = 0, samples = 0, sum = 0, peak = 0, lowByte = -1;
        const finishFrame = () => {
          const level = Math.sqrt(sum / samples);
          levels[index++] = level;
          peak = Math.max(peak, level);
          samples = 0;
          sum = 0;
        };
        await consume(size, (bytes) => {
          let i = 0;
          if (lowByte >= 0) {
            sum += ((lowByte | (bytes[i++] << 8)) << 16 >> 16) ** 2;
            if (++samples === frame) finishFrame();
          }
          for (; i + 1 < bytes.length; i += 2) {
            sum += ((bytes[i] | (bytes[i + 1] << 8)) << 16 >> 16) ** 2;
            if (++samples === frame) finishFrame();
          }
          lowByte = i < bytes.length ? bytes[i] : -1;
        });
        if (samples) finishFrame();
        const windows: Window[] = [];
        const step = frame / channels / rate;
        const threshold = Math.max(16, Math.min(peak * 0.01, 128));
        levels.forEach((level, i) => {
          if (level < threshold) return;
          const start = i * step;
          const end = Math.min((i + 1) * step, size / (2 * channels * rate));
          const last = windows.at(-1);
          if (last && start - last.end < 0.16) last.end = end;
          else windows.push({ start, end });
        });
        return { duration: size / (2 * channels * rate), windows };
      } else {
        await consume(size + size % 2);
      }
    }
    throw new Error("WAV recording has no audio.");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function correctTranscript(
  turns: Segment[],
  audio: Activity,
  trailingThanks: ReadonlyMap<string, Window> = new Map(),
  speakers: ReadonlyMap<string, Window[]> = new Map(),
) {
  // Require recorded activity to distinguish actual silence from a muted or broken recording.
  if (!audio.windows.length) return turns;
  const silent = ({ start, end }: Window) =>
    start >= 0 &&
    start < audio.duration &&
    end > start &&
    end <= audio.duration + 2 &&
    !audio.windows.some(
      (window) => window.start < end + 0.15 && window.end > start - 0.15,
    );
  const cleaned = turns.flatMap((turn) => {
    if (
      /^thank you[.!?]?$/i.test(turn.text.trim()) &&
      silent({
        start: Math.max(0, turn.start - 2),
        end: Math.min(audio.duration + 2, turn.end + 2),
      })
    )
      return [];
    const tail = trailingThanks.get(turn.id);
    if (tail && tail.start > turn.start && silent(tail)) {
      const lastAudio = audio.windows
        .filter((window) => window.end > turn.start && window.end <= tail.start)
        .at(-1);
      return [
        {
          ...turn,
          text: turn.text.replace(/\s+thank you[.!?]?$/i, ""),
          end: lastAudio ? Math.round(lastAudio.end * 100) / 100 : tail.start,
        },
      ];
    }
    return [turn];
  });
  if (!cleaned.length) return turns;
  return cleaned.map((turn, index) => {
    const previous = cleaned[index - 1];
    const next = cleaned[index + 1];
    // Leave plausible starts alone, including nearby speech separated by a short pause.
    if (
      audio.windows.some(
        (w) => w.start <= turn.start + 0.5 && w.end >= turn.start - 0.15,
      )
    )
      return turn;
    const nearby = audio.windows.find(
      (w) =>
        w.start > turn.start &&
        w.start <= turn.end + 0.25 &&
        w.end - w.start >= 0.15,
    );
    const speakerWindow =
      nearby &&
      speakers
        .get(turn.speaker)
        ?.find(
          (w) => w.start <= nearby.start + 0.3 && w.end > nearby.start + 0.1,
        );
    if (!nearby || !speakerWindow) return turn;
    // Speaker detection can lag the waveform at a handoff. Reject overlapping labels,
    // while allowing the previous label to end at this speaker's first chunk.
    const speakerStart = Math.max(nearby.start, speakerWindow.start);
    if (
      [...speakers].some(
        ([name, windows]) =>
          name !== turn.speaker &&
          windows.some(
            (w) => w.start < speakerStart + 0.1 && w.end > speakerStart + 0.02,
          ),
      )
    )
      return turn;
    if (
      (previous && previous.end > nearby.start) ||
      (next && next.start <= nearby.start + 0.2)
    )
      return turn;
    const end = Math.min(
      next?.start ?? audio.duration,
      Math.max(turn.end, nearby.end),
      audio.duration,
    );
    if (end <= nearby.start) return turn;
    return {
      ...turn,
      start: Math.round(nearby.start * 100) / 100,
      end: Math.round(end * 100) / 100,
    };
  });
}
