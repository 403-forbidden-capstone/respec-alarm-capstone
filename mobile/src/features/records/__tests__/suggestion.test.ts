import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { kst } from '@/mocks/data';

import { EDIT_MAX, EDIT_STEP, editBounds, previewTimes, shiftLog, shiftText, stepMinutes, suggestionPhase } from '../suggestion';

describe('S01 직접 수정 (D53)', () => {
  const both = { earlier: 30, later: 30 };

  it('1분 단위로 앞(일찍 +)뒤(늦게 −)', () => {
    expect(EDIT_STEP).toBe(1);
    expect(stepMinutes(10, 1, both)).toBe(11);
    expect(stepMinutes(10, -1, both)).toBe(9);
    expect(stepMinutes(0, -1, both)).toBe(-1); // 0을 넘어 늦추는 쪽으로
    expect(stepMinutes(-1, 1, both)).toBe(0);
  });

  it('끝에서 멈춤', () => {
    expect(stepMinutes(EDIT_MAX, 1, both)).toBe(EDIT_MAX);
    expect(stepMinutes(-EDIT_MAX, -1, both)).toBe(-EDIT_MAX);
    expect(stepMinutes(0, -1, { earlier: 30, later: 0 })).toBe(0); // 늦출 수 없는 일정
    expect(stepMinutes(-3, -1, { earlier: 30, later: 5 })).toBe(-4);
    expect(stepMinutes(-5, -1, { earlier: 30, later: 5 })).toBe(-5);
  });

  it('늦추는 쪽은 준비 알람이 출발을 넘지 않게 — 기상 ≤ 준비 ≤ 출발', () => {
    expect(editBounds(40, 10)).toEqual({ earlier: 30, later: 30 }); // 수업: 준비 40분 · 기상 뒤 10분에 준비 알람
    expect(editBounds(15, 10)).toEqual({ earlier: 30, later: 5 });
    expect(editBounds(10, 10)).toEqual({ earlier: 30, later: 0 });
    expect(editBounds(5, 10)).toEqual({ earlier: 30, later: 0 }); // 음수로 내려가지 않음
    expect(editBounds(100, 0)).toEqual({ earlier: 30, later: 30 }); // 준비 알람이 없으면 30분 한도만
  });

  it('미리 보기: 기상 · 준비는 같이 움직이고 출발은 그대로', () => {
    const base = { currentWake: kst(23, 440), currentPrepare: kst(23, 450), depart: kst(23, 480) };
    const show = (minutes: number) => {
      const p = previewTimes(base, minutes);
      return [formatTime(p.wake), p.prepare && formatTime(p.prepare), formatTime(p.depart)];
    };
    expect(show(10)).toEqual(['오전 7:10', '오전 7:20', '오전 8:00']);
    expect(show(-5)).toEqual(['오전 7:25', '오전 7:35', '오전 8:00']);
    expect(show(0)).toEqual(['오전 7:20', '오전 7:30', '오전 8:00']);
    expect(previewTimes({ ...base, currentPrepare: null }, 3).prepare).toBeNull(); // 준비 알람이 없는 일정
  });

  it('글자: 일찍 · 늦게 / 앞당김 · 늦춤', () => {
    expect([shiftText(10), shiftText(-5), shiftText(1), shiftText(0)]).toEqual(['10분 일찍', '5분 늦게', '1분 일찍', '그대로']);
    expect([shiftLog(10), shiftLog(-5)]).toEqual(['10분 앞당김', '5분 늦춤']);
  });

  it('화면 모양: 적용(APPLIED · 직접 고침 EDITED)이면 다시 수정 · 되돌리기 화면', () => {
    expect(['PENDING', 'APPLIED', 'EDITED', 'IGNORED'].map((s) => suggestionPhase(s as Parameters<typeof suggestionPhase>[0]))).toEqual([
      'pending',
      'applied',
      'applied',
      'ignored',
    ]);
  });
});
