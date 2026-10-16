import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError, errorBody } from './errors.ts';
import { jsonResponse, serve } from './http.ts';

const call = (handler: ReturnType<typeof serve>, init: RequestInit = { method: 'POST' }) => handler(new Request('http://x/fn', init));

test('오류 모양은 5.2.1 { error: { code, message, details? } }', () => {
  assert.deepEqual(errorBody('VALIDATION_FAILED', '틀렸어요'), { error: { code: 'VALIDATION_FAILED', message: '틀렸어요' } });
  assert.deepEqual(errorBody('UNPROCESSABLE', 'x', { reason: 'ORDER' }), { error: { code: 'UNPROCESSABLE', message: 'x', details: { reason: 'ORDER' } } });
});

test('코드별 HTTP 상태 (5.2.1 표)', () => {
  const status = (code: ConstructorParameters<typeof HttpError>[0]) => new HttpError(code, '').status;
  assert.deepEqual(
    ['VALIDATION_FAILED', 'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'UNPROCESSABLE', 'RATE_LIMITED', 'ROUTE_UNAVAILABLE', 'INTERNAL', 'NOT_CONFIGURED'].map((c) =>
      status(c as never),
    ),
    [400, 401, 403, 404, 409, 422, 429, 502, 500, 503],
  );
});

test('OPTIONS는 CORS 답, 허용하지 않은 메서드는 405', async () => {
  const handler = serve(async () => jsonResponse({ ok: true }));
  const pre = await call(handler, { method: 'OPTIONS' });
  assert.equal(pre.status, 200);
  assert.ok(pre.headers.get('access-control-allow-headers')?.includes('authorization'));
  const get = await call(handler, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal((await get.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('성공 응답에도 X-Request-Id · CORS가 붙음', async () => {
  const res = await call(serve(async () => jsonResponse({ ok: true })));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-request-id'));
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { ok: true });
});

test('HttpError는 그 코드 · 메시지로, 그 밖의 오류는 일반 문구의 INTERNAL(500)로', async () => {
  const known = await call(
    serve(async () => {
      throw new HttpError('FORBIDDEN', '권한이 없어요', { why: 'x' });
    }),
  );
  assert.equal(known.status, 403);
  assert.deepEqual(await known.json(), { error: { code: 'FORBIDDEN', message: '권한이 없어요', details: { why: 'x' } } });

  const origError = console.error;
  console.error = () => {}; // 예상 못 한 오류 로그를 시험 출력에 안 섞음
  try {
    const unknown = await call(
      serve(async () => {
        throw new Error('db password leaked');
      }),
    );
    assert.equal(unknown.status, 500);
    const body = await unknown.json();
    assert.equal(body.error.code, 'INTERNAL');
    assert.ok(!JSON.stringify(body).includes('leaked')); // 원문은 사용자에게 안 보냄
  } finally {
    console.error = origError;
  }
});
