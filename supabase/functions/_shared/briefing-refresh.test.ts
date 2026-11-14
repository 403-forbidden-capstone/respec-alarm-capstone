// 백그라운드 브리핑 갱신(#515) — 전날 대화가 새벽 정리 전인지 · 다시 받을 시각 (briefingRefreshAt)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { briefingRefreshAt, COMMIT_LAG_MS } from './briefing-refresh.ts';
import { FakeDb } from './fake-db.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REVIEW = '2026-11-13'; // 11/14 아침 기상 알람의 전날 밤 대화
const DUE = Date.parse('2026-11-14T04:00:00+09:00'); // 자동 정리 시각
const at = (iso: string) => Date.parse(`${iso}+09:00`);

type Commit = { status: string; at_turn?: number; started_at: string; finished_at?: string; attempts: number };
function session(db: FakeDb, over: { user?: string; review?: string; turns?: number; ended?: boolean; commit?: Commit; type?: string } = {}) {
  db.rows('conversation_sessions').push({
    session_id: db.newId(),
    user_id: over.user ?? USER,
    session_type: over.type ?? 'BEFORE_SLEEP',
    ended_at: over.ended ? '2026-11-13T23:00:00Z' : null,
    server_state: { v: 1, day: { review: over.review ?? REVIEW }, counts: { user_turns: over.turns ?? 3, llm_calls: 3 }, ended: over.ended ?? false, commit: over.commit },
  });
}

test('대화가 없거나 · 이미 정리됐거나 · 다른 날 · 남의 것 · 끝난 방이면 null (다시 받을 필요 없음)', async () => {
  const db = new FakeDb();
  assert.equal(await briefingRefreshAt(db as never, USER, REVIEW, at('2026-11-13T23:30:00')), null);
  session(db, { commit: { status: 'DONE', at_turn: 3, started_at: '2026-11-13T19:01:00Z', attempts: 1 } }); // 04:01 정리 끝
  session(db, { review: '2026-11-12' });
  session(db, { user: OTHER });
  session(db, { ended: true });
  session(db, { turns: 0 }); // 말 없이 연 방
  assert.equal(await briefingRefreshAt(db as never, USER, REVIEW, at('2026-11-14T04:12:00')), null);
});

test('정리 전이면 정리 시각(04:00) + 10분 = 04:10 · 정리 뒤 말이 늘었으면 다시 기다림', async () => {
  const db = new FakeDb();
  session(db);
  assert.equal(await briefingRefreshAt(db as never, USER, REVIEW, at('2026-11-13T23:30:00')), DUE + COMMIT_LAG_MS);
  const late = new FakeDb();
  session(late, { turns: 5, commit: { status: 'DONE', at_turn: 3, started_at: '2026-11-13T15:00:00Z', attempts: 1 } }); // [완료] 뒤 더 말함
  assert.equal(await briefingRefreshAt(late as never, USER, REVIEW, at('2026-11-13T23:30:00')), DUE + COMMIT_LAG_MS);
});

test('정리 시각이 지났는데 아직이면(배치 밀림) 지금 + 10분 · 실패 뒤 쉬는 중이면 다시 시도 시각 + 10분', async () => {
  const db = new FakeDb();
  session(db);
  const now = at('2026-11-14T04:25:00');
  assert.equal(await briefingRefreshAt(db as never, USER, REVIEW, now), now + COMMIT_LAG_MS);

  const failed = new FakeDb();
  session(failed, { commit: { status: 'FAILED', started_at: '2026-11-13T19:00:00Z', finished_at: '2026-11-13T19:01:00Z', attempts: 1 } }); // 04:01 실패 → 30분 쉼
  assert.equal(await briefingRefreshAt(failed as never, USER, REVIEW, at('2026-11-14T04:10:00')), at('2026-11-14T04:31:00') + COMMIT_LAG_MS);
});
