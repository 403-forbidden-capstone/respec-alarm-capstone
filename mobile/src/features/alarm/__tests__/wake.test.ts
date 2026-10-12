import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { kst } from '@/mocks/data';

import { thetaReachedAt, usedMinutes, usageSummary, type UseSpan } from '../wake';

const dismissed = kst(22, 480); // 오전 8:00에 해제
const demo: UseSpan[] = [
  [0.5, 1.5],
  [2.5, 3.3],
  [6, 7],
  [8.6, 9],
]; // 시연: 폰을 보며 일어남

describe('H08 화면 사용 합', () => {
  it('시연 구간 = 누적 3.2분 · 뒤쪽 5분 1.4분 (목업 simUse)', () => {
    expect(usageSummary(demo)).toEqual({ usage: 3.2, recent: 1.4 });
  });

  it('구간이 걸치면 걸친 만큼만 셈', () => {
    expect(usedMinutes([[4, 6]], 5, 10)).toBe(1);
    expect(usedMinutes([[9, 12]], 0, 10)).toBe(1); // 관찰 10분 뒤는 안 셈
  });

  it('겹치는 구간은 한 번만, 순서가 섞여도 같음', () => {
    expect(usedMinutes([[2, 4], [1, 3]], 0, 10)).toBe(3);
  });

  it('사용이 없으면 0', () => {
    expect(usageSummary([])).toEqual({ usage: 0, recent: 0 });
  });
});

describe('H08 기상 확정 시각 = 누적 사용이 θ를 넘은 시각 (D14)', () => {
  it('θ 1분이면 첫 구간이 끝나는 해제 1.5분 뒤', () => {
    const at = thetaReachedAt(dismissed, demo, 1);
    expect(at!.getTime() - dismissed.getTime()).toBe(90_000);
    expect(formatTime(at!)).toBe('오전 8:01'); // 초는 버림
  });

  it('θ 2분이면 셋째 구간에서 넘음 (1 + 0.8 + 0.2 → 해제 6.2분 뒤)', () => {
    const at = thetaReachedAt(dismissed, demo, 2);
    expect(at!.getTime() - dismissed.getTime()).toBeCloseTo(6.2 * 60_000, -1);
  });

  it('θ가 누적 사용보다 크면 null', () => {
    expect(thetaReachedAt(dismissed, demo, 3.5)).toBeNull();
    expect(thetaReachedAt(dismissed, [], 1)).toBeNull();
  });

  it('관찰 10분 뒤 사용은 안 셈', () => {
    expect(thetaReachedAt(dismissed, [[9.5, 12]], 1)).toBeNull();
    expect(thetaReachedAt(dismissed, [[9.5, 12]], 0.5)!.getTime() - dismissed.getTime()).toBe(600_000);
  });

  it('구간 순서가 섞여도 이른 구간부터 셈', () => {
    const at = thetaReachedAt(dismissed, [[3, 4], [1, 1.5]], 1);
    expect(at!.getTime() - dismissed.getTime()).toBe(3.5 * 60_000);
  });
});
