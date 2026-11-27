from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import sqlite3
import threading
import time
import urllib.request
from contextlib import closing
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .events import ID, BotStopped, TranscriptReady, Utterance, lifecycle_event, live_event

log = logging.getLogger(__name__)
API = "https://api.meetstream.ai/api/v1"
MAX_BODY = 256 * 1024
EVENT_TYPES = {cls.__name__: cls for cls in (Utterance, BotStopped, TranscriptReady)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Meeting:
    def __init__(self, agent: Agent, bot_id: str, event_id: str, transcript_id=None):
        self._agent = agent
        self.id = bot_id
        self.event_id = event_id
        self.transcript_id = transcript_id

    async def once(self, key, action):
        """Reserve one attempt per bot and key. A failed or uncertain call keeps its reservation."""
        with closing(self._agent.connect()) as db, db:
            inserted = db.execute(
                "INSERT OR IGNORE INTO actions(bot_id, key) VALUES (?,?)", (self.id, key)
            ).rowcount
        if not inserted:
            return False
        await action()
        return True

    async def send_chat(self, message: str, *, key: str | None = None):
        if not message.strip():
            raise ValueError("Chat message must not be empty")
        key = key or hashlib.sha256(message.encode()).hexdigest()
        return await self.once(
            "chat:" + key,
            lambda: self._agent.request(f"/bots/{self.id}/send_message", {"message": message}),
        )

    async def fetch_transcript(self):
        path = (f"/transcript/{self.transcript_id}/get_transcript" if self.transcript_id
                else f"/bots/{self.id}/get_transcript")
        return await self._agent.request(path + "?raw=false")


class Agent:
    def __init__(self):
        self.handlers = {}
        self._wake = threading.Event()

    def _register(self, kind, handler):
        if kind.__name__ in self.handlers:
            raise ValueError(f"Only one {kind.__name__} handler can be registered")
        self.handlers[kind.__name__] = handler
        return handler

    def on_utterance(self, handler):
        return self._register(Utterance, handler)

    def on_bot_stopped(self, handler):
        return self._register(BotStopped, handler)

    def on_transcript_ready(self, handler):
        return self._register(TranscriptReady, handler)

    def configure(self, *, database, api_key, signing_secret, live_token, agent_id):
        if not api_key or not signing_secret:
            raise ValueError("MeetStream API key and webhook signing secret are required")
        if not 1 <= len(agent_id) <= 64 or not ID.fullmatch(agent_id) or not 32 <= len(live_token) <= 128 or not ID.fullmatch(live_token):
            raise ValueError("Set an agent ID and a random URL-safe live token of at least 32 characters")
        self.database = Path(database)
        self.database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database.touch(exist_ok=True, mode=0o600)
        self.api_key = api_key
        self.signing_secret = signing_secret.encode()
        self.live_path = "/webhooks/live/" + live_token
        self.agent_id = agent_id
        with closing(self.connect()) as db, db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS events (
                    bot_id TEXT, event_id TEXT, kind TEXT NOT NULL,
                    payload TEXT NOT NULL, received REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                    retry_at REAL NOT NULL DEFAULT 0, PRIMARY KEY (bot_id, event_id)
                );
                CREATE TABLE IF NOT EXISTS actions (
                    bot_id TEXT, key TEXT, PRIMARY KEY (bot_id, key)
                );
                CREATE INDEX IF NOT EXISTS pending_events ON events(status, retry_at, received);
            """)

    def connect(self):
        return sqlite3.connect(self.database, timeout=1)

    def receive(self, path, body, signature=""):
        """Authenticate, persist, and return an HTTP status without invoking handlers."""
        if len(body) > MAX_BODY:
            return 413
        signed = path == "/webhooks/lifecycle"
        if signed:
            expected = "sha256=" + hmac.new(self.signing_secret, body, hashlib.sha256).hexdigest()
            authorized = hmac.compare_digest(expected.encode(), signature.encode())
        else:
            authorized = hmac.compare_digest(path.encode(), self.live_path.encode())
        if not authorized:
            return 401
        try:
            payload = json.loads(body)
        except (UnicodeError, ValueError, RecursionError):
            return 400
        if not isinstance(payload, dict):
            return 400
        attrs = payload.get("custom_attributes")
        bot_id = payload.get("bot_id")
        if not isinstance(bot_id, str) or not ID.fullmatch(bot_id):
            return 400
        if not isinstance(attrs, dict) or attrs.get("trace_agent") != self.agent_id:
            return 204

        try:
            decoded = lifecycle_event(payload) if signed else live_event(payload)
        except (TypeError, ValueError):
            return 400
        with closing(self.connect()) as db, db:
            # Only signed events can enroll a bot. Early live phrases wait for enrollment.
            if signed:
                db.execute("INSERT OR IGNORE INTO bots VALUES (?)", (bot_id,))
            if decoded:
                event_id, event = decoded
                kind = type(event).__name__
                if kind in self.handlers:
                    db.execute(
                        """INSERT OR IGNORE INTO events (bot_id,event_id,kind,payload,received)
                           VALUES (?,?,?,?,?)""",
                        (bot_id, event_id, kind, json.dumps(asdict(event)), time.time()),
                    )
        self._wake.set()
        return 202 if decoded else 204

    async def process_one(self):
        now = time.time()
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM events WHERE kind='Utterance' AND received<? "
                       "AND bot_id NOT IN (SELECT id FROM bots)", (now - 300,))
            row = db.execute("""
                SELECT e.bot_id,e.event_id,e.kind,e.payload,e.attempts+1
                FROM events e JOIN bots b ON b.id=e.bot_id
                WHERE e.status='pending' AND e.retry_at<=?
                ORDER BY e.received, e.rowid LIMIT 1
            """, (now,)).fetchone()
            if not row:
                return False
            bot, event_id, kind, payload, attempts = row
            db.execute("UPDATE events SET status='running', attempts=? WHERE bot_id=? AND event_id=?",
                       (attempts, bot, event_id))
        try:
            event = EVENT_TYPES[kind](**json.loads(payload))
            meeting = Meeting(self, bot, event_id, getattr(event, "transcript_id", None))
            await self.handlers[kind](event, meeting)
        except Exception:
            log.exception("Meeting handler %s failed (attempt %d)", kind, attempts)
            status = "failed" if attempts >= 3 else "pending"
        else:
            status, payload = "done", "{}"
        with closing(self.connect()) as db, db:
            db.execute("UPDATE events SET status=?, payload=?, retry_at=? WHERE bot_id=? AND event_id=?",
                       (status, payload, time.time() + 2 ** attempts, bot, event_id))
        return True

    async def request(self, path, payload=None):
        def send():
            request = urllib.request.Request(
                API + path,
                data=json.dumps(payload).encode() if payload is not None else None,
                headers={"Authorization": f"Token {self.api_key}", "Content-Type": "application/json"},
            )
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
                if response.status == 202 and payload is None:
                    raise RuntimeError("MeetStream transcript is still processing")
                data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024:
                    raise ValueError("MeetStream response is too large")
                return json.loads(data) if data else None
        return await asyncio.to_thread(send)

    def serve(self, host="127.0.0.1", port=8090):
        agent = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(5)

            def do_POST(self):
                try:
                    length = int(self.headers.get("Content-Length", ""))
                    if not 0 < length <= MAX_BODY:
                        self.send_error(413)
                        return
                    body = self.rfile.read(length)
                    status = agent.receive(self.path, body, self.headers.get("X-MeetStream-Signature", ""))
                except ValueError:
                    status = 400
                except sqlite3.OperationalError:
                    status = 503
                self.send_response(status)
                self.end_headers()

            def log_message(self, *_):
                # The live URL contains a secret. Never log request paths.
                pass

        stop = threading.Event()

        def dispatch():
            async def run():
                while not stop.is_set():
                    self._wake.clear()
                    try:
                        if await self.process_one():
                            continue
                    except sqlite3.OperationalError:
                        log.warning("Meeting agent database is busy")
                    await asyncio.to_thread(self._wake.wait, 0.5)
            asyncio.run(run())

        with ThreadingHTTPServer((host, port), Handler) as server:
            # Run one receiver per database. A restart resumes interrupted handlers.
            with closing(self.connect()) as db, db:
                db.execute("UPDATE events SET status='pending' WHERE status='running'")
            worker = threading.Thread(target=dispatch, daemon=True)
            worker.start()
            try:
                server.serve_forever()
            finally:
                stop.set()
                self._wake.set()
                worker.join()
