import { describe, expect, it } from '@jest/globals';

import { defaultDraft } from '@/features/alarm/api';
import { defaultAlarms } from '@/features/alarm/types';
import { dayKey } from '@/lib/format';

import type { ClassRow } from '../components/TimetableStep';
import { firstDate, rowStatus, toDraft } from '../timetable';

const row = (patch: Partial<ClassRow> = {}): ClassRow => ({ id: 'r1', name: '', days: [], startMinutes: null, place: '', ...patch });
const FULL = row({ name: '자료구조', days: ['월', '수'], startMinutes: 9 * 60 + 30, place: '공학관 301호' });

// 한국 시간 2026-10-30(금) hh:mm
const fri = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00+09:00`);
const kstDay = (key: string) => new Date(`${key}T00:00:00+09:00`);

describe('rowStatus', () => {
  it('모두 비면 empty', () => {
    expect(rowStatus(row())).toBe('empty');
    expect(rowStatus(row({ name: '  ' }))).toBe('empty');
  });

  it('과목 · 요일 · 시각 · 장소가 다 있으면 complete', () => {
    expect(rowStatus(FULL)).toBe('complete');
    expect(rowStatus(row({ ...FULL, startMinutes: 0 }))).toBe('complete'); // 0시도 고른 시각
  });

  it('그 사이는 partial — 하나라도 비었을 때', () => {
    expect(rowStatus(row({ name: '자료구조' }))).toBe('partial');
    expect(rowStatus(row({ days: ['월'] }))).toBe('partial');
    expect(rowStatus(row({ ...FULL, name: '' }))).toBe('partial');
    expect(rowStatus(row({ ...FULL, days: [] }))).toBe('partial');
    expect(rowStatus(row({ ...FULL, startMinutes: null }))).toBe('partial');
    expect(rowStatus(row({ ...FULL, place: '' }))).toBe('partial');
  });
});

describe('firstDate — 지금 이후 가장 가까운 수업 날', () => {
  it('오늘 요일이고 시각이 아직이면 오늘', () => {
    expect(firstDate(['금'], 10 * 60, fri('09:00'))).toEqual(kstDay('2026-10-30'));
  });

  it('오늘 요일이어도 시각이 지났으면(같은 시각 포함) 다음 주 같은 요일', () => {
    expect(firstDate(['금'], 10 * 60, fri('11:00'))).toEqual(kstDay('2026-11-06'));
    expect(firstDate(['금'], 10 * 60, fri('10:00'))).toEqual(kstDay('2026-11-06'));
  });

  it('요일이 여럿이면 가장 가까운 날', () => {
    expect(firstDate(['월', '수'], 9 * 60, fri('09:00'))).toEqual(kstDay('2026-11-02')); // 금 → 월
    expect(firstDate(['수', '목'], 9 * 60, fri('09:00'))).toEqual(kstDay('2026-11-04')); // 금 → 수
    expect(firstDate(['금', '월'], 9 * 60, fri('08:00'))).toEqual(kstDay('2026-10-30')); // 오늘이 더 가까움
    expect(firstDate(['금', '월'], 9 * 60, fri('12:00'))).toEqual(kstDay('2026-11-02')); // 오늘은 지났으니 월
  });

  it('일요일 경계 — 토 → 일, 일 → 월, 일요일 수업이 지난 일요일', () => {
    const sat = new Date('2026-10-31T12:00:00+09:00');
    const sun = new Date('2026-11-01T12:00:00+09:00');
    expect(firstDate(['일'], 9 * 60, sat)).toEqual(kstDay('2026-11-01'));
    expect(firstDate(['월'], 9 * 60, sun)).toEqual(kstDay('2026-11-02'));
    expect(firstDate(['일'], 9 * 60, sun)).toEqual(kstDay('2026-11-08'));
    expect(firstDate(['일'], 13 * 60, sun)).toEqual(kstDay('2026-11-01')); // 일요일 오후 수업이면 아직 오늘
  });

  it('자정 근처도 한국 시간 기준 (UTC로는 전날)', () => {
    // 한국 2026-11-02(월) 00:30 = UTC 11-01 15:30
    expect(firstDate(['월'], 9 * 60, new Date('2026-11-02T00:30:00+09:00'))).toEqual(kstDay('2026-11-02'));
  });

  it('요일이 비면 오늘', () => {
    expect(firstDate([], 9 * 60, fri('23:00'))).toEqual(kstDay('2026-10-30'));
  });
});

describe('toDraft — 수업 줄 → 일정 입력값', () => {
  const date = kstDay('2026-11-02');

  it('과목 · 날짜 · 시각 · 반복 요일 · 장소 · 좌표', () => {
    const draft = toDraft(FULL, { lat: 37.5, lng: 127.03 }, 'TRANSIT', date);
    expect(draft.title).toBe('자료구조');
    expect(dayKey(draft.date)).toBe('2026-11-02');
    expect(draft.time).toBe('09:30');
    expect(draft.repeat).toEqual(['월', '수']);
    expect(draft.place).toBe('공학관 301호');
    expect(draft.placeLat).toBe(37.5);
    expect(draft.placeLng).toBe(127.03);
    expect(draft.transport).toBe('TRANSIT');
  });

  it('요일은 월요일부터 정렬, 좌표 없는 장소는 좌표 없이', () => {
    const draft = toDraft({ ...FULL, days: ['금', '월'], startMinutes: 8 * 60 }, undefined, 'WALK', date);
    expect(draft.repeat).toEqual(['월', '금']);
    expect(draft.time).toBe('08:00');
    expect(draft.placeLat).toBeUndefined();
    expect(draft.placeLng).toBeUndefined();
    expect(draft.transport).toBe('WALK');
  });

  it('중요도 · 준비물 · 알람은 새 일정 화면(H05)의 기본 입력값 그대로', () => {
    const base = defaultDraft(date);
    const draft = toDraft(FULL, undefined, 'TRANSIT', date);
    expect(draft.importance).toBe(base.importance);
    expect(draft.items).toBe(base.items);
    expect(draft.alarms).toEqual(defaultAlarms());
  });

  it('덜 채운 줄은 일정으로 못 바꿈', () => {
    expect(() => toDraft(row({ name: '자료구조' }), undefined, 'TRANSIT', date)).toThrow();
  });
});
