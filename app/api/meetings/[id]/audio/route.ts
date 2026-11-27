import { integrationConfig } from "@/lib/integration-service";
import { getMeetStreamAudioUrl } from "@/lib/meetstream/audio";
import { access, db, failure, guard, HttpError } from "@/lib/server";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { workspace } = await access(req, "review");
    const { id } = await params;
    const recording = await db().prepare(
      `SELECT bots.id FROM meetstream_bots AS bots JOIN meetings ON meetings.id=bots.meeting_id
       WHERE bots.workspace=? AND meetings.owner=? AND meetings.id=?
       ORDER BY bots.created_at,bots.id LIMIT 1`,
    ).bind(workspace, workspace, id).first<{ id: string }>();
    if (!recording) throw new HttpError(404, "This meeting has no linked recording.");
    const config = await integrationConfig(workspace, "meetstream");
    if (config.disabled || !config.token)
      throw new HttpError(409, "Connect MeetStream to listen to the recording.");
    const range = req.headers.get("Range");
    if (range && !/^bytes=(?:[0-9]{1,12}-[0-9]{0,12}|-[0-9]{1,12})$/.test(range))
      throw new HttpError(416, "Unsupported audio range.");
    const controller = new AbortController();
    const signal = AbortSignal.any([req.signal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(), 20000);
    let recordingResponse: Response;
    try {
      const url = await getMeetStreamAudioUrl(config.token, recording.id, signal);
      recordingResponse = await fetch(url, {
        headers: range ? { Range: range } : {},
        signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "The recording could not be loaded.");
    } finally {
      clearTimeout(timeout);
    }
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Type": "audio/wav",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    });
    const contentRange = recordingResponse.headers.get("Content-Range");
    if (contentRange) headers.set("Content-Range", contentRange);
    if (recordingResponse.status === 416) {
      await recordingResponse.body?.cancel().catch(() => {});
      return new Response(null, { status: 416, headers });
    }
    if (!recordingResponse.ok || (range && recordingResponse.status !== 206) ||
      (recordingResponse.status === 206 && !contentRange)) {
      await recordingResponse.body?.cancel().catch(() => {});
      throw new HttpError(502, "This recording is unavailable or does not support seeking.");
    }
    const size = recordingResponse.headers.get("Content-Length");
    if (size && !recordingResponse.headers.has("Content-Encoding"))
      headers.set("Content-Length", size);
    return new Response(recordingResponse.body, { status: recordingResponse.status, headers });
  } catch (error) {
    return failure(error);
  }
}
