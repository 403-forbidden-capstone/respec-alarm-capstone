"""Re:Spec CatBoost prediction service: only C1 and W4."""
from __future__ import annotations

import hmac
import math
import os
from pathlib import Path
from typing import Any, Literal

from catboost import CatBoostRegressor
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from survey_v2_model import InvalidSurveyRequest, OriginalSurveyV2, MODEL_NAME as SURVEY_V2_NAME

MODEL_FILES = {
    "c1_mae": "c1_mae.cbm",
    "w4_mae": "w4_mae.cbm",
}
EXPECTED_FEATURES = {
    "c1_mae": ["weekday_code", "평토일구분코드", "휴일종류코드", "연령코드"],
    "w4_mae": ["weekday_code", "평토일구분코드", "휴일종류코드", "previous_day_target_minutes", "연령코드"],
}
MODEL_DIR = Path(os.environ.get("CATBOOST_MODEL_DIR", "models/v4_age_only")).expanduser().resolve()
SURVEY_V2_PATH = Path(os.environ.get("SURVEY_V2_MODEL_PATH", "/app/models/survey_v2/prep_start_ratio_v2.cbm"))
API_TOKEN = os.environ.get("CATBOOST_API_TOKEN", "")
if not API_TOKEN:
    raise RuntimeError("CATBOOST_API_TOKEN must be set")


class StoredModel:
    def __init__(self, key: str, path: Path) -> None:
        self.key = key
        self.path = path
        self.model = CatBoostRegressor()
        self.model.load_model(str(path))
        self.names = list(self.model.feature_names_)
        self.categorical = set(self.model.get_cat_feature_indices())
        if self.names != EXPECTED_FEATURES[key]:
            raise ValueError(f"Unexpected model feature order for {key}: {self.names!r}")
        expected_numeric = {3} if key == "w4_mae" else set()
        if (set(range(len(self.names))) - self.categorical) != expected_numeric:
            raise ValueError(f"Unexpected feature types for {key}")

    def describe(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "file": self.path.name,
            "features": [
                {"name": name, "type": "categorical" if i in self.categorical else "numeric"}
                for i, name in enumerate(self.names)
            ],
        }

    def predict(self, features: dict[str, Any]) -> float:
        missing = sorted(set(self.names) - features.keys())
        unknown = sorted(features.keys() - set(self.names))
        if missing or unknown:
            raise HTTPException(422, detail={"missing": missing, "unknown": unknown})
        ordered: list[Any] = []
        for i, name in enumerate(self.names):
            value = features[name]
            if value is None or isinstance(value, bool):
                raise HTTPException(422, detail=f"Invalid value: {name}")
            if i in self.categorical:
                if not isinstance(value, (str, int, float)) or (
                    isinstance(value, float) and not math.isfinite(value)
                ):
                    raise HTTPException(422, detail=f"Invalid category: {name}")
                ordered.append(str(value))
            else:
                try:
                    numeric = float(value)
                except (TypeError, ValueError, OverflowError):
                    raise HTTPException(422, detail=f"Invalid number: {name}") from None
                if not math.isfinite(numeric):
                    raise HTTPException(422, detail=f"Non-finite number: {name}")
                ordered.append(numeric)
        predicted = float(self.model.predict([ordered])[0])
        if not math.isfinite(predicted):
            raise HTTPException(500, detail="Non-finite model prediction")
        return predicted


MODELS: dict[str, StoredModel] = {}
LOAD_ERRORS: dict[str, str] = {}
for key, filename in MODEL_FILES.items():
    path = MODEL_DIR / filename
    if path.is_file():
        try:
            MODELS[key] = StoredModel(key, path)
        except Exception as error:
            LOAD_ERRORS[key] = f"{type(error).__name__}: {error}"


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: Literal["c1_mae", "w4_mae", "prep_start_ratio_v2"]
    baseline_definition: str | None = None
    history_count: int | None = None
    features: dict[str, Any] = Field(default_factory=dict)


# The survey model is optional. An absent survey artifact NEVER prevents the
# existing C1/W4 container from starting or becoming healthy.
SURVEY_V2: OriginalSurveyV2 | None = None
SURVEY_V2_LOAD_ERROR: str | None = None
if SURVEY_V2_PATH.is_file():
    try:
        SURVEY_V2 = OriginalSurveyV2(SURVEY_V2_PATH)
    except Exception as error:
        SURVEY_V2_LOAD_ERROR = f"{type(error).__name__}: {error}"

app = FastAPI(title="Re:Spec CatBoost Preparation Predictors", version="0.5.0")


def authorize(key: str | None) -> None:
    if not key or not hmac.compare_digest(key, API_TOKEN):
        raise HTTPException(401, detail="Invalid API key")


@app.get("/health")
def health(response: Response) -> dict[str, Any]:
    ready = len(MODELS) == 2 and not LOAD_ERRORS
    if not ready:
        response.status_code = 503
    return {"ok": ready, "loaded_models": list(MODELS) + ([SURVEY_V2_NAME] if SURVEY_V2 else [])}


@app.get("/models")
def models(x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(x_api_key)
    return {
        "model_dir": str(MODEL_DIR),
        "models": [m.describe() for m in MODELS.values()],
        "missing": [key for key in MODEL_FILES if key not in MODELS and key not in LOAD_ERRORS],
        "load_errors": {**LOAD_ERRORS, **({SURVEY_V2_NAME: SURVEY_V2_LOAD_ERROR} if SURVEY_V2_LOAD_ERROR else {})},
        "survey_v2_available": SURVEY_V2 is not None,
    }


@app.post("/predict")
def predict(body: PredictRequest, x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(x_api_key)
    if body.model == SURVEY_V2_NAME:
        if SURVEY_V2 is None:
            raise HTTPException(503, detail="Survey v2 model not loaded")
        try:
            return SURVEY_V2.predict(body.model_dump())
        except InvalidSurveyRequest as error:
            raise HTTPException(422, detail=str(error)) from error
    if body.model not in MODELS:
        raise HTTPException(503, detail="Model not loaded")
    raw = MODELS[body.model].predict(body.features)
    rounded = math.floor(raw + 0.5)
    minutes = max(10, min(240, rounded))
    return {
        "model": body.model,
        "raw_minutes": raw,
        "minutes": minutes,
        "clipped": minutes != rounded,
        "prediction_type": "point",
    }
