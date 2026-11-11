// 알람 긴급 음성 Gemini 한도 — DB 함수 reserve_alarm_tts로 원자적 예약 (프로젝트 하루 8 · 분당 2, 사용자 하루 2, 지점 AV)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dbTtsQuota, TTS_LIMITS } from './tts-quota.ts';
import type { Db } from '../supabase.ts';

function fakeDb(rpcResult: { data: unknown; error: { message: string } | null }) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const updates: { row: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => (rpcCalls.push({ fn, args }), rpcResult),
    from: () => ({
      update: (row: Record<string, unknown>) => {
        const u = { row, filters: [] as [string, unknown][] };
        updates.push(u);
        const q = { eq: (c: string, v: unknown) => (u.filters.push([c, v]), q), then: (res: (x: { error: null }) => void) => res({ error: null }) };
        return q;
      },
    }),
  };
  return { db: db as unknown as Db, rpcCalls, updates };
}

test('한도 값은 그대로 · 예약은 DB 함수 하나로 (한도 확인 + 예약 줄을 한 트랜잭션에서)', async () => {
  assert.deepEqual(TTS_LIMITS, { projectPerDay: 8, projectPerMinute: 2, userPerDay: 2 });
  const { db, rpcCalls } = fakeDb({ data: 'c-1', error: null });
  assert.equal(await dbTtsQuota(db, 'me').reserve('gemini-3.8-flash-tts'), 'c-1');
  assert.deepEqual(rpcCalls, [
    { fn: 'reserve_alarm_tts', args: { p_user_id: 'me', p_model: 'gemini-3.8-flash-tts', p_day_limit: 8, p_minute_limit: 2, p_user_day_limit: 2 } },
  ]);
});

test('한도 초과(null) · DB 오류면 null → Gemini 안 부름', async () => {
  assert.equal(await dbTtsQuota(fakeDb({ data: null, error: null }).db, 'me').reserve('m'), null);
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    assert.equal(await dbTtsQuota(fakeDb({ data: null, error: { message: 'permission denied' } }).db, 'me').reserve('m'), null);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
});

test('끝나면 예약한 그 줄만 결과로 고침 (AV 줄만, 실패 · 429도 남김)', async () => {
  const { db, updates } = fakeDb({ data: 'c-1', error: null });
  await dbTtsQuota(db, 'me').finish('c-1', { ok: false, errorCode: 'rate_limit', latencyMs: 12.4 });
  assert.deepEqual(updates, [{ row: { ok: false, error_code: 'rate_limit', latency_ms: 12, attempts: 1 }, filters: [['call_id', 'c-1'], ['point', 'AV']] }]);
});
