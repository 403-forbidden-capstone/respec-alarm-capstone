// ④ 캘린더 · 하루 기록 — 데이터 접근은 이 파일에서만 합니다.
// 가짜 데이터(src/mocks)는 그대로 두고, 실데이터 모드면 함수 맨 앞에서 real.ts(Supabase)로 넘김 (docs/screen-data-map.md "실데이터 연결 규칙")
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (R02 · S01, 제안은 alarm_suggestions)
import { KIND_LABEL } from '@/features/alarm/types';
import { getJournal } from '@/features/routine/api';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { addDays, dateParts, dayKey, isSameDay, startOfDay } from '@/lib/format';
import { isMock } from '@/lib/mode';
import { alarmChain } from '@/mocks/calc';
import { db, kst, TODAY } from '@/mocks/data';
import { pastDay } from '@/mocks/records';

import { leadingBlanks, monthDays, monthTitle, weekDays, weekRelative, weekTitle } from './calendar';
import * as real from './real';
import { prepareBounds, shiftLog } from './suggestion';
import { buildWeekSummary, dayMark, wakeScore, type WakeRow } from './summary';
import type { DayMark, DayRecord, MonthRecord, Suggestion, WeekAiSummary, WeekRecord, WeekSummary } from './types';

// 기록 화면의 오늘 — 목업은 시나리오 시각(아침 · 전날 밤)과 상관없이 5월 22일
const today = () => kst(TODAY, 0);

// 기록 화면이 여는 "오늘" — 목업 기록은 5월 22일 하루라 시나리오가 전날 밤이어도 22일을 보여 줌, 실데이터는 지금 시각 기준
export const recordToday = () => (isMock() ? today() : real.recordToday());

// 그날 기록 표시 — 목업은 2025년 5월만 있음: 지난 평일 기록 완료 · 주말 일부 기록, 오늘은 기상 확인 · 일기 뒤에 완료
// 규칙은 summary.ts dayMark (실데이터도 같은 함수). 목업 날의 기록(기상 확인 · 집 출발 · 직접 입력 한 줄)을 그 규칙에 넘김
function markOf(date: Date): DayMark {
  const { year, month, day } = dateParts(date);
  if (year !== 2025 || month !== 5) return 'none';
  if (day === TODAY) return dayMark({ woke: db.me.wakeAt != null, prepared: false, journal: db.journalWritten, any: false }, true);
  const p = pastDay(date);
  if (!p) return 'none';
  return dayMark({ woke: p.wake != null, prepared: p.actual.some(([, label]) => label === '집 출발'), journal: false, any: p.actual.length > 0 }, false);
}

// 월간 (R02) — 실데이터는 daily_records.record_date로 그달을 읽음. 목업에 없는 달은 기록 없이 달력만
export async function getMonth(year: number, month: number): Promise<MonthRecord> {
  if (!isMock()) return real.getMonth(year, month);
  const t = today();
  return {
    title: monthTitle(year, month),
    leadingBlanks: leadingBlanks(year, month),
    days: monthDays(year, month).map((date) => ({
      date,
      day: dateParts(date).day,
      mark: markOf(date),
      isToday: isSameDay(date, t),
      isFuture: date.getTime() > t.getTime(),
    })),
    today: { date: t, eventCount: db.events.length, journalWritten: db.journalWritten },
  };
}

// 그 주의 기상 기록 — 지난 날은 mocks/records, 오늘은 기상이 확인되면 더함
function weekRows(days: Date[]): WakeRow[] {
  const rows = days.flatMap((date) => {
    const p = pastDay(date);
    return p?.wake != null && p.score != null ? [{ date, wake: p.wake, score: p.score }] : [];
  });
  const a1 = db.appointments.find((a) => a.id === 'a1');
  if (db.me.wakeAt && a1 && days.some((d) => isSameDay(d, today()))) {
    const wakeMin = Math.round((db.me.wakeAt.getTime() - kst(TODAY, 0).getTime()) / 60_000);
    const target = Math.round((alarmChain(a1)[0].at.getTime() - kst(TODAY, 0).getTime()) / 60_000);
    rows.push({ date: today(), wake: wakeMin, score: wakeScore(wakeMin, target) });
  }
  return rows;
}

// 주간 기상 통계 — 계산은 summary.ts buildWeekSummary (실데이터도 같은 함수)
function weekSummary(days: Date[], relative: string): WeekSummary | null {
  return buildWeekSummary({
    days,
    rows: weekRows(days),
    beforeRows: weekRows(weekDays(addDays(days[0], -7))),
    relative,
    today: today(),
    todayWoke: db.me.wakeAt != null,
  });
}

// 그 주 글이 있는 일기 수 — 목업 일기(routine/api getJournal)
async function journalDaysOf(days: Date[]): Promise<number> {
  const journals = await Promise.all(days.map((d) => getJournal(dayKey(d))));
  return journals.filter((j) => j?.text.trim()).length;
}

// 주간 (R02) — anyDay가 든 주 (월요일 시작). 기록이 없는 주는 요약 없이 날짜 줄만
export async function getWeek(anyDay: Date): Promise<WeekRecord> {
  if (!isMock()) return real.getWeek(anyDay);
  const t = today();
  const days = weekDays(anyDay);
  const relative = weekRelative(anyDay, t);
  return {
    title: weekTitle(anyDay),
    relative,
    strip: days.map((date) => ({
      date,
      weekday: dateParts(date).weekday,
      day: dateParts(date).day,
      isToday: isSameDay(date, t),
      isFuture: date.getTime() > t.getTime(),
      recorded: markOf(date) !== 'none',
    })),
    summary: weekSummary(days, relative),
    journalDays: await journalDaysOf(days),
  };
}

// 주간 AI 요약 (R02) — 실데이터는 서버 weekly-summary가 그 주 일기로 만든 글. 목업은 고정 글에 그 주 일기 수만 맞춤
export async function getWeekAiSummary(anyDay: Date): Promise<WeekAiSummary | null> {
  if (!isMock()) return real.getWeekAiSummary(anyDay);
  const dayCount = await journalDaysOf(weekDays(anyDay));
  if (!dayCount) return null;
  return {
    text: '회의가 있는 날은 준비가 길어지는 흐름이 보였어요. 기록한 날마다 준비물을 전날 챙긴 점이 좋았어요. 다음 주에는 전날 밤 준비 루틴을 하나 만들어 보면 아침이 여유로워져요.',
    dayCount,
    period: weekTitle(anyDay),
    stale: false,
  };
}

// 기상 통계 · AI 요약이 둘 다 없을 때 문구 — 날짜 줄에 기록 점이 있는데 "기록이 없어요"라고 하면 어긋남 (기록이 전혀 없을 때만 "기록이 없어요")
export function weekEmptyText(week: WeekRecord): string {
  return week.strip.some((d) => d.recorded) ? '이 주 요약이 아직 없어요.' : '이 주에는 기록이 없어요.';
}

// 일간 (R02) — 그날 설정한 알람과 실제로 일어난 일. 오늘은 db, 지난 날은 mocks/records, 기록이 없는 날은 빈 기록
export async function getDay(date: Date): Promise<DayRecord> {
  if (!isMock()) return real.getDay(date);
  const day = startOfDay(date);
  const t = today();
  const base = {
    date: day,
    isToday: isSameDay(day, t),
    isFuture: day.getTime() > t.getTime(),
    journalWritten: (await getJournal(dayKey(day))) != null,
  };
  if (!base.isToday) {
    const p = pastDay(day);
    if (!p) return { ...base, planned: [], actual: [] };
    const source = p.appointment?.title ?? '';
    return {
      ...base,
      planned: p.planned.map(([minutes, label]) => ({ at: kst(p.day, minutes), label, source })),
      actual: p.actual.map(([minutes, label, from]) => ({ at: kst(p.day, minutes), label, source: from })),
    };
  }
  const a1 = db.appointments.find((a) => a.id === 'a1');
  const nowMs = now().getTime();
  const planned = a1
    ? alarmChain(a1).map((x) => ({
        at: x.at,
        label: x.kind === 'ARRIVE' ? `${KIND_LABEL[x.kind]} 목표` : `${KIND_LABEL[x.kind]} 알람`,
        source: a1.title,
        past: x.at.getTime() <= nowMs,
      }))
    : [];
  // 넣은 순서가 아니라 시각순 — 마지막 줄(지금 강조)이 가장 늦은 일이 되게 (목업 logE 정렬)
  const actual = db.events.map((e) => ({ ...e })).sort((x, y) => x.at.getTime() - y.at.getTime());
  return { ...base, planned, actual };
}

function buildSuggestion(): Suggestion | null {
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  if (!a) return null;
  // 준비 알람 당김 (안건 D111) — 일정의 당김 분(prepareAdvanceMinutes)을 바꿔 서버와 같은 사슬(calc/chain.ts)로 시각을 구함
  const times = (advance: number) => {
    const chain = alarmChain({ ...a, prepareAdvanceMinutes: advance });
    return {
      wake: chain.find((x) => x.kind === 'WAKE')?.at ?? chain[0].at,
      prepare: chain.find((x) => x.kind === 'PREPARE')?.at ?? null,
      depart: chain.find((x) => x.kind === 'DEPARTURE')?.at ?? a.at,
    };
  };
  const advance = a.prepareAdvanceMinutes ?? 0;
  const applied = s.status === 'APPLIED' || s.status === 'EDITED';
  // 적용 전: 지금 → 제안, 적용 뒤: 적용 전 시각 → 실제로 적용한 시각
  const before = times(advance - s.appliedMinutes);
  const after = times(applied ? advance : advance + s.minutes);
  return {
    id: s.id,
    title: `준비 알람을 ${s.minutes}분 앞당겨 볼까요?`,
    summary: '최근 3번의 준비가 예상보다 오래 걸렸어요.',
    reason: '최근 3번의 준비가\n예상보다 평균 12분 더 걸렸어요.',
    deltas: [
      { label: '1회 전', value: '+12분' },
      { label: '2회 전', value: '+14분' },
      { label: '3회 전', value: '+10분' },
    ],
    appointment: { id: a.id, title: a.title, at: a.at },
    minutes: s.minutes,
    currentWake: before.wake,
    currentPrepare: before.prepare,
    depart: before.depart,
    bounds: prepareBounds(advance - s.appliedMinutes),
    proposedWake: after.wake,
    proposedPrepare: after.prepare,
    status: s.status,
    applied: applied ? { wake: after.wake, prepare: after.prepare, minutes: s.appliedMinutes } : null,
  };
}

// 홈 카드에 띄울 제안 — 기다리는 것만
export async function getPendingSuggestion(): Promise<Suggestion | null> {
  if (!isMock()) return real.getPendingSuggestion();
  return db.suggestion.status === 'PENDING' ? buildSuggestion() : null;
}

export async function getSuggestion(id: string): Promise<Suggestion | null> {
  if (!isMock()) return real.getSuggestion(id);
  return db.suggestion.id === id ? buildSuggestion() : null;
}

// 적용 — 준비 알람을 minutes분 앞당김 (안건 D111): 일정의 당김 분을 바꾸면 사슬이 준비 알람을 당기고 준비 전 활동을 넘는 만큼만 기상도. 출발은 그대로
// 제안과 다르게 고치면 EDITED. 적용한 뒤에도 다시 고칠 수 있음 — 앞서 적용한 만큼을 걷어내고 새 값으로, 다시 고친 건 늘 EDITED (D53)
// 실데이터는 서버 suggestion-apply (real.ts)
export async function applySuggestion(id: string, minutes: number) {
  if (!isMock()) return real.applySuggestion(id, minutes);
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  // 거절은 한국어 이유로 던짐 — 화면이 토스트로 보여 주고 성공 안내는 안 띄움
  if (s.id !== id || !a) throw new UserError('제안을 찾을 수 없어요');
  if (!Number.isInteger(minutes) || minutes <= 0) throw new UserError('당길 시간을 골라 주세요'); // 화면도 0분이면 버튼을 끔
  const reapply = s.status === 'APPLIED' || s.status === 'EDITED';
  if (reapply && minutes === s.appliedMinutes) throw new UserError('이미 이 시간으로 적용했어요');
  const advance = a.prepareAdvanceMinutes ?? 0;
  const bounds = prepareBounds(advance - s.appliedMinutes);
  if (minutes > bounds.earlier) throw new UserError(`${bounds.earlier}분 일찍까지 고를 수 있어요`);
  a.prepareAdvanceMinutes = advance - s.appliedMinutes + minutes;
  s.appliedMinutes = minutes;
  s.status = reapply || minutes !== s.minutes ? 'EDITED' : 'APPLIED';
  // 편집 기록(고친 값 기록 — 다른 PR)이 머지되면 여기서 screen 'S01'로 같이 남김
  db.events.push({ at: now(), label: `알람 조정 ${reapply ? '수정' : '수락'} · ${shiftLog(minutes)}`, source: '직접 입력' });
}

// 이전 값으로 되돌리기 — 제안은 다시 기다림으로 (목업 A.sugUndo). 적용한 제안이 아니면 거절
export async function undoSuggestion(id: string) {
  if (!isMock()) return real.undoSuggestion(id);
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  if (s.id !== id || !a) throw new UserError('제안을 찾을 수 없어요');
  if (s.status !== 'APPLIED' && s.status !== 'EDITED') throw new UserError('적용한 제안만 되돌릴 수 있어요');
  a.prepareAdvanceMinutes = (a.prepareAdvanceMinutes ?? 0) - s.appliedMinutes;
  s.appliedMinutes = 0;
  s.status = 'PENDING';
  db.events.push({ at: now(), label: '알람 조정 되돌림', source: '직접 입력' });
}

// 이번 제안 무시 — 같은 종류 제안은 당분간 다시 만들지 않음 (suppress_until)
export async function ignoreSuggestion(id: string) {
  if (!isMock()) return real.ignoreSuggestion(id);
  if (db.suggestion.id !== id) throw new UserError('제안을 찾을 수 없어요');
  if (db.suggestion.status !== 'PENDING') throw new UserError('기다리는 제안만 무시할 수 있어요');
  db.suggestion.status = 'IGNORED';
}

export async function reopenSuggestion(id: string) {
  if (!isMock()) return real.reopenSuggestion(id);
  if (db.suggestion.id !== id) throw new UserError('제안을 찾을 수 없어요');
  if (db.suggestion.status !== 'IGNORED') throw new UserError('무시한 제안만 다시 볼 수 있어요');
  db.suggestion.status = 'PENDING';
}
