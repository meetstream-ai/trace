"""Post a playbook once, then save timestamped incident excerpts after the call."""

import logging
import os
from pathlib import Path

from trace_meeting_agent import Agent

agent = Agent()
trigger = "production is down"


@agent.on_utterance
async def share_playbook(turn, meeting):
    playbook = os.getenv("INCIDENT_PLAYBOOK_URL")
    if playbook and trigger in turn.text.casefold():
        await meeting.send_chat(f"Incident playbook: {playbook}", key="incident-playbook")


@agent.on_bot_stopped
async def record_stop(event, meeting):
    logging.info("Bot %s ended: %s", meeting.id, event.reason)


@agent.on_transcript_ready
async def write_recap(event, meeting):
    transcript = await meeting.fetch_transcript()
    rows = transcript if isinstance(transcript, list) else transcript.get("transcript", transcript.get("segments", []))
    excerpts = []
    for row in rows:
        words = row.get("words", [])
        text = row.get("transcript") or row.get("text") or " ".join(word["text"] for word in words)
        if trigger not in text.casefold():
            continue
        participant = row.get("participant") or {}
        speaker = row.get("speaker") or participant.get("name", "Unknown speaker")
        seconds = row.get("start_time", row.get("start"))
        if seconds is None and words:
            seconds = (words[0].get("start_timestamp") or {}).get("relative")
        stamp = f"{seconds:.1f}s" if isinstance(seconds, (int, float)) else "timestamp unavailable"
        excerpts.append(f"- {stamp} · {speaker} — {text}")
    folder = Path(".state/recaps")
    folder.parent.mkdir(exist_ok=True, mode=0o700)
    folder.mkdir(exist_ok=True, mode=0o700)
    path = folder / f"{meeting.id}.md"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        "# Incident recap\n\n" + "\n".join(excerpts or ["No escalation phrase found."]) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
