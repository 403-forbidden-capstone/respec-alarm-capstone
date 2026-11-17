// 하루 활동 계산 — 기상과 출발 사이에 집에서 하는 할 일(온라인 회의 등)이 있을 때 기상 · 준비 · 출발을 따로 정함
//   기존 역산(chain.ts)은 "준비 시간 = 기상 ~ 출발 한 덩어리"라서 사이 활동을 넣으려면 준비 시간을 늘릴 수밖에 없었음
//   → 기상은 앞당겨져도 준비 알람이 기상 + 준비 전 활동(20분)에 남아 회의 중에 울리고, 그날 기상~출발 실측이 학습에 들어가 다른 날 기상까지 앞당김
// 이 모듈은 활동 시각으로 기상 · 준비 시작을 정한 뒤 chain.ts가 받는 두 값(prepareMinutes = 기상~출발, beforePrepareMinutes = 기상~준비)으로 바꿔 줌
//   → 알람 역산 · 직접 고른 시각 · 당김 · 저장 경로는 그대로
// 규칙:
//   · 출발 = 약속 − 여유 − 이동 (chain.ts와 같음)
//   · 순수 외출 준비 = 적용 준비(기상~출발, P80 · CatBoost · 직접 값 그대로) − 준비 전 활동 — 앱 H03 "실제 준비"(prepMinutes)와 같은 나눔. 기록의 뜻은 바꾸지 않음
//   · 준비 뒤 활동(회의 전에 준비를 마침)이 있으면 준비는 그 활동 시작까지 끝냄, 없으면 출발까지
//   · 기상 = (가장 이른 준비 전 활동 시작, 없으면 준비 시작) − 준비 전 활동. 활동이 없으면 출발 − 준비 시간 (chain.ts와 같은 시각)
//   · 겹침 · 준비할 시간 부족 · 출발 뒤까지 이어지는 활동은 실패로 돌려줌 — 기상을 임의로 앞당기지 않음
//   · 끝 시각이나 준비 전 · 후를 모르면 실패(NEEDS_INFO) + 모르는 칸 목록 — 말한 칸은 다시 묻지 않도록 빠진 칸만
import { addMinutes } from './time.ts';

export type DayActivity = {
  title?: string;
  start: Date;
  end?: Date; // 모르면 NEEDS_INFO
  beforePrepare?: boolean; // true = 기상 → 활동 → 준비, false = 준비 → 활동 → 출발. 모르면 NEEDS_INFO
};

export type DayInput = {
  at: Date; // 목적지 약속 시각
  travelMinutes: number;
  bufferMinutes: number;
  prepareMinutes: number; // 적용 준비 시간 = 기상 ~ 출발 (기존 뜻 그대로)
  beforePrepareMinutes: number; // 기상 뒤 준비 전 시간 — 첫 활동 전에 필요한 시간으로도 씀
  activities: readonly DayActivity[];
};

export type DayFailure =
  | { ok: false; reason: 'NEEDS_INFO'; missing: { index: number; field: 'end' | 'before_prepare' }[] }
  | { ok: false; reason: 'OVERLAP' | 'NO_TIME_TO_PREPARE' | 'AFTER_DEPARTURE'; index: number; shortMinutes: number };

export type DayPlan =
  | { ok: true; wake: Date; prepare: Date; departure: Date; prepareMinutes: number; beforePrepareMinutes: number }
  | DayFailure;

const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

export function planDay(input: DayInput): DayPlan {
  const missing: { index: number; field: 'end' | 'before_prepare' }[] = [];
  input.activities.forEach((a, index) => {
    if (a.end == null) missing.push({ index, field: 'end' });
    if (a.beforePrepare == null) missing.push({ index, field: 'before_prepare' });
  });
  if (missing.length) return { ok: false, reason: 'NEEDS_INFO', missing };

  const departure = addMinutes(input.at, -(input.bufferMinutes + input.travelMinutes));
  const lead = Math.max(0, input.beforePrepareMinutes);
  const pure = Math.max(0, input.prepareMinutes - lead);
  const list = input.activities.map((a, index) => ({ ...a, end: a.end as Date, index })).sort((x, y) => x.start.getTime() - y.start.getTime());

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

// 사용자에게 보일 짧은 이유 (미리 보기 check.message · 저장 UNPROCESSABLE)
export function dayFailureMessage(f: DayFailure): string {
  switch (f.reason) {
    case 'NEEDS_INFO':
      return f.missing.some((m) => m.field === 'end') ? '할 일이 언제 끝나는지 알려 주세요' : '할 일을 준비 전에 할지 준비 뒤에 할지 알려 주세요';
    case 'OVERLAP':
      return '할 일 시간이 서로 겹쳐요';
    case 'NO_TIME_TO_PREPARE':
      return `할 일이 끝나고 준비할 시간이 ${f.shortMinutes}분 모자라요`;
    case 'AFTER_DEPARTURE':
      return `할 일이 출발 시각보다 ${f.shortMinutes}분 늦게 끝나요`;
  }
}
