// R02 기록 계산 — 점수 · 목표 기상 · 달력 점 · 주간 요약. 순수 함수 (시험: __tests__/summary.test.ts)
// 가짜 데이터(api.ts)와 실데이터(real.ts)가 같은 함수를 써서 두 모드의 뜻이 어긋나지 않게 함
//   점수식(D26)은 열린 안건이라 목업 계산 그대로, 달력 점은 D27 C(10/29 투표) 기준 — 바꾸려면 이 파일만 고침
import { addMinutes, dateParts, isSameDay } from '@/lib/format';

import type { DayMark, WeekBar, WeekSummary } from './types';

// 목표 기상 = 70점 이상 (목업 값, D26 열림)
export const GOAL_SCORE = 70;
// 기상 알람 시각 + 10분 안에 기상을 확정하면 높은 점수, 넘으면 낮은 점수 (목업 오늘 계산 그대로 — 지난 날 점수는 목업에 고정값)
export const WAKE_GRACE_MINUTES = 10;
export const SCORE_ON_TIME = 88;
export const SCORE_LATE = 61;

// 그날 실행 점수 — 두 값 모두 0시부터 분
export function wakeScore(wakeMinute: number, targetMinute: number): number {
  return wakeMinute <= targetMinute + WAKE_GRACE_MINUTES ? SCORE_ON_TIME : SCORE_LATE;
}

export const isGoalScore = (score: number) => score >= GOAL_SCORE;

// 그날 내 일정(이번만 지운 회차는 뺌)과 그 일정들의 출발 · 도착 기록 수 — total = 일정 수, departed · arrived = 출발 · 도착 기록이 있는 일정 수
export type AppointmentCounts = { total: number; departed: number; arrived: number };
export const NO_APPOINTMENTS: AppointmentCounts = { total: 0, departed: 0, arrived: 0 };

// 달력 점을 정하는 그날의 기록 — woke = 기상 확인이 있음, journal = 그날 일기가 있음, appointments = 그날 일정과 출발 · 도착 기록 수,
// any = 위 말고도 뭐든 기록이 하나라도 있음 (목업: 주말에 직접 입력한 한 줄 · 준비 실측 · 수면 기록 등)
export type DayFacts = { woke: boolean; journal: boolean; any: boolean; appointments: AppointmentCounts };

// 지난 날은 그날 있어야 할 기록이 다 있으면 완료 (D27 C, 10/29 투표) — 일정 있는 날은 기상 확인 + 일정마다 출발 · 도착, 일정 없는 날은 기상 확인만.
//   일부만 있으면 일부, 기록이 하나도 없으면 없음 (일정만 있고 기록이 없는 날도 없음 — 점은 기록이 있어야 찍힘)
//   L6 안건후보: 일정이 여럿인 날 기본안 = 일정마다 출발 · 도착이 다 있어야 완료 (하나라도 빠지면 일부)
// 오늘은 하루가 안 끝났으니 기상 확인(또는 일기)만 있어도 완료 — D27은 지난 날 기준만 정함
//   L6 안건후보: 오늘 규칙 기본안 = 지금 규칙 그대로 (기상 확인이나 일기만 있어도 완료)
export function dayMark(facts: DayFacts, isToday: boolean): DayMark {
  const { total, departed, arrived } = facts.appointments;
  const complete = facts.woke && departed >= total && arrived >= total; // 일정이 없으면 total이 0이라 기상 확인만 봄
  const done = isToday ? facts.woke || facts.journal : complete;
  if (done) return 'done';
  return facts.any || facts.woke || facts.journal || departed > 0 || arrived > 0 ? 'partial' : 'none';
}

// 주간 요약의 한 줄 — 기상 확인이 있고 점수를 낼 수 있는 날. wake = 그날 0시부터 분
export type WakeRow = { date: Date; wake: number; score: number };

const average = (rows: readonly WakeRow[]) => Math.round(rows.reduce((sum, x) => sum + x.wake, 0) / rows.length);

export type WeekSummaryInput = {
  days: readonly Date[]; // 그 주 월 ~ 일
  rows: readonly WakeRow[]; // 그 주 기록
  beforeRows: readonly WakeRow[]; // 앞 주 기록 (평균을 견줌)
  relative: string; // 이번 주 · 지난주 · 2주 전
  today: Date; // 오늘 0시
  todayWoke: boolean; // 오늘 기상 확인이 있음
  coaching: string; // 없으면 빈 글자 (화면이 카드를 접음)
};

// 주간 요약 — 기록이 한 날이라도 있는 주. 평균 기상은 앞 주와 견줌 (앞 주 기록이 없으면 견주지 않음)
export function buildWeekSummary(input: WeekSummaryInput): WeekSummary | null {
  const { days, rows, beforeRows, relative, today } = input;
  if (!rows.length) return null;
  const avg = average(rows);
  const diff = beforeRows.length ? average(beforeRows) - avg : null;
  const goal = rows.filter((x) => isGoalScore(x.score)).length;
  const thisWeek = days.some((d) => isSameDay(d, today));
  // 견주는 주 이름 — 이번 주는 "지난주"지만, 지난주를 보는 중이면 "지난주보다"가 자기 자신 같아서 "그 전 주"
  const prev = thisWeek ? '지난주' : '그 전 주';
  const bars: WeekBar[] = rows.map((x) => {
    const { weekday, day } = dateParts(x.date);
    return {
      label: `${weekday} ${day}`,
      score: x.score,
      date: x.date,
      isToday: isSameDay(x.date, today),
      isFuture: x.date.getTime() > today.getTime(),
    };
  });
  return {
    averageWake: addMinutes(days[0], avg),
    averageText:
      diff == null ? `${prev} 기록이 없어 견줄 수 없어요` : diff > 0 ? `${prev}보다 ${diff}분 빨라요` : diff < 0 ? `${prev}보다 ${-diff}분 늦어요` : `${prev}와 같아요`,
    goalRate: Math.round((goal / rows.length) * 100),
    goalText: `${relative} ${goal}/${rows.length}일`,
    bars,
    todayPending: thisWeek && !input.todayWoke,
    coaching: input.coaching,
  };
}
