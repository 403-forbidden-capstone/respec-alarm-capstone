#!/usr/bin/env python3
"""Train on actual opt-in user preparation sessions ONLY, not 2024 survey proxy.

Expected CSV columns:
user_id,prepare_started_at,departed_at,prepare_started_source,
weekday_code,평토일구분코드,휴일종류코드,연령코드

Every training row predicts the current session using ONLY previous sessions
from the same user. Split by user before training; never train on future events.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor

CATS = ["weekday_code", "평토일구분코드", "휴일종류코드", "연령코드"]
FEATURES = [*CATS, "baseline_observed"]
SEED = 42


def build_samples(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, encoding="utf-8-sig")
    required = set(CATS + ["user_id", "prepare_started_at", "departed_at", "prepare_started_source"])
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing input columns: {sorted(missing)}")
    df["start"] = pd.to_datetime(df["prepare_started_at"], errors="coerce", utc=True)
    df["depart"] = pd.to_datetime(df["departed_at"], errors="coerce", utc=True)
    df["minutes"] = (df["depart"] - df["start"]).dt.total_seconds() / 60
    df = df[
        df["prepare_started_source"].isin(["PREPARE_ALARM", "ROUTINE_STEP"])
        & df["minutes"].between(5, 240)
        & df["start"].notna()
        & df["depart"].notna()
        & df["user_id"].notna()
    ].copy()
    # Same completion should never occur twice for one user.
    df = df.drop_duplicates(["user_id", "depart"], keep="first")
    for c in CATS:
        df[c] = df[c].fillna("__MISSING__").replace("", "__MISSING__")
    invalid_age = ~df["연령코드"].isin([str(i) for i in range(1, 9)])
    if invalid_age.any():
        df = df.loc[~invalid_age]
    rows = []
    for uid, group in df.sort_values(["depart", "start"]).groupby("user_id", sort=False):
        prev: list[float] = []
        for _, cur in group.iterrows():
            # The target day is not available in prev.
            if len(prev) >= 10:
                recent = prev[-30:]
                row = {"user_id": uid, **{c: cur[c] for c in CATS},
                       "baseline_observed": float(np.mean(recent)),
                       "history_count": len(recent),
                       "target": float(cur["minutes"])}
                rows.append(row)
            prev.append(float(cur["minutes"]))
    if not rows:
        raise ValueError("No trainable sessions: require >=11 real completed prep sessions per user")
    return pd.DataFrame(rows)


def score(y: np.ndarray, pred: np.ndarray) -> dict:
    gap = y - pred
    return {"n": int(len(y)), "MAE": round(float(np.abs(gap).mean()), 3),
            "RMSE": round(float(np.sqrt(np.mean(gap ** 2))), 3),
            "under_rate": round(float(np.mean(gap > 0)), 4)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions-csv", required=True)
    parser.add_argument("--out-dir", default="reports/prepare-adjust-service")
    parser.add_argument("--min-train-users", type=int, default=100)
    args = parser.parse_args()
    samples = build_samples(Path(args.sessions_csv))
    ids = samples["user_id"].unique()
    if len(ids) < args.min_train_users:
        raise SystemExit(f"Only {len(ids)} users with >=11 records; need {args.min_train_users}")
    rng = np.random.default_rng(SEED)
    ids = rng.permutation(ids)
    n = len(ids)
    train_ids = set(ids[:int(n*.7)])
    valid_ids = set(ids[int(n*.7):int(n*.85)])
    test_ids = set(ids[int(n*.85):])
    tr = samples[samples.user_id.isin(train_ids)]
    va = samples[samples.user_id.isin(valid_ids)]
    te = samples[samples.user_id.isin(test_ids)]
    if min(len(tr),len(va),len(te)) == 0:
        raise SystemExit("Empty split")
    label = np.log((tr.target.to_numpy(float) + 10)/(tr.baseline_observed.to_numpy(float) + 10))
    model = CatBoostRegressor(iterations=450, depth=5, learning_rate=.045, l2_leaf_reg=4,
                              loss_function="MAE", random_seed=SEED, verbose=False,
                              allow_writing_files=False)
    model.fit(tr[FEATURES], label, cat_features=CATS)
    def predict(rows: pd.DataFrame) -> np.ndarray:
        z = np.clip(model.predict(rows[FEATURES]), -1.5, 1.5)
        return np.clip((rows.baseline_observed.to_numpy(float)+10)*np.exp(z)-10, 5, 240)
    yv,yt = va.target.to_numpy(float),te.target.to_numpy(float)
    vp,tp = predict(va),predict(te)
    # Calibration is report-only, never implicitly added by the model server.
    margin = float(np.quantile(yv-vp,.8))
    metrics = {
        "target": "actual_confirmed_preparation_start_to_departure_minutes",
        "minimum_history": 10,
        "user_counts": {"train":len(train_ids),"valid":len(valid_ids),"test":len(test_ids)},
        "train_samples": len(tr),
        "validation": {"baseline":score(yv,va.baseline_observed.to_numpy(float)),
                        "model":score(yv,vp)},
        "test": {"baseline":score(yt,te.baseline_observed.to_numpy(float)),
                 "model":score(yt,tp)},
        "validation_80pct_residual_margin_minutes":round(margin,2),
        "test_with_margin":score(yt,np.clip(tp+margin,5,240)),
        "warning":"PREPARE_ALARM is user dismissal/one-tap, not guaranteed true physical start; validate reliability",
    }
    out = Path(args.out_dir)
    out.mkdir(parents=True,exist_ok=True)
    model_file = out/"prep_ratio_actual_sessions.cbm"
    model.save_model(str(model_file))
    (out/"prep_ratio_actual_sessions.manifest.json").write_text(json.dumps({
        "training_target":"actual_start_depart",
        "sha256":hashlib.sha256(model_file.read_bytes()).hexdigest(),
        "model":"prep_start_ratio_v2",
        "feature_names":FEATURES,
        "minimum_history":10,
        "user_split":"user-disjoint",
    },ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"metrics.json").write_text(json.dumps(metrics,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(metrics,ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
