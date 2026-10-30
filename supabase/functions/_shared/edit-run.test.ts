// appointment-edit 본문(edit-run.ts) — 가짜 DB(fake-db.ts) + 가짜 카카오(분 고정, 부른 수 셈)로.
// 달력: 2026-10-26 월(지금 10:00) · 27 화 · 29 목 · 11-03 화 · 11-05 목 · 11-10 화 · 11-12 목. 모두 한국 시각
// 부른 사람의 RLS를 흉내 내는 껍데기(asUser)로 읽고 쓰게 해서, 남의 약속이 안 보이는 것까지 같이 확인함. service가 닿은 표도 지켜봄(serviceTables)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { persistAppointment } from './commit.ts';
import { deleteAppointment, leaveSharedAppointment, restoreAppointment, runEdit, updateAppointment, type EditCtx } from './edit-run.ts';
import type { EditRequest } from './edit-request.ts';
import type { AppointmentPatch } from './edit.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { KakaoError, type KakaoFailure } from './kakao.ts';
import { buildPlan } from './plan.ts';
import type { ProfileRow } from './plan-core.ts';
import { Reader } from './read.ts';
import { readCommitRequest } from './requests.ts';
import { runRoll, type RollResult, type TravelLookup } from './roll.ts';
import type { Db } from './supabase.ts';
import { localDateKey } from './tz.ts';

const A = 'u-a';
const B = 'u-b';
const kst = (local: string) => new Date(`${local}:00+09:00`);
const iso = (local: string) => `${local}:00+09:00`;
const hm = (value: unknown) => {
  const m = (new Date(value as string).getUTCHours() * 60 + new Date(value as string).getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const ymd = (value: unknown) => localDateKey(new Date(value as string), 'Asia/Seoul');
const HOME = { lat: 37.5547, lng: 126.9707 };
const SCHOOL = { lat: 37.55, lng: 127.07 };
const MON_10 = kst('2026-10-26T10:00');

// ---- 도구 ----

type Env = { db: FakeDb; serviceTables: Set<string> };

function setup(users: string[] = [A]): Env {
  const db = new FakeDb().withRollRpc();
  db.now = MON_10;
  for (const user_id of users) {
    db.rows('profiles').push({ user_id, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng } satisfies ProfileRow & { user_id: string });
  }
  return { db, serviceTables: new Set() };
}

// 부른 사람의 RLS 흉내 — 약속은 내가 만들었거나 내가 참여 중인 그룹의 것만, 참여 조건 · 알람 · 할 일은 내 것만 보임
function asUser(db: FakeDb, uid: string): Db {
  return {
    from(table: string) {
      const q = db.from(table);
      if (table === 'appointments') {
        const groups = new Set(db.rows('group_members').filter((m) => m.user_id === uid && m.invite_status === 'JOINED').map((m) => m.group_id));
        const visible = db.rows('appointments').filter((a) => a.creator_id === uid || (a.group_id != null && groups.has(a.group_id))).map((a) => a.appointment_id);
        return q.in('appointment_id', visible);
      }
      if (table === 'appointment_participants' || table === 'alarms' || table === 'todos') return q.eq('user_id', uid);
      return q;
    },
    rpc: (name: string, args?: Record<string, unknown>) => db.rpc(name, args),
  } as unknown as Db;
}

function fakeKakao(minutes = 35) {
  const state = { calls: 0, minutes, partial: false, fail: null as KakaoFailure | null };
  const lookup: TravelLookup = async () => {
    state.calls += 1;
    if (state.fail) throw new KakaoError(state.fail, '시험용 실패');
    return { minutes: state.minutes, partial: state.partial };
  };
  return { state, lookup };
}

function ctxFor(env: Env, user: string, over: { now?: Date; kakao?: TravelLookup } = {}): EditCtx {
  const service = { from: (table: string) => (env.serviceTables.add(table), env.db.from(table)) } as unknown as Db;
  return { userId: user, userDb: asUser(env.db, user), service, now: over.now ?? MON_10, ...(over.kakao ? { kakao: over.kakao } : {}) };
}

const upd = (id: string, patch: AppointmentPatch, scope: 'this' | 'following' = 'this', confirmed = false): Extract<EditRequest, { action: 'UPDATE' }> => ({ action: 'UPDATE', appointmentId: id, scope, patch, confirmed });
const del = (id: string, scope: 'this' | 'following' = 'this'): Extract<EditRequest, { action: 'DELETE' }> => ({ action: 'DELETE', appointmentId: id, scope });
const restore = (id: string): Extract<EditRequest, { action: 'RESTORE' }> => ({ action: 'RESTORE', appointmentId: id });
const leave = (id: string): Extract<EditRequest, { action: 'LEAVE' }> => ({ action: 'LEAVE', appointmentId: id });

function roll(env: Env, path: 'own' | 'batch', options: { user?: string; now?: Date; lookup?: TravelLookup } = {}): Promise<RollResult> {
  const now = options.now ?? MON_10;
  env.db.now = now;
  const db = env.db as unknown as Db;
  return runRoll({ path, now, read: db, write: db, lookup: options.lookup, log: () => {}, warn: () => {} }, path === 'own' ? { userId: options.user ?? A } : {});
}

const slot = (over: object = {}) => ({
  appointment: { title: '세미나', appointment_at: iso('2026-10-27T09:00'), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU,TH' },
  participant: { origin: { name: '집', ...HOME }, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', buffer_minutes: 10, before_prepare_minutes: 30 },
  ...over,
});

// alarm-commit이 약속을 저장한 것처럼 (요청 읽기 → 계산 → 저장). 돌려주는 값 = 약속 id
async function seed(env: Env, user: string, body: object, now: Date = MON_10): Promise<string> {
  const request = readCommitRequest(Reader.root(body));
  if (request.type !== 'APPOINTMENT') throw new Error('약속 요청이어야 해요');
  const db = env.db as unknown as Db;
  const built = await buildPlan({ userId: user, db, now }, request.draft);
  const saved = await persistAppointment({ userId: user, userDb: db, service: db, now }, {
    plan: built.plan, inputs: built.inputs, created: request.appointment, draft: request.draft, replaceExisting: request.replaceExisting, edits: [], timeZone: built.timeZone,
  });
  return saved.appointment_id;
}

// 한 번짜리 약속 (반복 없음)
const single = (env: Env, user: string, local: string, over: { title?: string; kinds?: string[] } = {}) =>
  seed(env, user, {
    appointment: { title: over.title ?? '약속', appointment_at: iso(local), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL' },
    participant: { origin: { name: '집', ...HOME }, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', buffer_minutes: 10, before_prepare_minutes: 30 },
    ...(over.kinds ? { kinds: over.kinds } : {}),
  });

// 시험용 간단 행 — ats마다 회차 한 줄 (첫 줄의 id가 묶음 번호). 알람 4개: 기상 −110 · 준비 −80 · 출발 −60 · 도착 −10분
let rawSeq = 0;
function rawSeries(db: FakeDb, user: string, over: { ats: string[]; rule: string | null; title?: string; group?: string }): string[] {
  const made: string[] = [];
  let series = '';
  for (const local of over.ats) {
    rawSeq += 1;
    const appointment_id = `ap-raw-${rawSeq}`;
    series ||= appointment_id;
    made.push(appointment_id);
    const when = iso(local);
    const at = new Date(when);
    db.rows('appointments').push({
      appointment_id, creator_id: user, group_id: over.group ?? null, title: over.title ?? '수업', appointment_at: at.toISOString(), dest_name: '세종대학교', dest_lat: SCHOOL.lat, dest_lng: SCHOOL.lng,
      importance: 'NORMAL', recurrence_rule: over.rule, memo: null, dest_radius_m: null, series_id: series, occurrence_on: localDateKey(at, 'Asia/Seoul'), exception_kind: null,
    });
    addParticipant(db, user, appointment_id, at);
  }
  return made;
}

function addParticipant(db: FakeDb, user: string, appointment_id: string, at: Date) {
  rawSeq += 1;
  const participant_id = `pt-raw-${rawSeq}`;
  db.rows('appointment_participants').push({
    participant_id, appointment_id, user_id: user, origin_name: '집', origin_lat: HOME.lat, origin_lng: HOME.lng, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', prepare_minutes: 50, buffer_minutes: 10,
    departed_at: null, arrived_at: null,
  });
  for (const [alarm_type, minutes] of [['WAKE', -110], ['PREPARE', -80], ['DEPARTURE', -60], ['ARRIVE', -10]] as const) {
    db.rows('alarms').push({
      alarm_id: `al-raw-${rawSeq}-${alarm_type}`, user_id: user, participant_id, routine_id: null, alarm_type, scheduled_at: new Date(at.getTime() + minutes * 60_000).toISOString(),
      intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: null, is_enabled: true, snooze_limit: 3, time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null,
    });
  }
}

const row = (db: FakeDb, id: string) => db.rows('appointments').find((a) => a.appointment_id === id);
const byDate = (db: FakeDb, series: string, date: string) => db.rows('appointments').find((a) => a.series_id === series && a.occurrence_on === date);
const dates = (db: FakeDb, series: string) => db.rows('appointments').filter((a) => a.series_id === series).map((a) => a.occurrence_on as string).sort();
const participantOf = (db: FakeDb, appointmentId: unknown, user: string = A) => db.rows('appointment_participants').find((p) => p.appointment_id === appointmentId && p.user_id === user);
const alarmsOf = (db: FakeDb, appointmentId: unknown, user: string = A) => {
  const p = participantOf(db, appointmentId, user);
  return db.rows('alarms').filter((a) => p && a.participant_id === p.participant_id).sort((x, y) => Date.parse(x.scheduled_at as string) - Date.parse(y.scheduled_at as string));
};
const lines = (db: FakeDb, appointmentId: unknown, user: string = A) => alarmsOf(db, appointmentId, user).map((a) => `${a.alarm_type} ${hm(a.scheduled_at)} ${a.is_enabled ? 'on' : 'off'}`);
const kinds = (db: FakeDb, appointmentId: unknown) => alarmsOf(db, appointmentId).map((a) => a.alarm_type as string).sort().join();
const alarmIds = (db: FakeDb, appointmentId: unknown, user: string = A) => alarmsOf(db, appointmentId, user).map((a) => a.alarm_id as string);
const snap = (db: FakeDb) => JSON.stringify(['appointments', 'appointment_participants', 'alarms', 'todos', 'roll_attempts'].map((t) => db.rows(t)));
const expectHttp = async (run: () => Promise<unknown>, code: string, reason?: string) => {
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.code, code);
    if (reason) assert.equal((e.details as { reason?: string } | undefined)?.reason, reason);
    return true;
  });
};

// 월요일(지금) 기준으로 시드 + roll로 만든 반복 묶음 — 화·목 09:00 세미나, 회차 10/27 · 10/29 · 11/03 · 11/05 (첫 회차 이동 50분, roll이 만든 회차는 35분)
async function seededSeries(env: Env) {
  const first = await seed(env, A, slot());
  const series = row(env.db, first)!.series_id as string;
  await roll(env, 'own', { lookup: fakeKakao(35).lookup });
  assert.deepEqual(dates(env.db, series), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);
  return { series, thu: byDate(env.db, series, '2026-10-29')!, tue: byDate(env.db, series, '2026-11-03')!, thu2: byDate(env.db, series, '2026-11-05')! };
}

// ===========================================================================
// 이번만 고치기
// ===========================================================================

test('이번만 고치기: 그 회차 행만 고침 — 날짜 칸 · 묶음은 그대로, 이번만 고침 표시, 알람 시각 다시 계산(알람 id 그대로), 다른 회차는 그대로', async () => {
  const env = setup();
  const { series, thu, tue, thu2 } = await seededSeries(env);
  const others = JSON.stringify([row(env.db, tue.appointment_id as string), row(env.db, thu2.appointment_id as string), alarmsOf(env.db, tue.appointment_id), alarmsOf(env.db, thu2.appointment_id)]);
  const idsBefore = alarmIds(env.db, thu.appointment_id);
  assert.deepEqual(lines(env.db, thu.appointment_id), ['WAKE 07:25 on', 'PREPARE 07:55 on', 'DEPARTURE 08:15 on', 'ARRIVE 08:50 on']);

  const res = await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T10:00'), title: '발표' }, 'this', true));
  assert.deepEqual([res.saved, res.needs_confirm], [true, false]);
  assert.deepEqual(res.changes.map((c) => [c.kind, hm(c.from), hm(c.to)]), [['WAKE', '07:25', '08:25'], ['PREPARE', '07:55', '08:55'], ['DEPARTURE', '08:15', '09:15']]);

  const after = row(env.db, thu.appointment_id as string)!;
  assert.deepEqual([hm(after.appointment_at), after.title, after.occurrence_on, after.series_id, after.exception_kind, after.recurrence_rule], ['10:00', '발표', '2026-10-29', series, 'EDITED', 'FREQ=WEEKLY;BYDAY=TU,TH']);
  assert.deepEqual(lines(env.db, thu.appointment_id), ['WAKE 08:25 on', 'PREPARE 08:55 on', 'DEPARTURE 09:15 on', 'ARRIVE 09:50 on']);
  assert.deepEqual(alarmIds(env.db, thu.appointment_id).sort(), [...idsBefore].sort()); // 알람은 지우고 다시 만들지 않고 제자리에서 고침
  assert.deepEqual(res.canceled_alarm_ids, []);
  assert.deepEqual(res.deleted_appointment_ids, []);
  assert.equal(res.ring_packages.length, 4);
  assert.deepEqual([res.ring_packages[0].type, res.ring_packages[0].title, res.ring_packages[0].subtitle, res.ring_packages[0].atMillis], ['WAKE', '발표', '오전 10:00 · 세종대학교', kst('2026-10-29T08:25').getTime()]);
  assert.equal(JSON.stringify([row(env.db, tue.appointment_id as string), row(env.db, thu2.appointment_id as string), alarmsOf(env.db, tue.appointment_id), alarmsOf(env.db, thu2.appointment_id)]), others);
  assert.deepEqual(res.warnings, []);
});

test('같은 요청을 두 번 보내면 같은 결과: 두 번째는 바뀐 것이 없어 아무것도 안 쓰고 폰에 걸 것도 없음', async () => {
  const env = setup();
  const { thu } = await seededSeries(env);
  const request = upd(thu.appointment_id as string, { at: kst('2026-10-29T10:00') }, 'this', true);
  await updateAppointment(ctxFor(env, A), request);
  const saved = snap(env.db);
  const again = await updateAppointment(ctxFor(env, A), request);
  assert.equal(snap(env.db), saved);
  assert.deepEqual([again.saved, again.needs_confirm, again.changes, again.ring_packages, again.canceled_alarm_ids], [true, false, [], [], []]);
  // 같은 요청을 한 번 더 보내도 roll이 같은 날을 다시 만들지 않음
  const kakao = fakeKakao();
  assert.deepEqual((await roll(env, 'own', { lookup: kakao.lookup })).created, []);
  assert.equal(kakao.state.calls, 0);
});

test('확인 경계(D67): 5분 이상 늦춰지면 저장하지 않고 needs_confirm — 확인 뒤 confirmed로 다시 보내면 저장. 앞당김 · 4분 늦춤은 바로 저장', async () => {
  const env = setup();
  const { thu, tue, thu2 } = await seededSeries(env);
  const before = snap(env.db);

  const ask = await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T09:05') }));
  assert.deepEqual([ask.saved, ask.needs_confirm], [false, true]);
  assert.deepEqual(ask.changes.map((c) => [c.kind, hm(c.from), hm(c.to)]), [['WAKE', '07:25', '07:30'], ['PREPARE', '07:55', '08:00'], ['DEPARTURE', '08:15', '08:20']]);
  assert.deepEqual([ask.ring_packages, ask.canceled_alarm_ids], [[], []]);
  assert.equal(snap(env.db), before); // 아무것도 안 씀

  const confirmed = await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T09:05') }, 'this', true));
  assert.deepEqual([confirmed.saved, confirmed.needs_confirm], [true, false]);
  assert.equal(hm(row(env.db, thu.appointment_id as string)!.appointment_at), '09:05');

  const earlier = await updateAppointment(ctxFor(env, A), upd(tue.appointment_id as string, { at: kst('2026-11-03T08:30') }));
  assert.deepEqual([earlier.saved, earlier.needs_confirm, earlier.changes.length], [true, false, 3]);
  assert.deepEqual(lines(env.db, tue.appointment_id), ['WAKE 06:55 on', 'PREPARE 07:25 on', 'DEPARTURE 07:45 on', 'ARRIVE 08:20 on']);

  const small = await updateAppointment(ctxFor(env, A), upd(thu2.appointment_id as string, { at: kst('2026-11-05T09:04') }));
  assert.deepEqual([small.saved, small.needs_confirm], [true, false]);
  assert.equal(hm(row(env.db, thu2.appointment_id as string)!.appointment_at), '09:04');
});

test('제목만 고치면 알람은 그대로, 폰의 알람 제목만 바뀌게 꾸러미를 줌 (이번만 고침 표시는 붙음)', async () => {
  const env = setup();
  const { thu } = await seededSeries(env);
  const alarmsBefore = JSON.stringify(alarmsOf(env.db, thu.appointment_id));
  const res = await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { title: '  특강 ' }));
  assert.deepEqual([res.saved, res.needs_confirm, res.changes, res.canceled_alarm_ids], [true, false, [], []]);
  assert.equal(JSON.stringify(alarmsOf(env.db, thu.appointment_id)), alarmsBefore);
  assert.deepEqual([row(env.db, thu.appointment_id as string)!.title, row(env.db, thu.appointment_id as string)!.exception_kind], ['특강', 'EDITED']);
  assert.deepEqual(res.ring_packages.map((p) => [p.type, p.title]), [['WAKE', '특강'], ['PREPARE', '특강'], ['DEPARTURE', '특강'], ['ARRIVE', '특강']]);
});

test('직접 고른 알람 시각(MANUAL)은 보존: 같은 날 시각을 옮기면 그대로, 날짜가 바뀌면 날짜만 따라감 (회차 날짜 칸은 그대로)', async () => {
  const env = setup();
  const { thu, thu2 } = await seededSeries(env);
  // 10/29: 기상을 07:00으로 직접 고름
  alarmsOf(env.db, thu.appointment_id).find((a) => a.alarm_type === 'WAKE')!.scheduled_at = iso('2026-10-29T07:00');
  alarmsOf(env.db, thu.appointment_id).find((a) => a.alarm_type === 'WAKE')!.time_source = 'MANUAL';
  await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T09:30') }, 'this', true));
  assert.equal(lines(env.db, thu.appointment_id)[0], 'WAKE 07:00 on');
  assert.equal(alarmsOf(env.db, thu.appointment_id)[0].time_source, 'MANUAL');
  assert.equal(lines(env.db, thu.appointment_id).find((l) => l.startsWith('DEPARTURE')), 'DEPARTURE 08:45 on');

  // 11/05 → 11/06 (금): 기상 직접 값이 하루 뒤 같은 시각으로
  const wake = alarmsOf(env.db, thu2.appointment_id).find((a) => a.alarm_type === 'WAKE')!;
  wake.scheduled_at = iso('2026-11-05T07:00');
  wake.time_source = 'MANUAL';
  await updateAppointment(ctxFor(env, A), upd(thu2.appointment_id as string, { at: kst('2026-11-06T09:00') }, 'this', true));
  const moved = row(env.db, thu2.appointment_id as string)!;
  assert.deepEqual([ymd(moved.appointment_at), moved.occurrence_on], ['2026-11-06', '2026-11-05']);
  assert.equal(lines(env.db, thu2.appointment_id)[0], 'WAKE 07:00 on');
  assert.equal(ymd(alarmsOf(env.db, thu2.appointment_id)[0].scheduled_at), '2026-11-06');
});

test('출발 시각까지 지난 시각으로는 못 옮김 (UNPROCESSABLE) — 아무것도 안 씀', async () => {
  const env = setup();
  const { thu } = await seededSeries(env);
  const before = snap(env.db);
  await expectHttp(() => updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-26T10:30') }, 'this', true)), 'UNPROCESSABLE');
  assert.equal(snap(env.db), before);
});

// ===========================================================================
// 장소 · 이동시간
// ===========================================================================

test('시각만 바꾸면 이동시간은 저장된 값 그대로(길찾기 0번), 장소를 바꾸면 길찾기를 새로 구해 알람이 다시 정해짐', async () => {
  const env = setup();
  const { thu, tue } = await seededSeries(env);
  const kakao = fakeKakao(20);
  await updateAppointment(ctxFor(env, A, { kakao: kakao.lookup }), upd(thu.appointment_id as string, { at: kst('2026-10-29T10:00') }, 'this', true));
  assert.equal(kakao.state.calls, 0);
  assert.equal(participantOf(env.db, thu.appointment_id)!.est_travel_minutes, 35);

  const res = await updateAppointment(ctxFor(env, A, { kakao: kakao.lookup }), upd(tue.appointment_id as string, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.equal(kakao.state.calls, 1);
  const part = participantOf(env.db, tue.appointment_id)!;
  assert.deepEqual([part.est_travel_minutes, part.travel_source], [20, 'API']);
  assert.deepEqual([row(env.db, tue.appointment_id as string)!.dest_name, row(env.db, tue.appointment_id as string)!.dest_lat], ['강남역', 37.4979]);
  assert.deepEqual(res.changes.map((c) => [c.kind, hm(c.from), hm(c.to)]), [['WAKE', '07:25', '07:40'], ['PREPARE', '07:55', '08:10'], ['DEPARTURE', '08:15', '08:30']]); // 이동 35 → 20분이라 출발이 15분 늦춰짐
  assert.equal(res.ring_packages[0].subtitle, '오전 9:00 · 강남역');
});

test('직접 입력한 이동시간(MANUAL)은 장소를 바꿔도 그대로 (D42 C) — 길찾기 0번', async () => {
  const env = setup();
  const { thu } = await seededSeries(env);
  Object.assign(participantOf(env.db, thu.appointment_id)!, { est_travel_minutes: 40, travel_source: 'MANUAL' });
  const kakao = fakeKakao(5);
  await updateAppointment(ctxFor(env, A, { kakao: kakao.lookup }), upd(thu.appointment_id as string, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.equal(kakao.state.calls, 0);
  assert.deepEqual([participantOf(env.db, thu.appointment_id)!.est_travel_minutes, participantOf(env.db, thu.appointment_id)!.travel_source], [40, 'MANUAL']);
});

test('길찾기가 안 되면 근사값(ESTIMATE)으로 저장하고 경고를 같이 줌, 좌표 없는 장소는 이동시간을 못 구해 ROUTE_UNAVAILABLE (아무것도 안 씀)', async () => {
  const env = setup();
  const { thu, tue } = await seededSeries(env);
  const down = fakeKakao();
  down.state.fail = 'TIMEOUT';
  const res = await updateAppointment(ctxFor(env, A, { kakao: down.lookup }), upd(thu.appointment_id as string, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.equal(participantOf(env.db, thu.appointment_id)!.travel_source, 'ESTIMATE');
  assert.ok(res.warnings.some((w) => w.code === 'TRAVEL_NOT_EXACT'));

  const before = snap(env.db);
  await expectHttp(() => updateAppointment(ctxFor(env, A), upd(tue.appointment_id as string, { destination: { name: '도서관' } }, 'this', true)), 'ROUTE_UNAVAILABLE');
  assert.equal(snap(env.db), before);
});

// ===========================================================================
// 이후 모두 고치기
// ===========================================================================

test('이후 모두 고치기: 이 회차를 고치고(표시 지움) 뒤 회차를 지움 → roll이 새 기준으로 다시 만듦. 지운 알람은 canceled_alarm_ids', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-27T09:00', '2026-10-29T09:00', '2026-11-03T09:00', '2026-11-05T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const series = row(env.db, ids[0])!.series_id as string;
  const gone = [...alarmIds(env.db, ids[2]), ...alarmIds(env.db, ids[3])];
  env.db.rows('roll_attempts').push({ user_id: A, series_id: series, occurrence_on: '2026-11-10', tries: 1, next_try_at: iso('2026-10-26T11:00'), skipped: true, last_error: 'X' });
  env.db.rows('roll_attempts').push({ user_id: A, series_id: series, occurrence_on: '2026-10-28', tries: 1, next_try_at: iso('2026-10-26T11:00'), skipped: true, last_error: 'X' });

  const res = await updateAppointment(ctxFor(env, A), upd(ids[1], { at: kst('2026-10-29T08:30'), title: '세미나2' }, 'following', true));
  assert.deepEqual(res.deleted_appointment_ids.sort(), [ids[2], ids[3]].sort());
  assert.deepEqual([...res.canceled_alarm_ids].sort(), [...gone].sort());
  assert.deepEqual(dates(env.db, series), ['2026-10-27', '2026-10-29']);
  const target = row(env.db, ids[1])!;
  assert.deepEqual([hm(target.appointment_at), target.title, target.exception_kind, target.occurrence_on], ['08:30', '세미나2', null, '2026-10-29']);
  assert.equal(lines(env.db, ids[1]).find((l) => l.startsWith('DEPARTURE')), 'DEPARTURE 07:30 on');
  // 뒤 날짜의 재시도 기록만 정리됨 (이 날짜 앞의 기록은 그대로) — service가 닿은 표는 roll_attempts · 참여 기록 확인뿐
  assert.deepEqual(env.db.rows('roll_attempts').map((r) => r.occurrence_on), ['2026-10-28']);
  assert.deepEqual([...env.serviceTables], ['roll_attempts']);

  // roll이 새 기준(이 회차의 08:30)으로 다시 만듦
  const kakao = fakeKakao(35);
  const rolled = await roll(env, 'own', { lookup: kakao.lookup });
  assert.deepEqual(rolled.created.map((c) => c.occurrence_on), ['2026-11-03', '2026-11-05']);
  assert.deepEqual(rolled.created.map((c) => hm(row(env.db, c.appointment_id as string)!.appointment_at)), ['08:30', '08:30']);
  assert.deepEqual(rolled.created.map((c) => row(env.db, c.appointment_id as string)!.title), ['세미나2', '세미나2']);
});

test('이후 모두 고치기: 이번만 고친 회차와 출발 · 도착 기록이 있는 회차는 남김 (이번만 고친 값이 덮이지 않음)', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00', '2026-11-05T09:00', '2026-11-10T09:00', '2026-11-12T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  row(env.db, ids[2])!.exception_kind = 'EDITED'; // 11/05는 이번만 고침
  participantOf(env.db, ids[3])!.departed_at = iso('2026-10-26T09:00'); // 11/10은 출발 기록이 있음
  const res = await updateAppointment(ctxFor(env, A), upd(ids[0], { importance: 'HIGH' }, 'following', true));
  assert.deepEqual(res.deleted_appointment_ids.sort(), [ids[1], ids[4]].sort());
  assert.deepEqual(env.db.rows('appointments').map((a) => a.appointment_id).sort(), [ids[0], ids[2], ids[3]].sort());
  assert.equal(row(env.db, ids[2])!.exception_kind, 'EDITED');
});

test('이후 모두 고치기에서 반복 요일을 바꾸면 이 회차에 새 규칙, 반복을 끄면(null) 묶음 모든 행의 규칙이 빠져 roll이 다시 안 만듦', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-27T09:00', '2026-10-29T09:00', '2026-11-03T09:00', '2026-11-05T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const series = row(env.db, ids[0])!.series_id as string;

  await updateAppointment(ctxFor(env, A), upd(ids[1], { recurrenceRule: 'FREQ=WEEKLY;BYDAY=TH' }, 'following', true));
  assert.deepEqual(env.db.rows('appointments').map((a) => [a.occurrence_on, a.recurrence_rule]), [['2026-10-27', 'FREQ=WEEKLY;BYDAY=TU,TH'], ['2026-10-29', 'FREQ=WEEKLY;BYDAY=TH']]); // 뒤 회차는 지워짐
  const kakao = fakeKakao();
  assert.deepEqual((await roll(env, 'own', { lookup: kakao.lookup })).created.map((c) => c.occurrence_on), ['2026-11-05']); // 목요일만 (11/03 화 없음)

  const off = await updateAppointment(ctxFor(env, A), upd(ids[1], { recurrenceRule: null }, 'following', true));
  assert.ok(off.saved);
  assert.deepEqual(env.db.rows('appointments').filter((a) => a.series_id === series).map((a) => [a.occurrence_on, a.recurrence_rule]), [['2026-10-27', null], ['2026-10-29', null]]);
  const none = fakeKakao();
  assert.deepEqual((await roll(env, 'own', { lookup: none.lookup })).created, []);
  assert.deepEqual((await roll(env, 'batch', { lookup: none.lookup })).created, []);
  assert.equal(none.state.calls, 0);
});

test('한 번짜리에 반복을 켜면 이 행에 규칙이 들어가고 roll이 다음 회차를 만듦 (범위와 상관없이, 이번만 고침 표시 없음)', async () => {
  const env = setup();
  const id = await single(env, A, '2026-10-27T09:00', { title: '스터디' });
  const res = await updateAppointment(ctxFor(env, A), upd(id, { recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU' }, 'this', true));
  assert.ok(res.saved);
  assert.deepEqual([row(env.db, id)!.recurrence_rule, row(env.db, id)!.exception_kind], ['FREQ=WEEKLY;BYDAY=TU', null]);
  const kakao = fakeKakao(30);
  const rolled = await roll(env, 'own', { lookup: kakao.lookup });
  assert.deepEqual(rolled.created.map((c) => c.occurrence_on), ['2026-11-03']);
});

// ===========================================================================
// 한 번짜리 고치기 · 지우기
// ===========================================================================

test('한 번짜리 고치기: 예외 표시 없이 그 행과 알람을 고침 (범위는 안 봄)', async () => {
  const env = setup();
  const id = await single(env, A, '2026-10-29T09:00');
  for (const scope of ['this', 'following'] as const) {
    const res = await updateAppointment(ctxFor(env, A), upd(id, { at: kst(scope === 'this' ? '2026-10-29T10:00' : '2026-10-29T11:00') }, scope, true));
    assert.ok(res.saved);
  }
  assert.deepEqual([hm(row(env.db, id)!.appointment_at), row(env.db, id)!.exception_kind], ['11:00', null]);
  assert.equal(lines(env.db, id).find((l) => l.startsWith('DEPARTURE')), 'DEPARTURE 10:00 on');
});

test('한 번짜리 지우기: 약속 + 참여 + 알람이 사라지고 폰에서 지울 알람을 돌려줌 — 같은 요청을 두 번 보내면 두 번째는 없는 행이라 성공(아무 일 없음)', async () => {
  const env = setup();
  const id = await single(env, A, '2026-10-29T09:00');
  const ids = alarmIds(env.db, id);
  assert.equal(ids.length, 4);
  const res = await deleteAppointment(ctxFor(env, A), del(id));
  assert.deepEqual([res.deleted, res.mode, res.deleted_appointment_ids], [true, 'ROW', [id]]);
  assert.deepEqual([...res.canceled_alarm_ids].sort(), [...ids].sort());
  assert.deepEqual([env.db.rows('appointments').length, env.db.rows('appointment_participants').length, env.db.rows('alarms').length], [0, 0, 0]);

  const again = await deleteAppointment(ctxFor(env, A), del(id));
  assert.deepEqual([again.deleted, again.mode, again.canceled_alarm_ids, again.ring_packages], [false, 'NONE', [], []]);
});

// ===========================================================================
// 이번만 지우기 · 되돌리기
// ===========================================================================

test('이번만 지우기: 행은 두고 알람만 지움 + 지운 회차 표시 → roll이 그 날짜를 다시 안 만듦 (본인 · 배치 모두), 같은 요청 두 번 = 같은 결과', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-27T09:00', '2026-10-29T09:00', '2026-11-03T09:00', '2026-11-05T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const series = row(env.db, ids[0])!.series_id as string;
  const gone = alarmIds(env.db, ids[2]);
  const others = JSON.stringify([row(env.db, ids[0]), row(env.db, ids[1]), row(env.db, ids[3]), alarmsOf(env.db, ids[1]), alarmsOf(env.db, ids[3])]);

  const res = await deleteAppointment(ctxFor(env, A), del(ids[2], 'this'));
  assert.deepEqual([res.deleted, res.mode, res.deleted_appointment_ids], [true, 'CANCEL_THIS', []]);
  assert.deepEqual([...res.canceled_alarm_ids].sort(), [...gone].sort());
  assert.deepEqual([row(env.db, ids[2])!.exception_kind, alarmsOf(env.db, ids[2]).length, !!participantOf(env.db, ids[2])], ['CANCELED', 0, true]);
  assert.equal(JSON.stringify([row(env.db, ids[0]), row(env.db, ids[1]), row(env.db, ids[3]), alarmsOf(env.db, ids[1]), alarmsOf(env.db, ids[3])]), others);
  assert.deepEqual(dates(env.db, series), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);

  const saved = snap(env.db);
  const again = await deleteAppointment(ctxFor(env, A), del(ids[2], 'this'));
  assert.deepEqual([again.deleted, again.mode, again.canceled_alarm_ids, again.ring_packages], [true, 'CANCEL_THIS', [], []]);
  assert.equal(snap(env.db), saved);

  const kakao = fakeKakao();
  assert.deepEqual((await roll(env, 'own', { lookup: kakao.lookup })).created, []);
  assert.deepEqual((await roll(env, 'batch', { lookup: kakao.lookup })).created, []);
  assert.equal(kakao.state.calls, 0);
});

test('되돌리기: 이번만 지운 회차는 알람을 자동 값으로 다시 만들어 되살림(이번만 고침 표시), 지운 적 없으면 아무것도 안 함 — 같은 요청 두 번 = 같은 결과', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  await deleteAppointment(ctxFor(env, A), del(ids[1], 'this'));

  const res = await restoreAppointment(ctxFor(env, A), restore(ids[1]));
  assert.deepEqual([res.restored, res.reason], [true, undefined]);
  assert.equal(kinds(env.db, ids[1]), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  assert.deepEqual([lines(env.db, ids[1]).find((l) => l.startsWith('DEPARTURE')), lines(env.db, ids[1]).find((l) => l.startsWith('ARRIVE'))], ['DEPARTURE 08:00 on', 'ARRIVE 08:50 on']);
  assert.equal(row(env.db, ids[1])!.exception_kind, 'EDITED');
  assert.deepEqual(res.ring_packages.map((p) => p.type), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);
  assert.deepEqual(res.ring_packages.map((p) => p.alarmId).sort(), alarmIds(env.db, ids[1]).sort());

  const saved = snap(env.db);
  const again = await restoreAppointment(ctxFor(env, A), restore(ids[1]));
  assert.deepEqual([again.restored, again.reason, again.ring_packages], [false, 'NOT_DELETED', []]);
  assert.equal(snap(env.db), saved);
  assert.deepEqual((await restoreAppointment(ctxFor(env, A), restore(ids[0]))).restored, false); // 지운 적 없는 일정
  assert.deepEqual((await restoreAppointment(ctxFor(env, A), restore('nope'))).reason, 'NOT_FOUND');
});

test('되돌리기는 이미 행이 지워진 경우(한 번짜리 · 이후 모두 지우기)는 못 함 — restored false, 아무것도 안 만듦', async () => {
  const env = setup();
  const id = await single(env, A, '2026-10-29T09:00');
  await deleteAppointment(ctxFor(env, A), del(id));
  const res = await restoreAppointment(ctxFor(env, A), restore(id));
  assert.deepEqual([res.restored, res.reason], [false, 'NOT_FOUND']);
  assert.equal(env.db.rows('appointments').length, 0);
});

test('지운(CANCELED) 회차는 고칠 수 없음 — 되돌리기가 먼저 (NOT_FOUND)', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  await deleteAppointment(ctxFor(env, A), del(ids[1], 'this'));
  await expectHttp(() => updateAppointment(ctxFor(env, A), upd(ids[1], { title: '고침' }, 'this', true)), 'NOT_FOUND');
});

// ===========================================================================
// 이후 모두 지우기 · 반복 끔
// ===========================================================================

test('이후 모두 지우기: 이 회차와 뒤 회차를 지우고 남은 행의 규칙을 비움(roll 대상에서 빠짐) — 지난 행 · 기록은 남음, 같은 요청 두 번 = 같은 결과', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-22T09:00', '2026-10-27T09:00', '2026-10-29T09:00', '2026-11-03T09:00', '2026-11-05T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const series = row(env.db, ids[0])!.series_id as string;
  Object.assign(participantOf(env.db, ids[0])!, { departed_at: iso('2026-10-22T08:00'), arrived_at: iso('2026-10-22T08:50') }); // 지난 회차의 기록
  const gone = [2, 3, 4].flatMap((i) => alarmIds(env.db, ids[i]));
  env.db.rows('roll_attempts').push({ user_id: A, series_id: series, occurrence_on: '2026-11-10', tries: 1, next_try_at: iso('2026-10-26T11:00'), skipped: false, last_error: 'X' });

  const res = await deleteAppointment(ctxFor(env, A), del(ids[2], 'following'));
  assert.deepEqual([res.deleted, res.mode], [true, 'FROM_HERE']);
  assert.deepEqual([...res.deleted_appointment_ids].sort(), [ids[2], ids[3], ids[4]].sort());
  assert.deepEqual([...res.canceled_alarm_ids].sort(), [...gone].sort());
  assert.deepEqual(dates(env.db, series), ['2026-10-22', '2026-10-27']);
  assert.deepEqual(env.db.rows('appointments').map((a) => a.recurrence_rule), [null, null]);
  assert.deepEqual([participantOf(env.db, ids[0])!.departed_at, alarmsOf(env.db, ids[0]).length], [iso('2026-10-22T08:00'), 4]); // 기록은 그대로
  assert.equal(env.db.rows('roll_attempts').length, 0);

  const kakao = fakeKakao();
  assert.deepEqual((await roll(env, 'own', { lookup: kakao.lookup })).created, []);
  assert.deepEqual((await roll(env, 'batch', { lookup: kakao.lookup })).created, []);
  assert.equal(kakao.state.calls, 0);

  const saved = snap(env.db);
  const again = await deleteAppointment(ctxFor(env, A), del(ids[2], 'following'));
  assert.deepEqual([again.deleted, again.mode, again.canceled_alarm_ids], [false, 'NONE', []]);
  assert.equal(snap(env.db), saved);
});

test('이후 모두 지우기: 이번만 고친 · 지운 회차도 지움(반복이 끝남), 출발 · 도착 기록이 있는 뒤 회차는 남김', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00', '2026-11-05T09:00', '2026-11-10T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  row(env.db, ids[1])!.exception_kind = 'EDITED';
  await deleteAppointment(ctxFor(env, A), del(ids[2], 'this')); // 11/05 이번만 지움
  participantOf(env.db, ids[3])!.arrived_at = iso('2026-11-10T08:50');
  const res = await deleteAppointment(ctxFor(env, A), del(ids[0], 'following'));
  assert.deepEqual([...res.deleted_appointment_ids].sort(), [ids[0], ids[1], ids[2]].sort());
  assert.deepEqual(env.db.rows('appointments').map((a) => [a.appointment_id, a.recurrence_rule]), [[ids[3], null]]);
});

test('출발 · 도착 기록이 있는 일정은 못 지움 (HAS_RECORDS) — 아무것도 안 지움', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  participantOf(env.db, ids[0])!.departed_at = iso('2026-10-29T08:00');
  const before = snap(env.db);
  for (const scope of ['this', 'following'] as const) await expectHttp(() => deleteAppointment(ctxFor(env, A), del(ids[0], scope)), 'UNPROCESSABLE', 'HAS_RECORDS');
  assert.equal(snap(env.db), before);
});

// ===========================================================================
// 7.1.3 — 앞 일정이 바뀌거나 지워지면 같은 날 다음 일정의 기상을 다시 정함
// ===========================================================================

test('7.1.3: 그날 첫 일정을 지우면 둘째 일정에 기상 알람이 붙음 (준비도 다시 계산), 폰에 걸 꾸러미와 지울 알람을 돌려줌', async () => {
  const env = setup();
  const first = await single(env, A, '2026-10-29T10:00', { title: '첫 일정' });
  const second = await single(env, A, '2026-10-29T13:00', { title: '둘째 일정' });
  assert.equal(kinds(env.db, first), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  assert.equal(kinds(env.db, second), 'ARRIVE,DEPARTURE,PREPARE'); // 첫 일정에 밀려 기상 없음
  const firstIds = alarmIds(env.db, first);

  const res = await deleteAppointment(ctxFor(env, A), del(first));
  assert.equal(kinds(env.db, second), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  const wake = alarmsOf(env.db, second).find((a) => a.alarm_type === 'WAKE')!;
  assert.equal(wake.is_enabled, true);
  assert.deepEqual(lines(env.db, second).find((l) => l.startsWith('DEPARTURE')), 'DEPARTURE 12:00 on');
  assert.ok(res.ring_packages.some((p) => p.alarmId === wake.alarm_id && p.type === 'WAKE' && p.title === '둘째 일정'));
  assert.deepEqual([...res.canceled_alarm_ids].sort(), [...firstIds].sort());
  assert.deepEqual(res.warnings, []);
});

test('7.1.3: 일정을 앞으로 옮기면 새 첫 일정에 기상이 붙고 옛 첫 일정의 기상은 떨어짐 (떨어진 기상은 canceled_alarm_ids)', async () => {
  const env = setup();
  const a1 = await single(env, A, '2026-10-29T10:00', { title: 'A1' });
  const a2 = await single(env, A, '2026-10-29T13:00', { title: 'A2' });
  const a1Wake = alarmsOf(env.db, a1).find((x) => x.alarm_type === 'WAKE')!.alarm_id;

  const res = await updateAppointment(ctxFor(env, A), upd(a2, { at: kst('2026-10-29T08:00') }, 'this', true));
  assert.equal(kinds(env.db, a2), 'ARRIVE,DEPARTURE,PREPARE,WAKE'); // 이제 첫 일정
  assert.equal(kinds(env.db, a1), 'ARRIVE,DEPARTURE,PREPARE'); // 밀려남
  assert.ok(res.canceled_alarm_ids.includes(a1Wake as string));
  assert.ok(res.ring_packages.some((p) => p.type === 'WAKE' && p.title === 'A2'));
  assert.ok(!res.ring_packages.some((p) => p.type === 'WAKE' && p.title === 'A1'));

  // 다시 뒤로 옮기면 원래대로
  await updateAppointment(ctxFor(env, A), upd(a2, { at: kst('2026-10-29T13:00') }, 'this', true));
  assert.equal(kinds(env.db, a1), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  assert.equal(kinds(env.db, a2), 'ARRIVE,DEPARTURE,PREPARE');
});

test('7.1.3: 이미 울린 기상 알람은 앞 일정이 생겨도 떼지 않음 (울린 기록 = 학습 · 미루기 근거), 아직 안 울린 것은 떼짐', async () => {
  const env = setup();
  const a1 = await single(env, A, '2026-10-29T13:00', { title: 'A1' });
  const a2 = await single(env, A, '2026-10-29T20:00', { title: 'A2' });
  const a1Wake = alarmsOf(env.db, a1).find((x) => x.alarm_type === 'WAKE')!;
  const wakeAt = new Date(a1Wake.scheduled_at as string);
  // 시험 전제: 기상은 낮 12시 전(12시 이후면 저녁 기상이라 아예 안 생김, #320)이고 11시 반 전에 울림
  assert.ok(wakeAt.getTime() < kst('2026-10-29T11:30').getTime());

  // 아직 안 울렸을 때(지금 = 월요일) — A2를 A1 앞으로 옮기면 A1의 기상은 떼짐
  const early = await updateAppointment(ctxFor(env, A), upd(a2, { at: kst('2026-10-29T12:45') }, 'this', true));
  assert.ok(early.canceled_alarm_ids.includes(a1Wake.alarm_id as string));
  assert.equal(kinds(env.db, a1), 'ARRIVE,DEPARTURE,PREPARE');
  await updateAppointment(ctxFor(env, A), upd(a2, { at: kst('2026-10-29T20:00') }, 'this', true)); // 원래대로 (A1이 다시 기상을 받음)
  assert.equal(kinds(env.db, a1), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  const wakeAgain = alarmsOf(env.db, a1).find((x) => x.alarm_type === 'WAKE')!;

  // 이미 울린 뒤(지금 = 11:30) — 같은 변경에도 A1의 기상 알람은 그대로 남음
  const late = await updateAppointment(ctxFor(env, A, { now: kst('2026-10-29T11:30') }), upd(a2, { at: kst('2026-10-29T12:45') }, 'this', true));
  assert.equal(late.saved, true);
  assert.equal(kinds(env.db, a1), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  assert.ok(!late.canceled_alarm_ids.includes(wakeAgain.alarm_id as string));
  assert.equal(alarmsOf(env.db, a1).find((x) => x.alarm_type === 'WAKE')!.is_enabled, true);
});

test('7.1.3: 셋째 일정은 밀려 있던 대로 — 둘째가 기상을 받으면 셋째는 그대로, 일부러 기상을 안 고른 일정은 되살리지 않음', async () => {
  const env = setup();
  const a1 = await single(env, A, '2026-10-29T10:00');
  const a2 = await single(env, A, '2026-10-29T13:00');
  const a3 = await single(env, A, '2026-10-29T17:00', { kinds: ['DEPARTURE'] });
  const a3Before = JSON.stringify(alarmsOf(env.db, a3));
  await deleteAppointment(ctxFor(env, A), del(a1));
  assert.equal(kinds(env.db, a2), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  assert.equal(JSON.stringify(alarmsOf(env.db, a3)), a3Before);
});

test('7.1.3: 반복 일정의 이번만 지우기 · 되돌리기도 같은 날 다른 일정의 기상을 다시 정함', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const other = await single(env, A, '2026-10-29T13:00', { title: '오후 약속' });
  assert.equal(kinds(env.db, other), 'ARRIVE,DEPARTURE,PREPARE');
  await deleteAppointment(ctxFor(env, A), del(ids[0], 'this'));
  assert.equal(kinds(env.db, other), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  const res = await restoreAppointment(ctxFor(env, A), restore(ids[0]));
  assert.equal(kinds(env.db, other), 'ARRIVE,DEPARTURE,PREPARE'); // 되살린 회차가 다시 첫 일정
  assert.equal(kinds(env.db, ids[0]), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  assert.equal(res.canceled_alarm_ids.length, 1);
});

test('7.1.3: 다시 계산이 안 되면(저장된 이동시간이 없음) 그 일정은 그대로 두고 경고만 — 요청은 성공', async () => {
  const env = setup();
  const first = await single(env, A, '2026-10-29T10:00');
  const second = await single(env, A, '2026-10-29T13:00');
  participantOf(env.db, second)!.est_travel_minutes = null;
  const before = JSON.stringify(alarmsOf(env.db, second));
  const res = await deleteAppointment(ctxFor(env, A), del(first));
  assert.equal(res.deleted, true);
  assert.equal(JSON.stringify(alarmsOf(env.db, second)), before);
  assert.deepEqual(res.warnings.map((w) => w.code), ['WAKE_REEVAL_SKIPPED']);
});

// ===========================================================================
// 보안 · 공동 약속
// ===========================================================================

test('남의 개인 약속은 못 고치고 못 지움: 고치기 NOT_FOUND, 지우기 · 되돌리기 · 빠지기는 없는 행처럼 성공(아무 일 없음) — 데이터는 그대로', async () => {
  const env = setup([A, B]);
  const id = await single(env, A, '2026-10-29T09:00');
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T15:00', '2026-11-03T15:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const before = snap(env.db);
  const b = ctxFor(env, B);
  await expectHttp(() => updateAppointment(b, upd(id, { title: '가로채기' }, 'this', true)), 'NOT_FOUND');
  await expectHttp(() => updateAppointment(b, upd(ids[0], { title: '가로채기' }, 'following', true)), 'NOT_FOUND');
  assert.deepEqual([(await deleteAppointment(b, del(id))).deleted, (await deleteAppointment(b, del(ids[0], 'following'))).mode], [false, 'NONE']);
  assert.equal((await restoreAppointment(b, restore(id))).restored, false);
  assert.equal((await leaveSharedAppointment(b, leave(id))).left, false);
  assert.equal(snap(env.db), before);
});

test('공동 약속: 만든 사람만 고치기 · 지우기 (참여만 한 사람은 FORBIDDEN), 시각 · 장소 · 반복은 아직 못 고침(제목 · 중요도만), 지우면 약속 전체가 사라짐', async () => {
  const env = setup([A, B]);
  env.db.rows('group_members').push({ group_id: 'g1', user_id: A, invite_status: 'JOINED' }, { group_id: 'g1', user_id: B, invite_status: 'JOINED' });
  const [id] = rawSeries(env.db, A, { ats: ['2026-10-29T09:00'], rule: null, title: '팀플', group: 'g1' });
  addParticipant(env.db, B, id, new Date(iso('2026-10-29T09:00')));
  const bAlarms = alarmIds(env.db, id, B);
  const before = snap(env.db);

  const b = ctxFor(env, B);
  await expectHttp(() => updateAppointment(b, upd(id, { title: '가로채기' }, 'this', true)), 'FORBIDDEN');
  await expectHttp(() => deleteAppointment(b, del(id)), 'FORBIDDEN');
  assert.equal(snap(env.db), before);

  const a = ctxFor(env, A);
  await expectHttp(() => updateAppointment(a, upd(id, { at: kst('2026-10-29T10:00') }, 'this', true)), 'UNPROCESSABLE', 'GROUP_EDIT_LIMIT');
  await expectHttp(() => updateAppointment(a, upd(id, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true)), 'UNPROCESSABLE', 'GROUP_EDIT_LIMIT');
  await expectHttp(() => updateAppointment(a, upd(id, { recurrenceRule: 'FREQ=DAILY' }, 'this', true)), 'UNPROCESSABLE', 'GROUP_EDIT_LIMIT');
  const titled = await updateAppointment(a, upd(id, { title: '팀플 (장소 변경)', importance: 'HIGH' }, 'this', true));
  assert.ok(titled.saved);
  assert.deepEqual([row(env.db, id)!.title, row(env.db, id)!.exception_kind], ['팀플 (장소 변경)', null]);
  assert.equal(JSON.stringify(alarmsOf(env.db, id, B).map((x) => x.alarm_id)), JSON.stringify(bAlarms)); // 다른 참여자의 알람은 이 PR에서 안 건드림

  participantOf(env.db, id, B)!.arrived_at = iso('2026-10-29T08:50'); // 다른 참여자의 도착 기록도 지킴 (service로 확인)
  await expectHttp(() => deleteAppointment(a, del(id)), 'UNPROCESSABLE', 'HAS_RECORDS');
  participantOf(env.db, id, B)!.arrived_at = null;
  assert.deepEqual([...env.serviceTables], ['appointment_participants']);

  const gone = await deleteAppointment(a, del(id));
  assert.deepEqual([gone.deleted, gone.mode], [true, 'ROW']);
  assert.deepEqual(env.db.rows('appointments').length + env.db.rows('appointment_participants').length + env.db.rows('alarms').length, 0);
  assert.equal(gone.canceled_alarm_ids.some((x) => bAlarms.includes(x)), false); // 내 알람만 돌려줌 (B의 폰은 B의 다음 맞추기에서 정리)
});

test('공동 약속에서 나만 빠지기: 내 참여 · 알람만 사라지고 약속 · 만든 사람의 참여는 그대로, 만든 사람 · 공동 약속이 아닌 일정은 UNPROCESSABLE, 두 번 보내도 같은 결과', async () => {
  const env = setup([A, B]);
  env.db.rows('group_members').push({ group_id: 'g1', user_id: A, invite_status: 'JOINED' }, { group_id: 'g1', user_id: B, invite_status: 'JOINED' });
  const [id] = rawSeries(env.db, A, { ats: ['2026-10-29T09:00'], rule: null, title: '팀플', group: 'g1' });
  addParticipant(env.db, B, id, new Date(iso('2026-10-29T09:00')));
  const own = await single(env, A, '2026-10-30T09:00');
  const bAlarms = alarmIds(env.db, id, B);
  const aAlarms = JSON.stringify(alarmsOf(env.db, id, A));

  const b = ctxFor(env, B);
  const res = await leaveSharedAppointment(b, leave(id));
  assert.deepEqual([res.left, res.canceled_alarm_ids.slice().sort()], [true, [...bAlarms].sort()]);
  assert.deepEqual([!!participantOf(env.db, id, B), alarmsOf(env.db, id, B).length, !!row(env.db, id), JSON.stringify(alarmsOf(env.db, id, A))], [false, 0, true, aAlarms]);

  const saved = snap(env.db);
  const again = await leaveSharedAppointment(b, leave(id));
  assert.deepEqual([again.left, again.canceled_alarm_ids], [true, []]);
  assert.equal(snap(env.db), saved);

  await expectHttp(() => leaveSharedAppointment(ctxFor(env, A), leave(id)), 'UNPROCESSABLE', 'CREATOR_CANNOT_LEAVE');
  await expectHttp(() => leaveSharedAppointment(ctxFor(env, A), leave(own)), 'UNPROCESSABLE', 'NOT_SHARED');
});

test('service 클라이언트는 필요한 곳(재시도 기록 정리 · 공동 약속 기록 확인)에만 닿음 — 나머지 읽기 · 쓰기는 모두 부른 사람의 RLS 클라이언트', async () => {
  const env = setup();
  const { thu } = await seededSeries(env);
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T15:00', '2026-11-03T15:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const single1 = await single(env, A, '2026-10-30T09:00');
  const ctx = ctxFor(env, A, { kakao: fakeKakao().lookup });
  await updateAppointment(ctx, upd(thu.appointment_id as string, { title: 'x' }, 'this', true));
  await updateAppointment(ctx, upd(ids[0], { at: kst('2026-10-29T16:00') }, 'following', true));
  await deleteAppointment(ctx, del(ids[0], 'following'));
  await deleteAppointment(ctx, del(single1));
  await restoreAppointment(ctx, restore(thu.appointment_id as string));
  assert.deepEqual([...env.serviceTables].sort(), ['roll_attempts']);
});

// ===========================================================================
// 중간에 실패해도 다시 보내면 이어서 끝남
// ===========================================================================

test('알람을 쓰다 실패하면 약속 행은 안 바뀐 채라 같은 요청을 다시 보내면 그대로 끝남', async () => {
  const env = setup();
  const { thu } = await seededSeries(env);
  const request = upd(thu.appointment_id as string, { at: kst('2026-10-29T10:00') }, 'this', true);
  env.db.failOn.push({ table: 'alarms', op: 'update' });
  await expectHttp(() => updateAppointment(ctxFor(env, A), request), 'INTERNAL');
  assert.deepEqual([hm(row(env.db, thu.appointment_id as string)!.appointment_at), row(env.db, thu.appointment_id as string)!.exception_kind], ['09:00', null]);

  env.db.failOn.length = 0;
  const res = await updateAppointment(ctxFor(env, A), request);
  assert.ok(res.saved);
  assert.deepEqual(lines(env.db, thu.appointment_id), ['WAKE 08:25 on', 'PREPARE 08:55 on', 'DEPARTURE 09:15 on', 'ARRIVE 09:50 on']);
  assert.equal(row(env.db, thu.appointment_id as string)!.exception_kind, 'EDITED');
});

test('이후 모두 고치기 중간에 실패해도(뒤 회차는 이미 지움) 다시 보내면 이 회차가 고쳐지고 끝남', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00', '2026-11-05T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  const request = upd(ids[0], { at: kst('2026-10-29T08:30') }, 'following', true);
  env.db.failOn.push({ table: 'appointments', op: 'update' });
  await expectHttp(() => updateAppointment(ctxFor(env, A), request), 'INTERNAL');
  assert.equal(hm(row(env.db, ids[0])!.appointment_at), '09:00'); // 이 회차는 그대로
  assert.deepEqual(env.db.rows('appointments').map((a) => a.appointment_id), [ids[0]]); // 뒤 회차는 이미 지움

  env.db.failOn.length = 0;
  const res = await updateAppointment(ctxFor(env, A), request);
  assert.ok(res.saved);
  assert.equal(hm(row(env.db, ids[0])!.appointment_at), '08:30');
  assert.equal(lines(env.db, ids[0]).find((l) => l.startsWith('DEPARTURE')), 'DEPARTURE 07:30 on');
});

test('되돌리기 중간에 실패해도(알람은 만들었는데 표시 쓰기 실패) 다시 보내면 이어서 끝남 — 같은 알람을 또 넣다 CONFLICT가 나지 않음 (로컬 리뷰 반영)', async () => {
  const env = setup();
  const ids = rawSeries(env.db, A, { ats: ['2026-10-29T09:00', '2026-11-03T09:00'], rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  await deleteAppointment(ctxFor(env, A), del(ids[1], 'this'));
  env.db.failOn.push({ table: 'appointments', op: 'update' });
  await expectHttp(() => restoreAppointment(ctxFor(env, A), restore(ids[1])), 'INTERNAL');
  assert.equal(row(env.db, ids[1])!.exception_kind, 'CANCELED'); // 표시는 그대로, 알람은 이미 만들어 둔 상태
  assert.equal(kinds(env.db, ids[1]), 'ARRIVE,DEPARTURE,PREPARE,WAKE');

  env.db.failOn.length = 0;
  const res = await restoreAppointment(ctxFor(env, A), restore(ids[1]));
  assert.deepEqual([res.restored, res.reason], [true, undefined]);
  assert.equal(row(env.db, ids[1])!.exception_kind, 'EDITED');
  assert.equal(kinds(env.db, ids[1]), 'ARRIVE,DEPARTURE,PREPARE,WAKE'); // 알람이 두 벌이 되지 않음
});

test('runEdit이 action에 맞는 함수를 부름', async () => {
  const env = setup();
  const id = await single(env, A, '2026-10-29T09:00');
  const ctx = ctxFor(env, A);
  assert.equal(((await runEdit(ctx, upd(id, { title: '바꿈' }))) as { saved: boolean }).saved, true);
  assert.equal(((await runEdit(ctx, restore(id))) as { restored: boolean }).restored, false);
  assert.equal(((await runEdit(ctx, del(id))) as { deleted: boolean }).deleted, true);
});

// ===========================================================================
// 저녁에만 일정이 있는 날은 기상 알람 없음 (#320) — 계산된 기상이 낮 12시 이후면 준비 · 출발 · 도착만
// ===========================================================================

test('#320: 저녁 단일 일정은 기상 없이 준비 · 출발 · 도착만, 저녁 일정 둘도 둘 다 기상 없음 (첫 일정이 기상 없다고 둘째가 기상을 얻지 않음)', async () => {
  const env = setup();
  const e1 = await single(env, A, '2026-10-29T17:00');
  const e2 = await single(env, A, '2026-10-29T19:00');
  assert.equal(kinds(env.db, e1), 'ARRIVE,DEPARTURE,PREPARE');
  assert.equal(kinds(env.db, e2), 'ARRIVE,DEPARTURE,PREPARE');
  assert.equal(participantOf(env.db, e1)!.prepare_minutes, 15);
});

test('#320: 오전 일정 + 저녁 일정 — 오전은 기상, 저녁은 기상 없음. 오전 일정을 지워도 저녁 일정에 기상을 되살리지 않음', async () => {
  const env = setup();
  const morning = await single(env, A, '2026-10-29T09:00');
  const evening = await single(env, A, '2026-10-29T18:00');
  assert.equal(kinds(env.db, morning), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
  assert.equal(kinds(env.db, evening), 'ARRIVE,DEPARTURE,PREPARE');
  const before = JSON.stringify(alarmsOf(env.db, evening));
  await deleteAppointment(ctxFor(env, A), del(morning));
  assert.equal(JSON.stringify(alarmsOf(env.db, evening)), before);
});

test('#320: 아침 일정을 저녁으로 옮기면 기상이 떨어지고, 다시 아침으로 옮기면 기상이 붙음', async () => {
  const env = setup();
  const a = await single(env, A, '2026-10-29T09:00');
  const wake = alarmsOf(env.db, a).find((x) => x.alarm_type === 'WAKE')!;
  assert.ok(wake);
  const res = await updateAppointment(ctxFor(env, A), upd(a, { at: kst('2026-10-29T20:00') }, 'this', true));
  assert.equal(kinds(env.db, a), 'ARRIVE,DEPARTURE,PREPARE');
  assert.ok(res.canceled_alarm_ids.includes(wake.alarm_id as string));
  await updateAppointment(ctxFor(env, A), upd(a, { at: kst('2026-10-29T09:00') }, 'this', true));
  assert.equal(kinds(env.db, a), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
});

test('#320: 저녁 일정 둘 중 앞 일정을 지워도 다른 저녁 일정에 기상이 붙지 않음', async () => {
  const env = setup();
  const e1 = await single(env, A, '2026-10-29T17:00');
  const e2 = await single(env, A, '2026-10-29T19:00');
  await deleteAppointment(ctxFor(env, A), del(e1));
  assert.equal(kinds(env.db, e2), 'ARRIVE,DEPARTURE,PREPARE');
});
