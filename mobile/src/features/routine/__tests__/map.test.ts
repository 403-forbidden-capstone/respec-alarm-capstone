import { describe, expect, it } from '@jest/globals';

import { dayKey, formatTime } from '@/lib/format';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

import {
  blankRoutine,
  DEFAULT_START_MINUTE,
  formatRepeatDays,
  journalFacts,
  nextAckStep,
  parseRepeatDays,
  parseSteps,
  pickTodayRoutine,
  planRoutineAlarms,
  routineFields,
  routineProgress,
  splitSuggestion,
  stepsToJson,
  toEveningRoutine,
  toJournal,
  toRoutine,
  toTodo,
  weekdayOf,
  type JournalRow,
  type RoutineRow,
} from '../map';
import type { Routine } from '../types';

// 저장 모양(D29 열림)을 정해 둔 곳 — 읽고 쓴 것이 그대로 돌아오는지, 모르는 모양도 너그럽게 읽는지

describe('반복 요일 글자', () => {
  it('DB 기본 모양(MON~FRI)과 쉼표 목록, 일요일을 넘는 범위를 읽음', () => {
    expect(parseRepeatDays('MON~FRI')).toEqual(['월', '화', '수', '목', '금']);
    expect(parseRepeatDays('MON,WED,FRI')).toEqual(['월', '수', '금']);
    expect(parseRepeatDays('sat~mon')).toEqual(['월', '토', '일']); // 토 일 월
    expect(parseRepeatDays('FRI, SAT')).toEqual(['금', '토']);
  });

  it('모르는 글자 · 빈 값은 건너뜀', () => {
    expect(parseRepeatDays(null)).toEqual([]);
    expect(parseRepeatDays('')).toEqual([]);
    expect(parseRepeatDays('주중,XYZ,WED')).toEqual(['수']);
  });

  it('3일 이상 이어지면 범위로, 아니면 쉼표로 저장', () => {
    expect(formatRepeatDays(['월', '화', '수', '목', '금'])).toBe('MON~FRI');
    expect(formatRepeatDays(['월', '수', '금'])).toBe('MON,WED,FRI');
    expect(formatRepeatDays(['월', '화'])).toBe('MON,TUE');
    expect(formatRepeatDays(['수', '금', '토', '일'])).toBe('WED,FRI~SUN');
    expect(formatRepeatDays([])).toBe('');
    expect(formatRepeatDays(['일', '월'])).toBe('MON,SUN'); // 월요일부터 순서대로
  });

  it('어떤 요일 조합이든 저장했다가 읽으면 같고, varchar(20) 안에 들어감', () => {
    for (let mask = 0; mask < 128; mask++) {
      const days = WEEKDAYS.filter((_, i) => mask & (1 << i)) as Weekday[];
      const text = formatRepeatDays(days);
      expect(parseRepeatDays(text)).toEqual(days);
      expect(text.length).toBeLessThanOrEqual(20);
    }
  });

  it('날짜의 요일', () => {
    expect(weekdayOf(new Date('2026-10-18T15:00:00Z'))).toBe('월'); // 한국 시간 10/19
    expect(weekdayOf(new Date('2026-10-18T14:59:00Z'))).toBe('일');
  });
});

describe('steps(JSON) ↔ 단계', () => {
  const routine: Routine = {
    id: null,
    title: '회의 전날 준비',
    goal: '여유로운 아침',
    days: ['수'],
    startMinute: 21 * 60 + 30,
    steps: [
      { id: 's1', name: '회의 자료 확인', minutes: 5, alarm: true },
      { id: 's2', name: '노트북 충전', minutes: 2, alarm: false },
      { id: 's3', name: '가방에 준비물 넣기', minutes: 3, alarm: true },
    ],
    active: true,
    sourceJournal: null,
  };

  it('첫 단계 시각부터 걸리는 시간을 차례로 더한 offset (draft.ts stepTimes와 같은 규칙)', () => {
    expect(stepsToJson(routine.startMinute, routine.steps)).toEqual([
      { order: 1, title: '회의 자료 확인', offset: 1290, minutes: 5, is_alarm: true },
      { order: 2, title: '노트북 충전', offset: 1295, minutes: 2, is_alarm: false },
      { order: 3, title: '가방에 준비물 넣기', offset: 1297, minutes: 3, is_alarm: true },
    ]);
  });

  it('저장했다가 읽으면 시작 시각 · 단계 이름 · 걸리는 시간 · 알람이 그대로', () => {
    const parsed = parseSteps(stepsToJson(routine.startMinute, routine.steps));
    expect(parsed).toEqual({ startMinute: 1290, steps: routine.steps });
  });

  it('자정을 넘는 루틴도 그대로 (offset이 1440 이상)', () => {
    const late = parseSteps(stepsToJson(23 * 60 + 50, [{ id: 's1', name: '스트레칭', minutes: 20, alarm: false }, { id: 's2', name: '잠자기', minutes: 5, alarm: true }]));
    expect(late?.startMinute).toBe(1430);
    expect(late?.steps.map((s) => s.minutes)).toEqual([20, 5]);
  });

  it('빠진 칸은 채움 — minutes가 없으면 다음 단계와의 간격, 마지막은 5분, 이름이 비면 새 단계', () => {
    const parsed = parseSteps([
      { order: 1, title: '물 마시기', offset: 420, is_alarm: false },
      { order: 2, title: ' ', offset: 425 },
      { order: 3, title: '샤워', offset: 440, minutes: 12, is_alarm: true },
    ]);
    expect(parsed?.startMinute).toBe(420);
    expect(parsed?.steps).toEqual([
      { id: 's1', name: '물 마시기', minutes: 5, alarm: false },
      { id: 's2', name: '새 단계', minutes: 15, alarm: false },
      { id: 's3', name: '샤워', minutes: 12, alarm: true },
    ]);
  });

  it('order가 있으면 그 순서로, 객체가 아닌 칸은 건너뜀, 시작 시각을 모르면 기본값', () => {
    const parsed = parseSteps([{ order: 2, title: '둘째', is_alarm: false }, 'x', null, { order: 1, title: '첫째', is_alarm: true }]);
    expect(parsed?.steps.map((s) => s.name)).toEqual(['첫째', '둘째']);
    expect(parsed?.startMinute).toBe(DEFAULT_START_MINUTE);
  });

  it('단계를 하나도 못 읽으면 null', () => {
    expect(parseSteps([])).toBeNull();
    expect(parseSteps({})).toBeNull();
    expect(parseSteps(null)).toBeNull();
    expect(parseSteps(['a', 1])).toBeNull();
  });
});

describe('routines 한 줄 ↔ 루틴', () => {
  const row = (patch: Partial<RoutineRow> = {}): RoutineRow => ({
    routine_id: 'r-1',
    title: '회의 전날 준비',
    goal: null,
    repeat_days: 'WED',
    steps: [{ order: 1, title: '자료 확인', offset: 1290, minutes: 5, is_alarm: true }],
    is_active: true,
    daily_journals: { record_date: '2026-10-14' },
    ...patch,
  });

  it('읽기: 목표가 없으면 빈 글자, 제안한 일기 날짜', () => {
    expect(toRoutine(row())).toEqual({
      id: 'r-1',
      title: '회의 전날 준비',
      goal: '',
      days: ['수'],
      startMinute: 1290,
      steps: [{ id: 's1', name: '자료 확인', minutes: 5, alarm: true }],
      active: true,
      sourceJournal: '2026-10-14',
    });
    expect(toRoutine(row({ daily_journals: null }))?.sourceJournal).toBeNull();
    expect(toRoutine(row({ steps: [] }))).toBeNull(); // 단계를 못 읽는 루틴은 빠짐
  });

  it('쓰기: 이름 60자 · 목표 200자로 자르고 빈 목표는 null', () => {
    const base = toRoutine(row())!;
    const fields = routineFields({ ...base, title: '가'.repeat(80), goal: '나'.repeat(250), days: ['월', '화', '수'] });
    expect(fields.title).toHaveLength(60);
    expect(fields.goal).toHaveLength(200);
    expect(fields.repeat_days).toBe('MON~WED');
    expect(routineFields({ ...base, goal: '  ' }).goal).toBeNull();
    expect(routineFields({ ...base, title: ' ' }).title).toBe('새 루틴');
    expect(routineFields({ ...base, active: false }).is_active).toBe(false);
  });

  it('저녁 루틴 카드', () => {
    expect(toEveningRoutine(toRoutine(row())!)).toEqual({ id: 'r-1', title: '회의 전날 준비', days: ['수'], startMinute: 1290, stepCount: 1 });
    expect(toEveningRoutine({ ...toRoutine(row())!, id: null })).toBeNull();
  });

  it('빈 초안: 제안 글 첫 줄이 이름, 요일은 비워 두고 단계는 새 단계 하나 (D30 열림)', () => {
    const draft = blankRoutine('2026-10-14', '회의 전날 준비\n수요일 밤 9:30부터 3단계');
    expect(draft).toEqual({
      id: null,
      title: '회의 전날 준비',
      goal: '',
      days: [],
      startMinute: DEFAULT_START_MINUTE,
      steps: [{ id: 's1', name: '새 단계', minutes: 5, alarm: false }],
      active: true,
      sourceJournal: '2026-10-14',
    });
    expect(blankRoutine(null, null).title).toBe('새 루틴');
    expect(blankRoutine(null, '  ').sourceJournal).toBeNull();
  });
});

describe('오늘 루틴 진행', () => {
  const routine = (patch: Partial<Routine> = {}): Routine => ({
    id: 'r-1',
    title: '출근 준비',
    goal: '',
    days: ['월', '화', '수', '목', '금'],
    startMinute: 7 * 60,
    steps: [
      { id: 's1', name: '물 마시기', minutes: 2, alarm: true },
      { id: 's2', name: '스트레칭', minutes: 5, alarm: false },
      { id: 's3', name: '샤워', minutes: 15, alarm: true },
      { id: 's4', name: '출발', minutes: 5, alarm: false },
    ],
    active: true,
    sourceJournal: null,
    ...patch,
  });

  it('켜져 있고 오늘 요일이며 저녁 전에 시작하는 루틴 중 가장 일찍 시작하는 것', () => {
    const early = routine({ id: 'early', startMinute: 6 * 60 });
    const evening = routine({ id: 'evening', startMinute: 21 * 60 });
    const off = routine({ id: 'off', active: false, startMinute: 5 * 60 });
    const weekend = routine({ id: 'weekend', days: ['토'], startMinute: 5 * 60 });
    expect(pickTodayRoutine([routine(), early, evening, off, weekend], '월', 18 * 60)?.id).toBe('early');
    expect(pickTodayRoutine([evening, off, weekend], '월', 18 * 60)).toBeNull();
    expect(pickTodayRoutine([], '월', 18 * 60)).toBeNull();
  });

  it('끝낸 단계 수 = 확인한 단계 중 가장 뒤 (알람 없는 단계는 뒤 단계를 확인하면 같이 끝남)', () => {
    expect(routineProgress(routine(), [])).toEqual({ id: 'r-1', title: '출근 준비', steps: ['물 마시기', '스트레칭', '샤워', '출발'], done: 0 });
    expect(routineProgress(routine(), [1])?.done).toBe(1);
    expect(routineProgress(routine(), [3, 1])?.done).toBe(3);
    expect(routineProgress(routine(), [9, 0])?.done).toBe(0); // 단계 밖 번호는 무시
    expect(routineProgress(routine({ id: null }), [])).toBeNull();
  });

  it('다음에 확인할 단계 = 끝낸 단계 뒤에서 처음 나오는 알람 있는 단계', () => {
    expect(nextAckStep(routine(), 0)).toBe(1);
    expect(nextAckStep(routine(), 1)).toBe(3); // 스트레칭은 알람이 없어 건너뜀
    expect(nextAckStep(routine(), 3)).toBeNull(); // 남은 단계(출발)에 알람이 없음
    expect(nextAckStep(routine({ steps: routine().steps.map((s) => ({ ...s, alarm: false })) }), 0)).toBeNull();
  });
});

describe('단계 알람이 처음 울릴 시각', () => {
  const steps = [
    { id: 's1', name: '자료 확인', minutes: 5, alarm: true },
    { id: 's2', name: '노트북 충전', minutes: 2, alarm: false },
    { id: 's3', name: '가방 싸기', minutes: 3, alarm: true },
  ];
  const plan = (from: string, days: Weekday[], startMinute = 21 * 60 + 30) =>
    planRoutineAlarms({ days, startMinute, steps }, new Date(from)).map((p) => `${p.stepOrder}:${dayKey(p.at)} ${formatTime(p.at)}`);

  it('고른 요일 중 가장 가까운 날 (수요일 밤 9:30 루틴을 월요일 아침에 저장)', () => {
    expect(plan('2026-10-18T22:00:00Z', ['수'])).toEqual(['1:2026-10-21 오후 9:30', '3:2026-10-21 오후 9:37']);
  });

  it('오늘이 고른 요일이어도 시작 시각이 지났으면 다음 주, 안 지났으면 오늘', () => {
    expect(plan('2026-10-21T13:00:00Z', ['수'])).toEqual(['1:2026-10-28 오후 9:30', '3:2026-10-28 오후 9:37']); // 수요일 밤 10시
    expect(plan('2026-10-21T03:00:00Z', ['수'])).toEqual(['1:2026-10-21 오후 9:30', '3:2026-10-21 오후 9:37']); // 수요일 낮 12시
  });

  it('자정을 넘는 단계는 다음 날 시각으로 (월요일 아침에 보면 시작 시각이 안 지났으니 오늘 밤)', () => {
    expect(plan('2026-10-18T22:00:00Z', ['월'], 23 * 60 + 58)).toEqual(['1:2026-10-19 오후 11:58', '3:2026-10-20 오전 12:05']);
  });

  it('요일이 없으면 알람 없음', () => {
    expect(plan('2026-10-18T22:00:00Z', [])).toEqual([]);
  });
});

describe('준비물', () => {
  it('todos 한 줄 → 화면 항목', () => {
    expect(toTodo({ todo_id: 't-1', title: '노트북', is_done: true })).toEqual({ id: 't-1', title: '노트북', done: true });
  });
});

describe('일기', () => {
  const row = (patch: Partial<JournalRow> = {}): JournalRow => ({
    journal_id: 'j-1',
    record_date: '2026-10-19',
    ai_summary: 'AI가 쓴 글',
    edited_summary: null,
    is_edited: false,
    coaching_insight: '코칭',
    encouragement: '격려',
    routine_suggestion: '회의 전날 준비\n수요일 밤 9:30부터 3단계',
    suggestion_status: 'PENDING',
    ...patch,
  });

  it('고치지 않은 일기: AI 글을 보여 주고 제안은 첫 줄이 제목, 나머지가 설명', () => {
    const j = toJournal(row(), [], null)!;
    expect([j.recordDate, dayKey(j.date), j.aiText, j.text, j.edited]).toEqual(['2026-10-19', '2026-10-19', 'AI가 쓴 글', 'AI가 쓴 글', false]);
    expect([j.coaching, j.encouragement, j.routineId]).toEqual(['코칭', '격려', null]);
    expect(j.suggestion).toEqual({ title: '회의 전날 준비', reason: '', summary: '수요일 밤 9:30부터 3단계', status: 'PENDING' });
  });

  it('고친 일기는 고친 글을 보여 주고 AI 원본은 따로', () => {
    const j = toJournal(row({ edited_summary: '내가 고친 글', is_edited: true, suggestion_status: 'APPLIED' }), [], 'r-1')!;
    expect([j.aiText, j.text, j.edited, j.suggestion.status, j.routineId]).toEqual(['AI가 쓴 글', '내가 고친 글', true, 'APPLIED', 'r-1']);
    // 고쳤다는 표시가 없으면 남아 있는 고친 글은 안 씀
    expect(toJournal(row({ edited_summary: '남은 글', is_edited: false }), [], null)?.text).toBe('AI가 쓴 글');
  });

  it('비어 있는 칸은 빈 글자, 제안 글이 없으면 제목이 빈 글자(화면이 제안 카드를 접음)', () => {
    const j = toJournal(row({ ai_summary: null, coaching_insight: null, encouragement: null, routine_suggestion: null }), [], null)!;
    expect([j.aiText, j.text, j.coaching, j.encouragement]).toEqual(['', '', '', '']);
    expect(j.suggestion).toEqual({ title: '', reason: '', summary: '', status: 'PENDING' });
    expect(toJournal(row({ record_date: 'nope' }), [], null)).toBeNull();
  });

  it('제안 글 나누기: 빈 줄은 건너뜀, 한 줄이면 설명 없음', () => {
    expect(splitSuggestion('\n  제목  \n\n설명 하나\n설명 둘')).toEqual({ title: '제목', summary: '설명 하나 설명 둘' });
    expect(splitSuggestion('제목만')).toEqual({ title: '제목만', summary: '' });
    expect(splitSuggestion('   ')).toEqual({ title: '', summary: '' });
    expect(splitSuggestion(undefined)).toEqual({ title: '', summary: '' });
  });

  it('오늘의 사실: 기상 확인 · 출발 · 도착 · 미루기만 (울림 · 해제 같은 자동 기록은 뺌)', () => {
    const at = new Date('2026-10-18T22:20:00Z');
    const rows = ['기상 알람 울림', '기상 알람 10분 미루기', '기상 알람 해제', '기상 확인', '준비 시작', '집 출발', '도착 · 지각 아님'].map((label) => ({ at, label, source: '자동', past: true }));
    expect(journalFacts(rows).map((f) => f.label)).toEqual(['기상 알람 10분 미루기', '기상 확인', '집 출발', '도착 · 지각 아님']);
    expect(journalFacts(rows)[0]).toEqual({ at, label: '기상 알람 10분 미루기', source: '자동' }); // past는 안 가져감
  });
});
