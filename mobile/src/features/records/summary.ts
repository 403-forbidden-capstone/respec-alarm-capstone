// R02 기록 계산 — 점수 · 목표 기상 · 달력 점 · 주간 요약. 순수 함수 (시험: __tests__/summary.test.ts)
// 가짜 데이터(api.ts)와 실데이터(real.ts)가 같은 함수를 써서 두 모드의 뜻이 어긋나지 않게 함
//   점수식(D26) · 달력 점 기준(D27)은 열린 안건이라 목업 계산 그대로 — 바꾸려면 이 파일만 고침
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

// 달력 점을 정하는 그날의 기록 — woke = 기상 확인이 있음, prepared = 준비 시작 · 출발까지 이어진 준비 실측이 있음, journal = 그날 일기가 있음,
// any = 위 말고도 뭐든 기록이 하나라도 있음 (목업: 주말에 직접 입력한 한 줄)
export type DayFacts = { woke: boolean; prepared: boolean; journal: boolean; any: boolean };

// 지난 날은 기상 확인 + 준비 실측이 다 있으면 완료, 일부만 있으면 일부, 없으면 없음. 오늘은 하루가 안 끝났으니 기상 확인(또는 일기)만 있어도 완료
//   (목업 markOf와 같은 뜻 — 평일은 완료, 주말은 일부. D27 열림)
export function dayMark(facts: DayFacts, isToday: boolean): DayMark {
  const done = isToday ? facts.woke || facts.journal : facts.woke && facts.prepared;
  if (done) return 'done';
  return facts.any || facts.woke || facts.journal ? 'partial' : 'none';
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
