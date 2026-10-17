import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { readWakeSignal, subscribeGroupWake, unsubscribeAll, wakeChannelName } from '../realtime';

// 가짜 Realtime 채널 — 구독 설정(비공개 · 이벤트 이름)과 신호 전달, 채널 하나 공유, 끊기를 확인
type Broadcast = { payload: unknown };
class MockChannel {
  name: string;
  config: unknown;
  handlers: { filter: { event: string }; callback: (message: Broadcast) => void }[] = [];
  subscribed = 0;
  statusCallback: ((status: string) => void) | null = null;
  constructor(name: string, config: unknown) {
    this.name = name;
    this.config = config;
  }
  on(_type: string, filter: { event: string }, callback: (message: Broadcast) => void) {
    this.handlers.push({ filter, callback });
    return this;
  }
  subscribe(callback: (status: string) => void) {
    this.subscribed += 1;
    this.statusCallback = callback;
    return this;
  }
  emit(event: string, payload: unknown) {
    this.handlers.filter((h) => h.filter.event === event).forEach((h) => h.callback({ payload }));
  }
}

const mockChannels: MockChannel[] = [];
const mockSetAuth = jest.fn<(token: string) => Promise<void>>();
const mockRemoveChannel = jest.fn<(channel: MockChannel) => Promise<string>>();
let mockSession: { access_token: string } | null = { access_token: 'token-1' };
jest.mock('../supabase', () => ({
  supabase: {
    channel: (name: string, options: unknown) => {
      const channel = new MockChannel(name, options);
      mockChannels.push(channel);
      return channel;
    },
    removeChannel: (channel: MockChannel) => mockRemoveChannel(channel),
    realtime: { setAuth: (token: string) => mockSetAuth(token) },
    auth: { getSession: async () => ({ data: { session: mockSession } }) },
  },
}));

const GROUP = '3f2b1c0e-5a4d-4e8f-9b7a-1c2d3e4f5a6b';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  unsubscribeAll();
  mockChannels.length = 0;
  jest.clearAllMocks();
  mockSession = { access_token: 'token-1' };
  mockSetAuth.mockResolvedValue();
  mockRemoveChannel.mockResolvedValue('ok');
});

describe('기상 신호 읽기', () => {
  it('payload에서 date만 읽음 — 실제 Realtime이 붙이는 id는 무시', () => {
    expect(readWakeSignal({ date: '2026-10-20', id: 'b9c1c7a0-0000-0000-0000-000000000000' })).toEqual({ date: '2026-10-20' });
  });

  it('모양이 다르면 date 없음 (오늘 것을 다시 읽으면 됨)', () => {
    for (const payload of [null, undefined, 'x', {}, { date: 20261020 }, { date: '10/20' }, { date: '2026-10-20T00:00:00Z' }]) {
      expect(readWakeSignal(payload)).toEqual({ date: null });
    }
  });
});

describe('그룹 기상 신호 구독', () => {
  it('토큰을 넘긴 뒤 비공개 채널 group:<id>:wake를 구독하고 refresh 신호를 콜백으로 전달', async () => {
    const onRefresh = jest.fn<(signal: { date: string | null }) => void>();
    subscribeGroupWake(GROUP, onRefresh);
    await flush();
    expect(mockSetAuth).toHaveBeenCalledWith('token-1');
    expect(mockChannels).toHaveLength(1);
    expect(mockChannels[0].name).toBe(wakeChannelName(GROUP));
    expect(wakeChannelName(GROUP)).toBe(`group:${GROUP}:wake`);
    expect(mockChannels[0].config).toEqual({ config: { private: true } });
    expect(mockChannels[0].subscribed).toBe(1);

    mockChannels[0].emit('refresh', { date: '2026-10-20', id: 'x' });
    mockChannels[0].emit('다른 이벤트', { date: '2026-10-21' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith({ date: '2026-10-20' });
  });

  it('같은 그룹을 여러 곳이 구독해도 채널은 하나, 마지막이 풀면 채널을 닫음', async () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = subscribeGroupWake(GROUP, a);
    const offB = subscribeGroupWake(GROUP, b);
    await flush();
    expect(mockChannels).toHaveLength(1);
    expect(mockChannels[0].subscribed).toBe(1);

    mockChannels[0].emit('refresh', { date: '2026-10-20' });
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);

    offA();
    expect(mockRemoveChannel).not.toHaveBeenCalled();
    mockChannels[0].emit('refresh', { date: '2026-10-20' });
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 2]);

    offB();
    expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannels[0]);
    subscribeGroupWake(GROUP, a); // 닫은 뒤 다시 구독하면 새 채널
    await flush();
    expect(mockChannels).toHaveLength(2);
  });

  it('토큰을 기다리는 동안 구독을 풀면 구독하지 않음', async () => {
    const off = subscribeGroupWake(GROUP, jest.fn());
    off();
    await flush();
    expect(mockChannels[0].subscribed).toBe(0);
    expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
  });

  it('로그인 정보가 없어도 부르기는 함 (서버가 막으면 상태로 알려 줌)', async () => {
    mockSession = null;
    const onStatus = jest.fn<(status: string) => void>();
    subscribeGroupWake(GROUP, jest.fn(), onStatus);
    await flush();
    expect(mockSetAuth).not.toHaveBeenCalled();
    mockChannels[0].statusCallback?.('CHANNEL_ERROR');
    expect(onStatus).toHaveBeenCalledWith('CHANNEL_ERROR');
  });

  it('unsubscribeAll은 모든 그룹의 구독을 끊음 (로그아웃 정리)', async () => {
    const onRefresh = jest.fn();
    subscribeGroupWake(GROUP, onRefresh);
    subscribeGroupWake('other-group', jest.fn());
    await flush();
    unsubscribeAll();
    expect(mockRemoveChannel).toHaveBeenCalledTimes(2);
    mockChannels[0].emit('refresh', { date: '2026-10-20' });
    expect(onRefresh).not.toHaveBeenCalled(); // 끊은 뒤에는 콜백이 안 불림
    unsubscribeAll(); // 두 번 불러도 안전
    expect(mockRemoveChannel).toHaveBeenCalledTimes(2);
  });
});
