"""Normalize MeetStream's two webhook formats."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

ID = re.compile(r"[A-Za-z0-9_-]{1,200}")
STOP_EVENTS = {"bot.stopped", "bot.failed", "bot.kicked", "bot.denied", "bot.notallowed"}


@dataclass(frozen=True)
class Utterance:
    text: str
    speaker: str
    speaker_id: str
    timestamp: str


@dataclass(frozen=True)
class BotStopped:
    reason: str
    status: str
    message: str


@dataclass(frozen=True)
class TranscriptReady:
    transcript_id: str | None


def live_event(payload: dict):
    if payload.get("transcription_mode") != "sentence":
        return None
    if payload.get("is_final") is False or payload.get("end_of_turn") is False:
        return None
    text = payload.get("utterance")
    timestamp = payload.get("timestamp")
    if not isinstance(text, str) or not text.strip() or not isinstance(timestamp, str) or not timestamp:
        return None
    speaker = payload.get("speakerName")
    speaker = speaker.strip() if isinstance(speaker, str) and speaker.strip() else "Unknown speaker"
    speaker_id = payload.get("speakerId")
    speaker_id = str(speaker_id) if isinstance(speaker_id, (str, int)) else ""
    identity = json.dumps([speaker_id or speaker, timestamp, text.strip()])
    event_id = hashlib.sha256(identity.encode()).hexdigest()
    return event_id, Utterance(text.strip(), speaker, speaker_id, timestamp)


def lifecycle_event(payload: dict):
    event = payload.get("bot_event") or payload.get("event")
    if isinstance(event, str) and event in STOP_EVENTS:
        reason, status, message = (payload.get(key) for key in ("failure_reason", "bot_status", "message"))
        return "stopped", BotStopped(
            reason if isinstance(reason, str) and reason else event.removeprefix("bot."),
            status if isinstance(status, str) else "",
            message if isinstance(message, str) else "",
        )
    if event == "transcription.processed":
        transcript_id = payload.get("transcript_id")
        if not isinstance(transcript_id, str) or not ID.fullmatch(transcript_id):
            transcript_id = None
        return "ready:" + (transcript_id or "default"), TranscriptReady(transcript_id)
    return None
