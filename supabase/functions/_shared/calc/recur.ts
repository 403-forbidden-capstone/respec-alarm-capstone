// 반복 규칙 읽기 · 다음 회차 날짜 — 서버(alarm-roll)가 쓰고, 앱의 일정 반복(mobile/src/features/alarm/repeat.ts) · 루틴 반복(features/routine/map.ts)과 같은 해석
//   일정 반복 규칙은 두 모양만 받음: FREQ=DAILY · FREQ=WEEKLY;BYDAY=MO,… (앱이 만드는 모양, repeat.ts repeatToRrule).
//   MONTHLY · INTERVAL · COUNT · UNTIL 같은 그 밖은 거절 — 앱 표시(repeat.ts는 INTERVAL을 무시)와 서버가 만드는 회차가 어긋나지 않게
//   요일은 회차 날짜(내 시간대)의 요일임. UTC 요일이 아님 — 새벽 1시 약속은 UTC로는 전날
//   하루 경계는 profiles.timezone 0시. 한국 · Android만, 앱 R02 기기 시간대와 같다고 봄(10/29 헤드)
// 순수 TS(날짜 글자 'YYYY-MM-DD'와 Date만) — node --test로 시험 (recur.test.ts)
import { localDateKey, localMinuteOfDay, safeTimeZone, zonedTime } from '../tz.ts';

const DAY_MS = 86_400_000;

// 요일 번호: 월 0 · 화 1 · 수 2 · 목 3 · 금 4 · 토 5 · 일 6 (앱 lib/weekday의 WEEKDAYS 순서)
export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

// 폰에 걸 알람이 앞으로 며칠치까지 있는지 — 약속 시각이 (지금, 지금 + 14일)인 회차를 미리 만듦 (폰 맞추기 창 reconcile.ts와 같은 시각 기준)
export const ROLL_WINDOW_DAYS = 14;

export type Recurrence = { freq: 'DAILY' } | { freq: 'WEEKLY'; days: readonly number[] };

// 쓸 때(draft.ts) 받는 글자 — 앱이 만드는 모양 그대로 (대문자 · RRULE: 접두사 없음). 읽을 때는 아래 parseRecurrence가 더 너그러움
export const RRULE_PATTERN = new RegExp(`^(FREQ=DAILY|FREQ=WEEKLY;BYDAY=(${WEEKDAY_CODES.join('|')})(,(${WEEKDAY_CODES.join('|')}))*)$`);

// 일정 반복 규칙 → 두 모양. 읽는 해석은 앱 repeat.ts rruleToRepeat과 같음 (RRULE: 접두사 · 소문자 · 순서가 달라도 읽고 요일은 월요일부터 정렬).
// 다른 점: 앱은 모르는 글자를 건너뛰어 읽지만 여기서는 두 모양 밖이면 통째로 거절(null) — 반복으로 치지 않음
export function parseRecurrence(rule: string | null | undefined): Recurrence | null {
  if (!rule) return null;
  const parts = new Map<string, string>();
  for (const part of rule.trim().replace(/^RRULE:/i, '').split(';')) {
    const [key, value, ...rest] = part.split('=');
    if (!key || value === undefined || rest.length > 0 || parts.has(key.toUpperCase())) return null;
    parts.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (freq === 'DAILY') return parts.size === 1 ? { freq: 'DAILY' } : null;
  if (freq !== 'WEEKLY' || parts.size !== 2) return null;
  const days = (parts.get('BYDAY') ?? '').split(',').map((code) => (WEEKDAY_CODES as readonly string[]).indexOf(code));
  if (days.some((d) => d < 0)) return null; // BYDAY가 없거나 모르는 요일 코드
  return { freq: 'WEEKLY', days: [...new Set(days)].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// 날짜 글자 'YYYY-MM-DD' (시간대 없는 달력 날짜 — DB date 칸 occurrence_on과 같은 글자)
// ---------------------------------------------------------------------------

function parseKey(dateKey: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new RangeError(`날짜는 YYYY-MM-DD 모양이어야 해요: ${dateKey}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// 그 날짜의 요일 번호 (월 0 … 일 6)
export function weekdayOfDate(dateKey: string): number {
  const [y, m, d] = parseKey(dateKey);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = parseKey(dateKey);
  const u = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(u.getUTCFullYear()).padStart(4, '0')}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`;
}

// 그 날짜가 규칙에 드는지
export function occursOn(rec: Recurrence, dateKey: string): boolean {
  return rec.freq === 'DAILY' || rec.days.includes(weekdayOfDate(dateKey));
}

// ---------------------------------------------------------------------------
// 일정 · 일정 없는 알람의 다음 회차
// ---------------------------------------------------------------------------

export type Occurrence = { date: string; at: Date };

// 다음 회차 목록 (가까운 순). 기준 회차(묶음에서 날짜가 가장 늦은 행)의 약속 시각 baseAt의 같은 벽시계 시:분을 쓰고, 날짜는 baseAt의 날짜 뒤부터 규칙대로 셈
//   · 창: 지금 < 회차 시각 < 지금 + windowDays (둘 다 포함 안 함). 서버가 며칠 못 돌았어도 지난 회차는 안 메움
//   · 첫 회차(사용자가 고른 날짜)는 요일이 규칙에 안 맞아도 그대로 두는 것 — 여기서는 baseAt 뒤 날짜만 규칙으로 셈
//   · afterDate: 이 날짜 뒤부터 셈 (기본은 baseAt의 날짜). 길찾기 실패로 중간 날짜가 비었을 때 그 빈 날짜까지 다시 구하려면 묶음 첫 회차의 날짜를 줌 — 이미 있는 날짜는 부르는 쪽이 뺌
//   · 규칙이 두 모양 밖이면 빈 목록
export function nextOccurrences(args: {
  rule: string | null | undefined;
  baseAt: Date;
  now: Date;
  timeZone: string;
  windowDays?: number;
  afterDate?: string;
}): Occurrence[] {
  const rec = parseRecurrence(args.rule);
  if (!rec) return [];
  const tz = safeTimeZone(args.timeZone);
  const end = new Date(args.now.getTime() + (args.windowDays ?? ROLL_WINDOW_DAYS) * DAY_MS);
  const minute = localMinuteOfDay(args.baseAt, tz);
  const today = localDateKey(args.now, tz);
  const lastKey = localDateKey(end, tz);
  let key = addDaysToKey(args.afterDate ?? localDateKey(args.baseAt, tz), 1);
  if (key < today) key = today; // 오늘보다 앞 날짜는 시각이 지금보다 뒤일 수 없음
  const out: Occurrence[] = [];
  for (; key <= lastKey; key = addDaysToKey(key, 1)) {
    if (!occursOn(rec, key)) continue;
    const at = zonedTime(key, minute, tz);
    if (at.getTime() > args.now.getTime() && at.getTime() < end.getTime()) out.push({ date: key, at });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 루틴 반복 요일 (routines.repeat_days)
// ---------------------------------------------------------------------------

const ROUTINE_CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

// 'MON,WED' · 'MON~FRI' · 'SAT~MON'(일요일을 넘는 범위) → 요일 번호(월 0 … 일 6, 월요일부터). 모르는 글자는 건너뜀
//   앱 features/routine/map.ts parseRepeatDays와 같은 해석
export function parseRepeatDays(text: string | null | undefined): number[] {
  const picked = new Set<number>();
  const index = (code: string) => (ROUTINE_CODES as readonly string[]).indexOf(code);
  for (const part of (text ?? '').toUpperCase().split(/[,\s]+/)) {
    const range = /^([A-Z]{3})[~-]([A-Z]{3})$/.exec(part);
    if (range) {
      const from = index(range[1]);
      const to = index(range[2]);
      if (from < 0 || to < 0) continue;
      for (let i = from; ; i = (i + 1) % 7) {
        picked.add(i);
        if (i === to) break;
      }
    } else if (index(part) >= 0) {
      picked.add(index(part));
    }
  }
  return ROUTINE_CODES.map((_, i) => i).filter((i) => picked.has(i));
}

// 루틴 단계 알람의 다음 시각 — 지금 뒤 첫 요일, 같은 단계 시각. 요일이 없으면 null
//   stepOffsetMinutes = routines.steps[].offset (그 단계가 시작하는 시각, 0시부터 분. 자정을 넘으면 1440 이상)
//   루틴이 도는 요일은 루틴을 시작하는 날 기준(앱 planRoutineAlarms와 같음) — 월요일 밤 11시에 시작해 화요일 00:30에 울리는 단계는 '월요일' 루틴의 알람
//   루틴은 회차 행을 따로 만들지 않고 같은 알람 행의 시각만 이 값으로 옮김
export function nextRoutineAt(args: { repeatDays: string | null | undefined; stepOffsetMinutes: number; now: Date; timeZone: string }): Date | null {
  const days = parseRepeatDays(args.repeatDays);
  if (!days.length) return null;
  const tz = safeTimeZone(args.timeZone);
  const offset = Math.max(0, Math.floor(args.stepOffsetMinutes));
  let key = addDaysToKey(localDateKey(args.now, tz), -Math.floor(offset / 1440)); // 자정을 넘는 단계는 시작한 날로 거슬러 올라가 봄
  for (let i = 0; i < 9; i++, key = addDaysToKey(key, 1)) {
    if (!days.includes(weekdayOfDate(key))) continue;
    const at = zonedTime(key, offset, tz);
    if (at.getTime() > args.now.getTime()) return at;
  }
  return null;
}
