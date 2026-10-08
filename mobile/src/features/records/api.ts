// ④ 캘린더 · 하루 기록 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (R02 · S01, 제안은 alarm_suggestions)
import { KIND_LABEL } from '@/features/alarm/types';
import { now } from '@/lib/clock';
import { addMinutes, dateParts, isSameDay, startOfDay } from '@/lib/format';
import { alarmChain } from '@/mocks/calc';
import { db, kst, lastWeekAverageWake, pastWakes, TODAY } from '@/mocks/data';

import { leadingBlanks, monthDays, monthTitle, weekDays, weekRelative, weekTitle } from './calendar';
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

// 주간 요약 — 목업은 5월 19일 주만 있음. 오늘 기상이 확인되면 오늘도 더함
function mockWeekSummary(): WeekSummary {
  const a1 = db.appointments.find((a) => a.id === 'a1');
  const rows = pastWakes.map((x) => ({ ...x }));
  if (db.me.wakeAt && a1) {
    const wakeMin = Math.round((db.me.wakeAt.getTime() - kst(TODAY, 0).getTime()) / 60_000);
    const target = Math.round((alarmChain(a1)[0].at.getTime() - kst(TODAY, 0).getTime()) / 60_000);
    rows.push({ day: TODAY, wake: wakeMin, score: wakeMin <= target + 10 ? 88 : 61 });
  }
  const average = Math.round(rows.reduce((s, x) => s + x.wake, 0) / rows.length);
  const diff = lastWeekAverageWake - average;
  const goal = rows.filter((x) => x.score >= 70).length;
  return {
    averageWake: kst(TODAY, average),
    averageText: diff > 0 ? `지난주보다 ${diff}분 빨라요` : diff < 0 ? `지난주보다 ${-diff}분 늦어요` : '지난주와 같아요',
    goalRate: Math.round((goal / rows.length) * 100),
    goalText: `이번 주 ${goal}/${rows.length}일`,
    bars: rows.map((x) => ({ label: `${dateParts(kst(x.day, 0)).weekday} ${x.day}`, score: x.score })),
    todayPending: db.me.wakeAt == null,
    coaching: '회의가 있는 날은 준비가 평균 12분 길었어요. 전날 밤 준비 루틴을 만들면 아침이 여유로워져요.',
  };
}

// 주간 (R02) — anyDay가 든 주 (월요일 시작). 목업에 없는 주는 요약 없이 날짜 줄만
export async function getWeek(anyDay: Date): Promise<WeekRecord> {
  const t = today();
  const days = weekDays(anyDay);
  return {
    title: weekTitle(anyDay),
    relative: weekRelative(anyDay, t),
    strip: days.map((date) => ({
      date,
      weekday: dateParts(date).weekday,
      day: dateParts(date).day,
      isToday: isSameDay(date, t),
      isFuture: date.getTime() > t.getTime(),
      recorded: markOf(date) !== 'none',
    })),
    summary: days.some((d) => isSameDay(d, t)) ? mockWeekSummary() : null,
  };
}

// 주간 요약이 없을 때 문구 — 날짜 줄에 기록 점이 있는데 "기록이 없어요"라고 하면 어긋남
export function weekEmptyText(week: WeekRecord): string {
  return week.strip.some((d) => d.recorded) ? '이 주 요약은 이번 목업에 없어요.' : '이 주에는 기록이 없어요.';
}

// 일간 (R02) — 그날 설정한 알람과 실제로 일어난 일. 목업은 5월 22일만 있고 다른 날은 빈 기록
export async function getDay(date: Date): Promise<DayRecord> {
  const day = startOfDay(date);
  if (!isSameDay(day, today())) return { date: day, planned: [], actual: [] };
  const a1 = db.appointments.find((a) => a.id === 'a1');
  const t = now().getTime();
  const planned = a1
    ? alarmChain(a1).map((x) => ({
        at: x.at,
        label: x.kind === 'ARRIVE' ? `${KIND_LABEL[x.kind]} 목표` : `${KIND_LABEL[x.kind]} 알람`,
        source: a1.title,
        past: x.at.getTime() <= t,
      }))
    : [];
  // 넣은 순서가 아니라 시각순 — 마지막 줄(지금 강조)이 가장 늦은 일이 되게 (목업 logE 정렬)
  const actual = db.events.map((e) => ({ ...e })).sort((x, y) => x.at.getTime() - y.at.getTime());
  return { date: day, planned, actual };
}

function buildSuggestion(): Suggestion | null {
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  if (!a) return null;
  const chain = alarmChain(a);
  const wake = chain[0].at;
  const prepare = chain.find((x) => x.kind === 'PREPARE')?.at ?? null;
  const applied = s.status === 'APPLIED' || s.status === 'EDITED';
  // 적용 전: 지금 → 제안, 적용 뒤: 적용 전 시각 → 실제로 적용한 시각
  const before = applied ? addMinutes(wake, s.appliedMinutes) : wake;
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
    currentWake: before,
    proposedWake: applied ? wake : addMinutes(wake, -s.minutes),
    status: s.status,
    applied: applied ? { wake, prepare } : null,
  };
}

// 홈 카드에 띄울 제안 — 기다리는 것만
export async function getPendingSuggestion(): Promise<Suggestion | null> {
  return db.suggestion.status === 'PENDING' ? buildSuggestion() : null;
}

export async function getSuggestion(id: string): Promise<Suggestion | null> {
  return db.suggestion.id === id ? buildSuggestion() : null;
}

// 적용 — 예측 준비를 minutes만큼 늘려 기상 · 준비 알람이 같이 앞당겨짐. 제안과 다르게 고치면 EDITED
export async function applySuggestion(id: string, minutes: number) {
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  // 거절은 한국어 이유로 던짐 — 화면이 토스트로 보여 주고 성공 안내는 안 띄움
  if (s.id !== id || !a) throw new Error('제안을 찾을 수 없어요');
  if (minutes <= 0) throw new Error('앞당길 시간을 골라 주세요'); // 화면도 0분이면 버튼을 끔
  if (s.status === 'APPLIED' || s.status === 'EDITED') throw new Error('이미 적용한 제안이에요');
  a.predictedPrepMinutes += minutes;
  s.appliedMinutes = minutes;
  s.status = minutes === s.minutes ? 'APPLIED' : 'EDITED';
  db.events.push({ at: now(), label: `알람 조정 수락 · ${minutes}분 앞당김`, source: '직접 입력' });
}

// 이전 값으로 되돌리기 — 제안은 다시 기다림으로 (목업 A.sugUndo)
export async function undoSuggestion(id: string) {
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  if (s.id !== id || !a || (s.status !== 'APPLIED' && s.status !== 'EDITED')) return;
  a.predictedPrepMinutes -= s.appliedMinutes;
  s.appliedMinutes = 0;
  s.status = 'PENDING';
  db.events.push({ at: now(), label: '알람 조정 되돌림', source: '직접 입력' });
}

// 이번 제안 무시 — 같은 종류 제안은 당분간 다시 만들지 않음 (suppress_until)
export async function ignoreSuggestion(id: string) {
  if (db.suggestion.id === id) db.suggestion.status = 'IGNORED';
}

export async function reopenSuggestion(id: string) {
  if (db.suggestion.id === id && db.suggestion.status === 'IGNORED') db.suggestion.status = 'PENDING';
}
