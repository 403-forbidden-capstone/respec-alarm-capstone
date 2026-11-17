// 기상 → 할 일 → 준비 → 출발 — 저장 · 다시 읽기 · 수정 · 다시 계산을 실제 서버 경로로 (요청 읽기 → buildPlan → 저장 검증 → persistAppointment, appointment-edit updateAppointment)
//   가짜 DB(fake-db.ts)에 저장된 참여 조건의 activity_plan을 다음 계산이 다시 읽는지까지 봄 — planDay만 부르는 시험이 아님
//   기준 예: 11/19(목) 10~11시 집에서 온라인 회의, 13시 학교 수업, 이동 40 · 여유 10 · 예측 준비 50(온보딩 첫 값) = 준비 전 20 + 외출 준비 30
//   → 기상 09:40 · 준비 11:40 · 출발 12:10 · 도착 목표 12:50
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertPersistable, persistAppointment } from './commit.ts';
import { updateAppointment, type EditCtx } from './edit-run.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { buildPlan } from './plan.ts';
import { toSuggestion, type ProfileRow } from './plan-core.ts';
import { Reader } from './read.ts';
import { readCommitRequest } from './requests.ts';
import type { Db } from './supabase.ts';

// buildPlan이 CatBoost 설정(PREPARE_ML_ENABLED)을 Deno.env로 읽음 — Node 시험에서는 설정 없음(꺼짐)으로
(globalThis as { Deno?: unknown }).Deno ??= { env: { get: () => undefined } };

const A = 'u-a';
const NOW = new Date('2026-11-18T21:00:00+09:00');
const iso = (local: string) => `${local}:00+09:00`;
const hm = (value: unknown) => new Date(value as string).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
const md = (value: unknown) => new Date(value as string).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).slice(5);
const HOME = { lat: 37.5547, lng: 126.9707 };
const SCHOOL = { lat: 37.5509, lng: 127.0736 };
const MEETING = { title: '온라인 회의', start: iso('2026-11-19T10:00'), end: iso('2026-11-19T11:00'), before_prepare: true };

function setup() {
  const db = new FakeDb();
  db.now = NOW;
  db.rows('profiles').push({ user_id: A, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng, default_prepare_minutes: 50 } satisfies ProfileRow & { user_id: string });
  return db;
}

const participant = (over: object = {}) => ({ origin: { name: '집', ...HOME }, transport_type: 'TRANSIT', est_travel_minutes: 40, travel_source: 'MANUAL', buffer_minutes: 10, ...over });
const newBody = (local: string, over: { participant?: object; manual_times?: object; recurrence_rule?: string; title?: string } = {}) => ({
  appointment: { title: over.title ?? '수업', appointment_at: iso(local), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL', ...(over.recurrence_rule ? { recurrence_rule: over.recurrence_rule } : {}) },
  participant: participant(over.participant),
  ...(over.manual_times ? { manual_times: over.manual_times } : {}),
});

// 이동시간은 확인 시트에서 사용자가 확인한 값(MANUAL)으로 저장 — 길찾기(API) 값은 다시 계산할 때 카카오를 다시 부르는 규칙(D5)이라 시험에 키가 없으면 근사값으로 바뀜
// alarm-suggest (미리 보기)
async function preview(db: FakeDb, body: object) {
  const r = Reader.root(body);
  const request = readCommitRequest(r);
  r.finish();
  if (request.type !== 'APPOINTMENT') throw new Error('약속 요청이어야 해요');
  const built = await buildPlan({ userId: A, db: db as unknown as Db, now: NOW }, request.draft, { mode: 'preview' });
  return { plan: built.plan, dto: toSuggestion(built.plan) };
}

// alarm-commit (index.ts와 같은 순서: 읽기 → 계산 → 저장 검증 → 쓰기)
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

const editCtx = (db: FakeDb): EditCtx => ({ userId: A, userDb: db as unknown as Db, service: db as unknown as Db, now: NOW });
const participantOf = (db: FakeDb, id: string) => db.rows('appointment_participants').find((p) => p.appointment_id === id)!;
const alarmsOf = (db: FakeDb, id: string) => {
  const pid = participantOf(db, id).participant_id;
  return db.rows('alarms').filter((a) => a.participant_id === pid);
};
const ORDER = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];
const lines = (db: FakeDb, id: string) =>
  alarmsOf(db, id)
    .sort((x, y) => ORDER.indexOf(x.alarm_type as string) - ORDER.indexOf(y.alarm_type as string))
    .map((a) => `${a.alarm_type} ${hm(a.scheduled_at)}`);
const previewLines = (dto: ReturnType<typeof toSuggestion>) => dto.alarms.map((a) => `${a.alarm_type} ${hm(a.scheduled_at)}`);
const storedItems = (db: FakeDb, id: string) => {
  const plan = participantOf(db, id).activity_plan as { lead_minutes: number; items: { title: string; start: string; end: string; before_prepare: boolean }[] } | null;
  return plan && { lead: plan.lead_minutes, items: plan.items.map((x) => `${x.title} ${md(x.start)} ${hm(x.start)}~${hm(x.end)} ${x.before_prepare ? '준비 전' : '준비 뒤'}`) };
};
const expectHttp = async (run: () => Promise<unknown>, code: string, detail?: Record<string, unknown>) => {
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.code, code);
    if (detail) for (const [k, v] of Object.entries(detail)) assert.deepEqual((e.details as Record<string, unknown>)?.[k], v, k);
    return true;
  });
};
const snap = (db: FakeDb) => JSON.stringify(['appointments', 'appointment_participants', 'alarms'].map((t) => db.rows(t)));

test('A. 최초 계산 · 저장: 기상 09:40 · 준비 11:40 · 출발 12:10 · 도착 목표 12:50, 할 일 계획이 참여 조건에 저장됨', async () => {
  const db = setup();
  const { dto } = await preview(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  assert.deepEqual(previewLines(dto), ['WAKE 09:40', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.deepEqual(storedItems(db, id), { lead: 20, items: ['온라인 회의 11-19 10:00~11:00 준비 전'] });
  assert.equal(participantOf(db, id).prepare_minutes, 150); // 이날 기상~출발 (저장 칸 뜻 그대로)
});

test('B. 저장 → 다시 읽기 → 같은 조건으로 다시 계산: 서버 재계산(칸 없음) · 앱이 저장된 값(준비 150 · 준비 전 120)을 그대로 보낸 경우 모두 시각 그대로', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  const ids = alarmsOf(db, id).map((a) => a.alarm_id).sort();
  // 서버가 저장된 할 일을 다시 읽음 (요청에 activities 칸 없음)
  const server = await preview(db, { appointment_id: id });
  assert.deepEqual(previewLines(server.dto), ['WAKE 09:40', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.deepEqual(server.plan.activityPlan?.items.map((x) => x.title), ['온라인 회의']);
  // 앱 H03처럼 저장된 값을 그대로 보내고 다시 저장 — 할 일이 지워지지 않고 알람 · 알람 id 그대로
  const echo = { appointment_id: id, participant: { ...participant(), prepare_minutes: 150, before_prepare_minutes: 120 } };
  assert.deepEqual(previewLines((await preview(db, echo)).dto), ['WAKE 09:40', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  await commit(db, echo);
  await commit(db, { appointment_id: id }); // 한 번 더
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.deepEqual(alarmsOf(db, id).map((a) => a.alarm_id).sort(), ids);
  assert.deepEqual(storedItems(db, id), { lead: 20, items: ['온라인 회의 11-19 10:00~11:00 준비 전'] });
});

test('C. 일정 수정: 수업 13시 → 14시면 회의 기상은 그대로, 준비 · 출발만 새 시각 기준 · 할 일 계획 유지. 날짜를 옮기면 할 일도 날짜만 따라감', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  const res = await updateAppointment(editCtx(db), { action: 'UPDATE', appointmentId: id, scope: 'this', patch: { at: new Date(iso('2026-11-19T14:00')) }, confirmed: true });
  assert.ok(res.saved);
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 12:40', 'DEPARTURE 13:10', 'ARRIVE 13:50']);
  assert.deepEqual(storedItems(db, id), { lead: 20, items: ['온라인 회의 11-19 10:00~11:00 준비 전'] });
  // 다음 날 같은 시각으로 — 회의도 11/20 10시로
  await updateAppointment(editCtx(db), { action: 'UPDATE', appointmentId: id, scope: 'this', patch: { at: new Date(iso('2026-11-20T14:00')) }, confirmed: true });
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 12:40', 'DEPARTURE 13:10', 'ARRIVE 13:50']);
  assert.deepEqual(alarmsOf(db, id).map((a) => md(a.scheduled_at)), ['11-20', '11-20', '11-20', '11-20']);
  assert.deepEqual(storedItems(db, id), { lead: 20, items: ['온라인 회의 11-20 10:00~11:00 준비 전'] });
});

test('D. 할 일 수정: 회의 끝을 11시 → 12시로 바꾸면 준비 시간이 20분 모자람 — 미리 보기는 이유, 저장은 UNPROCESSABLE이고 아무것도 안 씀', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  const late = { appointment_id: id, participant: { activities: [{ ...MEETING, end: iso('2026-11-19T12:00') }] } };
  const { dto } = await preview(db, late);
  assert.deepEqual(dto.check, { ok: false, reason: 'ACTIVITY', message: '할 일이 끝나고 준비할 시간이 20분 모자라요', detail: { activity_reason: 'NO_TIME_TO_PREPARE', index: 0, shortMinutes: 20 } });
  const before = snap(db);
  await expectHttp(() => commit(db, late), 'UNPROCESSABLE', { reason: 'ACTIVITY', activity_reason: 'NO_TIME_TO_PREPARE', shortMinutes: 20 });
  assert.equal(snap(db), before);
  // 11:30까지면 준비 11:40 전에 끝나서 저장됨 — 기상은 그대로
  await commit(db, { appointment_id: id, participant: { activities: [{ ...MEETING, end: iso('2026-11-19T11:30') }] } });
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.deepEqual(storedItems(db, id)?.items, ['온라인 회의 11-19 10:00~11:30 준비 전']);
});

test('E. 할 일 지우기(activities: []): 계획이 비고 다시 살아나지 않음, 알람은 할 일 없는 계산(기상 11:20)으로 같은 알람 행을 고침', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  const ids = alarmsOf(db, id).map((a) => a.alarm_id).sort();
  await commit(db, { appointment_id: id, participant: { activities: [] } });
  assert.equal(participantOf(db, id).activity_plan, null);
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.deepEqual(alarmsOf(db, id).map((a) => a.alarm_id).sort(), ids); // 새 행 없이 고침 — 겹치는 알람 없음
  await commit(db, { appointment_id: id }); // 다시 계산해도 할 일이 돌아오지 않음
  await updateAppointment(editCtx(db), { action: 'UPDATE', appointmentId: id, scope: 'this', patch: { at: new Date(iso('2026-11-19T13:30')) }, confirmed: true });
  assert.equal(participantOf(db, id).activity_plan, null);
  assert.deepEqual(lines(db, id), ['WAKE 11:50', 'PREPARE 12:10', 'DEPARTURE 12:40', 'ARRIVE 13:20']);
});

test('H. 오전 할 일 + 저녁 일정: 18시 외부 일정이어도 10시 회의 기상(09:40)은 남고, 준비 · 출발은 저녁 일정 기준', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T18:00', { title: '외부 일정', participant: { activities: [MEETING] } }));
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 16:40', 'DEPARTURE 17:10', 'ARRIVE 17:50']);
});

test('상황 3. 저녁 일정만 있으면 기존 저녁 기상 제외 규칙 그대로 (기상 없음, 준비 15분)', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T18:00', { title: '외부 일정' }));
  assert.deepEqual(lines(db, id), ['PREPARE 16:55', 'DEPARTURE 17:10', 'ARRIVE 17:50']);
  assert.equal(participantOf(db, id).activity_plan, null);
});

test('상황 4. 같은 날 앞 일정의 기상이 이미 있으면 기상을 더 만들지 않음 — 그 기상이 회의보다 늦으면 이유를 알려 주고 저장 안 함', async () => {
  const db = setup();
  await commit(db, newBody('2026-11-19T09:00', { title: '아침 약속' })); // 기상 07:20
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  assert.deepEqual(lines(db, id), ['PREPARE 11:55', 'DEPARTURE 12:10', 'ARRIVE 12:50']); // 그날 두 번째 일정: 준비 15분, 회의 뒤
  // 앞 일정이 12시(기상 10:20 = 12:00 − 여유 10 − 이동 40 − 준비 50)면 이미 일어나 있을 시각이 10시 회의보다 늦음
  const db2 = setup();
  await commit(db2, newBody('2026-11-19T12:00', { title: '점심 약속' }));
  const body = newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } });
  const { dto } = await preview(db2, body);
  assert.deepEqual(dto.check, { ok: false, reason: 'ACTIVITY', message: '기상이 할 일 시작보다 20분 늦어요', detail: { activity_reason: 'WAKE_AFTER_ACTIVITY', index: 0, shortMinutes: 20 } });
  await expectHttp(() => commit(db2, body), 'UNPROCESSABLE', { activity_reason: 'WAKE_AFTER_ACTIVITY' });
});

test('5. 회의 전에 준비를 마침(준비 뒤 할 일): 준비 10:30 → 회의 11~12시 → 출발 12:10', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [{ ...MEETING, start: iso('2026-11-19T11:00'), end: iso('2026-11-19T12:00'), before_prepare: false }] } }));
  assert.deepEqual(lines(db, id), ['WAKE 10:10', 'PREPARE 10:30', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
});

test('5. 직접 고른 준비 시각 · 받아들인 준비 알람 당김이 준비 알람을 회의 안으로 밀면 실패, 회의 뒤면 그대로 반영', async () => {
  const db = setup();
  const manual = newBody('2026-11-19T13:00', { participant: { activities: [MEETING] }, manual_times: { PREPARE: iso('2026-11-19T10:30') } });
  await expectHttp(() => commit(db, manual), 'UNPROCESSABLE', { activity_reason: 'NO_TIME_TO_PREPARE', shortMinutes: 30 });
  const okManual = newBody('2026-11-19T13:00', { participant: { activities: [MEETING] }, manual_times: { PREPARE: iso('2026-11-19T11:20') } });
  const id = await commit(db, okManual);
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 11:20', 'DEPARTURE 12:10', 'ARRIVE 12:50']);

  const db2 = setup();
  const id2 = await commit(db2, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  participantOf(db2, id2).prepare_advance_minutes = 10; // 당김 10분 — 준비 11:30, 회의 뒤라 그대로
  assert.deepEqual(previewLines((await preview(db2, { appointment_id: id2 })).dto), ['WAKE 09:40', 'PREPARE 11:30', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  participantOf(db2, id2).prepare_advance_minutes = 60; // 당김 60분 — 준비 10:40은 회의 중 → 실패, 기상을 더 당기지 않음
  const { dto } = await preview(db2, { appointment_id: id2 });
  assert.deepEqual(dto.check, { ok: false, reason: 'ACTIVITY', message: '할 일이 끝나고 준비할 시간이 20분 모자라요', detail: { activity_reason: 'NO_TIME_TO_PREPARE', index: 0, shortMinutes: 20 } });
  assert.equal(previewLines(dto)[0], 'WAKE 09:40');
});

test('반복 일정 + 할 일은 받지 않음 (요청 단계 VALIDATION_FAILED) — 할 일은 그날 시각이라 다음 회차로 옮길 규칙이 아직 없음', async () => {
  const db = setup();
  await expectHttp(() => commit(db, newBody('2026-11-19T13:00', { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH', participant: { activities: [MEETING] } })), 'VALIDATION_FAILED');
  assert.equal(db.rows('appointments').length, 0);
});

test('I. 할 일 없는 일반 일정은 그대로 (기상 11:20 · 준비 11:40), activity_plan은 비어 있음, 다시 계산해도 같음', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00'));
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.equal(participantOf(db, id).activity_plan, null);
  await commit(db, { appointment_id: id, participant: { ...participant(), prepare_minutes: 50, before_prepare_minutes: 20 } });
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
});
