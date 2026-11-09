#!/usr/bin/env python3
"""Safe, dummy-data HTTP smoke test for the temporary HTTPS tunnel.

Usage:
    python3 scripts/test-prepare-ml-tunnel.py https://RANDOM.trycloudflare.com

Reads the API token from ~/.config/respec-alarm/prepare-ml-tunnel.env;
never logs the token and does not touch Supabase or any user's real profile.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request


def get_token() -> str:
    path = pathlib.Path.home() / ".config/respec-alarm/prepare-ml-tunnel.env"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("CATBOOST_API_TOKEN="):
            return line.partition("=")[2].strip()
    raise RuntimeError("Missing CATBOOST_API_TOKEN in local protected file")


def read_json(request: urllib.request.Request) -> dict:
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/test-prepare-ml-tunnel.py https://RANDOM.trycloudflare.com")
    base = sys.argv[1].rstrip("/")
    parsed = urllib.parse.urlparse(base)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not parsed.hostname.endswith(".trycloudflare.com")
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("Only a clean https://*.trycloudflare.com base URL is permitted")
    token = get_token()
    if len(token) != 64:
        raise RuntimeError("Unexpected local API token format")

    health = read_json(urllib.request.Request(base + "/health"))
    print("health:", json.dumps(health, ensure_ascii=False))
    assert health["ok"] is True
    assert set(health["loaded_models"]) == {"c1_mae", "w4_mae"}

    # Confirm unauthorized callers cannot request predictions.
    unauthorized = urllib.request.Request(
        base + "/predict",
        data=b'{"model":"c1_mae","features":{}}',
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        read_json(unauthorized)
    except urllib.error.HTTPError as exc:
        if exc.code != 401:
            raise
        print("auth check: missing key returns 401")
    else:
        raise AssertionError("Security error: prediction request without a key succeeded")

    features = {
        "weekday_code": "1",
        "평토일구분코드": "1",
        "휴일종류코드": "__MISSING__",
        "연령코드": "2",
        "교육재학코드": "1",
        "경제활동상태코드": "1",
    }
    for model in ("c1_mae", "w4_mae"):
        values = features.copy()
        if model == "w4_mae":
            values["previous_day_target_minutes"] = 60.0
        request = urllib.request.Request(
            base + "/predict",
            data=json.dumps({"model": model, "features": values}, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-api-key": token},
            method="POST",
        )
        result = read_json(request)
        assert result["model"] == model, result
        assert result["prediction_type"] == "point", result
        assert type(result["minutes"]) is int and 10 <= result["minutes"] <= 240, result
        print(f"{model}: {result['minutes']} minutes (point prediction)")
    print("TUNNEL_PREDICT_OK")


if __name__ == "__main__":
    main()
