import { afterEach, describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { db, kst } from '@/mocks/data';

import {
  applySuggestion,
  getDay,
  getMonth,
  getPendingSuggestion,
  getSuggestion,
  getWeek,
  ignoreSuggestion,
  reopenSuggestion,
  undoSuggestion,
  weekEmptyText,
} from '../api';
import { EDIT_MAX, stepMinutes, suggestionPhase } from '../suggestion';

describe('R02 월간', () => {
  it('목업 달(2025년 5월): 앞 빈칸 3 · 지난 평일 완료 · 주말 일부 · 오늘 · 미래', async () => {
    const m = await getMonth(2025, 5);
    expect([m.title, m.leadingBlanks, m.days.length]).toEqual(['2025년 5월', 3, 31]);
    const day = (n: number) => m.days[n - 1];
    expect(day(21).mark).toBe('done'); // 수
    expect(day(18).mark).toBe('partial'); // 일
    expect([day(22).isToday, day(22).mark]).toEqual([true, 'none']); // 기상 확인 전
    expect([day(23).isFuture, day(23).mark]).toEqual([true, 'none']);
  });

  it('목업에 없는 달은 기록 없이 달력만', async () => {
    const m = await getMonth(2025, 6);
    expect([m.title, m.leadingBlanks, m.days.length]).toEqual(['2025년 6월', 6, 30]);
    expect(m.days.every((d) => d.mark === 'none' && d.isFuture && !d.isToday)).toBe(true);
    const april = await getMonth(2025, 4);
    expect(april.days.some((d) => d.isFuture)).toBe(false);
  });
});

describe('R02 주간', () => {
  it('목업 주(5월 19일): 날짜 줄 · 지난 사흘 요약', async () => {
    const w = await getWeek(kst(22, 475));
    expect([w.title, w.relative]).toEqual(['5월 19일 — 25일', '이번 주']);
    expect(w.strip.map((d) => `${d.weekday}${d.day}`)).toEqual(['월19', '화20', '수21', '목22', '금23', '토24', '일25']);
    expect(w.strip.map((d) => d.recorded)).toEqual([true, true, true, false, false, false, false]);
    expect(w.summary?.goalText).toBe('이번 주 3/3일');
    expect(w.summary?.bars.map((b) => b.label)).toEqual(['월 19', '화 20', '수 21']);
    expect(w.summary?.todayPending).toBe(true);
  });

  it('다른 주는 요약 없음', async () => {
    const w = await getWeek(kst(12, 0));
    expect([w.title, w.relative, w.summary]).toEqual(['5월 12일 — 18일', '지난주', null]);
  });

  it('실제로 일어난 일은 시각순 (넣은 순서와 상관없이)', async () => {
    db.events.push({ at: kst(22, 7 * 60), label: '이른 기록', source: '테스트' });
    const d = await getDay(kst(22, 0));
    const times = d.actual.map((e) => e.at.getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));
    db.events.pop();
  });

  it('일간은 받은 날짜로 — 목업에 없는 날은 빈 기록', async () => {
    const d = await getDay(kst(20, 9 * 60));
    expect([d.date.getTime(), d.planned.length, d.actual.length]).toEqual([kst(20, 0).getTime(), 0, 0]);
  });

  it('요약이 없는 주: 기록 점이 있으면 "요약 없음", 점도 없으면 "기록 없음"', async () => {
    expect(weekEmptyText(await getWeek(kst(12, 0)))).toBe('이 주 요약은 이번 목업에 없어요.');
    expect(weekEmptyText(await getWeek(kst(40, 0)))).toBe('이 주에는 기록이 없어요.');
  });
});

// S01 — 적용 · 직접 수정 · 되돌리기 · 무시 · 다시 보기 (목업 A.sugApply · sugApplyEdit · sugUndo · sugDismiss · sugReopen)
describe('S01 알람 조정 제안', () => {
  const eventCount = db.events.length;
  const prep = db.appointments.find((a) => a.id === 'a3')?.predictedPrepMinutes;

  afterEach(() => {
    db.suggestion.status = 'PENDING';
    db.suggestion.appliedMinutes = 0;
    const a3 = db.appointments.find((a) => a.id === 'a3');
    if (a3 && prep != null) a3.predictedPrepMinutes = prep;
    db.events.length = eventCount;
  });

  it('기다림: 수업 기상 오전 7:20 → 7:10 제안', async () => {
    const s = await getSuggestion('s1');
    expect(s && [suggestionPhase(s.status), formatTime(s.currentWake), formatTime(s.proposedWake)]).toEqual([
      'pending',
      '오전 7:20',
      '오전 7:10',
    ]);
    expect(await getSuggestion('nope')).toBeNull();
  });

  it('제안대로 적용하면 APPLIED, 기상 · 준비가 같이 앞당겨지고 홈 카드에서 빠짐', async () => {
    await applySuggestion('s1', 10);
    const s = await getSuggestion('s1');
    expect(s?.status).toBe('APPLIED');
    expect(s?.applied && [formatTime(s.applied.wake), s.applied.prepare && formatTime(s.applied.prepare)]).toEqual([
      '오전 7:10',
      '오전 7:20',
    ]);
    expect(await getPendingSuggestion()).toBeNull();
    expect(db.events.at(-1)?.label).toBe('알람 조정 수락 · 10분 앞당김');
  });

  it('직접 고친 분으로 적용하면 EDITED, 두 번 적용되지 않음', async () => {
    await applySuggestion('s1', 15);
    await expect(applySuggestion('s1', 15)).rejects.toThrow('이미 적용한 제안이에요');
    const s = await getSuggestion('s1');
    expect([s?.status, s && formatTime(s.proposedWake), s && formatTime(s.currentWake)]).toEqual(['EDITED', '오전 7:05', '오전 7:20']);
  });

  it('되돌리면 다시 기다림 · 원래 시각, 되돌림 기록이 남음', async () => {
    await applySuggestion('s1', 10);
    await undoSuggestion('s1');
    const s = await getSuggestion('s1');
    expect([s?.status, s && formatTime(s.currentWake)]).toEqual(['PENDING', '오전 7:20']);
    expect(db.events.at(-1)?.label).toBe('알람 조정 되돌림');
  });

  it('0분으로는 적용되지 않음', async () => {
    await expect(applySuggestion('s1', 0)).rejects.toThrow('앞당길 시간을 골라 주세요');
    expect((await getSuggestion('s1'))?.status).toBe('PENDING');
  });

  it('무시 → 다시 보기', async () => {
    await ignoreSuggestion('s1');
    expect(suggestionPhase((await getSuggestion('s1'))?.status ?? 'PENDING')).toBe('ignored');
    expect(await getPendingSuggestion()).toBeNull();
    await reopenSuggestion('s1');
    expect((await getSuggestion('s1'))?.status).toBe('PENDING');
  });

  it('직접 수정은 5분 단위 0~30분', () => {
    expect(stepMinutes(10, 5)).toBe(15);
    expect(stepMinutes(5, -5)).toBe(0);
    expect(stepMinutes(0, -5)).toBe(0);
    expect(stepMinutes(EDIT_MAX, 5)).toBe(EDIT_MAX);
  });
});
