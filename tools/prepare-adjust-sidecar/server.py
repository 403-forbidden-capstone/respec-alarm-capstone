#!/usr/bin/env python3
"""Research/QA-only server for an eventual real-duration CatBoost model.

IMPORTANT: The 2024 survey 141+142 proxy is NOT validated against actual user
prep-start -> departure. Do not use that research .cbm to schedule real alarms.
"""
from __future__ import annotations

import hmac
import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from catboost import CatBoostRegressor
import pandas as pd

CATS = ["weekday_code", "평토일구분코드", "휴일종류코드", "연령코드"]
FEATURES = [*CATS, "baseline_observed"]
MODEL_NAME = "prep_ratio_v1"
MAX_BODY = 4096


def predict(model: CatBoostRegressor, payload: dict, training_target: str) -> dict:
    if payload.get("model") != MODEL_NAME:
        raise ValueError("unexpected model")
    features = payload.get("features")
    if not isinstance(features, dict) or set(features) != set(FEATURES):
        raise ValueError("invalid feature schema")
    count = payload.get("history_count")
    if type(count) is not int or count < 3 or count > 30:
        raise ValueError("insufficient history")
    baseline = features.get("baseline_observed")
    if type(baseline) not in (int, float) or not math.isfinite(baseline) or not 5 <= baseline <= 240:
        raise ValueError("invalid baseline")
    for key in CATS:
        if not isinstance(features[key], str) or len(features[key]) > 20:
            raise ValueError(f"invalid {key}")
    if not features["weekday_code"] in [str(n) for n in range(7)]:
        raise ValueError("invalid weekday")
    if features["평토일구분코드"] not in ("1", "2", "3"):
        raise ValueError("invalid day type")
    if features["휴일종류코드"] not in (*[str(n) for n in range(1, 7)], "__MISSING__"):
        raise ValueError("invalid rest pattern")
    if features["연령코드"] not in [str(n) for n in range(1, 9)]:
        raise ValueError("invalid age code")
    x = pd.DataFrame([{**{c: features[c] for c in CATS}, "baseline_observed": float(baseline)}])
    log_ratio = float(model.predict(x[FEATURES])[0])
    if not math.isfinite(log_ratio):
        raise ValueError("nonfinite prediction")
    # The training target MUST be log((actual-preparation + 10)/(baseline + 10)).
    minutes = min(240, max(5, (baseline + 10) * math.exp(max(-1.5, min(1.5, log_ratio))) - 10))
    ratio = minutes / baseline
    if not 0.5 <= ratio <= 2.0:
        raise ValueError("ratio outside safety band")
    return {
        "model": MODEL_NAME, "prediction_type": "ratio", "training_target": training_target,
        "minutes": round(minutes, 3), "ratio": round(ratio, 5),
    }


def main() -> None:
    token = os.environ.get("PREP_ADJUST_API_TOKEN")
    model_path = os.environ.get("PREP_ADJUST_MODEL_PATH")
    if not token or len(token) < 24 or not model_path or not Path(model_path).is_file():
        raise SystemExit("PREP_ADJUST_API_TOKEN (>=24 characters) and PREP_ADJUST_MODEL_PATH are required")
    training_target = os.environ.get('PREP_ADJUST_MODEL_TRAINING_TARGET', '')
    if training_target not in ('actual_start_depart', 'survey_141142_proxy'):
        raise SystemExit('PREP_ADJUST_MODEL_TRAINING_TARGET must be explicitly declared')
    if training_target == 'survey_141142_proxy' and os.environ.get('PREP_ADJUST_ALLOW_SURVEY_PROXY') != '1':
        raise SystemExit('Survey proxy model requires PREP_ADJUST_ALLOW_SURVEY_PROXY=1 for research testing only')
    model = CatBoostRegressor()
    model.load_model(model_path)

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status: int, body: dict) -> None:
            blob = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)

        def do_GET(self) -> None:
            self.send_json(200, {"ok": True}) if self.path == "/health" else self.send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path != "/predict":
                return self.send_json(404, {"error": "not_found"})
            if not hmac.compare_digest(self.headers.get("x-api-key", ""), token):
                return self.send_json(401, {"error": "unauthorized"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    return self.send_json(413, {"error": "invalid_body_size"})
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    return self.send_json(400, {"error": "invalid_body"})
                result = predict(model, payload, training_target)
                return self.send_json(200, result)
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                return self.send_json(400, {"error": "invalid_prediction_request"})
            except Exception:
                return self.send_json(503, {"error": "prediction_unavailable"})

        def log_message(self, fmt: str, *args: object) -> None:
            # No request body, user ID, or authorization header in logs.
            super().log_message(fmt, *args)

    host = os.environ.get("PREP_ADJUST_HOST", "127.0.0.1")
    port = int(os.environ.get("PREP_ADJUST_PORT", "8094"))
    print(f"prep-adjust model server listening on {host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
