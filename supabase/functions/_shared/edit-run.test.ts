// appointment-edit 본문(edit-run.ts) — 가짜 DB(fake-db.ts) + 가짜 카카오(분 고정, 부른 수 셈)로.
// 달력: 2026-10-26 월(지금 10:00) · 27 화 · 29 목 · 11-03 화 · 11-05 목 · 11-10 화 · 11-12 목. 모두 한국 시각
// 부른 사람의 RLS를 흉내 내는 껍데기(asUser)로 읽고 쓰게 해서, 남의 약속이 안 보이는 것까지 같이 확인함. service가 닿은 표도 지켜봄(serviceTables)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commitPlacePending, persistAppointment } from './commit.ts';
import { deleteAppointment, leaveSharedAppointment, restoreAppointment, runEdit, SYNC_CONCURRENCY, updateAppointment, type EditCtx } from './edit-run.ts';
import type { EditRequest } from './edit-request.ts';
import type { AppointmentPatch } from './edit.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import type { NotifyOptions } from './notify.ts';
import { KakaoError, type KakaoFailure } from './kakao.ts';
import { ALARM_COLUMNS, buildPlan } from './plan.ts';
import type { ProfileRow } from './plan-core.ts';
import { Reader } from './read.ts';
import { readCommitRequest } from './requests.ts';
import { runRoll, type RollResult, type TravelLookup } from './roll.ts';
import type { Db } from './supabase.ts';
import { localDayRange } from './tz.ts';
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

function ctxFor(env: Env, user: string, over: { now?: Date; kakao?: TravelLookup; push?: NotifyOptions } = {}): EditCtx {
  const service = { from: (table: string) => (env.serviceTables.add(table), env.db.from(table)), rpc: (name: string, args?: Record<string, unknown>) => env.db.rpc(name, args) } as unknown as Db;
  return { userId: user, userDb: asUser(env.db, user), service, now: over.now ?? MON_10, ...(over.kakao ? { kakao: over.kakao } : {}), ...(over.push ? { push: over.push } : {}) };
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

test('공동 약속: 만든 사람만 고치기 · 지우기 (참여만 한 사람은 FORBIDDEN), 반복은 아직 못 고침, 제목 · 중요도만 고치면 다른 참여자의 알람은 그대로, 지우면 약속 전체가 사라짐', async () => {
  const env = setup([A, B]);
  env.db.rows('group_members').push({ group_id: 'g1', user_id: A, invite_status: 'JOINED' }, { group_id: 'g1', user_id: B, invite_status: 'JOINED' });
  withGroupPush(env);
  const [id] = rawSeries(env.db, A, { ats: ['2026-10-29T09:00'], rule: null, title: '팀플', group: 'g1' });
  addParticipant(env.db, B, id, new Date(iso('2026-10-29T09:00')));
  const bAlarms = alarmIds(env.db, id, B);
  const before = snap(env.db);

  const b = ctxFor(env, B);
  await expectHttp(() => updateAppointment(b, upd(id, { title: '가로채기' }, 'this', true)), 'FORBIDDEN');
  await expectHttp(() => deleteAppointment(b, del(id)), 'FORBIDDEN');
  assert.equal(snap(env.db), before);

  const a = ctxFor(env, A);
  await expectHttp(() => updateAppointment(a, upd(id, { recurrenceRule: 'FREQ=DAILY' }, 'this', true)), 'UNPROCESSABLE', 'GROUP_RECURRENCE_LATER');
  const titled = await updateAppointment(a, upd(id, { title: '팀플 (장소 변경)', importance: 'HIGH' }, 'this', true));
  assert.ok(titled.saved);
  assert.deepEqual([row(env.db, id)!.title, row(env.db, id)!.exception_kind], ['팀플 (장소 변경)', null]);
  assert.equal(JSON.stringify(alarmsOf(env.db, id, B).map((x) => x.alarm_id)), JSON.stringify(bAlarms)); // 제목만 고치면 다른 참여자의 알람은 그대로

  participantOf(env.db, id, B)!.arrived_at = iso('2026-10-29T08:50'); // 다른 참여자의 도착 기록도 지킴 (service로 확인)
  await expectHttp(() => deleteAppointment(a, del(id)), 'UNPROCESSABLE', 'HAS_RECORDS');
  participantOf(env.db, id, B)!.arrived_at = null;
  assert.deepEqual([...env.serviceTables], ['appointment_participants']);

  const gone = await deleteAppointment(a, del(id));
  assert.deepEqual([gone.deleted, gone.mode], [true, 'ROW']);
  assert.deepEqual(env.db.rows('appointments').length + env.db.rows('appointment_participants').length + env.db.rows('alarms').length, 0);
  assert.equal(gone.canceled_alarm_ids.some((x) => bAlarms.includes(x)), false); // 내 알람만 돌려줌 (B의 폰은 B의 다음 맞추기에서 정리)
});

// ---- 공동 약속 (친구 9장): 만든 사람이 시각 · 장소를 고치면 다른 참여자의 알람도 다시 계산하고 알림, 지우면 취소 알림 ----

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

const GROUP = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const T_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const FAR = { lat: 37.4, lng: 127.1 };

// DB 함수 plan_group_push 흉내 — 보낸 사람이 그 약속을 만든 사람(비었으면 참여자)이고 아직 안 지난 약속일 때만 OK, 받는 사람 = 약속 참여자 − 보낸 사람
function withGroupPush(env: Env): void {
  env.db.rpcHandlers.plan_group_push = (args) => {
    const ap = env.db.rows('appointments').find((a) => a.appointment_id === args.p_appointment_id);
    const sender = args.p_sender_id as string;
    const participants = env.db.rows('appointment_participants').filter((p) => p.appointment_id === args.p_appointment_id).map((p) => p.user_id as string);
    const mine = ap && (ap.creator_id === sender || (ap.creator_id == null && participants.includes(sender)));
    if (!ap || !mine || Date.parse(ap.appointment_at as string) < localDayRange(env.db.now, 'Asia/Seoul').start.getTime()) return { status: 'FORBIDDEN' }; // 지난 약속 = 하루 경계(내 시간대 오늘 0시 이전)
    const members = env.db.rows('group_members').filter((m) => m.group_id === args.p_group_id && m.invite_status === 'JOINED');
    const joined = new Set(members.filter((m) => !m.notifications_off).map((m) => m.user_id as string));
    const muted = new Set(members.filter((m) => m.notifications_off).map((m) => m.user_id as string));
    return {
      status: 'OK',
      group_name: '캡스톤팀',
      appointment_title: ap.title,
      recipients: participants.filter((u) => u !== sender && joined.has(u)),
      silent_recipients: participants.filter((u) => u !== sender && muted.has(u)), // 알림을 끈 멤버(차단 쌍도 같은 쪽)에게는 조용한 데이터 푸시
    };
  };
}

// sent = 보이는 알림만, quiet = 문구 없는 데이터 푸시(G2: 약속 변경 · 취소는 보이는 알림을 받는 참여자에게도 같이 감), all = 둘 다
function pushSpy(opts: { fail?: boolean } = {}) {
  type Wire = { to: string; title?: string; body?: string; data: Record<string, unknown> };
  const all: Wire[] = [];
  const sent = [] as { to: string; title: string; body: string; data: Record<string, unknown> }[];
  const quiet: Wire[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    if (opts.fail) throw new Error('network down');
    const body = JSON.parse(init?.body as string) as Wire[];
    all.push(...body);
    for (const m of body) (m.title === undefined ? quiet : sent).push(m as never);
    return new Response(JSON.stringify({ data: body.map((_b, i) => ({ status: 'ok', id: `ticket-${all.length}-${i}` })) }));
  };
  const push: NotifyOptions = { fetchImpl, sleep: async () => {} };
  return { sent, quiet, all, push };
}

const P_A = { origin: { name: '집', ...HOME }, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', buffer_minutes: 10, before_prepare_minutes: 30 };
const P_B = { origin: { name: '먼 집', ...FAR }, transport_type: 'TRANSIT', est_travel_minutes: 70, travel_source: 'API', buffer_minutes: 10, before_prepare_minutes: 30 };

// 그룹 + 공동 약속(만든 사람 A, 참여자 B 이상). 알람은 alarm-commit이 저장한 것과 같은 계산으로 만듦
async function groupCase(users: string[] = [A, B], local = '2026-10-29T09:00') {
  const env = setup(users);
  env.db.rows('groups').push({ group_id: GROUP, group_name: '캡스톤팀' });
  for (const u of users) env.db.rows('group_members').push({ group_id: GROUP, user_id: u, invite_status: 'JOINED' });
  withGroupPush(env);
  const id = await seed(env, A, { appointment: { title: '팀플', appointment_at: iso(local), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL', group_id: GROUP }, participant: P_A });
  for (const u of users.slice(1)) {
    await seed(env, u, { appointment_id: id, participant: u === B ? P_B : { ...P_B, origin: { name: `${u} 집`, lat: FAR.lat - users.indexOf(u) / 100, lng: FAR.lng } } });
    env.db.rows('push_tokens').push({ user_id: u, token: u === B ? T_B : `ExponentPushToken[${u.replace(/[^a-z0-9]/g, '').padEnd(22, 'x').slice(0, 22)}]` });
  }
  return { env, id };
}
const times = (db: FakeDb, id: string, user: string) => alarmsOf(db, id, user).map((a) => Date.parse(a.scheduled_at as string));
const min = (n: number) => n * 60_000;

test('9-10 · 9-15: 만든 사람이 시각을 10분 앞당기면 참여자의 알람이 바로 10분 빨라지고, 참여자에게만 변경 알림(만든 사람은 제외, 알림 데이터에 change · needsConfirm)', async () => {
  const { env, id } = await groupCase();
  const kk = fakeKakao();
  const spy = pushSpy();
  const bBefore = times(env.db, id, B);
  const res = await updateAppointment(ctxFor(env, A, { kakao: kk.lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T08:50') }, 'this', true));
  assert.deepEqual(times(env.db, id, B), bBefore.map((t) => t - min(10)));
  assert.deepEqual(res.participants, { updated: 1, held: 0, skipped: 0 });
  assert.equal(kk.state.calls, 0); // 시각만 바꾸면 길찾기를 새로 안 부름
  assert.deepEqual(spy.sent.map((m) => [m.to, m.title, m.body, m.data.kind, m.data.change, m.data.needsConfirm, m.data.recipientUserId, m.data.appointmentId]), [[T_B, '캡스톤팀', '‘팀플’ 약속이 바뀌었어요', 'GROUP_APPT_CHANGED', 'CHANGED', false, B, id]]);
  assert.equal(res.notified, 1);
  assert.equal(ymd(row(env.db, id)!.appointment_at), '2026-10-29');
  assert.equal(hm(row(env.db, id)!.appointment_at), '08:50');
});

test('9-11 · 9-12: 참여자의 알람이 5분 이상 늦춰지면 그 사람이 확인할 때까지 보류(알람 그대로, 알림에 needsConfirm), 5분 미만은 바로 반영 — 만든 사람 자신의 알람은 확인 시트 규칙 그대로', async () => {
  const late6 = await groupCase();
  const bBefore = times(late6.env.db, late6.id, B);
  const spy6 = pushSpy();
  const res6 = await updateAppointment(ctxFor(late6.env, A, { kakao: fakeKakao().lookup, push: spy6.push }), upd(late6.id, { at: kst('2026-10-29T09:06') }, 'this', true));
  assert.deepEqual(times(late6.env.db, late6.id, B), bBefore); // 보류: B 알람은 아직 그대로
  assert.deepEqual(res6.participants, { updated: 0, held: 1, skipped: 0 });
  assert.deepEqual(spy6.sent.map((m) => m.data.needsConfirm), [true]);
  assert.equal(hm(row(late6.env.db, late6.id)!.appointment_at), '09:06'); // 약속 자체는 바뀜

  const late3 = await groupCase();
  const bBefore3 = times(late3.env.db, late3.id, B);
  const spy3 = pushSpy();
  const res3 = await updateAppointment(ctxFor(late3.env, A, { kakao: fakeKakao().lookup, push: spy3.push }), upd(late3.id, { at: kst('2026-10-29T09:03') }, 'this'));
  assert.deepEqual(times(late3.env.db, late3.id, B), bBefore3.map((t) => t + min(3)));
  assert.deepEqual([res3.saved, res3.participants, spy3.sent.map((m) => m.data.needsConfirm)], [true, { updated: 1, held: 0, skipped: 0 }, [false]]);

  // 만든 사람 자신은 10분 늦추면 확인이 먼저 — 확인 전에는 아무것도 안 바뀌고 알림도 없음
  const mine = await groupCase();
  const spyM = pushSpy();
  const ask = await updateAppointment(ctxFor(mine.env, A, { kakao: fakeKakao().lookup, push: spyM.push }), upd(mine.id, { at: kst('2026-10-29T09:10') }, 'this'));
  assert.deepEqual([ask.saved, ask.needs_confirm, hm(row(mine.env.db, mine.id)!.appointment_at), spyM.sent.length], [false, true, '09:00', 0]);
});

test('9-13 · 9-14: 장소만 바꾸면 참여자마다 자기 출발지로 길찾기를 다시 부르고(서로 다른 새 알람 시각), 변경 알림이 감', async () => {
  const { env, id } = await groupCase();
  const lookup: TravelLookup = async ({ origin }) => ({ minutes: origin.lat > 37.5 ? 30 : 90, partial: false }); // A(집) 30분, B(먼 집) 90분 — B는 이동이 길어져 알람이 앞당겨짐
  let calls = 0;
  const counted: TravelLookup = async (args) => ((calls += 1), lookup(args));
  const spy = pushSpy();
  const res = await updateAppointment(ctxFor(env, A, { kakao: counted, push: spy.push }), upd(id, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.equal(calls, 2); // A와 B 각자 한 번
  const wake = (user: string) => Date.parse(alarmsOf(env.db, id, user).find((a) => a.alarm_type === 'WAKE')!.scheduled_at as string);
  const lead = (user: string) => { const p = participantOf(env.db, id, user)!; return (p.est_travel_minutes as number) + (p.buffer_minutes as number) + (p.prepare_minutes as number); };
  assert.equal(wake(A) - wake(B), min(lead(B) - lead(A))); // 각자 이동 · 여유 · 준비만큼 약속 시각에서 거꾸로
  assert.equal(participantOf(env.db, id, A)!.est_travel_minutes, 30);
  assert.equal(participantOf(env.db, id, B)!.est_travel_minutes, 90);
  assert.ok(wake(B) < wake(A));
  assert.deepEqual(res.participants, { updated: 1, held: 0, skipped: 0 });
  assert.deepEqual(spy.sent.map((m) => [m.data.kind, m.data.change]), [['GROUP_APPT_CHANGED', 'CHANGED']]);
});

test('9-16: 참여자의 이미 울린 알람은 안 건드리고 아직 안 울린 알람만 다시 맞춤, 알람이 모두 울렸으면 그 사람은 건너뜀', async () => {
  const { env, id } = await groupCase();
  const wakeB = alarmsOf(env.db, id, B).find((a) => a.alarm_type === 'WAKE')!;
  const rungAt = new Date(MON_10.getTime() - min(30)).toISOString();
  wakeB.scheduled_at = rungAt; // 울린 알람
  const others = alarmsOf(env.db, id, B).filter((a) => a.alarm_type !== 'WAKE').map((a) => Date.parse(a.scheduled_at as string));
  const res = await updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup, push: pushSpy().push }), upd(id, { at: kst('2026-10-29T08:50') }, 'this', true));
  assert.equal(wakeB.scheduled_at, rungAt);
  const nowOthers = alarmsOf(env.db, id, B).filter((a) => a.alarm_type !== 'WAKE').map((a) => Date.parse(a.scheduled_at as string));
  assert.ok(nowOthers.every((t, i) => t < others[i])); // 아직 안 울린 알람은 앞당겨짐
  assert.deepEqual(res.participants, { updated: 1, held: 0, skipped: 0 });

  const all = await groupCase();
  for (const a of alarmsOf(all.env.db, all.id, B)) a.scheduled_at = rungAt;
  const before = times(all.env.db, all.id, B);
  const res2 = await updateAppointment(ctxFor(all.env, A, { kakao: fakeKakao().lookup, push: pushSpy().push }), upd(all.id, { at: kst('2026-10-29T08:50') }, 'this', true));
  assert.deepEqual(times(all.env.db, all.id, B), before);
  assert.deepEqual(res2.participants, { updated: 0, held: 0, skipped: 1 });
});

test('9-17: 참여자의 이동시간을 구하지 못하면(길찾기 실패 → 근사값뿐) 그 사람의 기존 알람을 그대로 두고 경고만 — 이름 없이, 다른 참여자는 정상, 알림은 감', async () => {
  const { env, id } = await groupCase([A, B, 'u-c']);
  const lookup: TravelLookup = async ({ origin }) => {
    if (origin.lat < 37.5) throw new KakaoError('QUOTA', '시험용 한도 초과'); // 먼 집에서 오는 사람들만 실패
    return { minutes: 30, partial: false };
  };
  const spy = pushSpy();
  const bBefore = times(env.db, id, B);
  const res = await updateAppointment(ctxFor(env, A, { kakao: lookup, push: spy.push }), upd(id, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.deepEqual(times(env.db, id, B), bBefore);
  assert.deepEqual(res.participants, { updated: 0, held: 0, skipped: 2 });
  assert.equal(res.warnings.filter((w) => w.code === 'PARTICIPANT_ROUTE_FAILED').length, 2);
  assert.ok(!JSON.stringify(res.warnings).includes(B));
  assert.equal(spy.sent.length, 2); // 알림은 모두에게
});

test('동기화 대상: 그룹에 아직 참여 중인 참여자만 — 나간 사람에게 남은 참여 조건은 다시 계산하지도 알리지도 않음', async () => {
  const { env, id } = await groupCase();
  env.db.rows('group_members').find((m) => m.user_id === B)!.invite_status = 'LEFT';
  const before = times(env.db, id, B);
  const spy = pushSpy();
  const res = await updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T08:50') }, 'this', true));
  assert.deepEqual(times(env.db, id, B), before);
  assert.deepEqual(res.participants, { updated: 0, held: 0, skipped: 0 });
  assert.equal(spy.sent.length, 0);
});

test('9-39: 제목 · 중요도만 고치면 참여자 알림도 다시 계산도 없음', async () => {
  const { env, id } = await groupCase();
  const spy = pushSpy();
  const kk = fakeKakao();
  const bBefore = JSON.stringify(alarmsOf(env.db, id, B));
  const res = await updateAppointment(ctxFor(env, A, { kakao: kk.lookup, push: spy.push }), upd(id, { title: '팀플 (제목만)' }, 'this', true));
  assert.deepEqual([spy.sent.length, res.participants, res.notified, kk.state.calls], [0, undefined, undefined, 0]);
  assert.equal(JSON.stringify(alarmsOf(env.db, id, B)), bBefore);
});

test('9-20: 만든 사람이 지우면 참여자의 참여 · 알람이 사라지고 참여자에게 취소 알림(change CANCELED) — 알림이 안 가도 지우기는 끝남, 지난 약속을 지울 땐 알림 없음', async () => {
  const { env, id } = await groupCase();
  const spy = pushSpy();
  const res = await deleteAppointment(ctxFor(env, A, { push: spy.push }), del(id));
  assert.deepEqual([res.deleted, res.mode, res.notified], [true, 'ROW', 1]);
  assert.deepEqual(spy.sent.map((m) => [m.to, m.title, m.body, m.data.change, m.data.appointmentId]), [[T_B, '캡스톤팀', '‘팀플’ 약속이 취소됐어요', 'CANCELED', id]]);
  assert.equal(env.db.rows('appointments').length + env.db.rows('appointment_participants').length + env.db.rows('alarms').length, 0);

  const broken = await groupCase();
  const down = pushSpy({ fail: true });
  const quietRes = await quiet(() => deleteAppointment(ctxFor(broken.env, A, { push: down.push }), del(broken.id)));
  assert.deepEqual([quietRes.deleted, quietRes.warnings.some((w) => w.code === 'PUSH_NOT_SENT'), broken.env.db.rows('appointments').length], [true, true, 0]);

  const past = await groupCase();
  const spyPast = pushSpy();
  const pastRes = await deleteAppointment(ctxFor(past.env, A, { now: kst('2026-10-30T10:00'), push: spyPast.push }), del(past.id));
  assert.deepEqual([pastRes.deleted, pastRes.notified, spyPast.sent.length], [true, undefined, 0]);

  // 같은 날 이미 지난 약속(하루 경계)은 아직 '안 지난' 약속이라 취소 알림이 감
  const sameDay = await groupCase();
  const spySame = pushSpy();
  const sameRes = await deleteAppointment(ctxFor(sameDay.env, A, { now: kst('2026-10-29T09:30'), push: spySame.push }), del(sameDay.id));
  assert.deepEqual([sameRes.deleted, sameRes.notified, spySame.sent.length], [true, 1, 1]);
});

test('조용한 푸시: 알림을 끈 참여자에게는 보이는 알림 없이 데이터 푸시만(알람 다시 맞추기), needsConfirm도 실림 — 보이는 알림 수(notified)에는 안 더함', async () => {
  const { env, id } = await groupCase([A, B, 'u-mute']);
  env.db.rows('group_members').find((m) => m.user_id === 'u-mute')!.notifications_off = true;
  const spy = pushSpy();
  const res = await updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T09:06') }, 'this', true)); // 6분 늦춤 = 보류(needsConfirm)
  assert.equal(res.notified, 1);
  const byUser = Object.fromEntries(spy.sent.map((m) => [m.data.recipientUserId as string, m]));
  assert.equal(byUser[B]?.title, '캡스톤팀');
  assert.equal(byUser['u-mute'], undefined); // 알림을 끈 사람은 보이는 알림 없음
  assert.equal(byUser[B]?.data.needsConfirm, true);
  const quietBy = Object.fromEntries(spy.quiet.map((m) => [m.data.recipientUserId as string, m])); // 문구 없는 데이터 푸시 — 알림을 끈 사람 + (G2) 보이는 알림을 받는 사람
  assert.deepEqual(Object.keys(quietBy).sort(), [B, 'u-mute'].sort());
  assert.equal(quietBy['u-mute']?.data.silent, true);
  assert.equal(quietBy['u-mute']?.data.needsConfirm, true);
  assert.equal(quietBy[B]?.data.silent, true);
  assert.equal(quietBy[B]?.data.needsConfirm, true);
});

test('9-32: 지난 날의 공동 약속은 고칠 수 없고(PAST_APPOINTMENT), 지난 날로 옮길 수도 없고, 새로 참여할 수도 없음 — 앞으로 약속, 오늘 이미 지난 약속은 오늘 안에는 됨 (하루 경계: 내 폰 시간대 오늘 0시)', async () => {
  const { env, id } = await groupCase();
  const late = kst('2026-10-30T09:30'); // 약속 다음 날
  const sameDay = kst('2026-10-29T09:30'); // 약속과 같은 날, 시각은 이미 지남
  await expectHttp(() => updateAppointment(ctxFor(env, A, { now: late, kakao: fakeKakao().lookup }), upd(id, { title: '지난 약속 고치기' }, 'this', true)), 'UNPROCESSABLE', 'PAST_APPOINTMENT');
  await updateAppointment(ctxFor(env, A, { now: sameDay, kakao: fakeKakao().lookup }), upd(id, { title: '오늘 이미 지난 약속 고치기' }, 'this', true)); // 오류 없이 고쳐짐
  assert.equal(row(env.db, id)!.title, '오늘 이미 지난 약속 고치기');
  await expectHttp(() => updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup }), upd(id, { at: kst('2026-10-25T23:00') }, 'this', true)), 'UNPROCESSABLE', 'PAST_APPOINTMENT'); // 기준 시각(10/26 월요일)의 어제로 옮기기

  const joinEnv = await groupCase([A, B]);
  const c = 'u-late';
  joinEnv.env.db.rows('profiles').push({ user_id: c, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng });
  joinEnv.env.db.rows('group_members').push({ group_id: GROUP, user_id: c, invite_status: 'JOINED' });
  await assert.rejects(
    () => seed(joinEnv.env, c, { appointment_id: joinEnv.id, participant: P_A }, kst('2026-10-30T09:30')),
    (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE' && (e.details as { reason?: string }).reason === 'PAST_APPOINTMENT',
  );
  assert.equal(participantOf(joinEnv.env.db, joinEnv.id, c), undefined);
  await seed(joinEnv.env, c, { appointment_id: joinEnv.id, participant: P_A }); // 아직 안 지났을 때는 참여됨
  assert.ok(participantOf(joinEnv.env.db, joinEnv.id, c));

  // 하루 경계: 같은 날 이미 지난 약속에는 참여할 수 있고, 시간대는 그 사람 것 (UTC 사람에게는 서울 기준으로는 지난 날이어도 아직 오늘)
  const sameDayJoin = await groupCase([A, B]);
  for (const [u, tz] of [['u-same', 'Asia/Seoul'], ['u-utc', 'UTC']] as const) {
    sameDayJoin.env.db.rows('profiles').push({ user_id: u, timezone: tz, default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng });
    sameDayJoin.env.db.rows('group_members').push({ group_id: GROUP, user_id: u, invite_status: 'JOINED' });
  }
  // 같은 날 이미 지난 약속: '지난 약속' 검사는 통과하고 그다음 단계(출발이 지났다)에서 멈춤 — 지난 날이면 PAST_APPOINTMENT에서 멈췄을 것
  const passesPast = (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE' && (e.details as { reason?: string }).reason === 'DEPARTURE_PASSED';
  await assert.rejects(() => seed(sameDayJoin.env, 'u-same', { appointment_id: sameDayJoin.id, participant: P_A }, kst('2026-10-29T09:30')), passesPast); // 약속 09:00, 지금 09:30 — 같은 날
  await assert.rejects(() => seed(sameDayJoin.env, 'u-utc', { appointment_id: sameDayJoin.id, participant: P_A }, new Date('2026-10-29T16:00:00Z')), passesPast); // 서울로는 10/30 01:00이지만 UTC 사람에게는 아직 10/29
});

test('9-32(고치기 하루 경계): 오늘 안으로 옮기기는 지난 약속 오류가 아님(출발이 지났다는 다른 오류), 시간대는 부른 사람 것(UTC 사람은 서울로는 지난 날이어도 오늘 약속을 고침)', async () => {
  const { env, id } = await groupCase();
  await expectHttp(() => updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup }), upd(id, { at: kst('2026-10-26T08:00') }, 'this', true)), 'UNPROCESSABLE', 'DEPARTURE_PASSED'); // 기준 시각(10/26 10:00)의 오늘 이른 시각
  const utc = await groupCase();
  utc.env.db.rows('profiles').find((p) => p.user_id === A)!.timezone = 'UTC';
  await updateAppointment(ctxFor(utc.env, A, { now: new Date('2026-10-29T16:00:00Z'), kakao: fakeKakao().lookup }), upd(utc.id, { title: 'UTC 사람의 오늘 약속' }, 'this', true));
  assert.equal(row(utc.env.db, utc.id)!.title, 'UTC 사람의 오늘 약속');
  const seoul = await groupCase();
  await expectHttp(() => updateAppointment(ctxFor(seoul.env, A, { now: new Date('2026-10-29T16:00:00Z'), kakao: fakeKakao().lookup }), upd(seoul.id, { title: '서울 사람' }, 'this', true)), 'UNPROCESSABLE', 'PAST_APPOINTMENT');
});

test('9-38: 만든 사람이 없는(탈퇴한) 공동 약속은 그 약속에 참여한 사람이 고침(만든 사람 칸이 비어 있어도) — 참여 안 한 그룹원은 FORBIDDEN, 알림은 고친 사람 제외 다른 참여자에게 (지우기는 X-APPT-01)', async () => {
  const { env, id } = await groupCase([A, B, 'u-c']);
  row(env.db, id)!.creator_id = null;
  const spy = pushSpy();
  const aBefore = times(env.db, id, A);
  const res = await updateAppointment(ctxFor(env, B, { kakao: fakeKakao().lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T08:50') }, 'this', true));
  assert.equal(hm(row(env.db, id)!.appointment_at), '08:50');
  assert.deepEqual(times(env.db, id, A), aBefore.map((t) => t - min(10)));
  assert.deepEqual(res.participants, { updated: 2, held: 0, skipped: 0 });
  assert.ok(spy.sent.every((m) => m.data.recipientUserId !== B));
  env.db.rows('group_members').push({ group_id: GROUP, user_id: 'u-d', invite_status: 'JOINED' });
  env.db.rows('profiles').push({ user_id: 'u-d', timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng });
  await expectHttp(() => updateAppointment(ctxFor(env, 'u-d'), upd(id, { title: '참여 안 한 사람' }, 'this', true)), 'FORBIDDEN');
});

test('X-APPT-01: 만든 사람이 없는(탈퇴한) 공동 약속은 그 약속에 참여한 사람이 지움 — 참여 안 한 그룹원은 FORBIDDEN, 지우면 약속 · 참여 · 알람이 사라지고 지운 사람 빼고 취소 알림, 만든 사람이 있는 약속은 참여자가 못 지움', async () => {
  const { env, id } = await groupCase([A, B, 'u-c']);
  row(env.db, id)!.creator_id = null;
  env.db.rows('group_members').push({ group_id: GROUP, user_id: 'u-d', invite_status: 'JOINED' });
  await expectHttp(() => deleteAppointment(ctxFor(env, 'u-d'), del(id)), 'FORBIDDEN');        // 참여 안 한 그룹원
  assert.equal(env.db.rows('appointments').length, 1);
  const spy = pushSpy();
  const res = await deleteAppointment(ctxFor(env, B, { push: spy.push }), del(id));            // 참여자 B가 지움
  assert.deepEqual([res.deleted, res.mode, res.deleted_appointment_ids], [true, 'ROW', [id]]);
  assert.equal(env.db.rows('appointments').length + env.db.rows('appointment_participants').length + env.db.rows('alarms').length, 0);
  assert.equal(res.notified, 1);                                                                 // 알림 받는 폰이 있는 다른 참여자 u-c (A는 시험 설정에 폰이 없음)
  assert.deepEqual(spy.sent.map((m) => [m.data.change, m.data.recipientUserId]), [['CANCELED', 'u-c']]);
  const alive = await groupCase([A, B]);                                                        // 만든 사람이 있는 약속은 참여자가 못 지움 (9-18 · 9-31)
  await expectHttp(() => deleteAppointment(ctxFor(alive.env, B), del(alive.id)), 'FORBIDDEN');
  assert.equal(alive.env.db.rows('appointments').length, 1);
});

test('X-APPT-03(장소도 바뀜): 약속을 30분 앞당기며 장소도 바꿨는데 참여자의 길찾기가 실패하면 그 사람의 알람을 지난번 간격 그대로 30분 같이 앞당기고 확인 알림(needsConfirm) — 경고는 SHIFTED, 길찾기가 된 사람은 새 계산', async () => {
  const { env, id } = await groupCase([A, B, 'u-c']);
  const lookup: TravelLookup = async ({ origin }) => {
    if (Math.abs(origin.lat - FAR.lat) < 0.001) throw new KakaoError('QUOTA', '시험용 한도 초과'); // B(먼 집)만 실패
    return { minutes: 50, partial: false };
  };
  const bBefore = times(env.db, id, B);
  const spy = pushSpy();
  const res = await updateAppointment(ctxFor(env, A, { kakao: lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T08:30'), destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.deepEqual(times(env.db, id, B), bBefore.map((t) => t - min(30)));                  // 새 약속 뒤에 남지 않고 같이 앞당겨짐
  assert.deepEqual(res.participants, { updated: 2, held: 0, skipped: 0 });                 // B(옮김) + u-c(새 계산)
  const failed = res.warnings.filter((w) => w.code === 'PARTICIPANT_ROUTE_FAILED');
  assert.deepEqual(failed.map((w) => w.detail), ['SHIFTED']);
  assert.ok(!JSON.stringify(res.warnings).includes(B));
  const byUser = Object.fromEntries(spy.sent.map((m) => [m.data.recipientUserId as string, m.data.needsConfirm]));
  assert.equal(byUser[B], true);                                                           // 폰이 확인 화면을 띄움
});

test('X-APPT-03(늦춤 · 장소만): 길찾기가 실패한 참여자라도 약속을 5분 이상 늦추면 알람을 옮기지 않고(확인이 먼저) 기존대로 두며, 시각 없이 장소만 바뀐 경우도 알람 그대로 + 경고', async () => {
  const lookup: TravelLookup = async ({ origin }) => {
    if (Math.abs(origin.lat - FAR.lat) < 0.001) throw new KakaoError('QUOTA', '시험용 한도 초과');
    return { minutes: 30, partial: false };
  };
  const later = await groupCase([A, B]);
  const bLater = times(later.env.db, later.id, B);
  const resLater = await updateAppointment(ctxFor(later.env, A, { kakao: lookup, push: pushSpy().push }), upd(later.id, { at: kst('2026-10-29T09:30'), destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.deepEqual(times(later.env.db, later.id, B), bLater);
  assert.deepEqual(resLater.participants, { updated: 0, held: 0, skipped: 1 });
  assert.deepEqual(resLater.warnings.filter((w) => w.code === 'PARTICIPANT_ROUTE_FAILED').map((w) => w.detail), [undefined]);
  const placeOnly = await groupCase([A, B]);
  const bPlace = times(placeOnly.env.db, placeOnly.id, B);
  const resPlace = await updateAppointment(ctxFor(placeOnly.env, A, { kakao: lookup, push: pushSpy().push }), upd(placeOnly.id, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.deepEqual(times(placeOnly.env.db, placeOnly.id, B), bPlace);
  assert.deepEqual(resPlace.participants, { updated: 0, held: 0, skipped: 1 });
});

test('X-APPT-03(저장된 이동시간 없음): 시각만 앞당겼는데 참여자의 이동시간도 출발지도 없어 계산할 수 없어도 그 사람의 알람은 새 약속 뒤에 남지 않고 같이 앞당겨지며, 앞당긴 시각이 이미 지났으면 그 알람은 꺼짐', async () => {
  const { env, id } = await groupCase([A, B]);
  const p = participantOf(env.db, id, B)!;
  p.est_travel_minutes = null;
  p.origin_lat = null;
  p.origin_lng = null;
  const prof = env.db.rows('profiles').find((x) => x.user_id === B)!;
  prof.home_lat = null;
  prof.home_lng = null;
  const before = alarmsOf(env.db, id, B).map((x) => Date.parse(x.scheduled_at as string));
  const spy = pushSpy();
  const res = await updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T08:30') }, 'this', true));
  assert.deepEqual(times(env.db, id, B), before.map((t) => t - min(30)));
  assert.deepEqual(res.participants, { updated: 1, held: 0, skipped: 0 });
  assert.deepEqual(res.warnings.filter((w) => w.code === 'PARTICIPANT_ROUTE_FAILED').map((w) => w.detail), ['SHIFTED']);
  assert.equal(Object.fromEntries(spy.sent.map((m) => [m.data.recipientUserId as string, m.data.needsConfirm]))[B], true);
});

test('X-APPT-03(옮기는 대상): 이미 울린 알람은 그대로, 꺼 둔 알람은 꺼 둔 채 같이 옮겨 순서가 안 뒤집히고, 옮긴 시각이 이미 지난 알람만 꺼지고 아직 안 지난 알람은 켜진 채 옮겨짐', async () => {
  const { env, id } = await groupCase([A, B]);
  env.db.tables.appointment_participants = env.db.rows('appointment_participants').filter((x) => x.user_id !== A);   // 만든 사람은 알람이 없어 자기 계산에 안 걸림
  env.db.tables.alarms = env.db.rows('alarms').filter((x) => x.user_id !== A);
  const rows = alarmsOf(env.db, id, B).sort((x, y) => Date.parse(x.scheduled_at as string) - Date.parse(y.scheduled_at as string));
  assert.equal(rows.length, 4);
  const old = rows.map((x) => ({ id: x.alarm_id as string, at: Date.parse(x.scheduled_at as string) }));
  rows[1].is_enabled = false;                                             // 둘째 알람은 꺼 둠
  const now = new Date(old[0].at + min(1));                               // 첫 알람만 울린 뒤
  const delta = Math.ceil((old[2].at - now.getTime()) / min(1)) * min(1);   // 셋째 알람은 옮기면 now 이전(지남), 넷째는 아직 이후
  assert.ok(old[3].at - delta > now.getTime() && old[2].at - delta <= now.getTime());
  const lookup: TravelLookup = async ({ origin }) => {
    if (Math.abs(origin.lat - FAR.lat) < 0.001) throw new KakaoError('QUOTA', '시험용 한도 초과');
    return { minutes: 30, partial: false };
  };
  const res = await updateAppointment(ctxFor(env, A, { now, kakao: lookup, push: pushSpy().push }), upd(id, { at: new Date(Date.parse(row(env.db, id)!.appointment_at as string) - delta), destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.deepEqual(res.participants, { updated: 1, held: 0, skipped: 0 });
  const byId = (alarmId: string) => alarmsOf(env.db, id, B).find((x) => x.alarm_id === alarmId)!;
  const state = old.map((o) => ({ at: Date.parse(byId(o.id).scheduled_at as string), on: byId(o.id).is_enabled }));
  assert.deepEqual(state, [
    { at: old[0].at, on: true },                       // 이미 울린 알람은 그대로
    { at: old[1].at - delta, on: false },              // 꺼 둔 알람은 꺼 둔 채 같이 옮김
    { at: old[2].at - delta, on: false },              // 옮긴 시각이 이미 지났으면 꺼짐
    { at: old[3].at - delta, on: true },               // 아직 안 지났으면 켜진 채 옮겨짐
  ]);
});

test('X-APPT-03(다시 보내기): 약속 행 쓰기가 실패한 요청을 다시 보내도 참여자 알람은 한 번만 옮겨짐(옮기기는 약속 행을 쓴 뒤) — 첫 시도는 알람을 안 건드림', async () => {
  const { env, id } = await groupCase([A, B]);
  const lookup: TravelLookup = async ({ origin }) => {
    if (Math.abs(origin.lat - FAR.lat) < 0.001) throw new KakaoError('QUOTA', '시험용 한도 초과');
    return { minutes: 50, partial: false };
  };
  const bBefore = times(env.db, id, B);
  const req = upd(id, { at: kst('2026-10-29T08:30'), destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true);
  env.db.failOn.push({ table: 'appointments', op: 'update' });
  await assert.rejects(() => updateAppointment(ctxFor(env, A, { kakao: lookup, push: pushSpy().push }), req));
  assert.deepEqual(times(env.db, id, B), bBefore);                         // 약속 행이 안 써졌으니 알람도 그대로
  env.db.failOn.length = 0;
  await updateAppointment(ctxFor(env, A, { kakao: lookup, push: pushSpy().push }), req);
  assert.deepEqual(times(env.db, id, B), bBefore.map((t) => t - min(30)));   // 한 번만 옮겨짐
});

test('X-APPT-01(지난 약속): 만든 사람이 없는 공동 약속이라도 지난 약속은 참여자가 못 지움 — 정책이 막아 0행이 되는데 성공처럼 보이지 않게 먼저 PAST_APPOINTMENT', async () => {
  const { env, id } = await groupCase([A, B]);
  row(env.db, id)!.creator_id = null;
  await expectHttp(() => deleteAppointment(ctxFor(env, B, { now: kst('2026-10-30T10:00'), push: pushSpy().push }), del(id)), 'UNPROCESSABLE', 'PAST_APPOINTMENT');
  assert.equal(env.db.rows('appointments').length, 1);
  await deleteAppointment(ctxFor(env, B, { push: pushSpy().push }), del(id));   // 안 지난 약속(기준 시각 10/26)은 지움
  assert.equal(env.db.rows('appointments').length, 0);
});

test('9-43: 10명 그룹에서 장소를 바꾸면 참여자마다 길찾기를 다시 부름(최대 10번), 일부가 실패해도 나머지는 정상이고 실패한 사람은 기존 알람 유지', async () => {
  const users = [A, B, ...Array.from({ length: 8 }, (_v, i) => `u-p${i + 1}`)];
  const { env, id } = await groupCase(users);
  let calls = 0;
  const lookup: TravelLookup = async ({ origin }) => {
    calls += 1;
    if (Math.abs(origin.lat - 37.38) < 0.001) throw new KakaoError('QUOTA', '시험용 한도 초과'); // 한 사람만 실패
    return { minutes: 100, partial: false }; // 이동이 길어져 모두 앞당겨짐
  };
  const before = users.map((u) => JSON.stringify(times(env.db, id, u)));
  const res = await updateAppointment(ctxFor(env, A, { kakao: lookup, push: pushSpy().push }), upd(id, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.equal(calls, 10);
  assert.deepEqual(res.participants, { updated: 8, held: 0, skipped: 1 });
  assert.equal(res.warnings.filter((w) => w.code === 'PARTICIPANT_ROUTE_FAILED').length, 1);
  const unchanged = users.filter((_u, i) => JSON.stringify(times(env.db, id, users[i])) === before[i]);
  assert.deepEqual(unchanged, [users[2]]); // 실패한 사람(출발지 37.38)만 기존 알람 그대로 — users[2]
});

test('공동 약속 고치기에서 service 클라이언트는 다른 참여자의 행을 읽고 쓰는 곳에만 닿음 — 개인 일정 고치기는 그대로 roll_attempts뿐', async () => {
  const { env, id } = await groupCase();
  await updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup, push: pushSpy().push }), upd(id, { at: kst('2026-10-29T08:50') }, 'this', true));
  assert.ok(['appointment_participants', 'group_members'].every((t) => env.serviceTables.has(t)));
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

test('#320 F1: 13:00 일정에서 사용자가 일부러 끈 기상은 장소 · 중요도만 고쳐도 되살아나지 않음 (계산된 기상이 낮 12시 전이었으므로)', async () => {
  const env = setup();
  const a = await single(env, A, '2026-10-29T13:00');
  assert.ok(alarmsOf(env.db, a).some((x) => x.alarm_type === 'WAKE')); // 계산된 기상이 12시 전이라 처음엔 기상이 있음
  // 사용자가 H05에서 기상을 끔 — 기상 행만 지움
  const rows = env.db.rows('alarms');
  const wakeIdx = rows.findIndex((x) => x.participant_id === participantOf(env.db, a)!.participant_id && x.alarm_type === 'WAKE');
  rows.splice(wakeIdx, 1);
  assert.equal(kinds(env.db, a), 'ARRIVE,DEPARTURE,PREPARE');
  await updateAppointment(ctxFor(env, A), upd(a, { importance: 'HIGH' }, 'this', true));
  assert.equal(kinds(env.db, a), 'ARRIVE,DEPARTURE,PREPARE'); // 일부러 끈 기상이 그대로
});

test('#320 F1: 저녁 일정(규칙으로 기상 없음)을 아침으로 옮기면 기상이 생김', async () => {
  const env = setup();
  const a = await single(env, A, '2026-10-29T20:00');
  assert.equal(kinds(env.db, a), 'ARRIVE,DEPARTURE,PREPARE');
  await updateAppointment(ctxFor(env, A), upd(a, { at: kst('2026-10-29T09:00') }, 'this', true));
  assert.equal(kinds(env.db, a), 'ARRIVE,DEPARTURE,PREPARE,WAKE');
});

// ---- 9장 PR 리뷰 반영 ----

test('9-18(서버): 그룹을 나간(내보내진) 만든 사람은 약속이 보여도 고치기 · 지우기가 NOT_FOUND — 다른 참여자의 알람은 건드리지 않고 알림도 없음 (RLS가 약속 행을 막기 전에 service가 먼저 쓰지 못하게)', async () => {
  const { env, id } = await groupCase();
  // 나가면 DB가 그 사람의 앞으로 약속 참여 조건 · 알람을 지움(트리거) — 약속 행은 남고 만든 사람 칸도 그대로
  env.db.rows('group_members').find((m) => m.user_id === A)!.invite_status = 'LEFT';
  env.db.tables.alarms = env.db.rows('alarms').filter((x) => x.user_id !== A);
  env.db.tables.appointment_participants = env.db.rows('appointment_participants').filter((p) => p.user_id !== A);
  const bBefore = times(env.db, id, B);
  const spy = pushSpy();
  await assert.rejects(
    () => updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T08:50') }, 'this', true)),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
  await assert.rejects(() => deleteAppointment(ctxFor(env, A, { push: spy.push }), del(id)), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.deepEqual(times(env.db, id, B), bBefore);
  assert.equal(hm(row(env.db, id)!.appointment_at), '09:00');
  assert.deepEqual(spy.sent, []);
});

// 서비스 클라이언트의 참여 조건 update만 DB 오류로 만든 껍데기 (읽기는 그대로)
function failingParticipantUpdate(env: Env): Db {
  return {
    from: (table: string) => {
      const q = env.db.from(table);
      return table === 'appointment_participants'
        ? new Proxy(q, {
            get: (target, prop) =>
              prop === 'update' ? () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }) }) }) : (target as never as Record<string | symbol, unknown>)[prop] instanceof Function ? ((target as never as Record<string | symbol, (...a: unknown[]) => unknown>)[prop]).bind(target) : (target as never as Record<string | symbol, unknown>)[prop],
          })
        : q;
    },
    rpc: (name: string, args?: Record<string, unknown>) => env.db.rpc(name, args),
  } as unknown as Db;
}

test('9-14(오류): 참여자를 맞추다 DB 오류가 나면 "건너뜀"으로 삼키지 않고 요청이 실패(500) — 약속 행은 안 바뀌고 푸시도 없어서, 같은 요청을 다시 보내면 이어서 맞춰짐', async () => {
  const { env, id } = await groupCase();
  const bBefore = times(env.db, id, B);
  const spy = pushSpy();
  const ctx = { ...ctxFor(env, A, { kakao: fakeKakao().lookup, push: spy.push }), service: failingParticipantUpdate(env) };
  await quiet(() => assert.rejects(() => updateAppointment(ctx, upd(id, { at: kst('2026-10-29T08:50') }, 'this', true)), (e: unknown) => e instanceof HttpError && e.status === 500));
  assert.equal(hm(row(env.db, id)!.appointment_at), '09:00');   // 약속 행은 그대로
  assert.deepEqual(times(env.db, id, B), bBefore);
  assert.deepEqual(spy.sent, []);

  const again = await updateAppointment(ctxFor(env, A, { kakao: fakeKakao().lookup, push: spy.push }), upd(id, { at: kst('2026-10-29T08:50') }, 'this', true)); // 다시 보냄
  assert.deepEqual(again.participants, { updated: 1, held: 0, skipped: 0 });
  assert.deepEqual(times(env.db, id, B), bBefore.map((t) => t - min(10)));
  assert.equal(hm(row(env.db, id)!.appointment_at), '08:50');
  assert.equal(spy.sent.length, 1);
});

test('9-17(알림): 이동시간을 못 구해 알람을 그대로 둔 참여자 폰에도 needsConfirm: true — 앞당김 · 5분 미만 늦춤으로 바로 맞춘 사람은 false', async () => {
  const { env, id } = await groupCase([A, B, 'u-c']);
  const lookup: TravelLookup = async ({ origin }) => {
    if (Math.abs(origin.lat - FAR.lat) < 0.001) throw new KakaoError('QUOTA', '시험용 한도 초과'); // B(먼 집, 37.4)만 실패 — u-c(37.38)는 이동이 길어져 앞당겨짐
    return { minutes: 100, partial: false };
  };
  const spy = pushSpy();
  const res = await updateAppointment(ctxFor(env, A, { kakao: lookup, push: spy.push }), upd(id, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.deepEqual(res.participants, { updated: 1, held: 0, skipped: 1 });
  const byUser = Object.fromEntries(spy.sent.map((m) => [m.data.recipientUserId as string, m.data.needsConfirm]));
  assert.deepEqual(byUser, { [B]: true, 'u-c': false });
});

test('9-43(동시): 참여자는 4명씩 묶어 한꺼번에 맞춤 — 길찾기가 동시에 4번을 넘지 않고(앱 제한 시간 안에 끝나게), 둘 이상은 겹쳐 돌며, 결과 요약 · 경고 순서는 그대로', async () => {
  const users = [A, B, ...Array.from({ length: 8 }, (_v, i) => `u-p${i + 1}`)];
  const { env, id } = await groupCase(users);
  let inflight = 0;
  let peak = 0;
  const lookup: TravelLookup = async ({ origin }) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inflight -= 1;
    if (Math.abs(origin.lat - 37.38) < 0.001) throw new KakaoError('QUOTA', '시험용 한도 초과');
    return { minutes: 100, partial: false };
  };
  const res = await updateAppointment(ctxFor(env, A, { kakao: lookup, push: pushSpy().push }), upd(id, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  assert.equal(SYNC_CONCURRENCY, 4);
  assert.ok(peak > 1 && peak <= 4, `동시 길찾기 최대 ${peak}`);
  assert.deepEqual(res.participants, { updated: 8, held: 0, skipped: 1 });
  assert.equal(res.warnings.filter((w) => w.code === 'PARTICIPANT_ROUTE_FAILED').length, 1);
});

// ---- 10장: 친구가 제안해 주인이 적용한 알람 시각 (original_scheduled_at이 채워진 MANUAL) ----

// 10/29 09:00 약속의 기상을 친구가 07:25 → 07:20으로 바꿔 주인이 적용한 상태
async function friendAppliedCase() {
  const env = setup();
  const { thu } = await seededSeries(env);
  const wake = alarmsOf(env.db, thu.appointment_id).find((a) => a.alarm_type === 'WAKE')!;
  const original = wake.scheduled_at as string;
  wake.scheduled_at = new Date(Date.parse(original) - min(5)).toISOString();
  wake.time_source = 'MANUAL';
  wake.original_scheduled_at = original;
  wake.original_time_source = 'AUTO';           // 친구가 바꾸기 전엔 자동 계산이던 알람
  return { env, thu, wake, original };
}

// 기상 · 준비 · 출발 셋 다 친구가 바꿔 주인이 적용한 상태 (기상 −10 · 준비 +10 · 출발 −10분)
async function friendAppliedAll() {
  const env = setup();
  const { thu } = await seededSeries(env);
  for (const [type, delta] of [['WAKE', -10], ['PREPARE', 10], ['DEPARTURE', -10]] as const) {
    const row = alarmsOf(env.db, thu.appointment_id).find((a) => a.alarm_type === type)!;
    row.original_scheduled_at = row.scheduled_at;
    row.original_time_source = 'AUTO';
    row.scheduled_at = new Date(Date.parse(row.scheduled_at as string) + delta * 60_000).toISOString();
    row.time_source = 'MANUAL';
  }
  return { env, thu };
}

test('10-22: 약속의 제목만 다시 저장하면 친구가 정한 알람 시각이 그대로(알람을 안 건드림), 중요도만 바꿔도 시각은 그대로', async () => {
  const { env, thu, wake } = await friendAppliedCase();
  const before = wake.scheduled_at;
  await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { title: '새 제목' }, 'this', true));
  assert.deepEqual([wake.scheduled_at, wake.time_source, wake.original_scheduled_at != null], [before, 'MANUAL', true]);
  await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { importance: 'HIGH' }, 'this', true));
  assert.deepEqual([wake.scheduled_at, wake.time_source, wake.original_scheduled_at != null], [before, 'MANUAL', true]);
});

test('10-22: 약속의 시각을 바꾸면 친구가 정한 알람 시각은 새 계산에 밀림(주인이 직접 고른 MANUAL과 다름) — 장소를 바꿔도 같음', async () => {
  const { env, thu, wake } = await friendAppliedCase();
  await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T09:30') }, 'this', true));
  const moved = alarmsOf(env.db, thu.appointment_id).find((a) => a.alarm_type === 'WAKE')!;
  assert.equal(hm(moved.scheduled_at), '07:55');   // 09:30 약속의 새 계산 (친구 값 07:20은 같은 날이라 MANUAL이면 그대로였을 것)
  assert.notEqual(moved.time_source, 'MANUAL');

  const place = await friendAppliedCase();
  await updateAppointment(ctxFor(place.env, A, { kakao: fakeKakao(20).lookup }), upd(place.thu.appointment_id as string, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } }, 'this', true));
  const afterPlace = alarmsOf(place.env.db, place.thu.appointment_id).find((a) => a.alarm_type === 'WAKE')!;
  assert.notEqual(afterPlace.time_source, 'MANUAL');
  assert.equal(hm(afterPlace.scheduled_at), '07:40'); // 이동 20분으로 새 계산 (친구 값이 아님)
});

test('10-22: 친구 값이 기상 · 준비 · 출발 셋 다에 있어도 약속 시각을 바꾸면 친구 값이 없는 상태와 똑같이 새 계산 — 준비 알람 시각이 친구 값 간격에 끌려가지 않음', async () => {
  const control = setup();
  const c = await seededSeries(control);
  await updateAppointment(ctxFor(control, A), upd(c.thu.appointment_id as string, { at: kst('2026-10-29T09:30') }, 'this', true));
  const shape = (db: FakeDb, id: unknown) => alarmsOf(db, id).map((a) => [a.alarm_type, hm(a.scheduled_at), a.time_source]).sort();
  const expected = shape(control.db, c.thu.appointment_id);

  const { env, thu } = await friendAppliedAll();
  await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T09:30') }, 'this', true));
  assert.deepEqual(shape(env.db, thu.appointment_id), expected);
});

test('10-22: 친구가 바꾸기 전에 주인이 직접 골랐던 알람(original_time_source = MANUAL)은 약속 시각이 바뀌면 친구 값만 지워지고 주인의 값이 이어짐', async () => {
  const { env, thu, wake, original } = await friendAppliedCase();
  wake.original_time_source = 'MANUAL';
  await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T09:30') }, 'this', true));
  const moved = alarmsOf(env.db, thu.appointment_id).find((a) => a.alarm_type === 'WAKE')!;
  assert.deepEqual([hm(moved.scheduled_at), moved.time_source], [hm(original), 'MANUAL']);   // 친구 값 07:20이 아니라 주인이 고른 07:25
});

test('10-22: 알람을 읽는 열 목록에 원래 시각 · 그때의 time_source 칸이 들어 있음 (가짜 DB는 열 목록을 안 보므로 따로 못 박음)', () => {
  const columns = ALARM_COLUMNS.split(',').map((x) => x.trim());
  assert.ok(columns.includes('original_scheduled_at') && columns.includes('original_time_source'));
});

test('10-23: 주인이 직접 고른 MANUAL(원래 시각 기억 없음)은 약속 시각이 바뀌어도 그대로 — 친구 값과 규칙이 다름 (기존 규칙)', async () => {
  const { env, thu, wake } = await friendAppliedCase();
  wake.original_scheduled_at = null;           // 주인이 직접 고친 값이면 서버 가드가 기억을 비움
  const own = wake.scheduled_at;
  await updateAppointment(ctxFor(env, A), upd(thu.appointment_id as string, { at: kst('2026-10-29T09:30') }, 'this', true));
  assert.deepEqual([wake.scheduled_at, wake.time_source], [own, 'MANUAL']);
});

// ---- 장소 미확정 일정 (alarm-commit PLACE_PENDING) 고치기 ----

test('장소 미확정 일정: 시각만 고치면 길찾기 없이 저장(ROUTE_UNAVAILABLE 아님) · 알람은 계속 없음', async () => {
  const env = setup();
  const db = env.db as unknown as Db;
  const { appointment_id: id } = await commitPlacePending({ userId: A, userDb: db, service: db, now: MON_10 }, { appointment: { title: '캡스톤 회의', at: kst('2026-10-27T13:00'), importance: 'NORMAL' } });
  const kakao = fakeKakao();
  const res = await updateAppointment(ctxFor(env, A, { kakao: kakao.lookup }), upd(id, { at: kst('2026-10-27T15:00') }));
  assert.equal(res.saved, true);
  assert.equal(kakao.state.calls, 0);
  assert.equal(hm(row(env.db, id)!.appointment_at), '15:00');
  assert.deepEqual([alarmsOf(env.db, id).length, participantOf(env.db, id)!.est_travel_minutes], [0, null]);
  assert.ok(!res.warnings.some((w) => w.code === 'PLACE_SET_ALARMS_PENDING'));
});

test('장소 미확정 일정에 장소를 정하면 같은 일정(id 그대로)에 장소 · 이동시간만 저장, 알람은 만들지 않고 알람 설정에서 확인하라고 알림', async () => {
  const env = setup();
  const db = env.db as unknown as Db;
  const { appointment_id: id, participant_id: pid } = await commitPlacePending({ userId: A, userDb: db, service: db, now: MON_10 }, { appointment: { title: '캡스톤 회의', at: kst('2026-10-27T13:00'), importance: 'NORMAL' } });
  const kakao = fakeKakao(25);
  const res = await updateAppointment(ctxFor(env, A, { kakao: kakao.lookup }), upd(id, { destination: { name: '세종대학교', ...SCHOOL } }));
  assert.equal(res.saved, true);
  assert.equal(kakao.state.calls, 1);
  assert.deepEqual([row(env.db, id)!.dest_name, row(env.db, id)!.dest_lat], ['세종대학교', SCHOOL.lat]);
  const part = participantOf(env.db, id)!;
  assert.deepEqual([part.participant_id, part.est_travel_minutes, part.travel_source], [pid, 25, 'API']);
  assert.equal(alarmsOf(env.db, id).length, 0, '확인 없이 알람을 만들지 않음');
  assert.deepEqual(res.warnings.map((w) => w.code), ['PLACE_SET_ALARMS_PENDING']);
});
