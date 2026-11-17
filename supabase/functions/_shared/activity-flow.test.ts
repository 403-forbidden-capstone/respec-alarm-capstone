// 기상 → 할 일 → 준비 → 출발 — 저장 · 다시 읽기 · 수정 · 다시 계산을 실제 서버 경로로 (요청 읽기 → buildPlan → 저장 검증 → persistAppointment, appointment-edit updateAppointment)
//   가짜 DB(fake-db.ts)에 저장된 참여 조건의 activity_plan을 다음 계산이 다시 읽는지까지 봄 — planDay만 부르는 시험이 아님
//   기준 예: 11/19(목) 10~11시 집에서 온라인 회의, 13시 학교 수업, 이동 40 · 여유 10 · 예측 준비 50(온보딩 첫 값) = 준비 전 20 + 외출 준비 30
//   → 기상 09:40 · 준비 11:40 · 출발 12:10 · 도착 목표 12:50
//   지키는 것: 기상 알람을 만들지는 기존 규칙 그대로(시각만 할 일에 맞춤) · 준비 예측(prepare_minutes)에 할 일 시간을 더하지 않음
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

// buildPlan이 CatBoost 설정(PREPARE_ML_ENABLED)을 Deno.env로 읽음 — Node 시험에서는 설정 없음(꺼짐 = 기존 P80 계산)으로
(globalThis as { Deno?: unknown }).Deno ??= { env: { get: () => undefined } };

const A = 'u-a';
const NOW = new Date('2026-11-18T21:00:00+09:00');
const iso = (local: string) => `${local}:00+09:00`;
const hm = (value: unknown) => new Date(value as string).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
const md = (value: unknown) => new Date(value as string).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).slice(5);
const HOME = { lat: 37.5547, lng: 126.9707 };
const SCHOOL = { lat: 37.5509, lng: 127.0736 };
const MEETING = { title: '온라인 회의', start: iso('2026-11-19T10:00'), end: iso('2026-11-19T11:00'), before_prepare: true };
const NO_TIME = (title: string, minutes: number) => `'${title}' 끝나는 시각이 외출 준비 시작보다 ${minutes}분 늦어요. 준비를 할 일 전에 할지, 일정을 조정할지 정해 주세요`;

function setup(records: number[] = []) {
  const db = new FakeDb();
  db.now = NOW;
  db.rows('profiles').push({ user_id: A, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng, default_prepare_minutes: 50 } satisfies ProfileRow & { user_id: string });
  // 내 기상~출발 기록 (기존 P80 학습 입력 그대로)
  records.forEach((m, k) => db.rows('daily_records').push({ record_id: `r${k}`, user_id: A, record_date: `2026-11-${String(k + 1).padStart(2, '0')}`, actual_prepare_minutes: m }));
  return db;
}

// 이동시간은 확인 시트에서 사용자가 확인한 값(MANUAL)으로 저장 — 길찾기(API) 값은 다시 계산할 때 카카오를 다시 부르는 규칙(D5)이라 시험에 키가 없으면 근사값으로 바뀜
const participant = (over: object = {}) => ({ origin: { name: '집', ...HOME }, transport_type: 'TRANSIT', est_travel_minutes: 40, travel_source: 'MANUAL', buffer_minutes: 10, ...over });
const newBody = (local: string, over: { participant?: object; manual_times?: object; recurrence_rule?: string; title?: string; travel?: number } = {}) => ({
  appointment: { title: over.title ?? '수업', appointment_at: iso(local), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL', ...(over.recurrence_rule ? { recurrence_rule: over.recurrence_rule } : {}) },
  participant: participant({ ...(over.travel != null ? { est_travel_minutes: over.travel } : {}), ...over.participant }),
  ...(over.manual_times ? { manual_times: over.manual_times } : {}),
});

const readDraft = (body: object) => {
  const r = Reader.root(body);
  const request = readCommitRequest(r);
  r.finish(); // index.ts와 같이 — 요청 문제는 여기서 VALIDATION_FAILED
  if (request.type !== 'APPOINTMENT') throw new Error('약속 요청이어야 해요');
  return request;
};
// alarm-suggest (미리 보기)
async function preview(db: FakeDb, body: object) {
  const built = await buildPlan({ userId: A, db: db as unknown as Db, now: NOW }, readDraft(body).draft, { mode: 'preview' });
  return { plan: built.plan, dto: toSuggestion(built.plan) };
}
// alarm-commit (index.ts와 같은 순서: 읽기 → 계산 → 저장 검증 → 쓰기)
async function commit(db: FakeDb, body: object): Promise<string> {
  const request = readDraft(body);
  const d = db as unknown as Db;
  const built = await buildPlan({ userId: A, db: d, now: NOW }, request.draft);
  assertPersistable(built.plan);
  const saved = await persistAppointment({ userId: A, userDb: d, service: d, now: NOW }, {
    plan: built.plan, inputs: built.inputs, created: request.appointment, draft: request.draft, replaceExisting: request.replaceExisting, edits: [], timeZone: built.timeZone,
  });
  return saved.appointment_id;
}
const edit = (db: FakeDb, id: string, at: string) =>
  updateAppointment({ userId: A, userDb: db as unknown as Db, service: db as unknown as Db, now: NOW } satisfies EditCtx, { action: 'UPDATE', appointmentId: id, scope: 'this', patch: { at: new Date(iso(at)) }, confirmed: true });

const participantOf = (db: FakeDb, id: string) => db.rows('appointment_participants').find((p) => p.appointment_id === id)!;
const alarmsOf = (db: FakeDb, id: string) => db.rows('alarms').filter((a) => a.participant_id === participantOf(db, id).participant_id);
const ORDER = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];
const lines = (db: FakeDb, id: string) =>
  alarmsOf(db, id)
    .sort((x, y) => ORDER.indexOf(x.alarm_type as string) - ORDER.indexOf(y.alarm_type as string))
    .map((a) => `${a.alarm_type} ${hm(a.scheduled_at)}`);
const previewLines = (dto: ReturnType<typeof toSuggestion>) => dto.alarms.map((a) => `${a.alarm_type} ${hm(a.scheduled_at)}`);
const stored = (db: FakeDb, id: string) => {
  const plan = participantOf(db, id).activity_plan as { lead_minutes: number; outing_prepare_minutes?: number; items: { title: string; start: string; end: string; before_prepare: boolean }[] } | null;
  return plan && {
    lead: plan.lead_minutes,
    ...(plan.outing_prepare_minutes != null ? { outing: plan.outing_prepare_minutes } : {}),
    items: plan.items.map((x) => `${x.title} ${md(x.start)} ${hm(x.start)}~${hm(x.end)} ${x.before_prepare ? '준비 전' : '준비 뒤'}`),
  };
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
const BASE = ['WAKE 09:40', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50'];

test('A. 일반 일정(할 일 없음): 기존 계산 그대로 — 기상 11:20 · 준비 11:40, 준비 예측 50 저장, 할 일 계획 없음, 다시 계산해도 같음', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00'));
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.deepEqual([participantOf(db, id).prepare_minutes, participantOf(db, id).activity_plan], [50, null]);
  await commit(db, { appointment_id: id, participant: { ...participant(), prepare_minutes: 50, before_prepare_minutes: 20 } }); // 앱 H03 다시 저장
  await commit(db, { appointment_id: id });
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
});

test('B. 약속 전에 할 일: 기상 09:40 · 회의 10~11 · 준비 11:40 · 출발 12:10 — 준비 예측 · 준비 전 시간은 50 · 20 그대로(회의 60분을 안 더함)', async () => {
  const db = setup();
  const body = newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } });
  const { dto } = await preview(db, body);
  assert.deepEqual(previewLines(dto), BASE);
  assert.deepEqual([dto.prepare.minutes, dto.prepare.auto_minutes, dto.prepare.before_prepare_minutes, dto.with_wake], [50, 50, 20, true]);
  const id = await commit(db, body);
  assert.deepEqual(lines(db, id), BASE);
  assert.equal(participantOf(db, id).prepare_minutes, 50);
  assert.deepEqual(stored(db, id), { lead: 20, items: ['온라인 회의 11-19 10:00~11:00 준비 전'] });
});

test('B2. 할 일이 여럿 · 외출 준비를 직접 말한 경우: 외출 준비 30분은 따로 쓰고 모델 예측(65)은 그대로', async () => {
  const db = setup([80, 80, 80, 80, 80, 80, 80, 80, 80, 80]); // 예측 = 50 + 보정 15 = 65 (기존 P80 계산)
  const homework = { title: '과제 제출', start: iso('2026-11-19T11:10'), end: iso('2026-11-19T11:30'), before_prepare: true };
  const predicted = await preview(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING, homework] } }));
  // 외출 준비를 말하지 않으면 예측에서 나눈 45분(65 − 20) → 준비 11:25는 과제(~11:30)와 부딪쳐 확인 필요
  assert.deepEqual((predicted.dto.check as { detail?: object }).detail, { activity_reason: 'NO_TIME_TO_PREPARE', index: 1, shortMinutes: 5, activity_title: '과제 제출', ask: ['before_prepare', 'end', 'appointment_at'] });
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING, homework], outing_prepare_minutes: 30 } }));
  assert.deepEqual(lines(db, id), BASE);
  assert.equal(participantOf(db, id).prepare_minutes, 65);
  assert.deepEqual(stored(db, id), { lead: 20, outing: 30, items: ['온라인 회의 11-19 10:00~11:00 준비 전', '과제 제출 11-19 11:10~11:30 준비 전'] });
});

test('C. 회의 끝이 11시 → 12시: 준비 시간 그대로 · 준비 알람을 당기지 않고 충돌 · 확인할 칸을 돌려줌, 저장은 막고 아무것도 안 씀', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  const late = { appointment_id: id, participant: { activities: [{ ...MEETING, end: iso('2026-11-19T12:00') }] } };
  const { dto } = await preview(db, late);
  assert.deepEqual(dto.check, {
    ok: false,
    reason: 'ACTIVITY',
    message: NO_TIME('온라인 회의', 20),
    detail: { activity_reason: 'NO_TIME_TO_PREPARE', index: 0, shortMinutes: 20, activity_title: '온라인 회의', ask: ['before_prepare', 'end', 'appointment_at'] },
  });
  assert.equal(previewLines(dto)[1], 'PREPARE 11:40'); // 준비 알람은 출발 − 준비 그대로 (줄이거나 당기지 않음)
  assert.equal(dto.prepare.minutes, 50);
  const before = snap(db);
  await expectHttp(() => commit(db, late), 'UNPROCESSABLE', { reason: 'ACTIVITY', activity_reason: 'NO_TIME_TO_PREPARE', shortMinutes: 20, activity_title: '온라인 회의' });
  assert.equal(snap(db), before);
});

test('D. 저장 → 다시 읽기 → 일정 시각 수정 → 다시 계산: 할 일이 남고 준비 예측은 50 그대로(중복 반영 없음)', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  const ids = alarmsOf(db, id).map((a) => a.alarm_id).sort();
  // 서버가 저장된 할 일을 다시 읽음 (요청에 activities 칸 없음)
  const again = await preview(db, { appointment_id: id });
  assert.deepEqual(previewLines(again.dto), BASE);
  assert.deepEqual(again.plan.activityPlan?.items.map((x) => x.title), ['온라인 회의']);
  // 앱 H03이 저장된 값(준비 예측 50, 알람 간격으로 읽은 준비 전 120)을 그대로 보내도 같은 시각 — 간격은 저장된 lead(20)로 대신함
  const echo = { appointment_id: id, participant: { ...participant(), prepare_minutes: 50, before_prepare_minutes: 120 } };
  assert.deepEqual(previewLines((await preview(db, echo)).dto), BASE);
  await commit(db, echo);
  await commit(db, { appointment_id: id });
  assert.deepEqual(lines(db, id), BASE);
  assert.deepEqual(alarmsOf(db, id).map((a) => a.alarm_id).sort(), ids);
  assert.equal(participantOf(db, id).prepare_minutes, 50);
  // 수업 13시 → 13시 30분 (appointment-edit): 회의 기상 그대로, 준비 · 출발만 새 시각 기준
  assert.ok((await edit(db, id, '2026-11-19T13:30')).saved);
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 12:10', 'DEPARTURE 12:40', 'ARRIVE 13:20']);
  assert.deepEqual([participantOf(db, id).prepare_minutes, stored(db, id)], [50, { lead: 20, items: ['온라인 회의 11-19 10:00~11:00 준비 전'] }]);
  // 다음 날로 옮기면 할 일도 날짜만 따라감
  await edit(db, id, '2026-11-20T13:30');
  assert.deepEqual(lines(db, id), ['WAKE 09:40', 'PREPARE 12:10', 'DEPARTURE 12:40', 'ARRIVE 13:20']);
  assert.deepEqual(alarmsOf(db, id).map((a) => md(a.scheduled_at)), ['11-20', '11-20', '11-20', '11-20']);
  assert.deepEqual(stored(db, id)?.items, ['온라인 회의 11-20 10:00~11:00 준비 전']);
  // 14시로 옮기면 기존 저녁 규칙(할 일 없이 계산한 기상 12:20 ≥ 12시)으로 이 일정에 기상 알람이 없음 → 새로 만들지 않고 확인 필요, 아무것도 안 씀
  const before = snap(db);
  await expectHttp(() => edit(db, id, '2026-11-20T14:00'), 'UNPROCESSABLE', { reason: 'ACTIVITY', activity_reason: 'NO_WAKE_ALARM', ask: ['with_wake'] });
  assert.equal(snap(db), before);
  assert.equal(participantOf(db, id).prepare_minutes, 50);
});

test('D2. 할 일 지우기(activities: []): 계획이 비고 다시 살아나지 않음, 할 일 없는 계산(기상 11:20)으로 같은 알람 행을 고침', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  const ids = alarmsOf(db, id).map((a) => a.alarm_id).sort();
  await commit(db, { appointment_id: id, participant: { activities: [] } });
  assert.equal(participantOf(db, id).activity_plan, null);
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.deepEqual(alarmsOf(db, id).map((a) => a.alarm_id).sort(), ids);
  await commit(db, { appointment_id: id });
  await edit(db, id, '2026-11-19T13:30');
  assert.equal(participantOf(db, id).activity_plan, null);
  assert.deepEqual(lines(db, id), ['WAKE 11:50', 'PREPARE 12:10', 'DEPARTURE 12:40', 'ARRIVE 13:20']);
});

test('E. 같은 날 여러 일정: 오전 회의(일정) + 오후 수업 — 기상 알람은 기존 규칙대로 하루 하나', async () => {
  const db = setup();
  const meeting = await commit(db, newBody('2026-11-19T10:00', { title: '온라인 회의', travel: 0 }));
  const lecture = await commit(db, newBody('2026-11-19T13:00'));
  assert.deepEqual(lines(db, meeting), ['WAKE 09:00', 'PREPARE 09:20', 'DEPARTURE 09:50', 'ARRIVE 09:50']);
  assert.deepEqual(lines(db, lecture), ['PREPARE 11:55', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  assert.equal(db.rows('alarms').filter((a) => a.alarm_type === 'WAKE').length, 1);
});

test('E2. 같은 날 앞 일정의 기상이 있으면 할 일이 있어도 기상을 더 만들지 않음 — 그 기상이 회의보다 늦으면 확인 필요로 저장 안 함', async () => {
  const db = setup();
  await commit(db, newBody('2026-11-19T09:00', { title: '아침 약속' })); // 기상 07:20
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  assert.deepEqual(lines(db, id), ['PREPARE 11:55', 'DEPARTURE 12:10', 'ARRIVE 12:50']); // 그날 두 번째 일정: 기존 준비 15분, 회의 뒤
  assert.equal(db.rows('alarms').filter((a) => a.alarm_type === 'WAKE').length, 1);

  const db2 = setup();
  await commit(db2, newBody('2026-11-19T12:00', { title: '점심 약속' })); // 기상 10:20 = 12:00 − 10 − 40 − 50
  const body = newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } });
  const { dto } = await preview(db2, body);
  assert.deepEqual(dto.check, {
    ok: false, reason: 'ACTIVITY', message: "기상 알람이 '온라인 회의' 시작보다 20분 늦어요",
    detail: { activity_reason: 'WAKE_AFTER_ACTIVITY', index: 0, shortMinutes: 20, activity_title: '온라인 회의', ask: ['wake'] },
  });
  await expectHttp(() => commit(db2, body), 'UNPROCESSABLE', { activity_reason: 'WAKE_AFTER_ACTIVITY' });
  assert.equal(db2.rows('alarms').filter((a) => a.alarm_type === 'WAKE').length, 1);
});

test('H. 오전 할 일 + 저녁 일정: 기존 저녁 규칙으로 기상이 없으면 새로 만들지 않고 확인 필요(with_wake) — with_wake: true로 답하면 기상 09:40', async () => {
  const db = setup();
  const body = newBody('2026-11-19T18:00', { title: '외부 일정', participant: { activities: [MEETING] } });
  const { dto } = await preview(db, body);
  assert.equal(dto.with_wake, false); // 기상 알람 여부는 기존 규칙 그대로
  assert.deepEqual(dto.check, {
    ok: false, reason: 'ACTIVITY', message: "이 일정에는 기상 알람이 없어서 '온라인 회의' 전에 깨워 드리지 않아요. 기상 알람을 만들지 정해 주세요",
    detail: { activity_reason: 'NO_WAKE_ALARM', index: 0, shortMinutes: 0, activity_title: '온라인 회의', ask: ['with_wake'] },
  });
  await expectHttp(() => commit(db, body), 'UNPROCESSABLE', { activity_reason: 'NO_WAKE_ALARM' });
  assert.equal(db.rows('alarms').length, 0);
  const yes = await commit(db, newBody('2026-11-19T18:00', { title: '외부 일정', participant: { activities: [MEETING], with_wake: true } }));
  assert.deepEqual(lines(db, yes), ['WAKE 09:40', 'PREPARE 16:40', 'DEPARTURE 17:10', 'ARRIVE 17:50']);
});

test('H2. 저녁 일정만 있으면 기존 저녁 기상 제외 그대로 (기상 없음, 준비 15분)', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T18:00', { title: '외부 일정' }));
  assert.deepEqual(lines(db, id), ['PREPARE 16:55', 'DEPARTURE 17:10', 'ARRIVE 17:50']);
});

test('H3. 자정 넘김: 11/20 01:00 약속 · 11/19 22~23시 회의 → 기상 11/19 21:40', async () => {
  const db = setup();
  const night = { title: '야간 회의', start: iso('2026-11-19T22:00'), end: iso('2026-11-19T23:00'), before_prepare: true };
  const id = await commit(db, newBody('2026-11-20T01:00', { participant: { activities: [night] } }));
  assert.deepEqual(lines(db, id), ['WAKE 21:40', 'PREPARE 23:40', 'DEPARTURE 00:10', 'ARRIVE 00:50']);
  assert.deepEqual(alarmsOf(db, id).map((a) => md(a.scheduled_at)).sort(), ['11-19', '11-19', '11-20', '11-20']);
});

test('H4. 회의 전에 준비를 마침(준비 뒤 할 일): 준비 10:30 → 회의 11~12시 → 출발 12:10', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [{ ...MEETING, start: iso('2026-11-19T11:00'), end: iso('2026-11-19T12:00'), before_prepare: false }] } }));
  assert.deepEqual(lines(db, id), ['WAKE 10:10', 'PREPARE 10:30', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
});

test('H5. 직접 고른 기상 · 준비 시각은 기존 우선순위 그대로, 최종 시각이 할 일과 부딪치면 저장 안 함', async () => {
  const db = setup();
  // 직접 고른 기상 09:30 — 기존 규칙대로 준비 알람도 기상을 따라 같은 간격(11:30)
  const wake = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] }, manual_times: { WAKE: iso('2026-11-19T09:30') } }));
  assert.deepEqual(lines(db, wake), ['WAKE 09:30', 'PREPARE 11:30', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  await expectHttp(() => commit(setup(), newBody('2026-11-19T13:00', { participant: { activities: [MEETING] }, manual_times: { WAKE: iso('2026-11-19T10:30') } })), 'UNPROCESSABLE', { activity_reason: 'WAKE_AFTER_ACTIVITY', shortMinutes: 30 });
  // 직접 고른 준비 — 회의 중(10:30)이면 막고, 회의 뒤(11:20)면 그대로
  await expectHttp(() => commit(setup(), newBody('2026-11-19T13:00', { participant: { activities: [MEETING] }, manual_times: { PREPARE: iso('2026-11-19T10:30') } })), 'UNPROCESSABLE', { activity_reason: 'NO_TIME_TO_PREPARE', shortMinutes: 30 });
  const db2 = setup();
  const prep = await commit(db2, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] }, manual_times: { PREPARE: iso('2026-11-19T11:20') } }));
  assert.deepEqual(lines(db2, prep), ['WAKE 09:40', 'PREPARE 11:20', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
});

test('H6. 받아들인 준비 알람 당김(prepare_advance_minutes): 기존대로 준비 알람을 당기되, 회의 안으로 들어가면 실패하고 기상을 더 당기지 않음', async () => {
  const db = setup();
  const id = await commit(db, newBody('2026-11-19T13:00', { participant: { activities: [MEETING] } }));
  participantOf(db, id).prepare_advance_minutes = 10;
  assert.deepEqual(previewLines((await preview(db, { appointment_id: id })).dto), ['WAKE 09:40', 'PREPARE 11:30', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
  participantOf(db, id).prepare_advance_minutes = 60;
  const { dto } = await preview(db, { appointment_id: id });
  assert.equal((dto.check as { detail?: { activity_reason?: string; shortMinutes?: number } }).detail?.activity_reason, 'NO_TIME_TO_PREPARE');
  assert.equal((dto.check as { detail?: { shortMinutes?: number } }).detail?.shortMinutes, 20);
  assert.equal(previewLines(dto)[0], 'WAKE 09:40');
});

test('H7. 반복 일정 + 할 일은 받지 않음 (요청 단계 VALIDATION_FAILED, 아무것도 안 씀) — 할 일이 없는 반복 일정은 그대로', async () => {
  const db = setup();
  await expectHttp(() => commit(db, newBody('2026-11-19T13:00', { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH', participant: { activities: [MEETING] } })), 'VALIDATION_FAILED');
  assert.equal(db.rows('appointments').length, 0);
  const id = await commit(db, newBody('2026-11-19T13:00', { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' }));
  assert.deepEqual(lines(db, id), ['WAKE 11:20', 'PREPARE 11:40', 'DEPARTURE 12:10', 'ARRIVE 12:50']);
});
