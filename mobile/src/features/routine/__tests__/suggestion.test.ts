import { afterEach, describe, expect, it } from '@jest/globals';

import { aiDb, MOCK_ROUTINE_SUGGESTION } from '@/mocks/ai';
import { db } from '@/mocks/data';

import { getPendingRoutineSuggestion, getRoutine, ignoreRoutineSuggestion, saveRoutine } from '../api';
import { daysOf, suggestionSummary, suggestionToRoutine } from '../suggestion';
import type { RoutineSuggestion } from '../types';

// 루틴 제안 (안건 D114) — 제안 → 루틴 편집 초안(순수) · 가짜 데이터 흐름(기다림 → 만들기 · 넘김)
const night: RoutineSuggestion = {
  id: 'rs-night',
  cause: 'NIGHT_PREP',
  title: '전날 밤 준비',
  reason: '최근 아침 7번 중 4번, 준비물을 아침에야 챙겼어요',
  draft: {
    goal: '아침에 챙길 것 줄이기',
    days: [0, 2, 4],
    steps: [
      { name: '준비물 챙기기', minutes: 10, alarm: true, offsetFromWake: null, at: '21:30' },
      { name: '옷 꺼내 두기', minutes: 5, alarm: false, offsetFromWake: null, at: '21:40' },
    ],
  },
};

afterEach(() => {
  aiDb.routineSuggestion = 'PENDING';
  aiDb.routines.length = 0;
  db.events.length = 0;
});

describe('제안 → 루틴 편집 초안', () => {
  it('요일 숫자(0 일 ~ 6 토) → 월요일부터 순서대로', () => {
    expect(daysOf([4, 1, 3])).toEqual(['월', '수', '목']);
    expect(daysOf([0, 6])).toEqual(['토', '일']);
  });

  it('아침 루틴 — 기상 알람 시각에서 시작, 걸리는 분은 다음 단계까지 (물 한 잔 3분 → 창문 7:23)', () => {
    const r = suggestionToRoutine(MOCK_ROUTINE_SUGGESTION, 7 * 60 + 20);
    expect([r.id, r.title, r.goal, r.days, r.startMinute, r.sourceSuggestion]).toEqual([null, '일어나자마자 2단계', '다시 잠들지 않기', ['월', '수', '목'], 440, 'rs1']);
    expect(r.steps.map((s) => [s.name, s.minutes, s.alarm])).toEqual([['물 한 잔', 3, false], ['창문 열고 불 켜기', 3, true]]);
  });

  it('기상 알람을 못 찾으면 7:00으로 두고, 밤 루틴은 고정 시각(21:30)에서 시작', () => {
    expect(suggestionToRoutine(MOCK_ROUTINE_SUGGESTION, null).startMinute).toBe(420);
    const r = suggestionToRoutine(night, 440);
    expect([r.startMinute, r.days, r.steps.map((s) => s.minutes)]).toEqual([21 * 60 + 30, ['화', '목', '일'], [10, 5]]);
  });

  it('카드 한 줄 — 요일 · 단계 수 · 언제', () => {
    expect(suggestionSummary(MOCK_ROUTINE_SUGGESTION)).toBe('월 · 수 · 목 · 2단계 · 기상 알람에 맞춰');
    expect(suggestionSummary(night)).toBe('화 · 목 · 일 · 2단계 · 밤 21:30부터');
  });
});

describe('가짜 데이터 흐름', () => {
  it('기다리는 제안 → 초안으로 열어 저장하면 받아들임, 카드에서 사라짐 · 루틴은 AI 제안으로 남음', async () => {
    const s = await getPendingRoutineSuggestion();
    expect(s?.title).toBe('일어나자마자 2단계');
    const draft = await getRoutine('new', undefined, s!.id);
    expect([draft?.startMinute, draft?.sourceSuggestion]).toEqual([440, 'rs1']);
    await saveRoutine(draft!);
    expect(aiDb.routineSuggestion).toBe('ACCEPTED');
    expect(await getPendingRoutineSuggestion()).toBeNull();
    expect(await getRoutine('new', undefined, 'rs1')).toBeNull(); // 이미 답한 제안은 다시 못 엶
    expect(aiDb.routines.at(-1)?.title).toBe('일어나자마자 2단계');
  });

  it('괜찮아요 → 넘김, 카드에서 사라짐', async () => {
    await ignoreRoutineSuggestion('rs1');
    expect(aiDb.routineSuggestion).toBe('IGNORED');
    expect(await getPendingRoutineSuggestion()).toBeNull();
  });
});
