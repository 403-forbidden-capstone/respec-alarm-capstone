// alarm-commit의 쓰기 순서 · 응답 · 되돌리기 — 가짜 DB(fake-db.ts)로 시험
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertPersistable, commitStandalone, persistAppointment, type CommitCtx } from './commit.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { computePlan, type AlarmRow, type AppointmentRow, type ParticipantRow, type PlanDraft, type PlanInputs, type ProfileRow } from './plan-core.ts';
import type { ResolvedTravel } from './route.ts';
import type { Db } from './supabase.ts';

const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
const hm = (iso: unknown) => {
  const d = new Date(iso as string);
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const USER = 'u-me';
// 일부러 낸 DB 오류의 서버 로그가 시험 출력에 안 섞이게
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};
const NOW = kst(22, 400); // 6:40
const profile: ProfileRow = { timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: 37.5, home_lng: 127.0 };
const api: ResolvedTravel = {
  chosen: { minutes: 50, source: 'API', needsConfirmation: false, note: '' },
  auto: { minutes: 50, source: 'API', needsConfirmation: false, note: '' },
  warnings: [],
};

function setup() {
  const db = new FakeDb();
  const ctx: CommitCtx = { userId: USER, userDb: db as unknown as Db, service: db as unknown as Db, now: NOW };
  return { db, ctx };
}
const newDraft = (over: Partial<PlanDraft> = {}): PlanDraft => ({
  at: kst(22, 600),
  destination: { name: '세종대학교', lat: 37.55, lng: 127.07 },
  travelMinutes: 50,
  travelSource: 'API',
  prepareMinutes: 60,
  beforePrepareMinutes: 30,
  ...over,
});
const inputsOf = (draft: PlanDraft, over: Partial<PlanInputs> = {}): PlanInputs => ({
  now: NOW,
  draft,
  profile,
  existingAlarms: [],
  stats: { sampleCount: 0, p80: null },
  lateCount4w: 1,
  sameDayWake: false,
  ...over,
});
const commitArgs = (draft: PlanDraft, over: Partial<Parameters<typeof persistAppointment>[1]> = {}, inputOver: Partial<PlanInputs> = {}) => {
  const inputs = inputsOf(draft, inputOver);
  const plan = computePlan(inputs, api);
  return { plan, inputs, created: { title: '팀 주간회의', recurrenceRule: 'FREQ=WEEKLY;BYDAY=TH' }, draft, replaceExisting: true, edits: [], timeZone: 'Asia/Seoul', ...over };
};

test('새 약속: 약속 · 참여 조건 · 알람 4개를 만들고 예약 꾸러미를 돌려줌', async () => {
  const { db, ctx } = setup();
  const body = await persistAppointment(ctx, commitArgs(newDraft()));

  const [appointment] = db.rows('appointments');
  assert.deepEqual([appointment.creator_id, appointment.title, appointment.dest_name, appointment.importance, appointment.recurrence_rule, appointment.group_id], [USER, '팀 주간회의', '세종대학교', 'NORMAL', 'FREQ=WEEKLY;BYDAY=TH', null]);
  const [participant] = db.rows('appointment_participants');
  assert.deepEqual(
    [participant.appointment_id, participant.user_id, participant.est_travel_minutes, participant.travel_source, participant.prepare_minutes, participant.buffer_minutes, participant.transport_type],
    [appointment.appointment_id, USER, 50, 'API', 60, 10, 'TRANSIT'],
  );
  assert.deepEqual(db.rows('alarms').map((a) => `${a.alarm_type} ${hm(a.scheduled_at)} ${a.is_enabled} ${a.time_source}/${a.intensity_source}`), [
    'WAKE 08:00 true AUTO/AUTO',
    'PREPARE 08:30 true AUTO/AUTO',
    'DEPARTURE 09:00 true AUTO/AUTO',
    'ARRIVE 09:50 true AUTO/AUTO',
  ]);
  assert.ok(db.rows('alarms').every((a) => a.user_id === USER && a.participant_id === participant.participant_id));

  assert.equal(body.appointment_id, appointment.appointment_id);
  assert.equal(body.participant_id, participant.participant_id);
  assert.deepEqual(body.ring_packages.map((p) => [p.type, hm(new Date(p.atMillis).toISOString())]), [['WAKE', '08:00'], ['PREPARE', '08:30'], ['DEPARTURE', '09:00'], ['ARRIVE', '09:50']]);
  assert.equal(body.ring_packages[0].subtitle, '오전 10:00 · 세종대학교');
  assert.equal(body.ring_packages[0].title, '팀 주간회의');
  assert.equal(body.ring_packages[0].departAt, kst(22, 540).getTime());
  assert.deepEqual(body.canceled_alarm_ids, []);
});

test('새 약속: destination의 radiusM이 appointments.dest_radius_m으로 저장됨, 없으면 null', async () => {
  const withRadius = setup();
  await persistAppointment(withRadius.ctx, commitArgs(newDraft({ destination: { name: '세종대학교', lat: 37.55, lng: 127.07, radiusM: 250 } })));
  assert.equal(withRadius.db.rows('appointments')[0].dest_radius_m, 250);

  const none = setup();
  await persistAppointment(none.ctx, commitArgs(newDraft()));
  assert.equal(none.db.rows('appointments')[0].dest_radius_m, null);
});

test('직접 고른 시각 · 강도는 MANUAL로, 고친 값 기록에 알람 id가 붙음', async () => {
  const { db, ctx } = setup();
  const draft = newDraft({ manualTimes: { WAKE: kst(22, 450) }, levels: { vibration: 2 } });
  await persistAppointment(ctx, commitArgs(draft, { edits: [{ screen: 'H05', field: 'scheduled_at', alarmType: 'WAKE', autoValue: 'a', editedValue: 'b' }, { screen: 'H05', field: 'buffer_minutes', autoValue: 10, editedValue: 15 }] }));

  const wake = db.rows('alarms').find((a) => a.alarm_type === 'WAKE')!;
  // 진동을 직접 고르면 vibration 칸에, intensity(전체 세기)는 자동(보통) 그대로
  assert.deepEqual([hm(wake.scheduled_at), wake.time_source, wake.intensity_source, wake.intensity, wake.vibration], ['07:30', 'MANUAL', 'MANUAL', 'NORMAL', 'STRONG_CONTINUOUS']);
  assert.equal(db.rows('alarms').find((a) => a.alarm_type === 'PREPARE')!.vibration, 'STRONG_CONTINUOUS'); // 한 일정의 강도라 모든 종류에 같은 값
  assert.equal(db.rows('alarms').find((a) => a.alarm_type === 'PREPARE')!.time_source, 'AUTO');

  const logs = db.rows('user_edit_logs');
  assert.equal(logs.length, 2);
  assert.deepEqual([logs[0].alarm_id, logs[0].alarm_type, logs[0].user_id, logs[0].appointment_id], [wake.alarm_id, 'WAKE', USER, db.rows('appointments')[0].appointment_id]);
  assert.equal(logs[1].alarm_id, null);
});

test('같은 약속을 다시 저장: 있던 알람은 고치고, 빠진 종류는 지우고, 지운 알람은 canceled_alarm_ids로', async () => {
  const { db, ctx } = setup();
  const first = await persistAppointment(ctx, commitArgs(newDraft()));
  const appointment = db.rows('appointments')[0] as unknown as AppointmentRow;
  const participant = db.rows('appointment_participants')[0] as unknown as ParticipantRow;
  const existing = db.rows('alarms').map((a) => ({ ...a })) as unknown as AlarmRow[];

  const draft: PlanDraft = { appointmentId: appointment.appointment_id, travelMinutes: 50, travelSource: 'API', prepareMinutes: 60, beforePrepareMinutes: 30, kinds: ['WAKE'] };
  const inputs = inputsOf(draft, { appointment, participant, existingAlarms: existing });
  const plan = computePlan(inputs, api);
  const second = await persistAppointment(ctx, { plan, inputs, draft, replaceExisting: true, edits: [], timeZone: 'Asia/Seoul' });

  assert.equal(db.rows('appointments').length, 1); // 약속은 다시 안 만들고 안 고침
  assert.equal(db.rows('appointment_participants').length, 1);
  assert.deepEqual(db.rows('alarms').map((a) => a.alarm_type).sort(), ['ARRIVE', 'WAKE']);
  const removed = first.ring_packages.filter((p) => p.type === 'PREPARE' || p.type === 'DEPARTURE').map((p) => p.alarmId).sort();
  assert.deepEqual([...second.canceled_alarm_ids].sort(), removed);
  assert.deepEqual(second.ring_packages.map((p) => p.type), ['WAKE', 'ARRIVE']);
  assert.equal(second.ring_packages[0].alarmId, first.ring_packages[0].alarmId); // 같은 알람 id를 이어 씀
});

test('replace_existing false면 고르지 않은 종류를 지우지 않음', async () => {
  const { db, ctx } = setup();
  await persistAppointment(ctx, commitArgs(newDraft()));
  const appointment = db.rows('appointments')[0] as unknown as AppointmentRow;
  const participant = db.rows('appointment_participants')[0] as unknown as ParticipantRow;
  const existing = db.rows('alarms').map((a) => ({ ...a })) as unknown as AlarmRow[];
  const draft: PlanDraft = { appointmentId: appointment.appointment_id, travelMinutes: 50, travelSource: 'API', prepareMinutes: 60, beforePrepareMinutes: 30, kinds: ['WAKE'] };
  const inputs = inputsOf(draft, { appointment, participant, existingAlarms: existing });
  const body = await persistAppointment(ctx, { plan: computePlan(inputs, api), inputs, draft, replaceExisting: false, edits: [], timeZone: 'Asia/Seoul' });
  assert.equal(db.rows('alarms').length, 4);
  assert.deepEqual(body.canceled_alarm_ids, []);
});

test('알람 없는 일정: 약속 · 참여 조건만 만들고 알람은 없음', async () => {
  const { db, ctx } = setup();
  const body = await persistAppointment(ctx, commitArgs(newDraft({ kinds: [] })));
  assert.equal(db.rows('appointments').length, 1);
  assert.equal(db.rows('appointment_participants').length, 1);
  assert.equal(db.rows('alarms').length, 0);
  assert.deepEqual([body.ring_packages, body.canceled_alarm_ids], [[], []]);
});

test('지난 기상은 꺼서 저장하고 꾸러미에서 빼고 경고', async () => {
  const { db, ctx } = setup();
  const late = { ...ctx, now: kst(22, 478) }; // 기상 8:00 < 7:58 + 5분
  const inputs = inputsOf(newDraft(), { now: late.now });
  const body = await persistAppointment(late, { plan: computePlan(inputs, api), inputs, created: { title: 't' }, draft: newDraft(), replaceExisting: true, edits: [], timeZone: 'Asia/Seoul' });
  assert.equal(db.rows('alarms').find((a) => a.alarm_type === 'WAKE')!.is_enabled, false);
  assert.deepEqual(body.ring_packages.map((p) => p.type), ['PREPARE', 'DEPARTURE', 'ARRIVE']);
  assert.deepEqual(body.warnings.map((w) => w.code), ['PAST_ALARM_DISABLED']);
});

test('저장 막는 경우: 출발까지 지남 · 순서 어긋남 · 서버가 구한 CACHED/ESTIMATE 이동시간 — 아무것도 안 씀', async () => {
  const { db, ctx } = setup();
  const gone = { ...ctx, now: kst(22, 545) };
  const inputs = inputsOf(newDraft(), { now: gone.now });
  await assert.rejects(
    () => persistAppointment(gone, { plan: computePlan(inputs, api), inputs, created: { title: 't' }, draft: newDraft(), replaceExisting: true, edits: [], timeZone: 'Asia/Seoul' }),
    (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE' && (e.details as { reason: string }).reason === 'DEPARTURE_PASSED',
  );

  const order = inputsOf(newDraft({ manualTimes: { WAKE: kst(22, 600) } }));
  await assert.rejects(
    () => persistAppointment(ctx, { plan: computePlan(order, api), inputs: order, created: { title: 't' }, draft: order.draft, replaceExisting: true, edits: [], timeZone: 'Asia/Seoul' }),
    (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE' && (e.details as { reason: string }).reason === 'ORDER',
  );

  const cached: ResolvedTravel = { chosen: { minutes: 45, source: 'CACHED', sampleCount: 3, needsConfirmation: false, note: '' }, auto: null, warnings: [] };
  const plan = computePlan(inputsOf(newDraft()), cached);
  assert.throws(
    () => assertPersistable(plan),
    (e: unknown) => e instanceof HttpError && e.code === 'ROUTE_UNAVAILABLE' && (e.details as { fallback: { source: string } }).fallback.source === 'CACHED',
  );
  const estimate: ResolvedTravel = { chosen: { minutes: 33, source: 'ESTIMATE', needsConfirmation: true, note: '' }, auto: null, warnings: [] };
  assert.throws(() => assertPersistable(computePlan(inputsOf(newDraft()), estimate)), HttpError);
  assert.deepEqual(db.calls, []); // 어느 것도 DB를 건드리지 않음
});

test('중간에 실패하면 이번에 새로 만든 약속을 지움 (알람 만들기 실패)', async () => {
  const { db, ctx } = setup();
  db.failOn = [{ table: 'alarms', op: 'insert' }];
  await quiet(() => assert.rejects(() => persistAppointment(ctx, commitArgs(newDraft())), HttpError));
  assert.equal(db.rows('appointments').length, 0);
  assert.equal(db.rows('appointment_participants').length, 0);
  assert.equal(db.rows('alarms').length, 0);
});

test('기존 약속에 내 참여 조건을 더하다 실패하면 참여 조건만 지우고 약속은 그대로 (공동 약속)', async () => {
  const { db, ctx } = setup();
  db.rows('appointments').push({ appointment_id: 'ap-group', creator_id: 'someone', group_id: 'g1', title: '공동', appointment_at: kst(22, 600).toISOString(), dest_name: '세종대학교', importance: 'NORMAL' });
  const appointment = db.rows('appointments')[0] as unknown as AppointmentRow;
  const draft: PlanDraft = { appointmentId: 'ap-group', travelMinutes: 50, travelSource: 'API', prepareMinutes: 60 };
  const inputs = inputsOf(draft, { appointment });
  db.failOn = [{ table: 'alarms', op: 'insert' }];
  await quiet(() => assert.rejects(() => persistAppointment(ctx, { plan: computePlan(inputs, api), inputs, draft, replaceExisting: true, edits: [], timeZone: 'Asia/Seoul' }), HttpError));
  assert.equal(db.rows('appointments').length, 1);
  assert.equal(db.rows('appointment_participants').length, 0);
});

test('기존 약속(공동 약속)이면 약속은 건드리지 않고 내 몫만 만듦', async () => {
  const { db, ctx } = setup();
  db.rows('appointments').push({ appointment_id: 'ap-group', creator_id: 'someone', group_id: 'g1', title: '공동 회의', appointment_at: kst(22, 600).toISOString(), dest_name: '세종대학교', importance: 'HIGH' });
  const appointment = db.rows('appointments')[0] as unknown as AppointmentRow;
  const draft: PlanDraft = { appointmentId: 'ap-group', travelMinutes: 30, travelSource: 'MANUAL', prepareMinutes: 40, beforePrepareMinutes: 10 };
  const inputs = inputsOf(draft, { appointment });
  const manual: ResolvedTravel = { chosen: { minutes: 30, source: 'MANUAL', needsConfirmation: false, note: '' }, auto: null, warnings: [] };
  const body = await persistAppointment(ctx, { plan: computePlan(inputs, manual), inputs, draft, replaceExisting: true, edits: [], timeZone: 'Asia/Seoul' });
  assert.equal(db.rows('appointments').length, 1);
  assert.equal(db.rows('appointments')[0].creator_id, 'someone');
  const [participant] = db.rows('appointment_participants');
  assert.deepEqual([participant.user_id, participant.travel_source, participant.est_travel_minutes], [USER, 'MANUAL', 30]);
  assert.equal(body.ring_packages[0].title, '공동 회의');
  assert.equal(body.ring_packages.length, 4);
  assert.equal(db.rows('alarms')[0].intensity, 'STRONG'); // 매우 중요(HIGH) → 강
});

// ---- 일정 없는 알람 ----

test('일정 없는 알람(D46): 약속 · 루틴 없이 기상 알람 하나 + 반복 규칙, 시각 출처 MANUAL', async () => {
  const { db, ctx } = setup();
  const body = await commitStandalone(ctx, { alarm: { scheduledAt: kst(23, 420), recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }, edits: [], timeZone: 'Asia/Seoul' });
  const [alarm] = db.rows('alarms');
  assert.deepEqual(
    [alarm.participant_id, alarm.routine_id, alarm.alarm_type, alarm.recurrence_rule, alarm.time_source, alarm.intensity_source, alarm.intensity, alarm.is_enabled],
    [null, null, 'WAKE', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'MANUAL', 'AUTO', 'NORMAL', true],
  );
  assert.equal(db.rows('appointments').length, 0);
  assert.deepEqual(body.ring_packages.map((p) => [p.title, p.subtitle, p.type, hm(new Date(p.atMillis).toISOString())]), [['알람', '오전 7:00', 'WAKE', '07:00']]);
  assert.deepEqual(body.canceled_alarm_ids, []);
});

test('일정 없는 알람도 잠귀를 따름: 깊음이면 자동 강(STRONG), 가벼움이면 보통, 고른 칸은 그대로 (학습 기초 b)', async () => {
  const heavy = setup();
  heavy.db.rows('profiles').push({ user_id: USER, ...profile, wake_sensitivity: 'HEAVY' });
  await commitStandalone(heavy.ctx, { alarm: { scheduledAt: kst(23, 420) }, edits: [], timeZone: 'Asia/Seoul' });
  assert.deepEqual([heavy.db.rows('alarms')[0].intensity, heavy.db.rows('alarms')[0].intensity_source], ['STRONG', 'AUTO']);

  const light = setup();
  light.db.rows('profiles').push({ user_id: USER, ...profile, wake_sensitivity: 'LIGHT' });
  await commitStandalone(light.ctx, { alarm: { scheduledAt: kst(23, 420) }, edits: [], timeZone: 'Asia/Seoul' });
  assert.equal(light.db.rows('alarms')[0].intensity, 'NORMAL'); // 약이 아니라 보통 (D69)

  const picked = setup();
  picked.db.rows('profiles').push({ user_id: USER, ...profile, wake_sensitivity: 'HEAVY' });
  await commitStandalone(picked.ctx, { alarm: { scheduledAt: kst(23, 420), levels: { vibration: 0 } }, edits: [], timeZone: 'Asia/Seoul' });
  // D1 A: 진동 축을 직접 고르면 vibration 칸만 바뀌고 intensity는 전체 세기라 잠귀대로(강) 그대로
  const [pickedRow] = picked.db.rows('alarms');
  assert.deepEqual([pickedRow.intensity, pickedRow.vibration, pickedRow.intensity_source], ['STRONG', 'NONE', 'MANUAL']);
});

test('일정 없는 알람 고치기: 끄면 꾸러미에서 빠지고 canceled_alarm_ids에, 반복 규칙은 안 보내면 유지', async () => {
  const { db, ctx } = setup();
  const created = await commitStandalone(ctx, { alarm: { scheduledAt: kst(23, 420), recurrenceRule: 'FREQ=DAILY' }, edits: [], timeZone: 'Asia/Seoul' });
  const id = created.alarm_id;
  const off = await commitStandalone(ctx, { alarm: { alarmId: id, isEnabled: false }, edits: [], timeZone: 'Asia/Seoul' });
  assert.equal(db.rows('alarms')[0].is_enabled, false);
  assert.equal(db.rows('alarms')[0].recurrence_rule, 'FREQ=DAILY');
  assert.deepEqual([off.ring_packages, off.canceled_alarm_ids], [[], [id]]);

  const on = await commitStandalone(ctx, { alarm: { alarmId: id, isEnabled: true, scheduledAt: kst(23, 450), recurrenceRule: null, levels: { vibration: 2 } }, edits: [], timeZone: 'Asia/Seoul' });
  assert.deepEqual([db.rows('alarms')[0].recurrence_rule, db.rows('alarms')[0].intensity, db.rows('alarms')[0].vibration, db.rows('alarms')[0].intensity_source], [null, 'NORMAL', 'STRONG_CONTINUOUS', 'MANUAL']);
  assert.deepEqual(on.ring_packages.map((p) => p.alarmId), [id]);
  assert.deepEqual([on.ring_packages[0].intensity, on.ring_packages[0].vibration, on.ring_packages[0].soundKey], ['NORMAL', 'STRONG_CONTINUOUS', 'theme_default']); // 꾸러미에는 해석된 값
  assert.equal(db.rows('alarms').length, 1);
});

test('일정 없는 알람: 이미 지난 시각은 거절(끄는 요청은 허용), 남의 알람이나 약속에 달린 알람은 못 고침', async () => {
  const { db, ctx } = setup();
  await assert.rejects(
    () => commitStandalone(ctx, { alarm: { scheduledAt: kst(22, 300) }, edits: [], timeZone: 'Asia/Seoul' }),
    (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE',
  );
  await assert.rejects(() => commitStandalone(ctx, { alarm: {}, edits: [], timeZone: 'Asia/Seoul' }), HttpError);
  assert.equal(db.rows('alarms').length, 0);

  db.rows('alarms').push({ alarm_id: 'other', user_id: 'someone-else', participant_id: null, routine_id: null, alarm_type: 'WAKE', scheduled_at: kst(23, 420).toISOString() });
  db.rows('alarms').push({ alarm_id: 'attached', user_id: USER, participant_id: 'pt', routine_id: null, alarm_type: 'WAKE', scheduled_at: kst(23, 420).toISOString() });
  for (const alarmId of ['other', 'attached']) {
    await assert.rejects(
      () => commitStandalone(ctx, { alarm: { alarmId, isEnabled: false }, edits: [], timeZone: 'Asia/Seoul' }),
      (e: unknown) => e instanceof HttpError && e.code === 'NOT_FOUND',
    );
  }
});

test('일정 없는 알람: 시각 없이 강도만 · 켜기만 고치면 저장돼 있던 옛 시각이 지났어도 통과, 새로 보낸 지난 시각은 422', async () => {
  const { db, ctx } = setup();
  // 반복 알람의 첫 회차가 지나 옛 시각이 과거로 남은 상태 (D4 전)
  db.rows('alarms').push({
    alarm_id: 'old',
    user_id: USER,
    participant_id: null,
    routine_id: null,
    alarm_type: 'WAKE',
    scheduled_at: kst(21, 420).toISOString(),
    intensity: 'NORMAL',
    voice_tone: 'FRIENDLY',
    sound_key: 'default',
    is_enabled: false,
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  });

  const strong = await commitStandalone(ctx, { alarm: { alarmId: 'old', levels: { vibration: 2 } }, edits: [], timeZone: 'Asia/Seoul' });
  // 진동을 강으로 직접 고르면 vibration 칸에 — 전체 세기(intensity)는 자동 단계(보통) 그대로
  assert.deepEqual([db.rows('alarms')[0].intensity, db.rows('alarms')[0].vibration, db.rows('alarms')[0].intensity_source], ['NORMAL', 'STRONG_CONTINUOUS', 'MANUAL']);
  assert.equal(strong.alarms[0].scheduled_at, kst(21, 420).toISOString()); // 시각은 그대로

  const on = await commitStandalone(ctx, { alarm: { alarmId: 'old', isEnabled: true }, edits: [], timeZone: 'Asia/Seoul' });
  assert.equal(db.rows('alarms')[0].is_enabled, true);
  assert.equal(on.alarms[0].scheduled_at, kst(21, 420).toISOString());

  // 새로 보낸 시각이 지났으면 켜는 요청은 거절, 끄는 요청은 받음
  await assert.rejects(
    () => commitStandalone(ctx, { alarm: { alarmId: 'old', scheduledAt: kst(22, 300), isEnabled: true }, edits: [], timeZone: 'Asia/Seoul' }),
    (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE' && (e.details as { reason: string }).reason === 'PAST_TIME',
  );
  await assert.rejects(
    () => commitStandalone(ctx, { alarm: { alarmId: 'old', scheduledAt: kst(22, 300) }, edits: [], timeZone: 'Asia/Seoul' }),
    (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE',
  );
  assert.equal(db.rows('alarms')[0].scheduled_at, kst(21, 420).toISOString()); // 거절된 요청은 아무것도 안 바꿈
  await commitStandalone(ctx, { alarm: { alarmId: 'old', scheduledAt: kst(22, 300), isEnabled: false }, edits: [], timeZone: 'Asia/Seoul' });
  assert.equal(db.rows('alarms')[0].is_enabled, false);
});
