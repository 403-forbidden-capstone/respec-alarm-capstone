import { describe, expect, it } from '@jest/globals';

import { deleteConfirmCopy, editValueOf, isEditChanged, moveToast, needsScope, scopeWithoutAsking, toPatch, type ScheduleEditValue } from '../editSheet';

const at = new Date('2026-10-29T10:00:00+09:00');
const initial: ScheduleEditValue = { title: '팀 주간회의', at, place: '세종대학교', repeatDays: ['목'], importance: 'NORMAL' };

describe('H03 일정 편집 시트 — 값', () => {
  it('일정에서 시트의 처음 값을 만듦 (반복 규칙은 요일로)', () => {
    expect(editValueOf({ title: '수업', at, place: '강의동', importance: 'LOW', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE' })).toEqual({
      title: '수업',
      at,
      place: '강의동',
      repeatDays: ['월', '수'],
      importance: 'LOW',
    });
    expect(editValueOf({ title: '수업', at, place: '강의동', importance: 'LOW', recurrenceRule: null }).repeatDays).toEqual([]);
  });

  it('바뀐 게 없으면 저장을 흐리게 — 제목 앞뒤 공백 · 요일을 누른 순서는 바뀐 것이 아님', () => {
    expect(isEditChanged(initial, { ...initial })).toBe(false);
    expect(isEditChanged(initial, { ...initial, title: ' 팀 주간회의 ' })).toBe(false);
    expect(isEditChanged(initial, { ...initial, at: new Date(at.getTime()) })).toBe(false);
    expect(isEditChanged({ ...initial, repeatDays: ['월', '수'] }, { ...initial, repeatDays: ['수', '월'] })).toBe(false);
  });

  it('한 칸이라도 바뀌면 바뀐 것', () => {
    expect(isEditChanged(initial, { ...initial, title: '팀 회의' })).toBe(true);
    expect(isEditChanged(initial, { ...initial, at: new Date(at.getTime() + 60_000) })).toBe(true);
    expect(isEditChanged(initial, { ...initial, place: '강남역' })).toBe(true);
    expect(isEditChanged(initial, { ...initial, importance: 'HIGH' })).toBe(true);
    expect(isEditChanged(initial, { ...initial, repeatDays: [] })).toBe(true);
  });

  it('patch에는 바뀐 칸만 — 장소는 새로 골랐을 때만 좌표도 함께', () => {
    expect(toPatch(initial, { ...initial })).toEqual({});
    expect(toPatch(initial, { ...initial, title: ' 팀 회의 ', importance: 'HIGH' })).toEqual({ title: '팀 회의', importance: 'HIGH' });
    expect(toPatch(initial, { ...initial, place: '강남역', placeLat: 37.5, placeLng: 127 })).toEqual({ place: '강남역', placeLat: 37.5, placeLng: 127 });
    expect(toPatch(initial, { ...initial, place: '강남역' })).toEqual({ place: '강남역' });
    expect(toPatch(initial, { ...initial, repeatDays: [] })).toEqual({ repeatDays: [] });
  });

  it('되돌리기 patch = 값을 거꾸로 비교한 것 (이전 값으로)', () => {
    const edited: ScheduleEditValue = { ...initial, title: '팀 회의', at: new Date(at.getTime() - 20 * 60_000) };
    expect(toPatch(edited, initial)).toEqual({ title: '팀 주간회의', at });
  });
});

describe('H03 일정 편집 시트 — 반복 범위', () => {
  it('반복 일정이면 범위를 먼저 물음, 반복이 아니면 안 물음', () => {
    expect(needsScope(true)).toBe(true);
    expect(needsScope(false)).toBe(false);
  });

  it('반복 요일을 바꾸는 저장은 묻지 않고 이후 모두 — 요일은 이번만에 먹지 않는 값', () => {
    expect(needsScope(true, { title: '팀 회의' })).toBe(true);
    expect(needsScope(true, { repeatDays: ['월'] })).toBe(false);
    expect(needsScope(true, { repeatDays: [] })).toBe(false);
    expect(scopeWithoutAsking({ repeatDays: [] })).toBe('following');
    expect(scopeWithoutAsking({ title: '팀 회의' })).toBe('this');
    expect(scopeWithoutAsking()).toBe('this');
  });
});

describe('H03 일정 편집 시트 — 문구', () => {
  it('지우기 확인 창 — 일반 · 공동 약속 · 반복 범위', () => {
    expect(deleteConfirmCopy({ shared: false, repeated: false })).toEqual({ title: '일정을 지울까요?', message: '지운 뒤 잠깐은 되돌릴 수 있어요', okLabel: '지우기' });
    expect(deleteConfirmCopy({ shared: true, repeated: false }).message).toBe('공동 약속이라 모두에게서 사라져요');
    expect(deleteConfirmCopy({ shared: false, repeated: true, scope: 'this' }).title).toBe('이번 일정을 지울까요?');
    expect(deleteConfirmCopy({ shared: false, repeated: true, scope: 'following' }).title).toBe('이후 일정을 모두 지울까요?');
  });

  it('알람 시각이 바뀌면 토스트에 첫 알람의 전 → 후, 더 있으면 외 n개', () => {
    const wake = { kind: 'WAKE' as const, from: new Date('2026-10-29T07:10:00+09:00'), to: new Date('2026-10-29T06:50:00+09:00') };
    const prepare = { kind: 'PREPARE' as const, from: new Date('2026-10-29T07:40:00+09:00'), to: new Date('2026-10-29T07:20:00+09:00') };
    expect(moveToast([wake])).toBe('알람 오전 7:10 → 오전 6:50');
    expect(moveToast([wake, prepare])).toBe('알람 오전 7:10 → 오전 6:50 외 1개');
    expect(moveToast([])).toBe('');
  });
});
