"""Original 2024 time-use-survey CatBoost v2 predictor.

Distinct from C1/W4 and from an app-verified physical preparation interval.
Training baseline: previous survey diary's 141/142 preparation cluster proxy.
This adapter uses the previous local app observation only in an EXPLICIT,
single-user, opt-in cross-domain research pilot. It does not establish accuracy
or safety for real alarms.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
from pathlib import Path
from typing import Any

from catboost import CatBoostRegressor

ORIGINAL_SHA256 = "90f559120f9be9745013d47e7ae3fac3e76b4c32835d3cb40918c8c4c748ee91"
MODEL_NAME = "prep_start_ratio_v2"
TRAINING_TARGET = "survey_start_cluster_proxy"
BASELINE = "survey_previous_day_app_proxy_transfer_v1"
FEATURES = ["weekday_code", "평토일구분코드", "휴일종류코드", "연령코드", "baseline_observed"]
_ALLOWED = [
    {str(n) for n in range(7)},
    {"1", "2", "3"},
    {str(n) for n in range(1, 7)} | {"__MISSING__"},
    {str(n) for n in range(1, 9)},
]


class InvalidSurveyRequest(ValueError):
    """Invalid research inference request; caller should return HTTP 422."""


class OriginalSurveyV2:
    def __init__(self, path: Path):
        manifest_path = path.with_suffix(".manifest.json")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if not (
            hmac.compare_digest(digest, ORIGINAL_SHA256)
            and hmac.compare_digest(str(manifest.get("sha256", "")), digest)
            and manifest.get("model") == MODEL_NAME
            and manifest.get("training_target") == TRAINING_TARGET
            and manifest.get("actual_app_start_confirmed") is False
            and manifest.get("feature_names") == FEATURES
            and "previous" in str(manifest.get("baseline", "")).lower()
            and "survey" in str(manifest.get("baseline", "")).lower()
        ):
            raise ValueError("Original survey CatBoost model/manifest provenance mismatch")
        self.model = CatBoostRegressor()
        self.model.load_model(str(path))
        if list(self.model.feature_names_) != FEATURES:
            raise ValueError("Survey model feature order mismatch")
        if set(self.model.get_cat_feature_indices()) != {0, 1, 2, 3}:
            raise ValueError("Survey categorical feature types mismatch")

    def predict(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("model") != MODEL_NAME or payload.get("baseline_definition") != BASELINE:
            raise InvalidSurveyRequest("Wrong survey model or baseline contract")
        history_count = payload.get("history_count")
        if type(history_count) is not int or not 10 <= history_count <= 30:
            raise InvalidSurveyRequest("Ten valid post-edit sessions required")
        x = payload.get("features")
        if not isinstance(x, dict) or set(x) != set(FEATURES):
            raise InvalidSurveyRequest("Unexpected survey feature schema")
        if any(type(x[name]) is not str or x[name] not in codes
               for name, codes in zip(FEATURES[:4], _ALLOWED)):
            raise InvalidSurveyRequest("Invalid survey categorical code")
        baseline = x["baseline_observed"]
        if type(baseline) not in (int, float) or not math.isfinite(baseline) or not 10 <= baseline <= 240:
            raise InvalidSurveyRequest("Invalid previous-day observation")
        values = [x[name] for name in FEATURES[:4]] + [float(baseline)]
        raw = float(self.model.predict([values])[0])
        if not math.isfinite(raw):
            raise RuntimeError("Nonfinite survey model inference")
        minutes = max(5.0, min(240.0, (baseline + 10) *
            math.exp(max(-1.5, min(1.5, raw))) - 10))
        ratio = minutes / baseline
        if not .5 <= ratio <= 2:
            raise InvalidSurveyRequest("Survey transfer outside guardrail")
        return {
            "model": MODEL_NAME,
            "training_target": TRAINING_TARGET,
            "baseline_definition": BASELINE,
            "prediction_type": "ratio",
            "minutes": round(minutes, 3),
            "ratio": round(ratio, 5),
        }
