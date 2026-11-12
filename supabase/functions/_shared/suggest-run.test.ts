// 알람 조정 제안 만들기 — 후보 → 제안 (규칙 · 120분 상한 · 기상까지 당김 표시), 넣기(겹친 대기 제안은 건너뜀)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDb } from './fake-db.ts';
import { planSuggestions, runSuggest, type SuggestInputRow } from './suggest-run.ts';
import type { Db } from './supabase.ts';

const row = (over: Partial<SuggestInputRow> = {}): SuggestInputRow => ({
  user_id: 'u1',
  participant_id: 'p1',
  target_alarm_id: 'prep-1',
  current_advance: 0,
  before_prepare_minutes: 10,
  cap_minutes: 10,
  residuals: [2, 10, 14, 12],
  ...over,
});

test('목업 S01 예시 — 최근 3번 +10 · +14 · +12분이면 준비 알람 10분 당김 제안 (지금 0 → 10)', () => {
  assert.deepEqual(planSuggestions([row()]), [
    { user_id: 'u1', target_alarm_id: 'prep-1', suggestion_type: 'PREPARE_ADVANCE', current_value: '0', suggested_value: '10', evidence: [10, 14, 12] },
  ]);
});

test('이미 당긴 분이 있으면 그 위에 더함 (5 → 10), 규칙에 안 걸리면 제안 없음', () => {
  assert.equal(planSuggestions([row({ current_advance: 5, cap_minutes: 5 })])[0]?.suggested_value, '10');
  assert.deepEqual(planSuggestions([row({ residuals: [12, -1, 14] }), row({ residuals: [3, 4, 6] })]), []);
});

test('당김 분 합은 120분을 넘지 않음 — 115분이면 5분만, 120분이면 제안 없음', () => {
  assert.equal(planSuggestions([row({ current_advance: 115, residuals: [20, 20, 20], cap_minutes: 10 })])[0]?.suggested_value, '120');
  assert.deepEqual(planSuggestions([row({ current_advance: 120, residuals: [20, 20, 20] })]), []);
});

test('기상 알람이 없는 일정(before_prepare_minutes null)도 제안함', () => {
  assert.equal(planSuggestions([row({ before_prepare_minutes: null })]).length, 1);
});

test('runSuggest — 재료 함수를 지금 시각으로 부르고 제안을 넣음, 겹친 대기 제안(23505)은 건너뜀', async () => {
  const db = new FakeDb();
  const now = new Date('2025-05-22T09:00:00Z');
  db.rpcHandlers.prepare_suggestion_inputs = () => [row(), row({ participant_id: 'p2', target_alarm_id: 'prep-2' })];
  let inserts = 0;
  const original = db.from.bind(db);
  db.from = ((table: string) => {
    const q = original(table);
    if (table !== 'alarm_suggestions') return q;
    return {
      insert: (r: { target_alarm_id: string }) => {
        inserts += 1;
        return Promise.resolve(r.target_alarm_id === 'prep-2' ? { data: null, error: { code: '23505', message: 'duplicate' } } : { data: null, error: null });
      },
    } as unknown as ReturnType<typeof original>;
  }) as typeof db.from;
  const result = await runSuggest(db as unknown as Db, now);
  assert.deepEqual(db.rpcCalls, [{ name: 'prepare_suggestion_inputs', args: { p_now: now.toISOString() } }]);
  assert.equal(inserts, 2);
  assert.deepEqual(result, { candidates: 2, created: 1, skipped: 1 });
});

test('runSuggest — 후보가 없으면 아무것도 안 넣음', async () => {
  const db = new FakeDb();
  db.rpcHandlers.prepare_suggestion_inputs = () => [];
  assert.deepEqual(await runSuggest(db as unknown as Db, new Date()), { candidates: 0, created: 0, skipped: 0 });
});
