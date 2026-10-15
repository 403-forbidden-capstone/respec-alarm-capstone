// ④ 캘린더 · 하루 기록 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (R02 · S01, 제안은 alarm_suggestions)
import { KIND_LABEL } from '@/features/alarm/types';
import { getJournal } from '@/features/routine/api';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { addDays, addMinutes, dateParts, dayKey, isSameDay, startOfDay } from '@/lib/format';
import { alarmChain } from '@/mocks/calc';
import { db, kst, TODAY } from '@/mocks/data';
import { pastDay } from '@/mocks/records';

import { leadingBlanks, monthDays, monthTitle, weekDays, weekRelative, weekTitle } from './calendar';
import { editBounds, shiftLog } from './suggestion';
import type { DayMark, DayRecord, MonthRecord, Suggestion, WeekRecord, WeekSummary } from './types';

// 기록 화면의 오늘 — 목업은 시나리오 시각(아침 · 전날 밤)과 상관없이 5월 22일
const today = () => kst(TODAY, 0);

// 기록 화면이 여는 "오늘" — 목업 기록은 5월 22일 하루라 시나리오가 전날 밤이어도 22일을 보여 줌 (실데이터는 now() 기준으로 바꿈)
export const recordToday = today;

// 그날 기록 표시 — 목업은 2025년 5월만 있음: 지난 평일 기록 완료 · 주말 일부 기록, 오늘은 기상 확인 · 일기 뒤에 완료
// 실데이터는 daily_records가 있는지 · 얼마나 채워졌는지로 정함
function markOf(date: Date): DayMark {
  const { year, month, day, weekdayIndex } = dateParts(date);
  if (year !== 2025 || month !== 5) return 'none';
  const weekend = weekdayIndex === 0 || weekdayIndex === 6;
  if (day < TODAY) return weekend ? 'partial' : 'done';
  return day === TODAY && (db.me.wakeAt != null || db.journalWritten) ? 'done' : 'none';
}

// 월간 (R02) — 실데이터는 daily_records.record_date로 그달을 읽음. 목업에 없는 달은 기록 없이 달력만
export async function getMonth(year: number, month: number): Promise<MonthRecord> {
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
function weekRows(days: Date[]) {
  const rows = days.flatMap((date) => {
    const p = pastDay(date);
    return p?.wake != null && p.score != null ? [{ day: p.day, wake: p.wake, score: p.score }] : [];
  });
  const a1 = db.appointments.find((a) => a.id === 'a1');
  if (db.me.wakeAt && a1 && days.some((d) => isSameDay(d, today()))) {
    const wakeMin = Math.round((db.me.wakeAt.getTime() - kst(TODAY, 0).getTime()) / 60_000);
    const target = Math.round((alarmChain(a1)[0].at.getTime() - kst(TODAY, 0).getTime()) / 60_000);
    rows.push({ day: TODAY, wake: wakeMin, score: wakeMin <= target + 10 ? 88 : 61 });
  }
  return rows;
}

const average = (rows: { wake: number }[]) => Math.round(rows.reduce((s, x) => s + x.wake, 0) / rows.length);

// 주간 요약 — 기록이 한 날이라도 있는 주. 평균 기상은 앞 주와 견줌 (앞 주 기록이 없으면 견주지 않음)
function weekSummary(days: Date[], relative: string): WeekSummary | null {
  const rows = weekRows(days);
  if (!rows.length) return null;
  const avg = average(rows);
  const before = weekRows(weekDays(addDays(days[0], -7)));
  const diff = before.length ? average(before) - avg : null;
  const goal = rows.filter((x) => x.score >= 70).length;
  return {
    averageWake: addMinutes(days[0], avg),
    averageText:
      diff == null ? '지난주 기록이 없어 견줄 수 없어요' : diff > 0 ? `지난주보다 ${diff}분 빨라요` : diff < 0 ? `지난주보다 ${-diff}분 늦어요` : '지난주와 같아요',
    goalRate: Math.round((goal / rows.length) * 100),
    goalText: `${relative} ${goal}/${rows.length}일`,
    bars: rows.map((x) => ({ label: `${dateParts(kst(x.day, 0)).weekday} ${x.day}`, score: x.score })),
    todayPending: days.some((d) => isSameDay(d, today())) && db.me.wakeAt == null,
    coaching: '회의가 있는 날은 준비가 평균 12분 길었어요. 전날 밤 준비 루틴을 만들면 아침이 여유로워져요.',
  };
}

// 주간 (R02) — anyDay가 든 주 (월요일 시작). 기록이 없는 주는 요약 없이 날짜 줄만
export async function getWeek(anyDay: Date): Promise<WeekRecord> {
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
  };
}

// 주간 요약이 없을 때 문구 — 날짜 줄에 기록 점이 있는데 "기록이 없어요"라고 하면 어긋남
export function weekEmptyText(week: WeekRecord): string {
  return week.strip.some((d) => d.recorded) ? '이 주 요약이 아직 없어요.' : '이 주에는 기록이 없어요.';
}

// 일간 (R02) — 그날 설정한 알람과 실제로 일어난 일. 오늘은 db, 지난 날은 mocks/records, 기록이 없는 날은 빈 기록
export async function getDay(date: Date): Promise<DayRecord> {
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
  const chain = alarmChain(a);
  const wake = chain[0].at;
  const prepare = chain.find((x) => x.kind === 'PREPARE')?.at ?? null;
  const depart = chain.find((x) => x.kind === 'DEPARTURE')?.at ?? a.at;
  const applied = s.status === 'APPLIED' || s.status === 'EDITED';
  // 적용 전: 지금 → 제안, 적용 뒤: 적용 전 시각 → 실제로 적용한 시각 (적용 안 했으면 appliedMinutes가 0이라 그대로. 늦춰 적용했으면 적용 전이 더 이른 시각)
  const back = (at: Date) => addMinutes(at, s.appliedMinutes);
  return {
    id: s.id,
    title: `다음 알람을 ${s.minutes}분 앞당겨 볼까요?`,
    summary: '최근 3번의 준비가 예상보다 오래 걸렸어요.',
    reason: '최근 3번의 준비가\n예상보다 평균 12분 더 걸렸어요.',
    deltas: [
      { label: '1회 전', value: '+10분' },
      { label: '2회 전', value: '+14분' },
      { label: '3회 전', value: '+12분' },
    ],
    appointment: { id: a.id, title: a.title, at: a.at },
    minutes: s.minutes,
    currentWake: back(wake),
    currentPrepare: prepare && back(prepare),
    depart,
    bounds: editBounds(a.predictedPrepMinutes - s.appliedMinutes, a.beforePrepMinutes),
    proposedWake: applied ? wake : addMinutes(wake, -s.minutes),
    status: s.status,
    applied: applied ? { wake, prepare, minutes: s.appliedMinutes } : null,
  };
}

// 홈 카드에 띄울 제안 — 기다리는 것만
export async function getPendingSuggestion(): Promise<Suggestion | null> {
  return db.suggestion.status === 'PENDING' ? buildSuggestion() : null;
}

export async function getSuggestion(id: string): Promise<Suggestion | null> {
  return db.suggestion.id === id ? buildSuggestion() : null;
}

// 적용 — 예측 준비를 minutes(적용 전보다 일찍 +, 늦게 −)만큼 바꿔 기상 · 준비 알람이 같이 움직임. 출발은 약속에 묶여 그대로
// 제안과 다르게 고치면 EDITED. 적용한 뒤에도 다시 고칠 수 있음 — 앞서 적용한 만큼을 걷어내고 새 값으로, 다시 고친 건 늘 EDITED (D53)
// 다시 고친 값을 어디에 저장하는지는 D6 · D23 · D25가 정한 뒤 (지금은 가짜 데이터)
export async function applySuggestion(id: string, minutes: number) {
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  // 거절은 한국어 이유로 던짐 — 화면이 토스트로 보여 주고 성공 안내는 안 띄움
  if (s.id !== id || !a) throw new UserError('제안을 찾을 수 없어요');
  if (!Number.isInteger(minutes) || minutes === 0) throw new UserError('조정할 시간을 골라 주세요'); // 화면도 0분이면 버튼을 끔
  const reapply = s.status === 'APPLIED' || s.status === 'EDITED';
  if (reapply && minutes === s.appliedMinutes) throw new UserError('이미 이 시간으로 적용했어요');
  const bounds = editBounds(a.predictedPrepMinutes - s.appliedMinutes, a.beforePrepMinutes);
  if (minutes > bounds.earlier || minutes < -bounds.later) {
    const range = bounds.later ? `${bounds.earlier}분 일찍부터 ${bounds.later}분 늦게까지` : `${bounds.earlier}분 일찍까지`;
    throw new UserError(`${range} 고를 수 있어요`);
  }
  a.predictedPrepMinutes += minutes - s.appliedMinutes;
  s.appliedMinutes = minutes;
  s.status = reapply || minutes !== s.minutes ? 'EDITED' : 'APPLIED';
  // 편집 기록(고친 값 기록 — 다른 PR)이 머지되면 여기서 screen 'S01'로 같이 남김
  db.events.push({ at: now(), label: `알람 조정 ${reapply ? '수정' : '수락'} · ${shiftLog(minutes)}`, source: '직접 입력' });
}

// 이전 값으로 되돌리기 — 제안은 다시 기다림으로 (목업 A.sugUndo). 적용한 제안이 아니면 거절
export async function undoSuggestion(id: string) {
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  if (s.id !== id || !a) throw new UserError('제안을 찾을 수 없어요');
  if (s.status !== 'APPLIED' && s.status !== 'EDITED') throw new UserError('적용한 제안만 되돌릴 수 있어요');
  a.predictedPrepMinutes -= s.appliedMinutes;
  s.appliedMinutes = 0;
  s.status = 'PENDING';
  db.events.push({ at: now(), label: '알람 조정 되돌림', source: '직접 입력' });
}

// 이번 제안 무시 — 같은 종류 제안은 당분간 다시 만들지 않음 (suppress_until)
export async function ignoreSuggestion(id: string) {
  if (db.suggestion.id !== id) throw new UserError('제안을 찾을 수 없어요');
  if (db.suggestion.status !== 'PENDING') throw new UserError('기다리는 제안만 무시할 수 있어요');
  db.suggestion.status = 'IGNORED';
}

export async function reopenSuggestion(id: string) {
  if (db.suggestion.id !== id) throw new UserError('제안을 찾을 수 없어요');
  if (db.suggestion.status !== 'IGNORED') throw new UserError('무시한 제안만 다시 볼 수 있어요');
  db.suggestion.status = 'PENDING';
}
