"""Re:Spec CatBoost prediction service: only C1 and W4."""
from __future__ import annotations

import hmac
import math
import os
from pathlib import Path
from typing import Any, Literal

from catboost import CatBoostRegressor
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

MODEL_FILES = {
    "c1_mae": "C1_optional_profile_mae.cbm",
    "w4_mae": "W4_previous_duration_optional_profile_mae.cbm",
}
MODEL_DIR = Path(os.environ.get("CATBOOST_MODEL_DIR", "models/v4")).expanduser().resolve()
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
        if not self.names or len(self.names) != len(set(self.names)):
            raise ValueError(f"Feature names missing or duplicated: {key}")

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
    model: Literal["c1_mae", "w4_mae"]
    features: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(title="Re:Spec C1/W4 Preparation Predictor", version="0.3.0")


def authorize(key: str | None) -> None:
    if not key or not hmac.compare_digest(key, API_TOKEN):
        raise HTTPException(401, detail="Invalid API key")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": len(MODELS) == 2 and not LOAD_ERRORS, "loaded_models": list(MODELS)}


@app.get("/models")
def models(x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(x_api_key)
    return {
        "model_dir": str(MODEL_DIR),
        "models": [m.describe() for m in MODELS.values()],
        "missing": [key for key in MODEL_FILES if key not in MODELS and key not in LOAD_ERRORS],
        "load_errors": LOAD_ERRORS,
    }


@app.post("/predict")
def predict(body: PredictRequest, x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(x_api_key)
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
