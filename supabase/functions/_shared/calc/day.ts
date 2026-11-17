// 하루 활동 계산 — 기상과 출발 사이에 집에서 하는 할 일(온라인 회의 등)이 있을 때 기상 · 준비 · 출발을 따로 정함
//   기존 역산(chain.ts)은 "준비 시간 = 기상 ~ 출발 한 덩어리"라서 사이 활동을 넣으려면 준비 시간을 늘릴 수밖에 없었음
//   → 기상은 앞당겨져도 준비 알람이 기상 + 준비 전 활동(20분)에 남아 회의 중에 울리고, 그날 기상~출발 실측이 학습에 들어가 다른 날 기상까지 앞당김
// 이 모듈은 활동 시각으로 기상 · 준비 시작을 정한 뒤 chain.ts가 받는 두 값(prepareMinutes = 기상~출발, beforePrepareMinutes = 기상~준비)으로 바꿔 줌
//   → 알람 역산 · 직접 고른 시각 · 당김 · 저장 경로는 그대로
// 규칙:
//   · 출발 = 약속 − 여유 − 이동 (chain.ts와 같음)
//   · 순수 외출 준비 = 적용 준비(기상~출발) − 준비 전 시간(기상~준비) — 앱 H03 "실제 준비"(prepMinutes)와 같은 나눔. 기록의 뜻은 바꾸지 않음
//   · 준비 뒤 활동(회의 전에 준비를 마침)이 있으면 준비는 그 활동 시작까지 끝냄, 없으면 출발까지
//   · 기상 = (가장 이른 준비 전 활동 시작, 없으면 준비 시작) − 할 일 전 시간(lead, 없으면 준비 전 시간). 활동이 없으면 출발 − 준비 시간 (chain.ts와 같은 시각)
//   · 겹침 · 준비할 시간 부족 · 출발 뒤까지 이어지는 활동은 실패로 돌려줌 — 기상을 임의로 앞당기지 않음
//   · 끝 시각이나 준비 전 · 후를 모르면 실패(NEEDS_INFO) + 모르는 칸 목록 — 말한 칸은 다시 묻지 않도록 빠진 칸만
// 저장 모양(appointment_participants.activity_plan): { lead_minutes, items: [{ title, start, end, before_prepare, source }] } — activityPlanJson · activityPlanOf
import { addMinutes } from './time.ts';
import type { ChainAlarm } from './types.ts';

export type ActivitySource = 'USER' | 'ESTIMATED'; // 사용자가 말한 시각 · AI · 앱이 짐작한 시각
export const MAX_ACTIVITIES = 5;

export type DayActivity = {
  title?: string;
  start: Date;
  end?: Date; // 모르면 NEEDS_INFO
  beforePrepare?: boolean; // true = 기상 → 활동 → 준비, false = 준비 → 활동 → 출발. 모르면 NEEDS_INFO
  source?: ActivitySource; // 없으면 USER
};

export type DayInput = {
  at: Date; // 목적지 약속 시각
  travelMinutes: number;
  bufferMinutes: number;
  prepareMinutes: number; // 적용 준비 시간 = 기상 ~ 출발 (기존 뜻 그대로)
  beforePrepareMinutes: number; // 그 준비 시간 중 기상 ~ 준비 알람 몫 — 순수 외출 준비 = prepareMinutes − 이것
  leadMinutes?: number; // 첫 할 일 전에 필요한 시간. 없으면 beforePrepareMinutes
  activities: readonly DayActivity[];
};

export type DayFailureReason =
  | 'NEEDS_INFO'
  | 'OVERLAP'
  | 'NO_TIME_TO_PREPARE'
  | 'AFTER_DEPARTURE'
  | 'PREPARE_AFTER_ACTIVITY'
  | 'WAKE_AFTER_ACTIVITY'
  | 'RECURRING';

export type DayFailure =
  | { ok: false; reason: 'NEEDS_INFO'; missing: { index: number; field: 'end' | 'before_prepare' }[] }
  | { ok: false; reason: 'RECURRING' }
  | { ok: false; reason: Exclude<DayFailureReason, 'NEEDS_INFO' | 'RECURRING'>; index: number; shortMinutes: number };

export type DayPlan =
  | { ok: true; wake: Date; prepare: Date; departure: Date; prepareMinutes: number; beforePrepareMinutes: number }
  | DayFailure;

const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

type Sorted = { title?: string; start: Date; end: Date; beforePrepare: boolean; index: number };
const sortedOf = (activities: readonly DayActivity[]): Sorted[] =>
  activities
    .map((a, index) => ({ title: a.title, start: a.start, end: a.end as Date, beforePrepare: a.beforePrepare === true, index }))
    .sort((x, y) => x.start.getTime() - y.start.getTime());

export function planDay(input: DayInput): DayPlan {
  const missing: { index: number; field: 'end' | 'before_prepare' }[] = [];
  input.activities.forEach((a, index) => {
    if (a.end == null) missing.push({ index, field: 'end' });
    if (a.beforePrepare == null) missing.push({ index, field: 'before_prepare' });
  });
  if (missing.length) return { ok: false, reason: 'NEEDS_INFO', missing };

  const departure = addMinutes(input.at, -(input.bufferMinutes + input.travelMinutes));
  const lead = Math.max(0, input.leadMinutes ?? input.beforePrepareMinutes);
  const pure = Math.max(0, input.prepareMinutes - Math.max(0, input.beforePrepareMinutes));
  const list = sortedOf(input.activities);

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const prev = list[i - 1];
    if (a.end.getTime() <= a.start.getTime() || (prev && prev.end.getTime() > a.start.getTime())) {
      return { ok: false, reason: 'OVERLAP', index: a.index, shortMinutes: prev ? Math.max(0, minutes(a.start, prev.end)) : 0 };
    }
  }
  const before = list.filter((a) => a.beforePrepare);
  const after = list.filter((a) => !a.beforePrepare);
  const lastAfter = after[after.length - 1];
  if (lastAfter && lastAfter.end.getTime() > departure.getTime()) {
    return { ok: false, reason: 'AFTER_DEPARTURE', index: lastAfter.index, shortMinutes: minutes(departure, lastAfter.end) };
  }
  const prepareEnd = after[0] ? after[0].start : departure;
  const prepare = addMinutes(prepareEnd, -pure);
  const lastBefore = before[before.length - 1];
  if (lastBefore && lastBefore.end.getTime() > prepare.getTime()) {
    return { ok: false, reason: 'NO_TIME_TO_PREPARE', index: lastBefore.index, shortMinutes: minutes(prepare, lastBefore.end) };
  }
  const wake = addMinutes(before[0] ? before[0].start : prepare, -lead);
  return { ok: true, wake, prepare, departure, prepareMinutes: minutes(wake, departure), beforePrepareMinutes: minutes(wake, prepare) };
}

// 마지막 알람 사슬(직접 고른 시각 · 준비 알람 당김까지 반영한 뒤)이 할 일 순서를 지키는지 — planDay가 맞게 정해도 직접 시각 · 당김이 할 일 안으로 밀 수 있음
//   기상 ≤ 첫 준비 전 할 일 시작, 마지막 준비 전 할 일 끝 ≤ 준비, 준비 ≤ 첫 준비 뒤 할 일 시작, 마지막 준비 뒤 할 일 끝 ≤ 출발. 없는 알람 종류는 안 봄
export function activityOrderError(chain: readonly Pick<ChainAlarm, 'kind' | 'at'>[], activities: readonly DayActivity[]): DayFailure | null {
  const at = (kind: ChainAlarm['kind']) => chain.find((x) => x.kind === kind)?.at;
  const wake = at('WAKE');
  const prepare = at('PREPARE');
  const departure = at('DEPARTURE');
  const list = sortedOf(activities.filter((a) => a.end != null && a.beforePrepare != null));
  const before = list.filter((a) => a.beforePrepare);
  const after = list.filter((a) => !a.beforePrepare);
  const firstBefore = before[0];
  if (wake && firstBefore && wake.getTime() > firstBefore.start.getTime()) {
    return { ok: false, reason: 'WAKE_AFTER_ACTIVITY', index: firstBefore.index, shortMinutes: minutes(firstBefore.start, wake) };
  }
  const lastBefore = before[before.length - 1];
  if (prepare && lastBefore && prepare.getTime() < lastBefore.end.getTime()) {
    return { ok: false, reason: 'NO_TIME_TO_PREPARE', index: lastBefore.index, shortMinutes: minutes(prepare, lastBefore.end) };
  }
  const firstAfter = after[0];
  if (prepare && firstAfter && prepare.getTime() > firstAfter.start.getTime()) {
    return { ok: false, reason: 'PREPARE_AFTER_ACTIVITY', index: firstAfter.index, shortMinutes: minutes(firstAfter.start, prepare) };
  }
  const lastAfter = after[after.length - 1];
  if (departure && lastAfter && departure.getTime() < lastAfter.end.getTime()) {
    return { ok: false, reason: 'AFTER_DEPARTURE', index: lastAfter.index, shortMinutes: minutes(departure, lastAfter.end) };
  }
  return null;
}

// 사용자에게 보일 짧은 이유 (미리 보기 check.message · 저장 UNPROCESSABLE)
export function dayFailureMessage(f: DayFailure): string {
  switch (f.reason) {
    case 'NEEDS_INFO':
      return f.missing.some((m) => m.field === 'end') ? '할 일이 언제 끝나는지 알려 주세요' : '할 일을 준비 전에 할지 준비 뒤에 할지 알려 주세요';
    case 'RECURRING':
      return '반복 일정에는 할 일을 넣을 수 없어요';
    case 'OVERLAP':
      return '할 일 시간이 서로 겹쳐요';
    case 'NO_TIME_TO_PREPARE':
      return `할 일이 끝나고 준비할 시간이 ${f.shortMinutes}분 모자라요`;
    case 'AFTER_DEPARTURE':
      return `할 일이 출발 시각보다 ${f.shortMinutes}분 늦게 끝나요`;
    case 'PREPARE_AFTER_ACTIVITY':
      return `준비가 할 일 시작보다 ${f.shortMinutes}분 늦게 시작해요`;
    case 'WAKE_AFTER_ACTIVITY':
      return `기상이 할 일 시작보다 ${f.shortMinutes}분 늦어요`;
  }
}

// ---- 저장 모양 (appointment_participants.activity_plan, jsonb) ----
//   lead_minutes를 같이 둠 — 저장 뒤 다시 계산할 때 알람 간격(기상~준비 = 할 일 포함)을 준비 전 시간으로 잘못 읽지 않게

export type ActivityPlan = { leadMinutes: number; items: DayActivity[] };

// 계산에 쓴 할 일을 저장할 모양으로 — 할 일이 없으면 null (칸을 비움 = 할 일 없음)
export function activityPlanJson(plan: ActivityPlan | null | undefined): Record<string, unknown> | null {
  if (!plan || !plan.items.length) return null;
  return {
    lead_minutes: plan.leadMinutes,
    items: plan.items.map((a) => ({
      title: a.title ?? null,
      start: a.start.toISOString(),
      end: a.end ? a.end.toISOString() : null,
      before_prepare: a.beforePrepare ?? null,
      source: a.source ?? 'USER',
    })),
  };
}

// 저장된 칸 → 계산 모양. 비었거나 못 읽는 칸이면 null (할 일 없음으로 봄 — 옛 행 · 다른 서버가 쓴 행에서 멈추지 않게). 못 읽는 항목만 건너뜀
export function activityPlanOf(raw: unknown): ActivityPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { lead_minutes?: unknown; items?: unknown };
  if (!Array.isArray(r.items)) return null;
  const date = (v: unknown) => {
    const d = typeof v === 'string' ? new Date(v) : null;
    return d && Number.isFinite(d.getTime()) ? d : undefined;
  };
  const items: DayActivity[] = [];
  for (const x of r.items.slice(0, MAX_ACTIVITIES)) {
    if (!x || typeof x !== 'object') continue;
    const a = x as Record<string, unknown>;
    const start = date(a.start);
    if (!start) continue;
    const end = date(a.end);
    items.push({
      ...(typeof a.title === 'string' && a.title ? { title: a.title } : {}),
      start,
      ...(end ? { end } : {}),
      ...(typeof a.before_prepare === 'boolean' ? { beforePrepare: a.before_prepare } : {}),
      source: a.source === 'ESTIMATED' ? 'ESTIMATED' : 'USER',
    });
  }
  const lead = Number(r.lead_minutes);
  return items.length ? { leadMinutes: Number.isFinite(lead) && lead >= 0 ? Math.round(lead) : 0, items } : null;
}

// 측정 구간(예: 기상 ~ 출발)에 할 일이 걸치는지 — 준비 실측을 학습에 넣을지 가를 때 씀
export function activityOverlaps(plan: ActivityPlan | null | undefined, fromMs: number, toMs: number): boolean {
  return (plan?.items ?? []).some((a) => {
    const end = a.end ?? a.start;
    return a.start.getTime() < toMs && end.getTime() > fromMs;
  });
}
