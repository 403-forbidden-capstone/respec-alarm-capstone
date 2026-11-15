import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { breakerOpen, claimServerAttempt, recordServerFailure, recordServerSuccess, resetEdgeRoutes, routeFor, serverBaseUrl } from '../edgeRoutes';

// 가짜 supabase — 세션(로그인한 사용자) · get_server_routes RPC
type Rows = { name: string; mode: string }[];
const mockGetSession = jest.fn<() => Promise<{ data: { session: { user: { id: string } } | null } }>>();
const mockRpc = jest.fn<(name: string) => Promise<{ data: Rows | null; error: unknown }>>();
jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: () => mockGetSession() }, rpc: (name: string) => mockRpc(name) },
}));

const BASE = 'https://api.example.test';
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const withSession = (id = 'user-1') => mockGetSession.mockResolvedValue({ data: { session: { user: { id } } } });

beforeEach(() => {
  jest.useFakeTimers();
  mockGetSession.mockReset();
  mockRpc.mockReset();
  resetEdgeRoutes();
  process.env.EXPO_PUBLIC_API_BASE_URL = BASE;
  withSession();
});

afterEach(() => {
  jest.useRealTimers();
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

describe('서버 주소 (serverBaseUrl) — 빌드에 고정된 https 주소 하나만', () => {
  it('https 주소는 origin만 받고 끝의 / 는 뺌', () => {
    expect(serverBaseUrl('https://api.respecalarm.com')).toBe('https://api.respecalarm.com');
    expect(serverBaseUrl('  https://api.respecalarm.com/  ')).toBe('https://api.respecalarm.com');
    expect(serverBaseUrl('https://api.example.test:8443')).toBe('https://api.example.test:8443');
  });

  it.each([
    ['비었음', ''],
    ['없음', undefined],
    ['http', 'http://api.respecalarm.com'],
    ['경로가 붙음', 'https://api.respecalarm.com/fn'],
    ['쿼리', 'https://api.respecalarm.com?x=1'],
    ['해시', 'https://api.respecalarm.com#x'],
    ['사용자 정보(토큰이 남의 주소로 가는 모양)', 'https://user:pw@api.respecalarm.com'],
    ['주소가 아님', 'api.respecalarm.com'],
    ['다른 방식', 'ftp://api.respecalarm.com'],
  ])('%s → 서버를 쓰지 않음(null)', (_label, raw) => {
    expect(serverBaseUrl(raw)).toBeNull();
  });
});

describe('함수별 길 (routeFor) — 표 get_server_routes()', () => {
  it('표의 server만 server, edge · 모르는 값 · 표에 없는 함수는 edge', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { name: 'place-search', mode: 'server' },
        { name: 'place-reverse', mode: 'edge' },
        { name: 'alarm-commit', mode: 'canary' }, // RPC가 canary를 풀어서 주므로 오지 않지만, 와도 edge
        { name: 'alarm-suggest', mode: '엉뚱한 값' },
      ],
      error: null,
    });
    expect(await routeFor('place-search')).toBe('server');
    expect(await routeFor('place-reverse')).toBe('edge');
    expect(await routeFor('alarm-commit')).toBe('edge');
    expect(await routeFor('alarm-suggest')).toBe('edge');
    expect(await routeFor('표에 없는 함수')).toBe('edge');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('get_server_routes');
  });

  it('서버 주소가 없거나 https가 아니면 표를 묻지도 않고 edge', async () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    expect(await routeFor('place-search')).toBe('edge');
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.example.test';
    expect(await routeFor('place-search')).toBe('edge');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('로그인이 없으면 edge (표는 로그인한 뒤에만 읽음)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    expect(await routeFor('place-search')).toBe('edge');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('표를 못 읽으면(오류 · 모양이 이상함 · 예외) 전부 edge', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await routeFor('place-search')).toBe('edge');
    resetEdgeRoutes();
    mockRpc.mockResolvedValueOnce({ data: { not: 'array' } as unknown as Rows, error: null });
    expect(await routeFor('place-search')).toBe('edge');
    resetEdgeRoutes();
    mockRpc.mockRejectedValueOnce(new Error('network'));
    expect(await routeFor('place-search')).toBe('edge');
    mockGetSession.mockRejectedValueOnce(new Error('세션 읽기 실패'));
    resetEdgeRoutes();
    expect(await routeFor('place-search')).toBe('edge');
  });

  it('표를 읽는 데 3초가 넘으면 포기하고 edge', async () => {
    mockRpc.mockReturnValue(new Promise(() => {})); // 끝나지 않음
    const pending = routeFor('place-search');
    await jest.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBe('edge');
  });

  it('5분 동안은 다시 안 읽고, 5분이 지나면 다시 읽음', async () => {
    mockRpc.mockResolvedValue({ data: [{ name: 'place-search', mode: 'server' }], error: null });
    expect(await routeFor('place-search')).toBe('server');
    await jest.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    expect(await routeFor('place-search')).toBe('server');
    expect(mockRpc).toHaveBeenCalledTimes(1);

    mockRpc.mockResolvedValue({ data: [{ name: 'place-search', mode: 'edge' }], error: null }); // 표를 edge로 되돌림
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await routeFor('place-search')).toBe('edge');
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('5분 뒤 다시 읽다가 실패하면 옛 값도 안 쓰고 edge', async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ name: 'place-search', mode: 'server' }], error: null });
    expect(await routeFor('place-search')).toBe('server');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    expect(await routeFor('place-search')).toBe('edge'); // 옛 캐시(server)를 쓰면 안 됨
  });

  it('읽기에 실패하면 30초는 다시 안 묻고(매 호출마다 지연 방지) 그 뒤 다시 읽어 회복', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    expect(await routeFor('place-search')).toBe('edge');
    await jest.advanceTimersByTimeAsync(29_000);
    expect(await routeFor('place-search')).toBe('edge');
    expect(mockRpc).toHaveBeenCalledTimes(1);

    mockRpc.mockResolvedValue({ data: [{ name: 'place-search', mode: 'server' }], error: null });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await routeFor('place-search')).toBe('server');
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('사용자가 바뀌면 그 사람 기준으로 다시 읽음 (canary는 사람마다 다름)', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: [{ name: 'place-search', mode: 'server' }], error: null })
      .mockResolvedValueOnce({ data: [{ name: 'place-search', mode: 'edge' }], error: null });
    expect(await routeFor('place-search')).toBe('server');
    withSession('user-2');
    expect(await routeFor('place-search')).toBe('edge');
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('표를 읽는 도중 사용자가 바뀌면 늦게 끝난 앞 사용자의 결과가 새 사용자의 캐시를 덮어쓰지 않음', async () => {
    let resolveA!: (v: { data: Rows; error: null }) => void;
    mockRpc
      .mockReturnValueOnce(new Promise((r) => (resolveA = r))) // user-1 (늦게 끝남)
      .mockResolvedValueOnce({ data: [{ name: 'place-search', mode: 'server' }], error: null }); // user-2
    const first = routeFor('place-search'); // user-1이 읽는 중
    await jest.advanceTimersByTimeAsync(0);
    withSession('user-2');
    expect(await routeFor('place-search')).toBe('server'); // user-2 값
    resolveA({ data: [{ name: 'place-search', mode: 'edge' }], error: null }); // 뒤늦게 user-1 결과가 옴
    await first;
    expect(await routeFor('place-search')).toBe('server'); // user-2 캐시가 그대로 — 다시 읽지 않음
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('동시에 여러 호출이 와도 표는 한 번만 읽음', async () => {
    let resolve!: (v: { data: Rows; error: null }) => void;
    mockRpc.mockReturnValue(new Promise((r) => (resolve = r)));
    const all = Promise.all([routeFor('place-search'), routeFor('place-reverse'), routeFor('alarm-commit')]);
    await jest.advanceTimersByTimeAsync(0);
    resolve({ data: [{ name: 'place-search', mode: 'server' }], error: null });
    expect(await all).toEqual(['server', 'edge', 'edge']);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('차단기 — 서버가 연속 3번 실패하면 5분 동안 읽기 함수는 바로 Edge', () => {
  it('2번까지는 열리지 않고, 3번째에 5분간 열림, 5분 뒤 닫힘', async () => {
    recordServerFailure();
    recordServerFailure();
    expect(breakerOpen()).toBe(false);
    recordServerFailure();
    expect(breakerOpen()).toBe(true);
    await jest.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(breakerOpen()).toBe(true);
    await jest.advanceTimersByTimeAsync(2);
    expect(breakerOpen()).toBe(false);
  });

  it('성공하면 연속 횟수가 처음부터', () => {
    recordServerFailure();
    recordServerFailure();
    recordServerSuccess();
    recordServerFailure();
    recordServerFailure();
    expect(breakerOpen()).toBe(false);
  });

  it('닫힌 뒤 한 번 시험해 보고 또 실패하면 바로 다시 열림', async () => {
    for (let i = 0; i < 3; i++) recordServerFailure();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(breakerOpen()).toBe(false);
    recordServerFailure();
    expect(breakerOpen()).toBe(true);
  });
});

describe('차단기 — 5분 뒤에는 한 건만 서버로 시험하고 나머지는 결과가 나올 때까지 Edge', () => {
  const trip = () => {
    for (let i = 0; i < 3; i++) recordServerFailure();
  };

  it('닫혀 있으면 계속 통과', () => {
    expect(claimServerAttempt()).toBe(true);
    expect(claimServerAttempt()).toBe(true);
  });

  it('열려 있으면 막고, 5분이 지나면 첫 한 건만 통과(시험)하고 결과가 나올 때까지 나머지는 막음', async () => {
    trip();
    expect(claimServerAttempt()).toBe(false);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(claimServerAttempt()).toBe(true); // 시험 한 건
    expect(claimServerAttempt()).toBe(false);
    expect(claimServerAttempt()).toBe(false);
  });

  it('시험이 성공하면 닫혀서 다시 모두 통과', async () => {
    trip();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(claimServerAttempt()).toBe(true);
    recordServerSuccess();
    expect(claimServerAttempt()).toBe(true);
    expect(claimServerAttempt()).toBe(true);
  });

  it('시험이 실패하면 5분 더 막음', async () => {
    trip();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(claimServerAttempt()).toBe(true);
    expect(recordServerFailure()).toBe(true); // 다시 열림
    await jest.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    expect(claimServerAttempt()).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(claimServerAttempt()).toBe(true); // 또 한 건 시험
  });

  it('시험 결과가 기록되지 않아도(예외 등) 10초 뒤에는 다음 한 건이 다시 시험', async () => {
    trip();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(claimServerAttempt()).toBe(true);
    await jest.advanceTimersByTimeAsync(9_000);
    expect(claimServerAttempt()).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(claimServerAttempt()).toBe(true);
  });

  it('recordServerFailure는 닫혀 있다가 열린 순간(또는 시험이 실패한 순간)에만 true', () => {
    expect(recordServerFailure()).toBe(false);
    expect(recordServerFailure()).toBe(false);
    expect(recordServerFailure()).toBe(true); // 3번째에 열림
    expect(recordServerFailure()).toBe(false); // 이미 열려 있음 — 로그를 또 남기지 않게
  });
});
