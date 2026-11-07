// voice-live-token 한도 · 기록 시험 — 가짜 fetch · 가짜 DB만 씀 (Google 호출 없음)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpError } from '../errors.ts';
import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { handleLiveToken, LIVE_POINT, MAX_LIVE_TOKENS_PER_DAY } from './live-quota.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-07T21:00:00+09:00');

function setup(status = 200) {
  const db = new FakeDb();
  db.now = NOW;
  let fetched = 0;
  const fetchFn = (async () => {
    fetched++;
    return status === 200 ? new Response(JSON.stringify({ name: 'auth_tokens/t' }), { status }) : new Response('bad', { status });
  }) as unknown as typeof fetch;
  const deps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, apiKey: 'k', now: () => NOW, fetchFn };
  return { db, deps, fetched: () => fetched };
}

const add = (db: FakeDb, n: number, point: string, at = '2026-11-07T09:00:00+09:00', user = ME) => {
  for (let i = 0; i < n; i++) db.rows('ai_calls').push({ call_id: db.newId(), user_id: user, point, created_at: at });
};

const rateLimited = (e: unknown) => e instanceof HttpError && e.code === 'RATE_LIMITED';

describe('live-quota', () => {
  it('발급하면 ai_calls에 LV 한 줄 (토큰은 안 남김)', async () => {
    const { db, deps } = setup();
    const r = await handleLiveToken(deps);
    assert.equal(r.token, 'auth_tokens/t');
    assert.equal(r.left_today, MAX_LIVE_TOKENS_PER_DAY - 1);
    const rows = db.rows('ai_calls');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].point, LIVE_POINT);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].io, null);
  });

  it('오늘 LV가 한도만큼이면 RATE_LIMITED, Google 안 부름 (어제 · 다른 사람 · 글 대화 호출은 안 셈)', async () => {
    const { db, deps, fetched } = setup();
    add(db, MAX_LIVE_TOKENS_PER_DAY - 1, LIVE_POINT);
    add(db, 1, LIVE_POINT, '2026-11-06T23:59:00+09:00'); // 어제
    add(db, 5, LIVE_POINT, undefined, '22222222-2222-4222-8222-222222222222');
    add(db, 20, 'T1');
    assert.equal((await handleLiveToken(deps)).left_today, 0); // 마지막 한 번은 통과
    await assert.rejects(handleLiveToken(deps), rateLimited);
    assert.equal(fetched(), 1);
  });

  it('하루 전체 AI 호출 상한(300)에 닿아도 거절', async () => {
    const { db, deps, fetched } = setup();
    add(db, 300, 'T1');
    await assert.rejects(handleLiveToken(deps), rateLimited);
    assert.equal(fetched(), 0);
  });

  it('Google이 거절해도 실패 한 줄을 남겨 한도에 셈', async () => {
    const { db, deps } = setup(400);
    const log = console.error;
    console.error = () => {};
    try {
      await assert.rejects(handleLiveToken(deps), (e) => e instanceof HttpError && e.code === 'VOICE_UNAVAILABLE');
    } finally {
      console.error = log;
    }
    const rows = db.rows('ai_calls');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].error_code, 'UPSTREAM');
  });
});
