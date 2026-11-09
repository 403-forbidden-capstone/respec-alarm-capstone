// 알람 조정 제안 (ALG-07) — 준비 알람을 당길지 · 몇 분 당길지 (순수 함수, 새벽 배치 · 앱 미리 보기가 같이 씀 — 아직 부르는 곳 없음)
//   준비 = 루틴 첫 단계 시작 ~ 출발 (없으면 준비 알람을 끈 시각부터). 잔차 = 실제 준비 − 예측 준비(적용한 제안 분 포함)
//   당기는 알람은 준비 알람. 준비 전 시간(기상 → 준비 알람)이 모자라면 모자란 만큼만 기상도 당김 (팀 회의 · 안건 초안 D111 1 · 2번)
//   판단 · 크기 = 안건 초안 D111 4번 기본안 A: 최근 3번 모두 예측보다 길고 평균 5분 이상 → 평균을 5분 단위로 내림, D62 상한 안
//     근거: 가상 유저 실험(tools/suggest-lab, 로컬) — 잔차 누적합(CUSUM) · 중앙값 크기와 분위 손실 차이 0.2 안쪽, 화면 근거 설명이 가장 쉬움

export type SuggestRule = { window: number; minMean: number };

export const SUGGEST_DEFAULT_RULE: SuggestRule = { window: 3, minMean: 5 };
export const SUGGEST_ROUND_TO = 5; // 제안 분은 5분 단위로 내림 (12분 → 10분)

export type SuggestInput = {
  residuals: readonly number[]; // 오래된 → 최근. D62 제외일 · 잘못 찍힌 값 · 지난 제안 뒤 효과 보는 중인 회차는 부르는 쪽이 이미 뺌
  beforePrepareMinutes: number; // 지금 기상 알람 → 준비 알람 사이 (준비 전 시간). 기상 알람이 없는 일정은 Infinity
  capMinutes: number; // D62 변화 상한 (처음 2주 하루 10분, 그 뒤 주 5분) — 부르는 쪽이 기간에 맞춰 넘김
  rule?: SuggestRule;
};

export type PrepareAdvance = {
  minutes: number; // 준비 알람을 당기는 분
  wakeMinutes: number; // 그중 기상까지 당겨야 하는 분 (준비 전 시간이 모자란 만큼)
  evidence: number[]; // 근거로 쓴 잔차 — 화면 "최근 3번 +10 · +14 · +12분"
  overrun: number; // 근거 잔차 평균 (내림 · 상한 전)
};

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// 예측이 계속 짧았는지 — 최근 window번 모두 +이고 평균이 minMean분 이상이면 그 잔차를 돌려줌 (아니면 null)
export function detectOverrun(residuals: readonly number[], rule: SuggestRule = SUGGEST_DEFAULT_RULE): number[] | null {
  if (residuals.length < rule.window) return null;
  const recent = residuals.slice(-rule.window);
  if (recent.some((r) => r <= 0)) return null;
  return mean(recent) >= rule.minMean ? [...recent] : null;
}

// 준비 알람을 얼마나 당길지 — 5분 단위로 내림, 상한 안. 5분이 안 되면 0 (제안 안 함)
export function sizeAdvance(overrun: number, capMinutes: number): number {
  const floored = Math.floor(overrun / SUGGEST_ROUND_TO) * SUGGEST_ROUND_TO;
  const capped = Math.min(floored, Math.floor(capMinutes / SUGGEST_ROUND_TO) * SUGGEST_ROUND_TO);
  return capped >= SUGGEST_ROUND_TO ? capped : 0;
}

// 준비 전 시간이 모자란 만큼만 기상도 — 준비 알람은 기상보다 앞설 수 없음
export function wakeShift(advance: number, beforePrepareMinutes: number): number {
  return Math.max(0, advance - Math.max(0, beforePrepareMinutes));
}

export function suggestPrepareAdvance(input: SuggestInput): PrepareAdvance | null {
  const evidence = detectOverrun(input.residuals, input.rule ?? SUGGEST_DEFAULT_RULE);
  if (!evidence) return null;
  const overrun = mean(evidence);
  const minutes = sizeAdvance(overrun, input.capMinutes);
  if (!minutes) return null;
  return { minutes, wakeMinutes: wakeShift(minutes, input.beforePrepareMinutes), evidence, overrun };
}
