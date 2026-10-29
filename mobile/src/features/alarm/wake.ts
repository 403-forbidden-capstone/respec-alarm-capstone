// 기상 판정 계산 (H08) — 데이터를 읽지 않는 순수 함수만 (api.ts와 나눠서 단위 테스트)
// 화면 사용은 "해제 뒤 몇 분부터 몇 분까지 켜져 있었는지" 구간 목록으로 받음
//   실데이터(#40 사용 정보 접근: 화면 켜짐 · 잠금 해제 시각)도 해제 시각을 빼서 이 구간으로 바꿔 넣으면 같은 계산
import { addMinutes } from '@/lib/format';

import { WAKE_OBSERVE_MINUTES, WAKE_RECENT_MINUTES } from './types';

// H08이 열린 주소에서 기상 알람 id를 읽음 — 알람 코어가 알람을 끄고 앱을 여는 딥링크는 respecalarm://wake?alarmId=<id> (docs/alarm-core.md "해제 뒤 앱 열기"),
// 앱 안에서 오는 길(홈 배너 · 울림 화면)은 ?alarm=<id>. 같은 쿼리가 배열로 오면 첫 값, 빈 글자는 없는 것으로 봄
type Param = string | string[] | undefined;
const first = (value: Param) => (Array.isArray(value) ? value[0] : value) || undefined;
export function pickAlarmId(params: { alarmId?: Param; alarm?: Param }): string | undefined {
  return first(params.alarmId) ?? first(params.alarm);
}

export type UseSpan = readonly [start: number, end: number]; // 해제 뒤 분 (start ≤ end)

// 관찰 시간(0 ~ limit분) 안으로 자르고, 시각순으로 겹치는 구간을 합침 — 같은 시간을 두 번 세지 않게
function clean(spans: readonly UseSpan[], limit: number): [number, number][] {
  const sorted = spans
    .map(([s, e]): [number, number] => [Math.max(0, s), Math.min(limit, e)])
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// from ~ to분 사이 화면 사용 합 (분)
export function usedMinutes(spans: readonly UseSpan[], from: number, to: number): number {
  return clean(spans, to).reduce((sum, [s, e]) => sum + Math.max(0, e - Math.max(s, from)), 0);
}

// H08 막대 두 개 — 누적 사용(해제 후 10분) · 최근 사용(뒤쪽 5분), 소수 첫째 자리
export function usageSummary(spans: readonly UseSpan[], observeMinutes = WAKE_OBSERVE_MINUTES) {
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    usage: round(usedMinutes(spans, 0, observeMinutes)),
    recent: round(usedMinutes(spans, observeMinutes - WAKE_RECENT_MINUTES, observeMinutes)),
  };
}

// 누적 사용이 θ에 닿은 시각 (D14) — 기상 확정 시각으로 기록. 관찰 시간 안에 못 닿으면 null
// 판정은 관찰이 끝나야 하지만, 기록은 실제로 일어난 시각에 가까운 이 시각으로 거꾸로 남김
export function thetaReachedAt(
  dismissedAt: Date,
  spans: readonly UseSpan[],
  thetaMinutes: number,
  observeMinutes = WAKE_OBSERVE_MINUTES,
): Date | null {
  let used = 0;
  for (const [s, e] of clean(spans, observeMinutes)) {
    if (used + (e - s) >= thetaMinutes) return addMinutes(dismissedAt, s + Math.max(0, thetaMinutes - used));
    used += e - s;
  }
  return null;
}

// 사용 시간을 초 단위로 읽기 쉽게 (3.2분 → 3분 12초, 0.4분 → 24초) — 소수 분은 화면에 쓰지 않음
export function formatUsage(minutes: number) {
  const total = Math.max(0, Math.round(minutes * 60));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (!m && !s) return '0초';
  return [m ? `${m}분` : '', s ? `${s}초` : ''].filter(Boolean).join(' ');
}

// 최근 사용을 보는 구간 글자 — 관찰 뒤쪽 5분 = 해제 5~10분 뒤 (#225). H08 막대 이름과 판정 문구가 같이 씀
export const WAKE_RECENT_RANGE = `${WAKE_OBSERVE_MINUTES - WAKE_RECENT_MINUTES}~${WAKE_OBSERVE_MINUTES}`;

// 기상 확정 조건을 일상 말로 — 채웠으면 "썼어요", 아직이면 "써야 해요" (조건: 누적 사용 ≥ θ 그리고 뒤쪽 5분 사용 > 0)
export function judgeLines(usage: number, recent: number, thetaMinutes: number): string[] {
  return [
    usage >= thetaMinutes ? `알람 뒤 ${thetaMinutes}분 넘게 폰을 썼어요` : `알람 뒤 ${thetaMinutes}분 넘게 폰을 써야 해요`,
    recent > 0 ? `알람 끈 뒤 ${WAKE_RECENT_RANGE}분 사이에도 폰을 썼어요` : `알람 끈 뒤 ${WAKE_RECENT_RANGE}분 사이에도 폰을 써야 해요`,
  ];
}

// ---------------------------------------------------------------------------
// 실데이터 판정 (H08) — 사용 구간(알람 코어 getUsageSpans)과 지금 시각으로 단계를 정함. 순수 함수
// ---------------------------------------------------------------------------

// 기상 판정 기준 θ — 목업 기본값이자 7장 T_active(10분 중 누적 1분 이상). 고르는 화면이 없어 상수로 둠 (D14는 확정 시각만 정함)
export const WAKE_THETA_MINUTES = 1;

// 확인 알림에 응답이 없을 때 서버가 놓침(MISSED)으로 보기까지의 여유 — 7장 7.9.2 "+30분". 홈이 "기상 확인 중"을 보여 주는 마지막 때를 정함
export const WAKE_PROMPT_WINDOW_MINUTES = 30;

export type WakeEvaluation = {
  // observing = 해제 뒤 10분이 안 끝남, prompt = 조건을 못 채웠거나 사용 정보를 못 읽어 "일어났어요" 확인이 필요, auto = 조건을 채워 자동 확정
  phase: 'observing' | 'prompt' | 'auto';
  usage: number; // 누적 사용 · 해제 후 10분 (분, 소수 첫째 자리)
  recent: number; // 최근 사용 · 뒤쪽 5분
  reachedAt: Date | null; // auto일 때 누적 사용이 θ를 넘은 시각 (D14) — 기록 시각
};

// spans가 null이면 사용 정보를 읽을 수 없는 것(권한 없음 · 안드로이드 9 미만) → 바로 확인 알림("일어났어요" 버튼만)
//   판정은 관찰 10분이 끝나야 함 (D14: 끝난 뒤 θ를 넘은 시각으로 거꾸로 기록). 조건 = 누적 사용 ≥ θ 그리고 뒤쪽 5분 사용 > 0
export function evaluateWake(input: { dismissedAt: Date; now: Date; spans: readonly UseSpan[] | null; theta?: number }): WakeEvaluation {
  const theta = input.theta ?? WAKE_THETA_MINUTES;
  if (!input.spans) return { phase: 'prompt', usage: 0, recent: 0, reachedAt: null };
  const summary = usageSummary(input.spans);
  const observeEnd = addMinutes(input.dismissedAt, WAKE_OBSERVE_MINUTES);
  if (input.now.getTime() < observeEnd.getTime()) return { phase: 'observing', ...summary, reachedAt: null };
  // 소수 첫째 자리로 줄인 값이 아니라 실제 합으로 비교 — 화면 값과 기록 시각이 어긋나지 않게
  const met = usedMinutes(input.spans, 0, WAKE_OBSERVE_MINUTES) >= theta && usedMinutes(input.spans, WAKE_OBSERVE_MINUTES - WAKE_RECENT_MINUTES, WAKE_OBSERVE_MINUTES) > 0;
  if (!met) return { phase: 'prompt', ...summary, reachedAt: null };
  return { phase: 'auto', ...summary, reachedAt: thetaReachedAt(input.dismissedAt, input.spans, theta) ?? observeEnd };
}

// 해제 기록이 여러 개일 때(미루고 다시 울린 뒤 끈 경우) 기상 판정에 쓸 해제 시각
//   확정 전이면 마지막 해제(다시 울린 뒤 끄면 그 시각부터 10분), 확정 뒤면 확정 직전의 해제 (확정 뒤 다른 울림이 있어도 판정이 바뀌지 않게). 해제 기록이 없으면 null
export function pickDismissedAt(dismissals: readonly Date[], confirmedAt: Date | null): Date | null {
  const sorted = [...dismissals].sort((x, y) => x.getTime() - y.getTime());
  if (!sorted.length) return null;
  const pool = confirmedAt ? sorted.filter((d) => d.getTime() <= confirmedAt.getTime()) : sorted;
  const list = pool.length ? pool : sorted;
  return list[list.length - 1];
}
