from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from typing import Any

ENDPOINT = "https://discord.com/api/v9/unique-username/username-attempt-unauthed"
USERNAME_RE = re.compile(r"^[a-z0-9._]{2,32}$")
MAX_BODY_BYTES = 4_096
REQUEST_TIMEOUT_SECONDS = 15


def valid_username(username: Any) -> bool:
    return (
        isinstance(username, str)
        and bool(USERNAME_RE.fullmatch(username))
        and ".." not in username
    )


def read_json_response(response: Any) -> dict[str, Any]:
    raw = response.read(64_000)
    if not raw:
        return {}
    parsed = json.loads(raw.decode("utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def check_username(username: str) -> tuple[int, dict[str, Any]]:
    payload = json.dumps({"username": username}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 DiscordUsernameChecker-Vercel/1.0",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            data = read_json_response(response)
    except urllib.error.HTTPError as exc:
        retry_after: float | None = None
        try:
            error_data = read_json_response(exc)
            raw_retry = error_data.get("retry_after")
            if raw_retry is not None:
                retry_after = float(raw_retry)
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
            pass

        if retry_after is None and exc.headers:
            raw_header = exc.headers.get("Retry-After")
            try:
                retry_after = float(raw_header) if raw_header else None
            except (TypeError, ValueError):
                retry_after = None

        if exc.code == 429:
            return 429, {
                "status": "rate_limited",
                "username": username,
                "retry_after": max(5.0, retry_after or 5.0),
                "message": "Discord rate limited this Vercel deployment.",
            }
        if exc.code in (401, 403):
            return 502, {
                "status": "error",
                "username": username,
                "message": "Discord rejected requests from this Vercel deployment.",
            }
        return 502, {
            "status": "error",
            "username": username,
            "message": f"Discord returned HTTP {exc.code}.",
        }
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 502, {
            "status": "error",
            "username": username,
            "message": f"Could not connect to Discord: {exc}",
        }
    except (json.JSONDecodeError, UnicodeDecodeError):
        return 502, {
            "status": "error",
            "username": username,
            "message": "Discord returned an unexpected response.",
        }

    taken = data.get("taken")
    if not isinstance(taken, bool):
        return 502, {
            "status": "error",
            "username": username,
            "message": "Discord's response did not contain a valid taken value.",
        }

    return 200, {
        "status": "taken" if taken else "available",
        "username": username,
    }


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
        self.send_json(200, {"ok": True, "service": "discord-username-check"})

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(400, {"status": "error", "message": "Invalid request body."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"status": "error", "message": "Send valid JSON."})
            return

        raw_username = payload.get("username") if isinstance(payload, dict) else None
        username = raw_username.strip().lower() if isinstance(raw_username, str) else ""

        if not valid_username(username):
            self.send_json(
                400,
                {
                    "status": "invalid",
                    "username": username,
                    "message": "Use 2-32 lowercase letters, numbers, periods, or underscores; no consecutive periods.",
                },
            )
            return

        status, result = check_username(username)
        self.send_json(status, result)
