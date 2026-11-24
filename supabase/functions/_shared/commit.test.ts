// alarm-commit의 쓰기 순서 · 응답 · 되돌리기 — 가짜 DB(fake-db.ts)로 시험
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertLinkWake, assertPersistable, commitPlacePending, commitStandalone, isPlacePending, loadLinkableWake, persistAppointment, type CommitCtx } from './commit.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { computePlan, toSuggestion, type AlarmRow, type AppointmentRow, type ParticipantRow, type PlanDraft, type PlanInputs, type ProfileRow } from './plan-core.ts';
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
  assert.deepEqual([appointment.creator_id, appointment.title, appointment.dest_name, appointment.importance, appointment.recurrence_rule, appointment.group_id], [USER, '팀 주간회의', '세종대학교', 'LOW', 'FREQ=WEEKLY;BYDAY=TH', null]); // 중요도를 안 고르면 기본 약(LOW)
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

test('9-01: H05에서 고른 그룹(created.groupId)이 새 약속의 group_id로 저장되고 내 참여 조건 · 알람이 같이 생김 — 그룹을 안 골랐으면 null(개인 일정)', async () => {
  const group = setup();
  const body = await persistAppointment(group.ctx, commitArgs(newDraft(), { created: { title: '팀 회의', groupId: 'g-1' } }));
  const [appointment] = group.db.rows('appointments');
  assert.deepEqual([appointment.creator_id, appointment.group_id, appointment.title], [USER, 'g-1', '팀 회의']);
  const [participant] = group.db.rows('appointment_participants');
  assert.deepEqual([participant.appointment_id, participant.user_id], [appointment.appointment_id, USER]);
  assert.equal(group.db.rows('alarms').length, 4);
  assert.ok(group.db.rows('alarms').every((a) => a.user_id === USER && a.participant_id === participant.participant_id));
  assert.equal(body.appointment_id, appointment.appointment_id);

  const solo = setup();
  await persistAppointment(solo.ctx, commitArgs(newDraft(), { created: { title: '개인 약속' } }));
  assert.equal(solo.db.rows('appointments')[0].group_id, null);
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


test('C1/W4/P80: preview -> commit -> persisted alarm rows and participant minutes match', async () => {
  // This covers the real persistence implementation using FakeDb, unlike
  // the plan-only equality test. Both calls are given the same model output.
  // A live network/inference consistency test is still required.
  const cases: { label: string; mlPrediction: PlanInputs['mlPrediction']; expectedSource: string }[] = [
    { label: 'C1', mlPrediction: { model: 'c1_mae', minutes: 66 }, expectedSource: 'MODEL' },
    { label: 'W4', mlPrediction: { model: 'w4_mae', minutes: 58 }, expectedSource: 'MODEL' },
    { label: 'P80 fallback', mlPrediction: undefined, expectedSource: 'DEFAULT' },
  ];
  for (const spec of cases) {
    const { db, ctx } = setup();
    const draft = newDraft({
      prepareMinutes: undefined,  // automatically computed, not manual
      beforePrepareMinutes: 20,
      withWake: true,
    });
    const inputs = inputsOf(draft, { mlPrediction: spec.mlPrediction });
    const preview = toSuggestion(computePlan(inputs, api, 'preview'), inputs);
    const savedPlan = computePlan(inputs, api, 'save');
    assert.equal(preview.check.ok, true, spec.label);
    assert.equal(preview.prepare.source, spec.expectedSource, spec.label);

    const response = await persistAppointment(ctx, {
      plan: savedPlan, inputs,
      created: { title: 'ML 저장 검증' },
      draft, replaceExisting: true, edits: [], timeZone: 'Asia/Seoul',
    });
    const [storedParticipant] = db.rows('appointment_participants');
    assert.equal(storedParticipant.prepare_minutes, preview.prepare.minutes, spec.label);
    assert.equal(response.participant_id, storedParticipant.participant_id, spec.label);

    const fromRows = db.rows('alarms').map((a) => ({
      alarm_type: a.alarm_type,
      scheduled_at: a.scheduled_at,
      is_enabled: a.is_enabled,
      time_source: a.time_source,
    })).sort((a, b) => a.alarm_type.localeCompare(b.alarm_type));
    const fromPreview = preview.alarms.map((a) => ({
      alarm_type: a.alarm_type,
      scheduled_at: a.scheduled_at,
      is_enabled: a.is_enabled,
      time_source: a.time_source,
    })).sort((a, b) => a.alarm_type.localeCompare(b.alarm_type));
    assert.deepEqual(fromRows, fromPreview, spec.label);
    assert.deepEqual(
      response.alarms.map((a) => [a.alarm_type, a.scheduled_at, a.time_source]).sort(),
      fromRows.map((a) => [a.alarm_type, a.scheduled_at, a.time_source]).sort(),
      spec.label,
    );
    assert.equal(db.rows('appointments').length, 1, spec.label);
  }
});

// ---- 장소 미확정 일정 (AI 대화 — 장소를 확인하지 못함) ----

test('장소 미확정 일정: 장소 빈칸 · 좌표 없음 · 이동시간 NULL로 일정과 내 참여 행만, 알람 · 예약 꾸러미 없음', async () => {
  const { db, ctx } = setup();
  db.rows('profiles').push({ user_id: USER, ...profile, default_transport: 'SUBWAY', default_buffer_minutes: 15 });
  const body = await commitPlacePending(ctx, { appointment: { title: '캡스톤 회의', at: kst(23, 780), importance: 'NORMAL' } });
  const [appointment] = db.rows('appointments');
  assert.deepEqual(
    [appointment.creator_id, appointment.title, appointment.dest_name, appointment.dest_lat, appointment.dest_lng, appointment.group_id, appointment.recurrence_rule, appointment.importance, hm(appointment.appointment_at)],
    [USER, '캡스톤 회의', '', null, null, null, null, 'NORMAL', '13:00'],
  );
  const [participant] = db.rows('appointment_participants');
  assert.deepEqual(
    [participant.appointment_id, participant.user_id, participant.est_travel_minutes, participant.transport_type, participant.buffer_minutes, participant.origin_name ?? null],
    [appointment.appointment_id, USER, null, 'SUBWAY', 15, null], // 이동시간을 추측하지 않음 · 출발지는 비움(나중에 집이 기본)
  );
  assert.equal(db.rows('alarms').length, 0);
  assert.deepEqual([body.appointment_id, body.alarms, body.ring_packages, body.canceled_alarm_ids], [appointment.appointment_id, [], [], []]);
  assert.deepEqual(body.warnings.map((w) => w.code), ['PLACE_PENDING']);
  assert.equal(isPlacePending(appointment as { dest_name: string; dest_lat: null; dest_lng: null }), true);
  assert.equal(isPlacePending({ dest_name: '세종대학교', dest_lat: 37.55, dest_lng: 127.07 }), false);
  assert.equal(isPlacePending({ dest_name: '세종대학교', dest_lat: null, dest_lng: null }), false, '이름만 있는 장소(좌표 없음)는 미확정이 아님 — 기존 직접 입력 흐름');
});

test('장소 미확정 일정: 지난 시각은 거절하고 아무것도 안 씀 · 참여 행을 못 만들면 만든 일정을 지움', async () => {
  const past = setup();
  await assert.rejects(commitPlacePending(past.ctx, { appointment: { title: '회의', at: kst(22, 300), importance: 'LOW' } }), (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE');
  assert.equal(past.db.rows('appointments').length, 0);

  const broken = setup();
  broken.db.failOn = [{ table: 'appointment_participants', op: 'insert' }];
  await quiet(() => assert.rejects(commitPlacePending(broken.ctx, { appointment: { title: '회의', at: kst(23, 780), importance: 'LOW' } })));
  assert.equal(broken.db.rows('appointments').length, 0, '되돌림');
});

test('장소 미확정 일정: 다시 보낸 요청(resend)만 방금 만든 같은 일정을 돌려줌 — 새 요청은 같은 제목 · 시각이어도 새 일정, 10분이 지났거나 처음 요청이 저장 전에 실패했으면 새로 만듦', async () => {
  const { db, ctx } = setup();
  db.rows('profiles').push({ user_id: USER, ...profile });
  const meeting = { title: '캡스톤 회의', at: kst(23, 780), importance: 'NORMAL' as const };
  const first = await commitPlacePending(ctx, { appointment: meeting });
  // 응답을 잃고 같은 본문을 다시 보냄 → 같은 일정 · 같은 참여 행, 더 만들지 않음
  const again = await commitPlacePending(ctx, { appointment: { ...meeting, resend: true } });
  assert.deepEqual([again.appointment_id, again.participant_id], [first.appointment_id, first.participant_id]);
  assert.deepEqual([db.rows('appointments').length, db.rows('appointment_participants').length], [1, 1]);
  // 사용자가 같은 제목 · 시각으로 하나 더 만듦(새 요청) → 막지 않음
  const minuteLater: CommitCtx = { ...ctx, now: new Date(NOW.getTime() + 60_000) };
  const second = await commitPlacePending(minuteLater, { appointment: meeting });
  assert.notEqual(second.appointment_id, first.appointment_id);
  assert.equal(db.rows('appointments').length, 2);
  // 다시 보냄은 가장 최근 것을 돌려줌 · 제목이나 시각이 다르면 새로
  assert.equal((await commitPlacePending(minuteLater, { appointment: { ...meeting, resend: true } })).appointment_id, second.appointment_id);
  await commitPlacePending(ctx, { appointment: { ...meeting, at: kst(23, 840), resend: true } });
  assert.equal(db.rows('appointments').length, 3);

  // 10분이 지난 다시 보냄(앱 요청 키도 이미 사라짐) → 새로 만듦
  const later: CommitCtx = { ...ctx, now: new Date(NOW.getTime() + 12 * 60_000) }; // 마지막으로 만든 지 11분 뒤
  await commitPlacePending(later, { appointment: { ...meeting, resend: true } });
  assert.equal(db.rows('appointments').length, 4);

  // 처음 요청이 저장 전에 실패 → 다시 보내면 찾을 일정이 없어 새로 만듦
  const fresh = setup();
  fresh.db.rows('profiles').push({ user_id: USER, ...profile });
  await commitPlacePending(fresh.ctx, { appointment: { ...meeting, resend: true } });
  assert.equal(fresh.db.rows('appointments').length, 1);
});

// ---- 일정 없는 기상 알람 → 약속 기상으로 합치기 (장소를 나중에 정한 일정, H03에서 사용자가 고름) ----

function placeSetWithStandaloneWake() {
  const { db, ctx } = setup();
  db.rows('appointments').push({ appointment_id: 'ap-cap', creator_id: USER, group_id: null, title: '캡스톤 회의', appointment_at: kst(23, 780).toISOString(), dest_name: '세종대학교', dest_lat: 37.55, dest_lng: 127.07, importance: 'NORMAL' });
  db.rows('appointment_participants').push({ participant_id: 'pt-cap', appointment_id: 'ap-cap', user_id: USER, est_travel_minutes: 50, travel_source: 'API', buffer_minutes: 10 });
  db.rows('alarms').push(
    { alarm_id: 'al-8', user_id: USER, participant_id: null, routine_id: null, alarm_type: 'WAKE', scheduled_at: kst(23, 480).toISOString(), is_enabled: true, recurrence_rule: null, time_source: 'MANUAL', intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'basic', vibration: null, intensity_source: 'AUTO' },
    { alarm_id: 'al-daily', user_id: USER, participant_id: null, routine_id: null, alarm_type: 'WAKE', scheduled_at: kst(23, 450).toISOString(), is_enabled: true, recurrence_rule: 'FREQ=DAILY', time_source: 'MANUAL' },
    { alarm_id: 'al-other', user_id: 'u-other', participant_id: null, routine_id: null, alarm_type: 'WAKE', scheduled_at: kst(23, 480).toISOString(), is_enabled: true, recurrence_rule: null },
  );
  const appointment = db.rows('appointments')[0] as unknown as AppointmentRow;
  const participant = db.rows('appointment_participants')[0] as unknown as ParticipantRow;
  // alarm-commit/index.ts와 같은 순서: 합칠 알람 읽기 → 약속 기상 = 그 시각(직접 고름) → 계산 → 검사 → 쓰기
  const save = async (linkId: string | null, over: Partial<PlanDraft> = {}) => {
    const linkWake = linkId ? await loadLinkableWake(ctx, linkId) : null;
    const draft: PlanDraft = { appointmentId: 'ap-cap', prepareMinutes: 60, beforePrepareMinutes: 30, ...over };
    if (linkWake) draft.manualTimes = { ...draft.manualTimes, WAKE: new Date(linkWake.scheduled_at) };
    const inputs = inputsOf(draft, { appointment, participant, existingAlarms: db.rows('alarms').filter((a) => a.participant_id === 'pt-cap') as unknown as AlarmRow[] });
    const plan = computePlan(inputs, api);
    if (linkId) assertLinkWake(plan, draft, linkWake, inputs.existingAlarms);
    return persistAppointment(ctx, { plan, inputs, draft, replaceExisting: true, edits: [], timeZone: 'Asia/Seoul', linkWake });
  };
  return { db, ctx, save };
}

test('합치기: 약속 기상을 일정 없는 기상 시각(8:00, 직접 고름)으로 만들고 그 알람은 지움 — 폰은 옛 알람 취소 · 새 기상 예약, 준비는 고른 대로', async () => {
  const { db, save } = placeSetWithStandaloneWake();
  // 앱은 기상만 옮겨 준비가 따라오지 않게 준비 자동 시각(기상 11:00 + 30 = 11:30)을 같이 보냄 — 기상도 그 알람 시각으로 같이 보냄 (H03 linkTimes)
  const body = await save('al-8', { manualTimes: { WAKE: kst(23, 480), PREPARE: kst(23, 690) } });
  const mine = db.rows('alarms').filter((a) => a.participant_id === 'pt-cap');
  assert.deepEqual(mine.map((a) => [a.alarm_type, hm(a.scheduled_at)]), [['WAKE', '08:00'], ['PREPARE', '11:30'], ['DEPARTURE', '12:00'], ['ARRIVE', '12:50']]);
  assert.equal(mine[0].time_source, 'MANUAL');
  assert.equal(db.rows('alarms').some((a) => a.alarm_id === 'al-8'), false, '합친 알람은 지움');
  assert.deepEqual(db.rows('alarms').filter((a) => a.participant_id == null).map((a) => a.alarm_id), ['al-daily', 'al-other'], '반복 · 남의 알람은 그대로');
  assert.deepEqual(body.canceled_alarm_ids, ['al-8']);
  assert.deepEqual(body.ring_packages.filter((p) => p.type === 'WAKE').map((p) => [p.title, hm(new Date(p.atMillis).toISOString())]), [['캡스톤 회의', '08:00']]);
});

test('따로 두기(합치기 없음): 일정 없는 기상은 그대로 · 약속 기상은 자동 시각으로 따로 — 지우거나 취소하지 않음', async () => {
  const { db, save } = placeSetWithStandaloneWake();
  const body = await save(null);
  assert.deepEqual(db.rows('alarms').filter((a) => a.alarm_type === 'WAKE' && a.user_id === USER).map((a) => [a.participant_id, hm(a.scheduled_at)]), [
    [null, '08:00'],
    [null, '07:30'],
    ['pt-cap', '11:00'],
  ]);
  assert.deepEqual(body.canceled_alarm_ids, []);
});

test('합치기 검사: 반복 · 남의 알람은 못 고름, 이미 합쳐 지웠으면(다시 보냄) 그대로 저장, 이 약속에 기상이 안 생기면 거절', async () => {
  const { ctx, db, save } = placeSetWithStandaloneWake();
  assert.equal(await loadLinkableWake(ctx, 'al-daily'), null);
  assert.equal(await loadLinkableWake(ctx, 'al-other'), null);
  await assert.rejects(save('al-daily'), (e: unknown) => e instanceof HttpError && e.code === 'NOT_FOUND');
  assert.equal(db.rows('alarms').filter((a) => a.participant_id === 'pt-cap').length, 0, '거절하면 아무것도 안 씀');

  await save('al-8', { manualTimes: { WAKE: kst(23, 480), PREPARE: kst(23, 690) } });
  const again = await save('al-8', { manualTimes: { WAKE: kst(23, 480), PREPARE: kst(23, 690) } }); // 응답을 잃고 같은 저장을 다시
  assert.deepEqual(db.rows('alarms').filter((a) => a.participant_id === 'pt-cap' && a.alarm_type === 'WAKE').map((a) => hm(a.scheduled_at)), ['08:00'], '기상은 하나');
  assert.deepEqual(again.canceled_alarm_ids, []);

  const off = placeSetWithStandaloneWake();
  await assert.rejects(off.save('al-8', { enabled: { WAKE: false } }), (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE');
  assert.equal(off.db.rows('alarms').some((a) => a.alarm_id === 'al-8'), true, '거절하면 일정 없는 알람은 그대로');
  assert.throws(() => assertLinkWake({ chain: [] }, {}, { alarm_id: 'al-8' } as AlarmRow, []), (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE');
});

test('합치기 도중 실패해도 기존 알람은 사라지지 않음 — 약속 알람 쓰기 실패면 독립 알람 그대로, 독립 알람 지우기 실패면 둘 다 남고 다시 저장하면 기상 하나로', async () => {
  const insertFails = placeSetWithStandaloneWake();
  insertFails.db.failOn = [{ table: 'alarms', op: 'insert' }];
  await quiet(() => assert.rejects(insertFails.save('al-8', { manualTimes: { WAKE: kst(23, 480), PREPARE: kst(23, 690) } })));
  assert.equal(insertFails.db.rows('alarms').some((a) => a.alarm_id === 'al-8'), true, '약속 알람을 못 썼으면 독립 알람은 안 지움');

  const deleteFails = placeSetWithStandaloneWake();
  deleteFails.db.failOn = [{ table: 'alarms', op: 'delete' }];
  await quiet(() => assert.rejects(deleteFails.save('al-8', { manualTimes: { WAKE: kst(23, 480), PREPARE: kst(23, 690) } })));
  const wakes = () => deleteFails.db.rows('alarms').filter((a) => a.alarm_type === 'WAKE' && a.user_id === USER && a.recurrence_rule == null).map((a) => [a.participant_id, hm(a.scheduled_at)]);
  assert.deepEqual(wakes(), [[null, '08:00'], ['pt-cap', '08:00']], '둘 다 남음 (유실 없음)');

  deleteFails.db.failOn = [];
  const retry = await deleteFails.save('al-8', { manualTimes: { WAKE: kst(23, 480), PREPARE: kst(23, 690) } }); // 같은 저장을 다시
  assert.deepEqual(wakes(), [['pt-cap', '08:00']]);
  assert.deepEqual(retry.canceled_alarm_ids, ['al-8']);
});
