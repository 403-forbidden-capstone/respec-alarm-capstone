// 예측 준비 시간(기상 ~ 출발) — 앱 목업의 "공통 P80 + 개인 보정"(features/alarm/api.ts estimateAppointment)을 그대로 옮김
//   예측 = 공통 P80 + round(가중치 × 개인 오차 P80),  가중치 = n ÷ (n + k)
//   n = 내 기록 수, k = 축소 강도(prior), 개인 오차 P80 = 내 P80 − 공통 P80
//   기록이 없으면(n = 0) 개인 보정 0 → 공통 P80 그대로. 직접 고른 값이 있으면 그 값이 먼저 (자르지 않음)
// 문서(7장 7.2)는 "조건별 P80과 전체 P80을 n:K로 섞는 축소 추정"이라 같은 모양(공통 ↔ 개인을 n:k로 섞음)이지만
//   목업 숫자(k = 10, 공통 50 · 15)를 따름. 문서 K = 5 · 학습 대상 = 기상~출발 한 덩어리(R-19)와의 차이는 D56 (F1)
// 공통 P80 기본값 — 목업의 값. 전체 사용자 통계 칸이 DB에 없어 임시로 고정 (그날 첫 일정이면 기상부터, 아니면 외출 준비만)
export const DEFAULT_COMMON_P80 = { withWake: 50, sameDay: 15 } as const;
// 기상 뒤 준비 전 활동 기본값 (기상 알람이 있는 일정). 7장 pre_prep_minutes 기본 10분과 다르게 목업 값(20분)
export const DEFAULT_BEFORE_PREPARE_MINUTES = 20;
export const PREPARE_PRIOR_K = 10; // 목업 k
export const PERSONAL_MIN_SAMPLES = 5; // 7장 7.2.1 N_min — 이 아래면 출처를 DEFAULT로 표시
export const PREPARE_CORRECTION_MAX = 30; // 7장 7.0.5 ADJ_max ±30분
export const PREPARE_ESTIMATE_RANGE = { min: 15, max: 240 } as const; // 7장 7.2.2 clamp(15, 240) — 추정값에만

export type PrepareSource = 'DEFAULT' | 'PERSONAL' | 'MANUAL';
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export type PrepareInput = {
  commonP80: number;
  personalP80?: number | null; // 내 기상~출발 P80 (분). 기록이 없으면 null
  sampleCount: number; // n
  prior?: number; // k (기본 PREPARE_PRIOR_K)
  override?: number | null; // 직접 고른 준비 시간 (D42 C)
};

export type PrepareBasis = {
  minutes: number; // 적용되는 값 (직접 고른 값이 있으면 그것)
  autoMinutes: number; // 직접 고른 값이 없을 때의 예측값
  commonP80: number;
  correction: number; // 개인 보정 (분)
  sampleCount: number;
  prior: number;
  weight: number; // n ÷ (n + k)
  residualP80: number; // 개인 오차 P80
  source: PrepareSource;
  confidence: Confidence; // 7장 7.2.4 — 기록 수 기준 (최근 14일 조건은 안 봄)
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function predictPrepare(input: PrepareInput): PrepareBasis {
  const n = Math.max(0, Math.floor(input.sampleCount));
  const k = input.prior ?? PREPARE_PRIOR_K;
  const weight = n + k > 0 ? n / (n + k) : 0;
  const residual = input.personalP80 != null && n > 0 ? input.personalP80 - input.commonP80 : 0;
  const correction = clamp(Math.round(weight * residual), -PREPARE_CORRECTION_MAX, PREPARE_CORRECTION_MAX);
  const auto = clamp(input.commonP80 + correction, PREPARE_ESTIMATE_RANGE.min, PREPARE_ESTIMATE_RANGE.max);
  const manual = input.override != null;
  return {
    minutes: manual ? (input.override as number) : auto,
    autoMinutes: auto,
    commonP80: input.commonP80,
    correction,
    sampleCount: n,
    prior: k,
    weight,
    residualP80: residual,
    source: manual ? 'MANUAL' : n >= PERSONAL_MIN_SAMPLES ? 'PERSONAL' : 'DEFAULT',
    confidence: n >= 15 ? 'HIGH' : n >= PERSONAL_MIN_SAMPLES ? 'MEDIUM' : 'LOW',
  };
}

// 내가 적어 둔 준비(= 출발 − 준비 시작, daily_records.actual_prepare_minutes)의 P80을 기상~출발 기준으로 맞춤
//   기상 ~ 출발 = 준비 전 활동 + 준비 (7장 7.1.1: prep_minutes = morning_minutes − pre_prep_minutes)
export function toMorningMinutes(prepareP80: number, beforePrepareMinutes: number): number {
  return Math.round(prepareP80 + beforePrepareMinutes);
}

// P80 (percentile_cont(0.8)과 같은 선형 보간 — 뷰 v_prepare_time_stats와 같은 값)
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
