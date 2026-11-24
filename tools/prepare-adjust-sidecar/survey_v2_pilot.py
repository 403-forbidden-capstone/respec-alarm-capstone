#!/usr/bin/env python3
"""Authenticated survey-v2 transfer pilot. Do not present proxy as actual prep.

The original artifact was trained on the previous 2024 survey diary day.
The app's preceding local-day PREPARE_ALARM->LOCATION observation is a
cross-domain proxy: explicit single-user opt-in is required for any live use.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pandas as pd
from catboost import CatBoostRegressor

MODEL = "prep_start_ratio_v2"
TARGET = "survey_start_cluster_proxy"
BASELINE = "survey_previous_day_app_proxy_transfer_v1"
FEATURES = ["weekday_code", "평토일구분코드", "휴일종류코드", "연령코드", "baseline_observed"]
CATS = FEATURES[:4]


def load_verified_model(model_path: Path):
    manifest_path = model_path.with_suffix(".manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
    if not hmac.compare_digest(str(manifest.get("sha256", "")), digest):
        raise ValueError("Model hash mismatch")
    if (manifest.get("model") != MODEL or
            manifest.get("training_target") != TARGET or
            manifest.get("actual_app_start_confirmed") is not False or
            manifest.get("feature_names") != FEATURES or
            "previous" not in str(manifest.get("baseline", "")).lower() or
            "survey" not in str(manifest.get("baseline", "")).lower()):
        raise ValueError("Survey model provenance mismatch")
    model = CatBoostRegressor()
    model.load_model(str(model_path))
    if model.feature_names_ != FEATURES:
        raise ValueError("Binary feature schema mismatch")
    return model


def predict(model, payload):
    if not isinstance(payload, dict) or payload.get("model") != MODEL or payload.get("baseline_definition") != BASELINE:
        raise ValueError("Unexpected model or baseline contract")
    history_count = payload.get("history_count")
    if type(history_count) is not int or not 10 <= history_count <= 30:
        raise ValueError("At least ten genuine past observations required")
    x = payload.get("features")
    if not isinstance(x, dict) or set(x) != set(FEATURES):
        raise ValueError("Invalid feature schema")
    allowed = [
        [str(n) for n in range(7)],
        ["1", "2", "3"],
        [str(n) for n in range(1, 7)] + ["__MISSING__"],
        [str(n) for n in range(1, 9)],
    ]
    if any(type(x[c]) is not str or x[c] not in values for c, values in zip(CATS, allowed)):
        raise ValueError("Invalid categorical feature")
    base = x["baseline_observed"]
    if type(base) not in (float, int) or not math.isfinite(base) or not 10 <= base <= 240:
        raise ValueError("Invalid previous-day baseline")
    df = pd.DataFrame([{**{c: x[c] for c in CATS}, "baseline_observed": float(base)}])
    logratio = float(model.predict(df[FEATURES])[0])
    if not math.isfinite(logratio):
        raise ValueError("Invalid model output")
    minutes = max(5.0, min(240.0, (base + 10) * math.exp(max(-1.5, min(1.5, logratio))) - 10))
    ratio = minutes / base
    if not .5 <= ratio <= 2:
        raise ValueError("Out-of-distribution safety band")
    return {
        "model": MODEL,
        "training_target": TARGET,
        "baseline_definition": BASELINE,
        "prediction_type": "ratio",
        "minutes": round(minutes, 3),
        "ratio": round(ratio, 5),
    }


def main():
    token = os.environ.get("SURVEY_V2_PILOT_API_TOKEN", "")
    model_path = os.environ.get("SURVEY_V2_PILOT_MODEL_PATH", "")
    if len(token) < 24 or not model_path:
        raise SystemExit("SURVEY_V2_PILOT_API_TOKEN (>=24 chars) and SURVEY_V2_PILOT_MODEL_PATH are required")
    model = load_verified_model(Path(model_path))

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, result):
            body = json.dumps(result).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.send_json(200, {"ok": True, "model": MODEL, "target": TARGET}) if self.path == "/health" else self.send_json(404, {})

        def do_POST(self):
            if self.path != "/predict":
                return self.send_json(404, {})
            if not hmac.compare_digest(self.headers.get("x-api-key", ""), token):
                return self.send_json(401, {"error": "unauthorized"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096:
                    return self.send_json(413, {"error": "invalid_size"})
                payload = json.loads(self.rfile.read(length))
                return self.send_json(200, predict(model, payload))
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                return self.send_json(400, {"error": "invalid_request"})
            except Exception:
                return self.send_json(503, {"error": "prediction_unavailable"})

    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("SURVEY_V2_PILOT_PORT", "8095"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
