import { describe, expect, it } from '@jest/globals';

import { addDays, dayKey, formatTime } from '@/lib/format';
import { kst } from '@/mocks/data';

import { weekDays } from '../calendar';
import { buildWeekSummary, dayMark, GOAL_SCORE, isGoalScore, SCORE_LATE, SCORE_ON_TIME, wakeScore, type DayFacts } from '../summary';

const facts = (f: Partial<DayFacts> = {}): DayFacts => ({ woke: false, prepared: false, journal: false, any: false, ...f });

// 가짜(api.ts)와 실데이터(real.ts)가 같이 쓰는 계산 — 점수식(D26) · 달력 점(D27)은 목업 뜻 그대로
describe('wakeScore — 기상 알람 + 10분 안이면 88점, 넘으면 61점', () => {
  it('경계는 10분까지 포함', () => {
    expect(wakeScore(435, 435)).toBe(SCORE_ON_TIME);
    expect(wakeScore(445, 435)).toBe(SCORE_ON_TIME);
    expect(wakeScore(446, 435)).toBe(SCORE_LATE);
    expect(wakeScore(400, 435)).toBe(SCORE_ON_TIME); // 알람보다 일찍 일어남
  });

  it('70점 이상이 목표 기상 — 두 점수 모두 기준 양쪽에 있음', () => {
    expect(isGoalScore(SCORE_ON_TIME)).toBe(true);
    expect(isGoalScore(SCORE_LATE)).toBe(false);
    expect(isGoalScore(GOAL_SCORE)).toBe(true);
    expect(isGoalScore(GOAL_SCORE - 1)).toBe(false);
  });
});

describe('dayMark — 달력 점', () => {
  it('지난 날: 기상 확인 + 준비 실측이 다 있으면 완료', () => {
    expect(dayMark(facts({ woke: true, prepared: true, any: true }), false)).toBe('done');
  });

  it('지난 날: 일부만 있으면 일부 (기상 확인만 · 직접 입력 한 줄만 · 일기만)', () => {
    expect(dayMark(facts({ woke: true, any: true }), false)).toBe('partial');
    expect(dayMark(facts({ prepared: true, any: true }), false)).toBe('partial');
    expect(dayMark(facts({ any: true }), false)).toBe('partial');
    expect(dayMark(facts({ journal: true }), false)).toBe('partial'); // 일기가 있는 날은 기록 있음
  });

  it('지난 날: 아무것도 없으면 없음', () => {
    expect(dayMark(facts(), false)).toBe('none');
  });

  it('오늘: 하루가 안 끝났으니 기상 확인만 있어도 완료, 일기만 있어도 완료 (목업 오늘 규칙)', () => {
    expect(dayMark(facts({ woke: true }), true)).toBe('done');
    expect(dayMark(facts({ journal: true }), true)).toBe('done');
    expect(dayMark(facts({ prepared: true, any: true }), true)).toBe('partial');
    expect(dayMark(facts(), true)).toBe('none');
  });
});

describe('buildWeekSummary', () => {
  const days = weekDays(kst(22, 0)); // 5월 19일 월 ~ 25일 일
  const today = kst(22, 0);
  const row = (day: number, wake: number, score: number) => ({ date: kst(day, 0), wake, score });
  const base = { days, relative: '이번 주', today, todayWoke: false };

  it('기록이 없는 주는 요약 없음', () => {
    expect(buildWeekSummary({ ...base, rows: [], beforeRows: [row(14, 450, 80)] })).toBeNull();
  });

  it('평균 기상 · 앞 주와 견줌 · 목표 기상률 · 막대 (날짜가 막대에 들어 있음)', () => {
    const s = buildWeekSummary({
      ...base,
      rows: [row(19, 451, 76), row(20, 440, 92), row(21, 444, 84)],
      beforeRows: [row(12, 460, 82), row(13, 449, 68), row(14, 458, 79)],
    })!;
    expect(formatTime(s.averageWake)).toBe('오전 7:25'); // (451+440+444)/3 = 445 → 7:25
    expect(s.averageText).toBe('지난주보다 11분 빨라요'); // 앞 주 평균 (460+449+458)/3 = 456 → 456 − 445
    expect([s.goalRate, s.goalText]).toEqual([100, '이번 주 3/3일']);
    expect(s.bars.map((b) => `${b.label}:${b.score}`)).toEqual(['월 19:76', '화 20:92', '수 21:84']);
    expect(s.bars.map((b) => dayKey(b.date))).toEqual(['2025-05-19', '2025-05-20', '2025-05-21']);
    expect(s.bars.every((b) => !b.isToday && !b.isFuture)).toBe(true);
  });

  it('목표 기상률은 70점 이상인 날 ÷ 기록한 날, 앞 주 기록이 없으면 견주지 않음', () => {
    const s = buildWeekSummary({ ...base, rows: [row(19, 450, SCORE_ON_TIME), row(20, 470, SCORE_LATE)], beforeRows: [] })!;
    expect([s.goalRate, s.goalText]).toEqual([50, '이번 주 1/2일']);
    expect(s.averageText).toBe('지난주 기록이 없어 견줄 수 없어요');
  });

  it('지난주를 보는 중이면 "그 전 주"로 견줌, 늦거나 같을 때 문구', () => {
    const lastWeek = weekDays(kst(14, 0));
    const input = { ...base, days: lastWeek, relative: '지난주' };
    const later = buildWeekSummary({ ...input, rows: [{ date: kst(12, 0), wake: 460, score: 80 }], beforeRows: [{ date: kst(5, 0), wake: 450, score: 80 }] })!;
    expect(later.averageText).toBe('그 전 주보다 10분 늦어요');
    const same = buildWeekSummary({ ...input, rows: [{ date: kst(12, 0), wake: 450, score: 80 }], beforeRows: [{ date: kst(5, 0), wake: 450, score: 80 }] })!;
    expect(same.averageText).toBe('그 전 주와 같아요');
  });

  it('오늘 기록은 기상 확인 뒤에 더해짐 — 이번 주이고 오늘 기상 확인이 없을 때만 대기', () => {
    const rows = [row(19, 450, 80)];
    expect(buildWeekSummary({ ...base, rows, beforeRows: [] })!.todayPending).toBe(true);
    expect(buildWeekSummary({ ...base, rows, beforeRows: [], todayWoke: true })!.todayPending).toBe(false);
    expect(buildWeekSummary({ ...base, days: weekDays(kst(14, 0)), rows, beforeRows: [] })!.todayPending).toBe(false); // 오늘이 없는 주
  });

  it('오늘 막대는 오늘 표시', () => {
    const s = buildWeekSummary({ ...base, rows: [row(22, 455, 61)], beforeRows: [] })!;
    expect(s.bars[0]).toMatchObject({ label: '목 22', isToday: true, isFuture: false });
    expect(dayKey(addDays(days[0], 3))).toBe('2025-05-22');
  });
});
