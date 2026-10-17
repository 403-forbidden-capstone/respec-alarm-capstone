import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { watchGroupWake } from '../hooks/useGroupWake';

// 기상 신호 → 화면 다시 읽기. lib/realtime(subscribeGroupWake)은 가짜로 — 채널 자체는 lib/__tests__/realtime.test.ts
type Listener = (signal: { date: string | null }) => void;
const mockListeners = new Map<string, Listener>();
const mockUnsubscribed: string[] = [];
jest.mock('@/lib/realtime', () => ({
  subscribeGroupWake: (groupId: string, listener: Listener) => {
    mockListeners.set(groupId, listener);
    return () => {
      mockListeners.delete(groupId);
      mockUnsubscribed.push(groupId);
    };
  },
}));
// 훅 파일이 lib/mode · useLoad(expo-router)를 불러옴 — watchGroupWake는 쓰지 않으니 가볍게 막음
jest.mock('@/lib/mode', () => ({ useMode: () => ({ mode: 'real', ready: true }) }));
jest.mock('@/lib/useLoad', () => ({ useLoad: jest.fn() }));

const signal = (groupId: string, date: string | null) => mockListeners.get(groupId)?.({ date });

beforeEach(() => {
  jest.useFakeTimers();
  mockListeners.clear();
  mockUnsubscribed.length = 0;
});
afterEach(() => {
  jest.useRealTimers();
});

describe('watchGroupWake', () => {
  it('신호의 날짜를 그대로 넘겨 다시 읽게 함', () => {
    const onRefresh = jest.fn<(date: string | null) => void>();
    watchGroupWake(['g1'], onRefresh);
    signal('g1', '2026-10-20');
    expect(onRefresh).not.toHaveBeenCalled(); // 잠깐 모았다가
    jest.advanceTimersByTime(400);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('2026-10-20');
  });

  it('연달아 온 신호는 한 번만 — 마지막 날짜로 (날짜 없는 신호가 뒤에 와도 앞의 날짜를 지우지 않음)', () => {
    const onRefresh = jest.fn<(date: string | null) => void>();
    watchGroupWake(['g1', 'g2'], onRefresh);
    signal('g1', '2026-10-20');
    jest.advanceTimersByTime(100);
    signal('g2', null);
    jest.advanceTimersByTime(100);
    signal('g1', '2026-10-20');
    jest.advanceTimersByTime(400);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('2026-10-20');
    // 한 번 부른 뒤의 신호는 새 날짜로 다시 시작
    signal('g2', null);
    jest.advanceTimersByTime(400);
    expect(onRefresh).toHaveBeenLastCalledWith(null);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('여러 그룹을 각각 구독하고, 끊으면 모두 풀고 기다리던 읽기도 취소', () => {
    const onRefresh = jest.fn<(date: string | null) => void>();
    const stop = watchGroupWake(['g1', 'g2', 'g3'], onRefresh);
    expect([...mockListeners.keys()]).toEqual(['g1', 'g2', 'g3']);
    signal('g2', '2026-10-20');
    stop();
    expect(mockUnsubscribed).toEqual(['g1', 'g2', 'g3']);
    jest.advanceTimersByTime(1000);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('그룹이 없으면 아무것도 구독하지 않음', () => {
    const stop = watchGroupWake([], jest.fn());
    expect(mockListeners.size).toBe(0);
    stop();
  });
});
