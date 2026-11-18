// AI 대화에서 나가기 전 할 일 때문에 기상만 정한 일정 — 저장 · 다시 읽기 · 수정 뒤에도 기상만 그 시각, 준비 · 출발은 일정 기준 그대로 (2026-11-19 팀 결정)
//   앱(features/voice/real.ts estimateNew → features/alarm/adjust.ts moveWakeOnly)이 기상만 옮기고 준비를 지금 시각에 고정해(직접 고름) 저장함
//   → 서버는 계산 규칙을 바꾸지 않고 저장된 직접 고른 시각을 이어받음 (D42 C). 이 시험은 그 저장 모양이 실제 서버 경로에서 유지되는지 봄
//   실제 경로: 요청 읽기 → buildPlan → 저장 검증 → persistAppointment, 일정 수정 updateAppointment (가짜 DB)
//   기준: 11/19 13:00 수업, 이동 40 · 여유 10 · 예측 준비 50 → 계산 기상 11:20 · 준비 11:40 · 출발 12:10. 사용자가 기상 09:30을 고름
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertPersistable, persistAppointment } from './commit.ts';
import { updateAppointment } from './edit-run.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { buildPlan } from './plan.ts';
import type { ProfileRow } from './plan-core.ts';
import { Reader } from './read.ts';
import { readCommitRequest } from './requests.ts';
import type { Db } from './supabase.ts';

// buildPlan이 CatBoost 설정(PREPARE_ML_ENABLED)을 Deno.env로 읽음 — Node 시험에서는 설정 없음(꺼짐 = 기존 P80 계산)으로
(globalThis as { Deno?: unknown }).Deno ??= { env: { get: () => undefined } };

const A = 'u-a';
const NOW = new Date('2026-11-18T21:00:00+09:00');
const iso = (local: string) => `${local}:00+09:00`;
const hm = (v: unknown) => new Date(v as string).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
const HOME = { lat: 37.5547, lng: 126.9707 };

function setup() {
  const db = new FakeDb();
  db.now = NOW;
  db.rows('profiles').push({ user_id: A, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng, default_prepare_minutes: 50 } satisfies ProfileRow & { user_id: string });
  return db;
}
// 앱 createCommitBody 모양 — 확인 시트 값(이동 MANUAL · 준비 50 · 준비 전 20 · 기상 있음) + 직접 고른 시각
const participant = { origin: { name: '집', ...HOME }, transport_type: 'TRANSIT', est_travel_minutes: 40, travel_source: 'MANUAL', buffer_minutes: 10, prepare_minutes: 50, before_prepare_minutes: 20, with_wake: true };
const newBody = (manual: Record<string, string>) => ({
  appointment: { title: '수업', appointment_at: iso('2026-11-19T13:00'), destination: { name: '세종대학교', lat: 37.5509, lng: 127.0736 }, importance: 'NORMAL' },
  participant,
  manual_times: manual,
});
async function commit(db: FakeDb, body: object): Promise<string> {
  const r = Reader.root(body);
  const request = readCommitRequest(r);
  r.finish();
  if (request.type !== 'APPOINTMENT') throw new Error('약속 요청이어야 해요');
  const d = db as unknown as Db;
  const built = await buildPlan({ userId: A, db: d, now: NOW }, request.draft);
  assertPersistable(built.plan);
  const saved = await persistAppointment({ userId: A, userDb: d, service: d, now: NOW }, {
    plan: built.plan, inputs: built.inputs, created: request.appointment, draft: request.draft, replaceExisting: request.replaceExisting, edits: [], timeZone: built.timeZone,
  });
  return saved.appointment_id;
}
const ORDER = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];
const lines = (db: FakeDb, id: string) => {
  const pid = db.rows('appointment_participants').find((p) => p.appointment_id === id)!.participant_id;
  return db.rows('alarms').filter((a) => a.participant_id === pid)
    .sort((x, y) => ORDER.indexOf(x.alarm_type as string) - ORDER.indexOf(y.alarm_type as string))
    .map((a) => `${a.alarm_type} ${hm(a.scheduled_at)}${a.time_source === 'MANUAL' ? ' 직접' : ''}`);
};

test('A. 할 일이 없는 일정은 기존 계산 그대로 (기상 11:20 · 준비 11:40 · 출발 12:10)', async () => {
  const db = setup();
  const id = await commit(db, newBody({}));
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
});

test('H. 기상만 09:30으로 저장 → 다시 읽어 저장 · 서버 재계산 · 같은 날 일정 시각 수정에도 기상 09:30 · 준비 11:40 유지', async () => {
  const db = setup();
  const id = await commit(db, newBody({ WAKE: iso('2026-11-19T09:30'), PREPARE: iso('2026-11-19T11:40') }));
  assert.deepEqual(lines(db, id), ['WAKE 09:30 직접', 'PREPARE 11:40 직접', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  // 앱 H03을 다시 열어 저장(저장된 직접 시각을 그대로 보냄) · 서버가 칸 없이 다시 계산
  await commit(db, { appointment_id: id, participant: { ...participant, before_prepare_minutes: undefined }, manual_times: { WAKE: iso('2026-11-19T09:30'), PREPARE: iso('2026-11-19T11:40') } });
  await commit(db, { appointment_id: id });
  assert.deepEqual(lines(db, id), ['WAKE 09:30 직접', 'PREPARE 11:40 직접', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  // 수업 13:00 → 13:30 (appointment-edit): 직접 고른 기상 · 준비는 같은 날이면 그대로(기존 규칙), 출발만 새 시각 기준
  const res = await updateAppointment({ userId: A, userDb: db as unknown as Db, service: db as unknown as Db, now: NOW }, { action: 'UPDATE', appointmentId: id, scope: 'this', patch: { at: new Date(iso('2026-11-19T13:30')) }, confirmed: true });
  assert.ok(res.saved);
  assert.deepEqual(lines(db, id), ['WAKE 09:30 직접', 'PREPARE 11:40 직접', 'DEPARTURE 12:40', 'ARRIVE 13:20']);
});

test('G. 준비 알람(11:40)보다 늦은 기상(12:00)은 저장 단계에서도 막음 (UNPROCESSABLE ORDER) — 아무것도 안 씀', async () => {
  const db = setup();
  await assert.rejects(() => commit(db, newBody({ WAKE: iso('2026-11-19T12:00'), PREPARE: iso('2026-11-19T11:40') })), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.code, 'UNPROCESSABLE');
    assert.equal((e.details as { reason?: string }).reason, 'ORDER');
    return true;
  });
  assert.equal(db.rows('alarms').length, 0);
});
