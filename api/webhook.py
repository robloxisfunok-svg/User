from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.parse import urlsplit

MAX_BODY_BYTES = 8_192
REQUEST_TIMEOUT_SECONDS = 15
USERNAME_RE = re.compile(r"^[a-z0-9._]{2,32}$")
WEBHOOK_PATH_RE = re.compile(r"/api(?:/v\d+)?/webhooks/\d{10,30}/[A-Za-z0-9._-]{20,250}/?")
ALLOWED_HOSTS = {
    "discord.com",
    "canary.discord.com",
    "ptb.discord.com",
    "discordapp.com",
}


def validate_webhook_url(raw: Any) -> tuple[bool, str, str]:
    if not isinstance(raw, str) or not raw.strip():
        return False, "", "Enter a Discord webhook URL."

    try:
        parsed = urlsplit(raw.strip())
    except ValueError:
        return False, "", "Invalid webhook URL."

    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in ALLOWED_HOSTS:
        return False, "", "Use an official HTTPS Discord webhook URL."

    if not WEBHOOK_PATH_RE.fullmatch(parsed.path):
        return False, "", "That does not look like a Discord webhook URL."

    normalized_host = "discord.com" if host == "discordapp.com" else host
    return True, f"https://{normalized_host}{parsed.path.rstrip('/')}", ""


def send_webhook(webhook_url: str, content: str) -> tuple[int, dict[str, Any]]:
    payload = json.dumps(
        {
            "username": "Username Checker",
            "content": content,
            "allowed_mentions": {"parse": []},
        },
        separators=(",", ":"),
    ).encode("utf-8")

    request = urllib.request.Request(
        webhook_url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "DiscordUsernameChecker-Vercel/1.0",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status in (200, 204):
                return 200, {"ok": True, "message": "Webhook sent successfully."}
            return 502, {"ok": False, "message": f"Webhook returned HTTP {response.status}."}
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            return 429, {"ok": False, "message": "Discord rate limited the webhook."}
        if exc.code in (401, 403, 404):
            return 400, {"ok": False, "message": "Webhook is invalid, deleted, or inaccessible."}
        return 502, {"ok": False, "message": f"Webhook returned HTTP {exc.code}."}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 502, {"ok": False, "message": f"Could not reach Discord: {exc}"}


class handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self.send_json(200, {"ok": True, "service": "discord-webhook"})

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(400, {"ok": False, "message": "Invalid request body."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"ok": False, "message": "Send valid JSON."})
            return

        if not isinstance(payload, dict):
            self.send_json(400, {"ok": False, "message": "Send a JSON object."})
            return

        valid, webhook_url, error = validate_webhook_url(payload.get("webhook_url"))
        if not valid:
            self.send_json(400, {"ok": False, "message": error})
            return

        action = payload.get("action")
        if action == "test":
            content = "✅ Discord Username Checker webhook test successful."
        elif action == "available":
            raw_username = payload.get("username")
            username = raw_username.strip().lower() if isinstance(raw_username, str) else ""
            if not USERNAME_RE.fullmatch(username) or ".." in username:
                self.send_json(400, {"ok": False, "message": "Invalid username."})
                return
            content = f"✅ Available Discord username: `{username}`"
        else:
            self.send_json(400, {"ok": False, "message": "Invalid webhook action."})
            return

        status, result = send_webhook(webhook_url, content)
        self.send_json(status, result)
