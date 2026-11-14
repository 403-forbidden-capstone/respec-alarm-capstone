import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

import { ERROR_STATUS } from '@shared/errors.ts';

import { callEdge, DEFAULT_MESSAGE, EDGE_MESSAGES, EdgeError, toEdgeError, UNPROCESSABLE_MESSAGES } from '../edge';
import { UserError, userMessage } from '../errors';

// jest.mock은 import보다 먼저 실행되도록 끌어올려짐 — 아래 가짜 supabase를 ../edge가 받음
const mockInvoke = jest.fn<(name: string, options: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>();
jest.mock('../supabase', () => ({ supabase: { functions: { invoke: (name: string, options: Record<string, unknown>) => mockInvoke(name, options) } } }));

// 서버가 오류를 돌려줄 때 FunctionsHttpError.context에 들어오는 Response와 같은 모양
function httpError(status: number, body: unknown, requestId = 'req-1') {
  const response = {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'x-request-id' ? requestId : null) },
    json: async () => {
      if (body === undefined) throw new SyntaxError('JSON이 아님');
      return body;
    },
  };
  return new FunctionsHttpError(response);
}
const serverError = (status: number, code: string, message = '서버가 쓴 문구', details?: unknown) =>
  httpError(status, { error: details === undefined ? { code, message } : { code, message, details } });

describe('서버 오류 → 사용자 문구 (toEdgeError)', () => {
  it('서버 코드마다 해요체 문구가 있음 — 서버에 코드가 늘면 여기서 알려 줌', () => {
    const missing = Object.keys(ERROR_STATUS).filter((code) => !EDGE_MESSAGES[code as keyof typeof EDGE_MESSAGES]);
    // METHOD_NOT_ALLOWED는 앱 버그(POST가 아님)라 기본 문구
    expect(missing).toEqual(['METHOD_NOT_ALLOWED']);
    for (const message of [...Object.values(EDGE_MESSAGES), ...Object.values(UNPROCESSABLE_MESSAGES)]) {
      expect(message).toMatch(/요$/);
    }
  });

  it('{ error: { code } } 본문은 code로 문구를 고르고 서버 message는 화면에 쓰지 않음', async () => {
    const e = await toEdgeError(serverError(403, 'FORBIDDEN', 'group_members 정책 위반'));
    expect(e).toBeInstanceOf(UserError);
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toBe(EDGE_MESSAGES.FORBIDDEN);
    expect(e.status).toBe(403);
    expect(e.requestId).toBe('req-1');
    expect(e.serverMessage).toBe('group_members 정책 위반');
    expect(userMessage(e)).toBe('이 작업을 할 권한이 없어요'); // 화면이 쓰는 경로 (UserError라 그대로 보임)
  });

  it('UNPROCESSABLE은 details.reason으로 이유를 나눔', async () => {
    expect((await toEdgeError(serverError(422, 'UNPROCESSABLE', 'x', { reason: 'DEPARTURE_PASSED' }))).message).toBe(UNPROCESSABLE_MESSAGES.DEPARTURE_PASSED);
    expect((await toEdgeError(serverError(422, 'UNPROCESSABLE', 'x', { reason: 'ORDER', earlier: 'WAKE' }))).message).toBe(UNPROCESSABLE_MESSAGES.ORDER);
    expect((await toEdgeError(serverError(422, 'UNPROCESSABLE', 'x', { reason: 'PAST_TIME' }))).message).toBe(UNPROCESSABLE_MESSAGES.PAST_TIME);
    expect((await toEdgeError(serverError(422, 'UNPROCESSABLE', 'x', { reason: '모르는 이유' }))).message).toBe(EDGE_MESSAGES.UNPROCESSABLE);
    expect((await toEdgeError(serverError(422, 'UNPROCESSABLE'))).message).toBe(EDGE_MESSAGES.UNPROCESSABLE);
  });

  it('details는 그대로 넘김 — 화면이 이동시간 직접 입력 같은 갈래를 나눌 때 씀', async () => {
    const details = { manual_required: true, fallback: { minutes: 40, source: 'ESTIMATE' } };
    const e = await toEdgeError(serverError(502, 'ROUTE_UNAVAILABLE', '길찾기 실패', details));
    expect(e.code).toBe('ROUTE_UNAVAILABLE');
    expect(e.details).toEqual(details);
    expect(e.message).toBe('이동시간을 구하지 못했어요. 직접 입력해 주세요');
  });

  it('METHOD_NOT_ALLOWED처럼 문구가 없는 서버 코드는 기본 문구', async () => {
    const e = await toEdgeError(serverError(405, 'METHOD_NOT_ALLOWED'));
    expect(e.code).toBe('METHOD_NOT_ALLOWED');
    expect(e.message).toBe(DEFAULT_MESSAGE);
  });

  it('모르는 code는 HTTP 상태로 짐작하고 그래도 모르면 기본 문구', async () => {
    expect((await toEdgeError(serverError(500, 'SOMETHING_NEW'))).code).toBe('INTERNAL');
    const unknown = await toEdgeError(serverError(418, 'TEAPOT'));
    expect(unknown.code).toBe('UNKNOWN');
    expect(unknown.message).toBe(DEFAULT_MESSAGE);
  });

  it('우리 모양이 아닌 응답(게이트웨이가 토큰을 거절 · JSON이 아님)은 상태로 짐작', async () => {
    const gateway = await toEdgeError(httpError(401, { code: 401, message: 'Invalid JWT' }));
    expect(gateway.code).toBe('AUTH_REQUIRED');
    expect(gateway.message).toBe(EDGE_MESSAGES.AUTH_REQUIRED);
    expect((await toEdgeError(httpError(502, undefined))).code).toBe('INTERNAL');
    expect((await toEdgeError(httpError(404, undefined))).code).toBe('UNKNOWN'); // 함수가 배포 안 됐을 때
    expect((await toEdgeError(httpError(429, undefined))).code).toBe('RATE_LIMITED');
    // 서버(nginx) 앞단: 504는 늦어서(TIMEOUT), 413은 요청이 너무 커서(입력 문제)
    expect((await toEdgeError(httpError(504, undefined))).code).toBe('TIMEOUT');
    expect((await toEdgeError(httpError(413, undefined))).code).toBe('VALIDATION_FAILED');
  });

  it('서버만 쓰는 코드 AUTH_UNAVAILABLE(공개 키를 못 받음)도 코드 그대로 읽고 문구가 있음', async () => {
    const e = await toEdgeError(serverError(503, 'AUTH_UNAVAILABLE', '서버 문구'));
    expect(e.code).toBe('AUTH_UNAVAILABLE');
    expect(e.message).toBe(EDGE_MESSAGES.AUTH_UNAVAILABLE);
    expect(e.message).not.toBe(DEFAULT_MESSAGE);
  });

  it('네트워크 실패 · 시간 초과 · 중계 실패 · 모르는 오류', async () => {
    const network = await toEdgeError(new FunctionsFetchError(new TypeError('Network request failed')));
    expect(network.code).toBe('NETWORK');
    expect(network.message).toBe('인터넷 연결을 확인해 주세요');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect((await toEdgeError(new FunctionsFetchError(abort))).code).toBe('TIMEOUT');
    expect((await toEdgeError(new FunctionsRelayError({}))).code).toBe('INTERNAL');
    const other = await toEdgeError(new Error('엉뚱한 오류'));
    expect(other.code).toBe('UNKNOWN');
    expect(other.message).toBe(DEFAULT_MESSAGE);
  });
});

describe('callEdge', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('성공하면 응답 본문을 돌려주고 이름 · 본문 · 시간 제한을 넘김', async () => {
    mockInvoke.mockResolvedValue({ data: { ring_packages: [] }, error: null });
    const result = await callEdge<{ ring_packages: unknown[] }>('alarm-commit', { kinds: ['WAKE'] });
    expect(result).toEqual({ ring_packages: [] });
    expect(mockInvoke).toHaveBeenCalledWith('alarm-commit', { body: { kinds: ['WAKE'] }, headers: undefined, timeout: 20_000 });
  });

  it('중복 막는 키를 주면 Idempotency-Key 헤더로 보냄', async () => {
    mockInvoke.mockResolvedValue({ data: {}, error: null });
    await callEdge('alarm-commit', {}, { idempotencyKey: 'key-1', timeoutMs: 5_000 });
    expect(mockInvoke).toHaveBeenCalledWith('alarm-commit', { body: {}, headers: { 'Idempotency-Key': 'key-1' }, timeout: 5_000 });
  });

  it('실패하면 EdgeError로 던짐', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: serverError(404, 'NOT_FOUND') });
    await expect(callEdge('alarm-suggest', {})).rejects.toMatchObject({ name: 'EdgeError', code: 'NOT_FOUND', message: EDGE_MESSAGES.NOT_FOUND });
    expect(mockInvoke).toHaveBeenCalledTimes(1); // 기본은 다시 하지 않음
  });

  it('retry를 주면 네트워크 · 서버 오류만 다시 함', async () => {
    mockInvoke
      .mockResolvedValueOnce({ data: null, error: new FunctionsFetchError(new TypeError('x')) })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(callEdge('place-search', { query: '세종' }, { retry: 1 })).resolves.toEqual({ ok: true });
    expect(mockInvoke).toHaveBeenCalledTimes(2);

    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ data: null, error: serverError(400, 'VALIDATION_FAILED') });
    await expect(callEdge('place-search', {}, { retry: 2 })).rejects.toBeInstanceOf(EdgeError);
    expect(mockInvoke).toHaveBeenCalledTimes(1); // 요청이 잘못된 건 다시 해도 같음
  });
});
