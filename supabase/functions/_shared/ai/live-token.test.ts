// Live 토큰 만들기 시험 — 가짜 fetch만 씀
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpError } from '../errors.ts';
import { createLiveToken, LIVE_MODEL, LIVE_TOKEN_URL } from './live-token.ts';

describe('live-token', () => {
  it('키를 헤더로 보내고 모델 · 지침을 잠근 토큰을 돌려줌', async () => {
    let url = '';
    let init: RequestInit = {};
    const fetchFn = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createLiveToken('k', { fetchFn, now: 0 });
    assert.deepEqual(r, { token: 'auth_tokens/abc', model: LIVE_MODEL });
    assert.equal(url, LIVE_TOKEN_URL);
    assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], 'k');
    const body = JSON.parse(String(init.body));
    assert.equal(body.bidiGenerateContentSetup.model, `models/${LIVE_MODEL}`);
    assert.equal(body.newSessionExpireTime, new Date(60_000).toISOString());
  });

  it('Google이 거절하거나 연결이 안 되면 VOICE_UNAVAILABLE', async () => {
    const reject = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    for (const fetchFn of [reject, offline]) {
      await assert.rejects(createLiveToken('k', { fetchFn, log: () => {} }), (e) => e instanceof HttpError && e.code === 'VOICE_UNAVAILABLE');
    }
  });
});
