// ④ 캘린더 · 하루 기록 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (R02 · S01, 제안은 alarm_suggestions)
import { KIND_LABEL } from '@/features/alarm/types';
import { now } from '@/lib/clock';
import { addMinutes } from '@/lib/format';
import { alarmChain } from '@/mocks/calc';
import { db, kst, lastWeekAverageWake, pastWakes, TODAY } from '@/mocks/data';

import type { DayMark, DayRecord, MonthRecord, Suggestion, WeekRecord } from './types';

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];

// 월간 (R02) — 실데이터는 daily_records.record_date로 그달을 읽음
// 목업은 2025년 5월 한 달만 있음 (1일이 목요일이라 월요일 시작 달력에서 앞 빈칸 3개)
export async function getMonth(year: number, month: number): Promise<MonthRecord> {
  const todayDone = db.me.wakeAt != null || db.journalWritten;
  const days = Array.from({ length: 31 }, (_, i) => {
    const day = i + 1;
    const weekend = (day + 2) % 7 >= 5;
    const mark: DayMark = day < TODAY ? (weekend ? 'partial' : 'done') : day === TODAY && todayDone ? 'done' : 'none';
    return { date: kst(day, 0), day, mark, isToday: day === TODAY, isFuture: day > TODAY };
  });
  return {
    title: '2025년 5월',
    leadingBlanks: 3,
    days,
    today: { date: kst(TODAY, 0), eventCount: db.events.length, journalWritten: db.journalWritten },
  };
}

// 주간 (R02) — anyDay가 든 주 (월요일 시작). 목업은 5월 19일 주만 있음. 오늘 기상이 확인되면 오늘도 더함
export async function getWeek(anyDay: Date): Promise<WeekRecord> {
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
    title: '5월 19일 — 25일',
    strip: [19, 20, 21, 22, 23, 24, 25].map((day, i) => ({
      date: kst(day, 0),
      weekday: WEEK[i],
      day,
      isToday: day === TODAY,
      isFuture: day > TODAY,
    })),
    averageWake: kst(TODAY, average),
    averageText: diff > 0 ? `지난주보다 ${diff}분 빨라요` : diff < 0 ? `지난주보다 ${-diff}분 늦어요` : '지난주와 같아요',
    goalRate: Math.round((goal / rows.length) * 100),
    goalText: `이번 주 ${goal}/${rows.length}일`,
    bars: rows.map((x) => ({ label: `${WEEK[(x.day - 19) % 7]} ${x.day}`, score: x.score })),
    todayPending: db.me.wakeAt == null,
    coaching: '회의가 있는 날은 준비가 평균 12분 길었어요. 전날 밤 준비 루틴을 만들면 아침이 여유로워져요.',
  };
}

// 일간 (R02) — 그날 설정한 알람과 실제로 일어난 일. 목업은 5월 22일만 있음
export async function getDay(date: Date): Promise<DayRecord> {
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
  return { date: kst(TODAY, 0), planned, actual: db.events.map((e) => ({ ...e })) };
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
  if (s.id !== id || !a || s.status === 'APPLIED' || s.status === 'EDITED') return;
  a.predictedPrepMinutes += minutes;
  s.appliedMinutes = minutes;
  s.status = minutes === s.minutes ? 'APPLIED' : 'EDITED';
  db.events.push({ at: now(), label: `알람 조정 수락 · ${minutes}분 앞당김`, source: '직접 입력' });
}

// 이전 값으로 되돌리기
export async function undoSuggestion(id: string) {
  const s = db.suggestion;
  const a = db.appointments.find((x) => x.id === s.appointmentId);
  if (s.id !== id || !a || (s.status !== 'APPLIED' && s.status !== 'EDITED')) return;
  a.predictedPrepMinutes -= s.appliedMinutes;
  s.appliedMinutes = 0;
  s.status = 'PENDING';
}

// 이번 제안 무시 — 같은 종류 제안은 당분간 다시 만들지 않음 (suppress_until)
export async function ignoreSuggestion(id: string) {
  if (db.suggestion.id === id) db.suggestion.status = 'IGNORED';
}

export async function reopenSuggestion(id: string) {
  if (db.suggestion.id === id && db.suggestion.status === 'IGNORED') db.suggestion.status = 'PENDING';
}
