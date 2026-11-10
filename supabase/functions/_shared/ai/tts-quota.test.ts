// 알람 긴급 음성 Gemini 한도 — 프로젝트 하루 8 · 분당 2, 사용자 하루 2 (기존 대화 한도와 따로 · 지점 AV)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dbTtsQuota, ttsAllowed, TTS_LIMITS, TTS_POINT } from './tts-quota.ts';
import type { Db } from '../supabase.ts';

test('한도 값 · 경계', () => {
  assert.deepEqual(TTS_LIMITS, { projectPerDay: 8, projectPerMinute: 2, userPerDay: 2 });
  assert.equal(ttsAllowed({ projectDay: 7, projectMinute: 1, userDay: 1 }), true);
  assert.equal(ttsAllowed({ projectDay: 8, projectMinute: 0, userDay: 0 }), false);
  assert.equal(ttsAllowed({ projectDay: 0, projectMinute: 2, userDay: 0 }), false);
  assert.equal(ttsAllowed({ projectDay: 0, projectMinute: 0, userDay: 2 }), false);
});

// ai_calls 세기 · 넣기만 흉내 내는 가짜 DB
function fakeDb(rows: { user_id: string; point: string; created_at: string }[]) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    from: () => {
      const filters: ((r: (typeof rows)[number]) => boolean)[] = [];
      const q = {
        select: () => q,
        eq: (col: 'user_id' | 'point', v: string) => (filters.push((r) => r[col] === v), q),
        gte: (_c: string, v: string) => (filters.push((r) => r.created_at >= v), q),
        then: (res: (x: { count: number; error: null }) => void) => res({ count: rows.filter((r) => filters.every((f) => f(r))).length, error: null }),
        insert: async (row: Record<string, unknown>) => (inserted.push(row), { error: null }),
      };
      return q;
    },
  };
  return { db: db as unknown as Db, inserted };
}

test('DB 셈: 프로젝트 전체 · 사용자별을 AV 지점만, 기록은 AV로', async () => {
  const now = new Date('2026-11-11T00:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  const rows = [
    { user_id: 'me', point: TTS_POINT, created_at: ago(3600) },
    { user_id: 'other', point: TTS_POINT, created_at: ago(30) },
    { user_id: 'other', point: 'T1', created_at: ago(10) }, // 글 대화 — 안 셈
    { user_id: 'me', point: TTS_POINT, created_at: ago(90_000) }, // 24시간 넘음
  ];
  const { db, inserted } = fakeDb(rows);
  const quota = dbTtsQuota(db, 'me', () => now);
  assert.equal(await quota.allow(), true); // 프로젝트 2 · 분당 1 · 나 1
  rows.push({ user_id: 'me', point: TTS_POINT, created_at: ago(5) });
  assert.equal(await quota.allow(), false); // 분당 2 · 나 2
  await quota.record({ ok: false, errorCode: 'rate_limit', latencyMs: 12.4, model: 'm' });
  assert.equal(inserted[0].point, 'AV');
  assert.equal(inserted[0].user_id, 'me');
  assert.equal(inserted[0].latency_ms, 12);
});
