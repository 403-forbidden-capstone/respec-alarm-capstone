import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { callEdge, EDGE_MESSAGES } from '../edge';
import { breakerOpen, resetEdgeRoutes } from '../edgeRoutes';

// callEdge가 표가 server라고 한 함수를 우리 서버(fetch)로 부르는 길 — 표 읽기는 진짜 edgeRoutes, supabase만 가짜
type Rows = { name: string; mode: string }[];
const mockInvoke = jest.fn<(name: string, options: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>();
const mockGetSession = jest.fn<() => Promise<{ data: { session: { user: { id: string }; access_token: string } | null } }>>();
const mockRefresh = jest.fn<() => Promise<{ data: { session: { access_token: string } | null }; error: unknown }>>();
const mockRpc = jest.fn<(name: string) => Promise<{ data: Rows | null; error: unknown }>>();
jest.mock('../supabase', () => ({
  supabase: {
    functions: { invoke: (name: string, options: Record<string, unknown>) => mockInvoke(name, options) },
    auth: { getSession: () => mockGetSession(), refreshSession: () => mockRefresh() },
    rpc: (name: string) => mockRpc(name),
  },
}));

// fetch가 돌려주는 Response와 같은 모양 (본문은 text()로 읽음 — 서버가 JSON이 아닌 본문을 줄 수도 있어서)
type FakeResponse = { status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> };
function reply(status: number, body?: unknown, options: { raw?: string; requestId?: string } = {}): FakeResponse {
  const text = options.raw ?? (body === undefined ? '' : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === 'x-request-id' ? (options.requestId ?? 'req-s') : null) },
    text: async () => text,
  };
}
const serverError = (status: number, code: string, details?: unknown) =>
  reply(status, { error: details === undefined ? { code, message: '서버가 쓴 문구' } : { code, message: '서버가 쓴 문구', details } });

const mockFetch = jest.fn<(url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<FakeResponse>>();
const BASE = 'https://api.example.test';
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const originalFetch = global.fetch;
let warn: ReturnType<typeof jest.spyOn>;

const ROUTES: Rows = [
  { name: 'place-search', mode: 'server' }, // 읽기 함수 → 서버 실패 시 Edge로 대체
  { name: 'place-reverse', mode: 'server' },
  { name: 'alarm-commit', mode: 'server' }, // 쓰기 함수 → 대체 없음
  { name: 'alarm-roll', mode: 'edge' },
];

// 서버가 응답하지 않는 상태 — 시간 초과(AbortController)까지 흉내
function neverResponds() {
  mockFetch.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  for (const m of [mockInvoke, mockGetSession, mockRefresh, mockRpc, mockFetch]) m.mockReset();
  resetEdgeRoutes();
  process.env.EXPO_PUBLIC_API_BASE_URL = BASE;
  global.fetch = mockFetch as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' }, access_token: 'token-1' } } });
  mockRefresh.mockResolvedValue({ data: { session: { access_token: 'token-2' } }, error: null });
  mockRpc.mockResolvedValue({ data: ROUTES, error: null });
  mockInvoke.mockResolvedValue({ data: { from: 'edge' }, error: null });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  warn.mockRestore();
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

describe('표가 edge이거나 서버를 못 쓰는 상태 — 기존 동작 그대로', () => {
  it('표의 값이 edge면 Edge로만 부르고 서버는 안 부름', async () => {
    await expect(callEdge('alarm-roll', { a: 1 })).resolves.toEqual({ from: 'edge' });
    expect(mockInvoke).toHaveBeenCalledWith('alarm-roll', { body: { a: 1 }, headers: undefined, timeout: 20_000 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('표를 못 읽으면 전부 Edge', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    await expect(callEdge('place-search', { query: '세종' })).resolves.toEqual({ from: 'edge' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('서버 주소가 없으면 표도 안 읽고 Edge', async () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    await expect(callEdge('place-search', {})).resolves.toEqual({ from: 'edge' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('서버 길 — 요청 모양', () => {
  it('POST {주소}/fn/{이름}, 로그인 토큰 · JSON 본문, 응답을 그대로 돌려줌 (Edge는 안 부름)', async () => {
    mockFetch.mockResolvedValue(reply(200, { places: [{ name: '세종대왕' }] }));
    await expect(callEdge('place-search', { query: '세종' })).resolves.toEqual({ places: [{ name: '세종대왕' }] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/fn/place-search`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ query: '세종' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('본문이 없으면 {}를 보내고, 중복 막는 키는 Idempotency-Key 헤더로', async () => {
    mockFetch.mockResolvedValue(reply(200, { ok: true }));
    await callEdge('alarm-commit', undefined, { idempotencyKey: 'key-1' });
    const init = mockFetch.mock.calls[0][1];
    expect(init.body).toBe('{}');
    expect(init.headers['Idempotency-Key']).toBe('key-1');
  });

  it('응답 본문이 비어 있으면 undefined', async () => {
    mockFetch.mockResolvedValue(reply(200));
    await expect(callEdge('alarm-commit', {})).resolves.toBeUndefined();
  });

  it('호출마다 현재 로그인 토큰을 새로 읽음', async () => {
    mockFetch.mockResolvedValue(reply(200, {}));
    await callEdge('alarm-commit', {});
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' }, access_token: 'token-9' } } });
    await callEdge('alarm-commit', {});
    expect(mockFetch.mock.calls.map((c) => c[1].headers.Authorization)).toEqual(['Bearer token-1', 'Bearer token-9']);
  });
});

describe('서버 오류 → 앱 오류 코드 (Edge와 같은 모양 그대로 읽힘)', () => {
  it('{ error: { code, message, details } }는 code로 문구를 고르고 requestId · details를 보관', async () => {
    const details = { manual_required: true };
    mockFetch.mockResolvedValue(reply(502, { error: { code: 'ROUTE_UNAVAILABLE', message: '길찾기 실패', details } }, { requestId: 'req-77' }));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({
      name: 'EdgeError',
      code: 'ROUTE_UNAVAILABLE',
      status: 502,
      details,
      requestId: 'req-77',
      serverMessage: '길찾기 실패',
      message: EDGE_MESSAGES.ROUTE_UNAVAILABLE,
    });
  });

  it('서버만 쓰는 코드 AUTH_UNAVAILABLE(공개 키를 못 받음, 503)도 문구가 있음', async () => {
    mockFetch.mockResolvedValue(serverError(503, 'AUTH_UNAVAILABLE'));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE', message: EDGE_MESSAGES.AUTH_UNAVAILABLE });
    expect(EDGE_MESSAGES.AUTH_UNAVAILABLE).toMatch(/요$/);
  });

  it.each([
    [502, 'INTERNAL'],
    [503, 'INTERNAL'],
    [504, 'TIMEOUT'],
    [413, 'VALIDATION_FAILED'],
    [429, 'RATE_LIMITED'],
  ])('JSON이 아닌 본문(nginx 등) %i → %s로 판정', async (status, code) => {
    mockFetch.mockResolvedValue(reply(status, undefined, { raw: '<html>nginx</html>' }));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code, status });
  });

  it('우리 모양이 아닌 JSON(예: 게이트웨이 { code, message })은 상태로 짐작', async () => {
    mockFetch.mockResolvedValue(reply(403, { code: 403, message: 'forbidden' }));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('2xx인데 본문이 JSON이 아니면 INTERNAL', async () => {
    mockFetch.mockResolvedValue(reply(200, undefined, { raw: '<html>oops</html>' }));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('서버에 못 닿으면 NETWORK', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('쓰기 함수는 시간 제한(기본 20초)이 지나면 TIMEOUT', async () => {
    neverResponds();
    const result = expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'TIMEOUT' });
    await jest.advanceTimersByTimeAsync(19_999);
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await result;
    expect(mockInvoke).not.toHaveBeenCalled(); // 쓰기는 Edge로 대신 부르지 않음
  });
});

describe('로그인 토큰이 만료돼 401이면 한 번만 갱신해서 다시', () => {
  it('401 → refreshSession → 새 토큰으로 한 번 더 → 성공', async () => {
    mockFetch.mockResolvedValueOnce(serverError(401, 'AUTH_REQUIRED')).mockResolvedValueOnce(reply(200, { ok: true }));
    await expect(callEdge('alarm-commit', {})).resolves.toEqual({ ok: true });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.map((c) => c[1].headers.Authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('또 401이면 AUTH_REQUIRED (세 번째는 없음)', async () => {
    mockFetch.mockResolvedValue(serverError(401, 'AUTH_REQUIRED'));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED', message: EDGE_MESSAGES.AUTH_REQUIRED });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('갱신에 실패하면 다시 보내지 않고 AUTH_REQUIRED', async () => {
    mockRefresh.mockResolvedValue({ data: { session: null }, error: { message: 'refresh_token_not_found' } });
    mockFetch.mockResolvedValue(serverError(401, 'AUTH_REQUIRED'));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('401은 읽기 함수여도 Edge로 대신 부르지 않음 (Edge도 같은 토큰이라 같은 결과)', async () => {
    mockFetch.mockResolvedValue(serverError(401, 'AUTH_REQUIRED'));
    await expect(callEdge('place-search', {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('토큰이 아예 없으면 서버에 보내지 않고 AUTH_REQUIRED', async () => {
    mockGetSession
      .mockResolvedValueOnce({ data: { session: { user: { id: 'user-1' }, access_token: 'token-1' } } }) // 표 읽기용
      .mockResolvedValueOnce({ data: { session: null } }); // 호출용 (그 사이 로그아웃)
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('읽기 함수 자동 대체 — 서버 1번 → Edge 1번', () => {
  it('서버에 못 닿으면 Edge로 한 번 더 부르고 그 결과를 돌려줌 (retry를 줘도 합쳐서 서버 1 → Edge 1)', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(callEdge('place-search', { query: '세종' }, { retry: 3 })).resolves.toEqual({ from: 'edge' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('place-search', { body: { query: '세종' }, headers: undefined, timeout: 20_000 });
  });

  it('로그는 한 줄 — 이름 · 코드 · requestId만, 요청 내용(검색어 등)은 안 남김', async () => {
    mockFetch.mockResolvedValue(serverError(503, 'AUTH_UNAVAILABLE'));
    await callEdge('place-search', { query: '비밀검색어' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('place-search');
    expect(line).toContain('AUTH_UNAVAILABLE');
    expect(line).toContain('req-s');
    expect(line).not.toContain('비밀검색어');
    expect(line).not.toContain('token-1');
  });

  it('서버가 4초 안에 답하지 않으면 시간 초과 → Edge', async () => {
    neverResponds();
    const result = callEdge('place-search', { query: '세종' });
    await jest.advanceTimersByTimeAsync(3_999);
    expect(mockInvoke).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ from: 'edge' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('호출하는 쪽이 더 짧은 시간 제한을 주면 그것을 따름', async () => {
    neverResponds();
    const result = callEdge('place-search', {}, { timeoutMs: 1_000 });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ from: 'edge' });
  });

  it.each([
    ['NETWORK', () => mockFetch.mockRejectedValue(new TypeError('x'))],
    ['서버 오류(500)', () => mockFetch.mockResolvedValue(serverError(500, 'INTERNAL'))],
    ['게이트웨이 오류(502 · 본문 없음)', () => mockFetch.mockResolvedValue(reply(502, undefined, { raw: '<html>' }))],
    ['게이트웨이 시간 초과(504)', () => mockFetch.mockResolvedValue(reply(504, undefined, { raw: '<html>' }))],
    ['공개 키를 못 받음(AUTH_UNAVAILABLE)', () => mockFetch.mockResolvedValue(serverError(503, 'AUTH_UNAVAILABLE'))],
    ['2xx인데 JSON이 아님', () => mockFetch.mockResolvedValue(reply(200, undefined, { raw: '<html>' }))],
  ])('서버가 죽었거나 이상한 응답: %s → Edge', async (_label, arrange) => {
    arrange();
    await expect(callEdge('place-reverse', { lat: 1 })).resolves.toEqual({ from: 'edge' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, 'VALIDATION_FAILED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [422, 'UNPROCESSABLE'],
  ])('서버가 정상으로 거절한 것(%i %s)은 Edge로 대신 부르지 않고 그대로 던짐', async (status, code) => {
    mockFetch.mockResolvedValue(serverError(status, code));
    await expect(callEdge('place-search', {})).rejects.toMatchObject({ code });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('쓰기 함수는 서버가 죽어도 Edge로 대신 부르지 않음 (이미 처리됐을 수 있어 두 번 쓰면 안 됨)', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(callEdge('alarm-commit', {})).rejects.toMatchObject({ code: 'NETWORK' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('쓰기 함수의 retry는 서버에서 그대로 적용 (네트워크 · 시간 초과 · 서버 오류만)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(reply(200, { ok: true }));
    await expect(callEdge('alarm-commit', {}, { retry: 1 })).resolves.toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(serverError(400, 'VALIDATION_FAILED'));
    await expect(callEdge('alarm-commit', {}, { retry: 2 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(mockFetch).toHaveBeenCalledTimes(1); // 요청이 잘못된 건 다시 해도 같음
  });

  it('서버도 Edge도 실패하면 Edge의 오류를 던짐', async () => {
    mockFetch.mockRejectedValue(new TypeError('x'));
    mockInvoke.mockResolvedValue({ data: null, error: new Error('엉뚱한 오류') });
    await expect(callEdge('place-search', {})).rejects.toMatchObject({ name: 'EdgeError', code: 'UNKNOWN' });
  });
});

describe('차단기 — 서버가 연속 3번 실패하면 5분 동안 읽기 함수는 서버를 건너뛰고 바로 Edge', () => {
  const failOnce = () => callEdge('place-search', { query: 'x' });

  it('3번 실패하면 4번째 호출은 서버에 가지 않음, 5분 뒤 다시 서버를 시험해 보고 성공하면 풀림', async () => {
    mockFetch.mockRejectedValue(new TypeError('x'));
    for (let i = 0; i < 3; i++) await failOnce();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(breakerOpen()).toBe(true);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('5분'))).toBe(true); // 차단기가 열렸다고 한 줄

    await expect(failOnce()).resolves.toEqual({ from: 'edge' });
    expect(mockFetch).toHaveBeenCalledTimes(3); // 서버를 건너뜀
    expect(mockInvoke).toHaveBeenCalledTimes(4);

    await jest.advanceTimersByTimeAsync(5 * 60_000);
    mockFetch.mockResolvedValue(reply(200, { places: [] }));
    await expect(failOnce()).resolves.toEqual({ places: [] });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(breakerOpen()).toBe(false);
  });

  it('서버가 정상으로 거절한 응답(4xx)은 "서버가 살아 있음"이라 연속 횟수를 끊음', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('x'))
      .mockRejectedValueOnce(new TypeError('x'))
      .mockResolvedValueOnce(serverError(400, 'VALIDATION_FAILED'))
      .mockRejectedValueOnce(new TypeError('x'))
      .mockRejectedValueOnce(new TypeError('x'));
    await failOnce();
    await failOnce();
    await expect(failOnce()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await failOnce();
    await failOnce();
    expect(breakerOpen()).toBe(false);
  });

  it('차단기가 열려도 쓰기 함수는 그대로 서버로 (대신 부를 수 없고, 서버가 살아났는지 봐야 함)', async () => {
    mockFetch.mockRejectedValue(new TypeError('x'));
    for (let i = 0; i < 3; i++) await failOnce();
    expect(breakerOpen()).toBe(true);
    mockFetch.mockResolvedValue(reply(200, { ok: true }));
    await expect(callEdge('alarm-commit', {})).resolves.toEqual({ ok: true });
    expect(breakerOpen()).toBe(false); // 성공하면 풀림
  });
});
