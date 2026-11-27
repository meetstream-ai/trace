import hashlib
import hmac
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from trace_meeting_agent import Agent


class AgentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.database = Path(temp.name) / "agent.sqlite"
        self.agent = self.configure(Agent())
        self.agent.request = AsyncMock(return_value=[{"speaker": "Maya", "transcript": "production is down"}])
        self.calls = []

        @self.agent.on_utterance
        async def utterance(turn, meeting):
            self.calls.append((turn.text, turn.speaker, meeting.id))
            await meeting.send_chat("Incident playbook", key="playbook")

        @self.agent.on_bot_stopped
        async def stopped(event, meeting):
            self.calls.append((event.reason, meeting.id))

        @self.agent.on_transcript_ready
        async def ready(event, meeting):
            transcript = await meeting.fetch_transcript()
            self.calls.append((event.transcript_id, transcript[0]["speaker"]))

    def configure(self, agent):
        agent.configure(database=self.database, api_key="test-token", signing_secret="test-signing",
                        live_token="x" * 32, agent_id="incident")
        return agent

    def send(self, path, *, signed=False, **values):
        body = json.dumps({"bot_id": "bot-123", "custom_attributes": {"trace_agent": "incident"}, **values}).encode()
        signature = "sha256=" + hmac.new(b"test-signing", body, hashlib.sha256).hexdigest() if signed else ""
        return self.agent.receive(path, body, signature)

    def sentence(self, **values):
        return self.send(self.agent.live_path, **{
            "transcription_mode": "sentence", "utterance": "production is down",
            "speakerName": "Maya", "speakerId": "s1", "timestamp": "2026-11-24T10:00:00", **values,
        })

    async def drain(self):
        while await self.agent.process_one():
            pass

    async def test_authenticated_event_lifecycle_and_duplicate_actions(self):
        self.assertEqual(self.sentence(), 202)
        await self.drain()
        self.assertEqual(self.calls, [])  # Unsigned live traffic cannot enroll a bot.
        self.assertEqual(self.send("/webhooks/lifecycle", event="bot.inmeeting"), 401)
        self.assertEqual(self.send("/webhooks/live/wrong-token", event="bot.inmeeting"), 401)
        self.assertEqual(self.sentence(transcription_mode="raw", is_final=False), 204)
        self.assertEqual(self.sentence(), 202)
        self.assertEqual(self.send("/webhooks/lifecycle", signed=True, event="bot.inmeeting"), 204)
        self.assertEqual(self.sentence(timestamp="2026-11-24T10:00:01"), 202)
        for _ in range(2):
            self.assertEqual(self.send("/webhooks/lifecycle", signed=True, event="transcription.processed",
                                       transcript_id="transcript-123"), 202)
            self.assertEqual(self.send("/webhooks/lifecycle", signed=True, event="bot.stopped",
                                       bot_event="bot.failed", failure_reason="meeting_ended"), 202)
        self.assertEqual(self.calls, [])  # Receive acknowledged before invoking a handler.
        await self.drain()
        self.assertEqual(self.calls, [
            ("production is down", "Maya", "bot-123"),
            ("production is down", "Maya", "bot-123"),
            ("transcript-123", "Maya"),
            ("meeting_ended", "bot-123"),
        ])
        self.assertEqual(self.agent.request.await_count, 2)
        self.agent.request.assert_any_await("/bots/bot-123/send_message", {"message": "Incident playbook"})
        self.agent.request.assert_any_await("/transcript/transcript-123/get_transcript?raw=false")

    async def test_handler_retry_keeps_uncertain_chat_claim(self):
        self.send("/webhooks/lifecycle", signed=True, event="bot.inmeeting")
        self.sentence()
        self.agent.request.side_effect = TimeoutError("provider did not confirm")
        with self.assertLogs("trace_meeting_agent.agent", "ERROR"):
            await self.drain()
        self.agent = self.configure(self.agent)
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE events SET retry_at=0")
        await self.drain()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.agent.request.await_count, 1)
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT status, attempts FROM events").fetchone(), ("done", 2))

    async def test_unmarked_bots_and_non_ready_events_do_not_run_handlers(self):
        self.assertEqual(self.send("/webhooks/lifecycle", signed=True, event="bot.inmeeting",
                                   custom_attributes={"trace_agent": "elsewhere"}), 204)
        self.assertEqual(self.send("/webhooks/lifecycle", signed=True, event="transcription.not_required",
                                   custom_attributes={"trace_agent": "elsewhere"}), 204)
        await self.drain()
        self.assertEqual(self.calls, [])
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM bots").fetchone(), (0,))
