// 예측 준비 시간(기상 ~ 출발) — 앱 목업의 "공통 P80 + 개인 보정"(features/alarm/api.ts estimateAppointment)을 그대로 옮김
//   예측 = 공통 P80 + round(가중치 × 개인 오차 P80),  가중치 = n ÷ (n + k)
//   n = 내 기록 수, k = 축소 강도(prior), 개인 오차 P80 = 내 P80 − 공통 P80
//   기록이 없으면(n = 0) 개인 보정 0 → 공통 P80 그대로. 직접 고른 값이 있으면 그 값이 먼저
//   보정 상한(7장 7.0.5 ADJ_max ±30분)과 예측 범위(7장 7.2.2 clamp(15, 240))는 목업 계산에 없어서 넣지 않음 — 앱이 이 계산을 그대로 가져다 쓰므로
//   목업과 한 줄도 달라지면 안 됨. 7장 clamp는 D56(계산 규칙) 뒤에 넣음
// 문서(7장 7.2)는 "조건별 P80과 전체 P80을 n:K로 섞는 축소 추정"이라 같은 모양(공통 ↔ 개인을 n:k로 섞음)이지만
//   목업 숫자(k = 10, 공통 50 · 15)를 따름. 문서 K = 5 · 학습 대상 = 기상~출발 한 덩어리(R-19)와의 차이는 D56 (F1)
// 공통 P80 기본값 — 목업의 값. 전체 사용자 통계 칸이 DB에 없어 임시로 고정 (그날 첫 일정이면 기상부터, 아니면 외출 준비만)
//   withWake는 온보딩 값(profiles.default_prepare_minutes)이 없을 때만 씀 — 있으면 그 값이 "기상~출발 첫 값" (학습 루프 기초 1절 ①). sameDay 15는 그대로
export const DEFAULT_COMMON_P80 = { withWake: 50, sameDay: 15 } as const;
// 기상 뒤 준비 전 활동 기본값 (기상 알람이 있는 일정). 7장 pre_prep_minutes 기본 10분과 다르게 목업 값(20분)
export const DEFAULT_BEFORE_PREPARE_MINUTES = 20;
export const PREPARE_PRIOR_K = 10; // 목업 k
export const PERSONAL_MIN_SAMPLES = 5; // 7장 7.2.1 N_min — 이 아래면 출처를 DEFAULT(첫 값)로 표시
// 학습에 쓰는 기록 범위 (학습 루프 기초 ③, 7장 7.0.5 N_win) — 최근 30건, 기상~출발 10~240분만 (잘못 찍힌 5분 · 400분 같은 값은 버림). 상한 240 = D107 기본안 A(4시간 넘으면 학습에 안 씀, 기록은 남김)
export const PREPARE_WINDOW = 30;
export const PREPARE_RECORD_MIN = 10;
export const PREPARE_RECORD_MAX = 240;

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

export function predictPrepare(input: PrepareInput): PrepareBasis {
  const n = Math.max(0, Math.floor(input.sampleCount));
  const k = input.prior ?? PREPARE_PRIOR_K;
  const weight = n + k > 0 ? n / (n + k) : 0;
  const residual = input.personalP80 != null && n > 0 ? input.personalP80 - input.commonP80 : 0;
  const correction = Math.round(weight * residual);
  const auto = input.commonP80 + correction;
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

// 준비 전 활동을 더해 "기상 ~ 출발"로 바꾸는 계산 (7장 7.1.1: prep_minutes = morning_minutes − pre_prep_minutes)
//   지금 알람 계산(plan-core.ts)은 부르지 않음 — 기록(daily_records.actual_prepare_minutes)이 이미 기상~출발이라
//   여기에 20분을 또 더하면 기록이 쌓일수록 알람이 일찍 당겨지는 버그였음 (학습 루프 기초 2절 1). 공용 export라 남겨 둠
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

// 기록 목록(최신순)에서 학습에 쓸 것만 — 10~240분, 앞에서 30건. 개수(n)와 P80이 같은 30건 기준 (학습 루프 기초 ③)
//   뷰 v_prepare_time_stats(전체 기간 · 거르기 없음)를 대신함. 값이 소수 · 문자여도 숫자로 읽고 유한한 값만 셈
export function prepareStatsOf(minutesNewestFirst: readonly (number | string | null | undefined)[]): { sampleCount: number; p80: number | null } {
  const used: number[] = [];
  for (const raw of minutesNewestFirst) {
    if (used.length >= PREPARE_WINDOW) break;
    if (raw == null) continue;
    const m = Number(raw);
    if (Number.isFinite(m) && m >= PREPARE_RECORD_MIN && m <= PREPARE_RECORD_MAX) used.push(m);
  }
  return { sampleCount: used.length, p80: percentile(used, 0.8) };
}

// 계산 근거에 보이는 출처 한 줄 (H03 · H05) — 5건부터 "내 기록 기반 N건", 4건까지는 "배우는 중 N/5". 통계 식 · P80 같은 말은 화면에 안 보임 (D47)
//   앱 가짜 모드와 서버 실데이터가 같은 글자가 되도록 한 곳에서 만듦
export function prepareSourceLabel(sampleCount: number): string {
  const n = Math.max(0, Math.floor(sampleCount));
  return n >= PERSONAL_MIN_SAMPLES ? `내 기록 기반 ${n}건` : `배우는 중 ${n}/${PERSONAL_MIN_SAMPLES}`;
}
