import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { AppState, type AppStateStatus } from 'react-native';

import { isWakeStale, pollWhileActive, watchForeground, watchGroupWake, WAKE_POLL_MS } from '../hooks/useGroupWake';

// 기상 신호 → 화면 다시 읽기. lib/realtime(subscribeGroupWake)은 가짜로 — 채널 자체는 lib/__tests__/realtime.test.ts
type Listener = (signal: { date: string | null }) => void;
type Status = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';
const mockListeners = new Map<string, Listener>();
const mockStatus = new Map<string, (status: Status) => void>();
const mockUnsubscribed: string[] = [];
jest.mock('@/lib/realtime', () => ({
  subscribeGroupWake: (groupId: string, listener: Listener, onStatus?: (status: Status) => void) => {
    mockListeners.set(groupId, listener);
    if (onStatus) mockStatus.set(groupId, onStatus);
    return () => {
      mockListeners.delete(groupId);
      mockStatus.delete(groupId);
      mockUnsubscribed.push(groupId);
    };
  },
}));
// 훅 파일이 lib/mode · useLoad(expo-router)를 불러옴 — watchGroupWake는 쓰지 않으니 가볍게 막음
jest.mock('@/lib/mode', () => ({ useMode: () => ({ mode: 'real', ready: true }) }));
jest.mock('@/lib/useLoad', () => ({ useLoad: jest.fn() }));
jest.mock('@/lib/alarmSync', () => ({ afterEvent: jest.fn() }));

// 앱이 앞에 오는 것(AppState) — 바꾼 상태를 시험이 직접 보냄
const appListeners = new Set<(s: AppStateStatus) => void>();
const signal = (groupId: string, date: string | null) => mockListeners.get(groupId)?.({ date });

beforeEach(() => {
  jest.useFakeTimers();
  mockListeners.clear();
  mockStatus.clear();
  mockUnsubscribed.length = 0;
  appListeners.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appListeners.add(listener as (s: AppStateStatus) => void);
    return { remove: () => appListeners.delete(listener as (s: AppStateStatus) => void) } as ReturnType<typeof AppState.addEventListener>;
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('watchGroupWake — 3초 뒤 한 번 더 (약속 변경 · 취소는 알람 재계산이 늦게 옴)', () => {
  it('신호 뒤 읽고, 3초 뒤 같은 날짜로 한 번 더', () => {
    const onRefresh = jest.fn<(date: string | null) => void>();
    watchGroupWake(['g1'], onRefresh);
    signal('g1', '2026-10-20');
    jest.advanceTimersByTime(400);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2999);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenLastCalledWith('2026-10-20');
    jest.advanceTimersByTime(10_000);
    expect(onRefresh).toHaveBeenCalledTimes(2); // 더는 없음
  });

  it('신호가 연달아 오면 뒤 읽기는 하나로 묶음', () => {
    const onRefresh = jest.fn<(date: string | null) => void>();
    watchGroupWake(['g1'], onRefresh);
    signal('g1', null);
    jest.advanceTimersByTime(400); // 첫 읽기
    jest.advanceTimersByTime(1000);
    signal('g1', null); // 뒤 읽기를 기다리는 중에 새 신호
    jest.advanceTimersByTime(400); // 두 번째 읽기
    expect(onRefresh).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(10_000);
    expect(onRefresh).toHaveBeenCalledTimes(3); // 뒤 읽기는 한 번뿐
  });

  it('끊으면 기다리던 뒤 읽기도 취소 · 재연결 읽기에는 뒤 읽기 없음', () => {
    const onRefresh = jest.fn<(date: string | null) => void>();
    const stop = watchGroupWake(['g1'], onRefresh);
    signal('g1', null);
    jest.advanceTimersByTime(400);
    stop();
    jest.advanceTimersByTime(10_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const again = jest.fn<(date: string | null) => void>();
    watchGroupWake(['g2'], again);
    mockStatus.get('g2')?.('SUBSCRIBED');
    mockStatus.get('g2')?.('CLOSED');
    mockStatus.get('g2')?.('SUBSCRIBED');
    jest.advanceTimersByTime(10_000);
    expect(again).toHaveBeenCalledTimes(1);
  });
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

// 7-30 — 실시간 연결이 끊겼다 돌아오면 · 앱이 앞에 올 때 다시 읽음 (신호를 놓쳤을 수 있으니)
describe('watchGroupWake — onSignal', () => {
  it('신호를 받을 때마다 부르고, 다시 연결해서 읽을 때는 안 부름', () => {
    const onSignal = jest.fn<() => void>();
    watchGroupWake(['g1'], jest.fn(), { onSignal });
    mockStatus.get('g1')?.('SUBSCRIBED');
    signal('g1', '2026-10-20');
    signal('g1', null);
    expect(onSignal).toHaveBeenCalledTimes(2);
    mockStatus.get('g1')?.('CLOSED');
    mockStatus.get('g1')?.('SUBSCRIBED');
    jest.advanceTimersByTime(10_000);
    expect(onSignal).toHaveBeenCalledTimes(2);
  });
});

describe('다시 연결 · 앱이 앞에 올 때 (7-30)', () => {
  const status = (groupId: string, s: Status) => mockStatus.get(groupId)?.(s);

  it('처음 연결은 다시 읽지 않고, 끊겼다 돌아오면 한 번 다시 읽음(날짜 없이 = 오늘)', () => {
    const onRefresh = jest.fn<(date: string | null) => void>();
    const onLink = jest.fn<(up: boolean) => void>();
    watchGroupWake(['g1'], onRefresh, { onLink });
    status('g1', 'SUBSCRIBED');
    jest.advanceTimersByTime(1000);
    expect(onRefresh).not.toHaveBeenCalled();
    status('g1', 'CHANNEL_ERROR');
    expect(onLink).toHaveBeenLastCalledWith(false);
    status('g1', 'SUBSCRIBED');
    expect(onLink).toHaveBeenLastCalledWith(true);
    jest.advanceTimersByTime(400);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith(null);
  });

  it('여러 그룹 중 하나라도 끊겨 있으면 끊김, 모두 돌아와야 연결됨', () => {
    const onLink = jest.fn<(up: boolean) => void>();
    watchGroupWake(['g1', 'g2'], jest.fn(), { onLink });
    status('g1', 'TIMED_OUT');
    status('g2', 'CLOSED');
    status('g1', 'SUBSCRIBED');
    expect(onLink).toHaveBeenLastCalledWith(false);
    status('g2', 'SUBSCRIBED');
    expect(onLink).toHaveBeenLastCalledWith(true);
  });

  it('앱이 뒤에 있다 앞에 오면 부름, 앞에 있는 동안의 같은 상태는 무시, 끊으면 그만', () => {
    const onActive = jest.fn();
    const stop = watchForeground(onActive);
    const send = (s: AppStateStatus) => appListeners.forEach((l) => l(s));
    send('active');
    expect(onActive).not.toHaveBeenCalled();
    send('background');
    send('active');
    expect(onActive).toHaveBeenCalledTimes(1);
    send('inactive');
    send('active');
    expect(onActive).toHaveBeenCalledTimes(2);
    stop();
    send('background');
    send('active');
    expect(onActive).toHaveBeenCalledTimes(2);
  });
});

// 7-36 — 오프라인이면 옛 값을 최신처럼 보이지 않음: 다시 읽기가 실패했거나 실시간이 끊겼으면 화면에 한 줄
describe('옛 값 표시 (7-36)', () => {
  it('값이 있는데 다시 읽기가 실패했거나 실시간이 끊겼으면 true, 처음 읽는 중 · 정상이면 false', () => {
    expect(isWakeStale({ hasData: true, error: new Error('offline'), linkUp: true })).toBe(true);
    expect(isWakeStale({ hasData: true, error: null, linkUp: false })).toBe(true);
    expect(isWakeStale({ hasData: true, error: null, linkUp: true })).toBe(false);
    expect(isWakeStale({ hasData: false, error: new Error('offline'), linkUp: false })).toBe(false); // 값이 없으면 오류 화면이 따로
  });
});

describe('pollWhileActive — 그룹 화면이 열려 있는 동안 1분마다 조용히 다시 읽음 (G6)', () => {
  const setAppState = (state: AppStateStatus) => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => state });
    appListeners.forEach((l) => l(state));
  };
  beforeEach(() => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => 'active' });
  });

  it('1분마다 부르고, 59초에는 아직 안 부름', () => {
    const tick = jest.fn();
    pollWhileActive(tick);
    jest.advanceTimersByTime(WAKE_POLL_MS - 1);
    expect(tick).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(WAKE_POLL_MS * 3);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('끊으면(화면을 떠나면) 멈추고 앱 상태 구독도 풀림', () => {
    const tick = jest.fn();
    const stop = pollWhileActive(tick);
    jest.advanceTimersByTime(WAKE_POLL_MS);
    stop();
    jest.advanceTimersByTime(WAKE_POLL_MS * 5);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(appListeners.size).toBe(0);
  });

  it('앱이 뒤로 가면 멈추고, 앞으로 오면 그 시점부터 다시 1분 (돌아온 순간에는 안 부름 — 그때 읽기는 watchForeground)', () => {
    const tick = jest.fn();
    pollWhileActive(tick);
    jest.advanceTimersByTime(WAKE_POLL_MS);
    setAppState('background');
    jest.advanceTimersByTime(WAKE_POLL_MS * 10);
    expect(tick).toHaveBeenCalledTimes(1); // 뒤에 있는 동안 0번
    setAppState('active');
    expect(tick).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(WAKE_POLL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    setAppState('inactive');
    jest.advanceTimersByTime(WAKE_POLL_MS * 2);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('처음부터 앱이 뒤에 있으면 앞으로 올 때까지 안 돎, 앞으로 와도 타이머는 하나만(여러 번 active가 와도 겹치지 않음)', () => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => 'background' });
    const tick = jest.fn();
    pollWhileActive(tick);
    jest.advanceTimersByTime(WAKE_POLL_MS * 2);
    expect(tick).not.toHaveBeenCalled();
    setAppState('active');
    setAppState('active');
    jest.advanceTimersByTime(WAKE_POLL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
