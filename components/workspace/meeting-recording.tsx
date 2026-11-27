import { useEffect, useRef, useState } from "react";

export function useMeetingRecording(meetingId: string | undefined) {
  const audio = useRef<HTMLAudioElement>(null);
  const pending = useRef<{ meetingId: string; start: number } | null>(null);
  const requestedStart = useRef(0);
  const [visibleFor, setVisibleFor] = useState("");
  const [message, setMessage] = useState("");

  function play(id: string, start: number) {
    const player = audio.current;
    if (!player || id !== meetingId) {
      pending.current = { meetingId: id, start };
      return;
    }

    setVisibleFor(id);
    setMessage("");
    requestedStart.current = start;
    if (player.error) player.load();
    if (Number.isFinite(player.duration) && start >= player.duration) {
      player.pause();
      setMessage("This timestamp falls outside the recording.");
      return;
    }
    player.currentTime = start;
    void player.play().catch((error: DOMException) => {
      if (error.name === "NotAllowedError" && audio.current === player)
        setMessage("Press play to hear this timestamp.");
    });
  }

  useEffect(() => {
    const request = pending.current;
    if (request && request.meetingId === meetingId && audio.current) {
      pending.current = null;
      play(request.meetingId, request.start);
    }
  }, [meetingId]);

  const player = meetingId ? (
    <div className="transcript-audio" hidden={visibleFor !== meetingId}>
      <audio
        key={meetingId}
        ref={audio}
        src={`/api/meetings/${encodeURIComponent(meetingId)}/audio`}
        aria-label="Meeting recording"
        controls
        preload="none"
        onLoadedMetadata={(event) => {
          if (requestedStart.current >= event.currentTarget.duration) {
            event.currentTarget.pause();
            setMessage("This timestamp falls outside the recording.");
          }
        }}
        onError={() => setMessage("The recording is unavailable. Check the MeetStream connection or try again.")}
        onPlay={() => setMessage("")}
      />
      {message && <p role="status">{message}</p>}
    </div>
  ) : null;

  return { play, player };
}
