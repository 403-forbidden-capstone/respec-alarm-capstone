// 루틴 제안 — 기록에서 늦어지는 원인을 찾아 그 원인에 맞는 짧은 루틴 초안을 만듦 (순수 함수, 18:00 배치 · 앱 미리 보기가 같이 씀 — 아직 부르는 곳 없음)
//   안건 D114 기본안: 원인 세 가지(늦잠 · 다시 잠듦 / 준비를 늦게 시작 / 전날 준비 부족), 기록이 있는 최근 아침 7번 중 같은 원인 4번 이상
//   알람 조정 제안(D111, suggest.ts)과 나눔 — "준비가 길다"는 그쪽만. 하루에 원인이 겹치면 늦잠 → 준비를 늦게 시작 → 전날 준비 순서로 하나만 셈
//   근거: 가상 유저 실험(tools/routine-lab, 로컬) — 7번 중 3번이면 원인 없는 사람의 30%가 엉뚱한 제안, 4번이면 10% · 맞는 원인 88%
//   단계 시각은 기상 알람 기준 분(D29). 전날 밤 루틴만 시각을 고정(21:30 ~) — D29와 밤 루틴은 D114에서 같이 정할 것

export type RoutineCause = 'OVERSLEEP' | 'LATE_START' | 'NIGHT_PREP';

// 판정 순서 = 제안 순서 (앞의 것이 일어나면 뒤의 것은 그 결과일 가능성이 큼)
export const ROUTINE_CAUSES: readonly RoutineCause[] = ['OVERSLEEP', 'LATE_START', 'NIGHT_PREP'];

export type RoutineRule = {
  window: number; // 기록이 있는 최근 아침 몇 번을 볼지
  minDays: number; // 그중 같은 원인이 몇 번 이상이면 제안
  lateWakeMinutes: number; // 기상 확인이 첫 기상 알람보다 이 분을 넘게 늦으면 늦잠
  lateStartMinutes: number; // 준비 알람이 울리고 이 분 이상 지나서 시작하면 준비를 늦게 시작
};

export const ROUTINE_DEFAULT_RULE: RoutineRule = { window: 7, minDays: 4, lateWakeMinutes: 10, lateStartMinutes: 5 };

// 하루 아침 기록 — 부르는 쪽이 DB에서 모아 넘김 (시각은 epoch ms, 그 사람 시간대의 날짜 · 요일)
export type MorningFacts = {
  date: string; // 'YYYY-MM-DD'
  weekday: number; // 0 일 ~ 6 토
  wakeAlarmAt: number | null; // 그날 첫 기상 알람. 없으면 기록이 없는 날로 침
  wakeConfirmedAt: number | null; // 기상 확인
  wakeMissed: boolean; // 기상 미확인 기록이 있음
  prepareAlarmAt: number | null; // 준비 알람 시각
  prepareStartedAt: number | null; // 준비 시작 (준비 알람을 끈 시각, #490)
  itemsDue: number; // 그날 일정의 준비물 수
  itemsLate: number; // 그중 그날 아침에야 체크했거나 출발 때까지 못 챙긴 수
};

const MIN = 60_000;
const minutes = (from: number, to: number) => (to - from) / MIN;

// 기록이 있는 아침인지 — 기상 알람이 있던 날만 셈 (알람 없는 날 · 주말에 쉬는 날은 창에 안 들어감)
export const hasMorning = (f: MorningFacts) => f.wakeAlarmAt != null;

// 그날 원인 하나 (없으면 null). 순서: 늦잠 → 준비를 늦게 시작 → 전날 준비 부족
//   늦잠: 미확인이거나 기상 확인이 기상 알람 + 10분보다 늦음. 미루기는 한 번 5분이라 2번이면 이미 10분을 넘어 따로 안 셈 (실험에서 결과 같음)
export function morningCause(f: MorningFacts, rule: RoutineRule = ROUTINE_DEFAULT_RULE): RoutineCause | null {
  if (!hasMorning(f)) return null;
  if (f.wakeMissed) return 'OVERSLEEP';
  if (f.wakeConfirmedAt != null && minutes(f.wakeAlarmAt!, f.wakeConfirmedAt) > rule.lateWakeMinutes) return 'OVERSLEEP';
  if (f.prepareAlarmAt != null && f.prepareStartedAt != null && minutes(f.prepareAlarmAt, f.prepareStartedAt) >= rule.lateStartMinutes) return 'LATE_START';
  if (f.itemsDue > 0 && f.itemsLate > 0) return 'NIGHT_PREP';
  return null;
}

export type RoutineDetection = {
  cause: RoutineCause;
  days: MorningFacts[]; // 이 원인으로 센 아침 (오래된 → 최근)
  window: number; // 본 아침 수
};

// 제안할 원인 — 기록이 있는 최근 아침 window번(모자라면 null) 중 같은 원인이 minDays번 이상인 것, 여럿이면 판정 순서로 앞의 것 하나
//   skip: 지금 루틴이 켜져 있거나(받아들인 루틴), 대기 중이거나, 넘긴 뒤 기록이 3일 더 안 쌓인(D24 C) 원인 — 부르는 쪽이 정함
export function detectRoutineCause(
  mornings: readonly MorningFacts[], // 오래된 → 최근
  opts: { rule?: RoutineRule; skip?: readonly RoutineCause[] } = {},
): RoutineDetection | null {
  const rule = opts.rule ?? ROUTINE_DEFAULT_RULE;
  const recorded = mornings.filter(hasMorning);
  if (recorded.length < rule.window) return null;
  const win = recorded.slice(-rule.window);
  for (const cause of ROUTINE_CAUSES) {
    if (opts.skip?.includes(cause)) continue;
    const days = win.filter((f) => morningCause(f, rule) === cause);
    if (days.length >= rule.minDays) return { cause, days, window: rule.window };
  }
  return null;
}

export type RoutineDraftStep = {
  name: string;
  minutes: number; // 걸리는 분
  alarm: boolean; // 단계 알람을 따로 울릴지 (기상 · 준비 알람과 같은 때인 첫 단계는 끔)
  offsetFromWake: number | null; // 기상 알람 기준 분 (D29). 밤 루틴은 null
  at: string | null; // 밤 루틴의 고정 시각 'HH:MM'. 아침 루틴은 null
};

export type RoutineDraft = {
  cause: RoutineCause;
  title: string;
  goal: string;
  days: number[]; // 반복 요일 (0 일 ~ 6 토, 오름차순)
  steps: RoutineDraftStep[];
  reason: string; // 화면 근거 한 줄
  evidence: { dates: string[]; average: number | null; missed: number }; // average = 늦은 분 평균(늦잠 · 준비 늦게 시작), missed = 미확인 아침 수
};

const round = (x: number) => Math.round(x);
const avg = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: readonly number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const uniqDays = (ds: readonly number[]) => [...new Set(ds)].sort((a, b) => a - b);

// 원인 → 루틴 초안 (이름 · 요일 · 단계 · 근거 한 줄). 사용자는 루틴 편집(A04)에서 고쳐 저장
export function routineDraft(d: RoutineDetection): RoutineDraft {
  const dates = d.days.map((f) => f.date);
  const head = `최근 아침 ${d.window}번 중 ${d.days.length}번`;
  if (d.cause === 'OVERSLEEP') {
    const late = d.days.filter((f) => !f.wakeMissed && f.wakeConfirmedAt != null).map((f) => minutes(f.wakeAlarmAt!, f.wakeConfirmedAt!));
    const missed = d.days.filter((f) => f.wakeMissed).length;
    const a = avg(late);
    const tail = a != null ? `기상 알람 뒤 평균 ${round(a)}분 만에 일어났어요` : '일어났는지 확인이 안 됐어요';
    return {
      cause: d.cause,
      title: '일어나자마자 2단계',
      goal: '다시 잠들지 않기',
      days: uniqDays(d.days.map((f) => f.weekday)),
      steps: [
        { name: '물 한 잔', minutes: 2, alarm: false, offsetFromWake: 0, at: null },
        { name: '창문 열고 불 켜기', minutes: 3, alarm: true, offsetFromWake: 3, at: null },
      ],
      reason: `${head}, ${tail}${a != null && missed ? ` (확인이 안 된 날 ${missed}번 포함)` : ''}`,
      evidence: { dates, average: a != null ? round(a) : null, missed },
    };
  }
  if (d.cause === 'LATE_START') {
    const delays = d.days.map((f) => minutes(f.prepareAlarmAt!, f.prepareStartedAt!));
    const gaps = d.days.filter((f) => f.prepareAlarmAt != null).map((f) => minutes(f.wakeAlarmAt!, f.prepareAlarmAt!));
    const start = round(median(gaps) ?? 0); // 준비 알람의 기상 기준 분 — 첫 단계가 준비 알람과 같은 때
    const a = avg(delays)!;
    return {
      cause: d.cause,
      title: '준비 바로 시작',
      goal: '준비 알람에 맞춰 시작하기',
      days: uniqDays(d.days.map((f) => f.weekday)),
      steps: [
        { name: '세수', minutes: 10, alarm: false, offsetFromWake: start, at: null },
        { name: '옷 입기', minutes: 10, alarm: true, offsetFromWake: start + 10, at: null },
      ],
      reason: `${head}, 준비 알람이 울리고 평균 ${round(a)}분 뒤에 시작했어요`,
      evidence: { dates, average: round(a), missed: 0 },
    };
  }
  // 전날 준비 부족 — 문제가 난 아침의 전날 밤 (월요일 아침이면 일요일 밤)
  return {
    cause: d.cause,
    title: '전날 밤 준비',
    goal: '아침에 챙길 것 줄이기',
    days: uniqDays(d.days.map((f) => (f.weekday + 6) % 7)),
    steps: [
      { name: '준비물 챙기기', minutes: 10, alarm: true, offsetFromWake: null, at: '21:30' },
      { name: '옷 꺼내 두기', minutes: 5, alarm: false, offsetFromWake: null, at: '21:40' },
    ],
    reason: `${head}, 준비물을 아침에야 챙겼어요`,
    evidence: { dates, average: null, missed: 0 },
  };
}

// 한 번에: 원인 찾기 → 초안 (없으면 null)
export function suggestRoutine(mornings: readonly MorningFacts[], opts: { rule?: RoutineRule; skip?: readonly RoutineCause[] } = {}): RoutineDraft | null {
  const d = detectRoutineCause(mornings, opts);
  return d ? routineDraft(d) : null;
}
