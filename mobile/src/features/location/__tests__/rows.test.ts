import { describe, expect, it } from '@jest/globals';

import { kst } from '@/mocks/data';

import type { LocationDetection } from '../detections';
import { detectionKey, detectionLabel, erasedMessage, restoredMessage, sortDetections } from '../rows';

// 홈 감지 정정 줄의 글자 · 정렬 (순수)
describe('detectionLabel — 줄 글자', () => {
  it('"출발 오전 8:30 · 자동 감지" / "도착 오전 9:52 · 자동 감지"', () => {
    expect(detectionLabel('DEPART', kst(22, 510))).toBe('출발 오전 8:30 · 자동 감지');
    expect(detectionLabel('ARRIVE', kst(22, 592))).toBe('도착 오전 9:52 · 자동 감지');
    expect(detectionLabel('ARRIVE', kst(22, 13 * 60 + 5))).toBe('도착 오후 1:05 · 자동 감지');
  });

  it('지각 여부 같은 겁주는 말은 줄에 쓰지 않음 (D61)', () => {
    expect(detectionLabel('ARRIVE', kst(22, 592))).not.toMatch(/지각/);
  });
});

describe('토스트 문구', () => {
  it('지웠어요 · 되돌렸어요', () => {
    expect(erasedMessage('DEPART', kst(22, 510))).toBe('출발 오전 8:30 기록을 지웠어요');
    expect(restoredMessage('ARRIVE', kst(22, 592))).toBe('도착 오전 9:52 기록을 되돌렸어요');
  });
});

describe('sortDetections · detectionKey', () => {
  const dep = (id: string, minutes: number): LocationDetection => ({ participantId: id, kind: 'DEPART', at: kst(22, minutes), source: 'LOCATION', settled: true, isLate: null });
  const arr = (id: string, minutes: number): LocationDetection => ({ participantId: id, kind: 'ARRIVE', at: kst(22, minutes), source: 'LOCATION', settled: true, isLate: false });

  it('시각순, 같은 시각이면 출발이 먼저 — 원본은 그대로', () => {
    const list = [arr('a', 592), dep('b', 800), dep('a', 510), arr('b', 800)];
    expect(sortDetections(list).map((d) => `${d.kind}:${d.participantId}`)).toEqual(['DEPART:a', 'ARRIVE:a', 'DEPART:b', 'ARRIVE:b']);
    expect(list[0].participantId).toBe('a');
    expect(list[0].kind).toBe('ARRIVE');
  });

  it('키는 종류 · 참여 조건 · 시각이 모두 같아야 같음', () => {
    expect(detectionKey(dep('a', 510))).toBe(detectionKey(dep('a', 510)));
    expect(detectionKey(dep('a', 510))).not.toBe(detectionKey(dep('a', 511)));
    expect(detectionKey(dep('a', 510))).not.toBe(detectionKey(arr('a', 510)));
    expect(detectionKey(dep('a', 510))).not.toBe(detectionKey(dep('b', 510)));
  });
});
