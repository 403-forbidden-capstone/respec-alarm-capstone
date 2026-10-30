// alarm-roll 본문(roll.ts) — 가짜 DB(fake-db.ts) + 가짜 카카오(분 고정, 부른 수 셈)로. 달력: 2026-10-26 월 · 27 화 · 28 수 · 29 목 · 30 금 · 11-02 월 · 03 화 · 04 수 · 05 목
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareSourceLabel, prepareStatsOf, RING_KINDS, type RingKind } from './calc/index.ts';
import { commitStandalone, persistAppointment } from './commit.ts';
import { deleteAppointment, updateAppointment, type EditCtx } from './edit-run.ts';
import { FakeDb } from './fake-db.ts';
import { KakaoError, type KakaoFailure } from './kakao.ts';
import { buildPlan } from './plan.ts';
import type { AlarmRow, ParticipantRow, ProfileRow } from './plan-core.ts';
import { Reader } from './read.ts';
import { readCommitRequest } from './requests.ts';
import {
  FALLBACK_BEFORE_FIRST_ALARM_HOURS,
  firstAlarmAt,
  inheritedKinds,
  planOccurrence,
  readRollRequest,
  retryAt,
  routineStepStarts,
  runRoll,
  shiftManualTimes,
  type RollBase,
  type RollPlanCtx,
  type RollResult,
  type TravelLookup,
} from './roll.ts';
import type { SeriesAppointmentRow } from './plan.ts';
import type { Db } from './supabase.ts';
import { localDateKey } from './tz.ts';

const A = 'u-a';
const B = 'u-b';
const kst = (local: string) => new Date(`${local}:00+09:00`); // '2026-10-26T10:00'
const iso = (local: string) => `${local}:00+09:00`;
const hm = (value: unknown) => {
  const m = (new Date(value as string).getUTCHours() * 60 + new Date(value as string).getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const ymd = (value: unknown) => localDateKey(new Date(value as string), 'Asia/Seoul');
const HOME = { lat: 37.5547, lng: 126.9707 };
const SCHOOL = { lat: 37.55, lng: 127.07 };

// ---- 도구 ----

type Env = { db: FakeDb; logs: string[]; warns: string[] };

function setup(now: Date, users: string[] = [A]): Env {
  const db = new FakeDb().withRollRpc();
  db.now = now;
  for (const user_id of users) {
    db.rows('profiles').push({ user_id, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng } satisfies ProfileRow & { user_id: string });
  }
  return { db, logs: [], warns: [] };
}

// 가짜 카카오 — 분 고정, 부른 수를 셈. script에 실패 이름이나 분을 줄 세우면 부를 때마다 하나씩 꺼내 씀 (다 쓰면 fail 또는 minutes)
function fakeKakao(minutes = 50) {
  const state = { calls: 0, minutes, partial: false, fail: null as KakaoFailure | null, script: [] as (KakaoFailure | number)[] };
  const lookup: TravelLookup = async () => {
    state.calls += 1;
    const next = state.script.shift() ?? state.fail;
    if (typeof next === 'string') throw new KakaoError(next, '시험용 실패');
    return { minutes: next ?? state.minutes, partial: state.partial };
  };
  return { state, lookup };
}

type RunOptions = { userId?: string; seriesId?: string; lookup?: TravelLookup; limits?: Parameters<typeof runRoll>[0]['limits'] };
function roll(env: Env, path: 'own' | 'batch', now: Date, options: RunOptions = {}): Promise<RollResult> {
  env.db.now = now;
  const db = env.db as unknown as Db;
  return runRoll(
    { path, now, read: db, write: db, lookup: options.lookup, limits: options.limits, log: (l) => env.logs.push(l), warn: (l) => env.warns.push(l) },
    path === 'own' ? { userId: options.userId ?? A, seriesId: options.seriesId } : {},
  );
}

const slot = (over: object = {}) => ({
  appointment: { title: '세미나', appointment_at: iso('2026-10-27T09:00'), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU,TH' },
  participant: { origin: { name: '집', ...HOME }, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', buffer_minutes: 10, before_prepare_minutes: 30 },
  ...over,
});

// alarm-commit이 첫 회차를 저장한 것처럼 (요청 읽기 → 계산 → 저장). 돌려주는 값 = 묶음 번호
async function seed(env: Env, user: string, body: object, now: Date): Promise<string> {
  const request = readCommitRequest(Reader.root(body));
  if (request.type !== 'APPOINTMENT') throw new Error('약속 요청이어야 해요');
  const db = env.db as unknown as Db;
  const built = await buildPlan({ userId: user, db, now }, request.draft);
  const saved = await persistAppointment({ userId: user, userDb: db, service: db, now }, {
    plan: built.plan,
    inputs: built.inputs,
    created: request.appointment,
    draft: request.draft,
    replaceExisting: request.replaceExisting,
    edits: [],
    timeZone: built.timeZone,
  });
  return env.db.rows('appointments').find((a) => a.appointment_id === saved.appointment_id)!.series_id as string;
}

const occurrence = (db: FakeDb, series: string, date: string) => db.rows('appointments').find((a) => a.series_id === series && a.occurrence_on === date);
const datesOf = (db: FakeDb, series: string) => db.rows('appointments').filter((a) => a.series_id === series).map((a) => a.occurrence_on as string).sort();
const alarmsOf = (db: FakeDb, appointmentId: unknown) => {
  const participant = db.rows('appointment_participants').find((p) => p.appointment_id === appointmentId)!;
  return db.rows('alarms').filter((a) => a.participant_id === participant.participant_id).sort((x, y) => Date.parse(x.scheduled_at as string) - Date.parse(y.scheduled_at as string));
};
const lines = (db: FakeDb, appointmentId: unknown) => alarmsOf(db, appointmentId).map((a) => `${a.alarm_type} ${hm(a.scheduled_at)} ${a.is_enabled ? 'on' : 'off'}`);
const participantOf = (db: FakeDb, appointmentId: unknown) => db.rows('appointment_participants').find((p) => p.appointment_id === appointmentId)!;
const attempts = (db: FakeDb) => db.rows('roll_attempts').map((r) => `${r.occurrence_on} ${r.tries} ${r.last_error} ${r.skipped ? 'skipped' : ymd(r.next_try_at) + ' ' + hm(r.next_try_at)}`).sort();

// 시험용 간단 행 (alarm-commit을 거치지 않고) — 많이 만들 때
// ats마다 회차 한 줄 (첫 줄의 id가 묶음 번호)
let rawSeq = 0;
function rawSeries(db: FakeDb, user: string, over: { ats: string[]; rule: string; title?: string }): string {
  let series = '';
  for (const when of over.ats) {
    rawSeq += 1;
    const appointment_id = `ap-raw-${rawSeq}`;
    series ||= appointment_id;
    const at = new Date(when);
    db.rows('appointments').push({
      appointment_id, creator_id: user, group_id: null, title: over.title ?? `일정 ${rawSeq}`, appointment_at: when, dest_name: '세종대학교', dest_lat: SCHOOL.lat, dest_lng: SCHOOL.lng,
      importance: 'NORMAL', recurrence_rule: over.rule, memo: null, dest_radius_m: null, series_id: series, occurrence_on: localDateKey(at, 'Asia/Seoul'),
    });
    const participant_id = `pt-raw-${rawSeq}`;
    db.rows('appointment_participants').push({
      participant_id, appointment_id, user_id: user, origin_name: '집', origin_lat: HOME.lat, origin_lng: HOME.lng, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', prepare_minutes: 50, buffer_minutes: 10,
    });
    for (const [alarm_type, minutes] of [['WAKE', -110], ['PREPARE', -80], ['DEPARTURE', -60], ['ARRIVE', -10]] as const) {
      db.rows('alarms').push({
        alarm_id: `al-raw-${rawSeq}-${alarm_type}`, user_id: user, participant_id, routine_id: null, alarm_type, scheduled_at: new Date(at.getTime() + minutes * 60_000).toISOString(),
        intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: null, is_enabled: true, snooze_limit: 3, time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null,
      });
    }
  }
  return series;
}

// 같은 경로를 실제로 다닌 기록 (출발 · 도착이 찍힌 참여 한 줄)
let sampleSeq = 0;
function addSample(db: FakeDb, user: string, minutes: number, over: { actual?: number } = {}) {
  sampleSeq += 1;
  const appointment_id = `ap-sample-${sampleSeq}`;
  const departed = new Date(Date.UTC(2026, 9, 1 + sampleSeq, 0, 0));
  db.rows('appointments').push({
    appointment_id, creator_id: user, group_id: null, title: '지난 일정', appointment_at: departed.toISOString(), dest_name: '세종대학교', dest_lat: SCHOOL.lat, dest_lng: SCHOOL.lng,
    importance: 'NORMAL', recurrence_rule: null, series_id: appointment_id, occurrence_on: localDateKey(departed, 'Asia/Seoul'),
  });
  db.rows('appointment_participants').push({
    participant_id: `pt-sample-${sampleSeq}`, appointment_id, user_id: user, origin_name: '집', origin_lat: HOME.lat, origin_lng: HOME.lng, transport_type: 'TRANSIT', est_travel_minutes: 50,
    travel_source: 'API', prepare_minutes: 50, buffer_minutes: 10, departed_at: departed.toISOString(), arrived_at: new Date(departed.getTime() + minutes * 60_000).toISOString(),
    actual_travel_minutes: over.actual ?? null,
  });
}

// ===========================================================================
// 두 길 · 응답 모양 · 같은 요청 두 번
// ===========================================================================

const MON_10 = kst('2026-10-26T10:00');

test('본인 길: 앞으로 14일 안 회차를 회차마다 길찾기 1번씩 만들고, 응답에 폰에 걸 꾸러미 · 호출 수를 담음', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10); // 첫 회차 화 10/27 (알람 4개)
  const kakao = fakeKakao(35);
  const res = await roll(env, 'own', MON_10, { lookup: kakao.lookup });

  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-10-29', '2026-11-03', '2026-11-05']); // 화 · 목, 가까운 순. 11/10 화는 창(11/9 10시) 밖
  assert.ok(res.created.every((c) => c.series_id === series && c.appointment_id));
  assert.equal(res.kakao_calls, 3);
  assert.equal(kakao.state.calls, 3);
  assert.deepEqual([res.pending, res.moved_alarm_ids, res.canceled_alarm_ids], [[], [], []]);
  assert.deepEqual(datesOf(env.db, series), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);

  const thu = occurrence(env.db, series, '2026-10-29')!;
  assert.equal(hm(thu.appointment_at), '09:00');
  assert.equal(thu.series_id, series);
  assert.equal(thu.recurrence_rule, 'FREQ=WEEKLY;BYDAY=TU,TH'); // 모든 회차가 같은 규칙
  assert.deepEqual(participantOf(env.db, thu.appointment_id), { ...participantOf(env.db, thu.appointment_id), user_id: A, est_travel_minutes: 35, travel_source: 'API', transport_type: 'TRANSIT', buffer_minutes: 10 });
  assert.deepEqual(lines(env.db, thu.appointment_id), ['WAKE 07:25 on', 'PREPARE 07:55 on', 'DEPARTURE 08:15 on', 'ARRIVE 08:50 on']); // 출발 = 9:00 − 여유 10 − 이동 35

  // 꾸러미: 새 회차 3개 × 켜진 알람 4개, 시각 순. alarm-commit과 같은 조립 함수
  assert.equal(res.ring_packages.length, 12);
  assert.deepEqual(res.ring_packages.map((p) => p.atMillis), [...res.ring_packages.map((p) => p.atMillis)].sort((x, y) => x - y));
  const first = res.ring_packages[0];
  assert.deepEqual([first.type, first.title, first.subtitle, first.alarmId], ['WAKE', '세미나', '오전 9:00 · 세종대학교', alarmsOf(env.db, thu.appointment_id)[0].alarm_id]);
  assert.equal(first.departAt, kst('2026-10-29T08:15').getTime());

  assert.deepEqual(env.logs.map((l) => JSON.parse(l)), [{ fn: 'alarm-roll', path: 'own', kakao_calls: 3, created: 3, pending: 0 }]);
  assert.deepEqual(env.warns, []);
});

test('배치 길: 같은 회차를 만들고 꾸러미는 비움 (개수만 로그)', async () => {
  const env = setup(MON_10);
  await seed(env, A, slot(), MON_10);
  const kakao = fakeKakao();
  const res = await roll(env, 'batch', MON_10, { lookup: kakao.lookup });
  assert.equal(res.created.length, 3);
  assert.deepEqual(res.ring_packages, []);
  assert.equal(res.kakao_calls, 3);
  assert.deepEqual(env.logs.map((l) => JSON.parse(l)), [{ fn: 'alarm-roll', path: 'batch', kakao_calls: 3, created: 3, pending: 0 }]);
  assert.ok(!env.logs[0].includes(A)); // 로그에 사용자 id 없음
});

test('같은 요청을 두 번 보내면 같은 결과: 두 번째는 만들 것도 길찾기도 없음 (본인 · 배치 섞어서)', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  const kakao = fakeKakao();
  await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  const before = JSON.stringify([env.db.rows('appointments'), env.db.rows('appointment_participants'), env.db.rows('alarms')]);
  for (const path of ['own', 'batch', 'own'] as const) {
    const again = await roll(env, path, MON_10, { lookup: kakao.lookup });
    assert.deepEqual([again.created, again.pending, again.kakao_calls], [[], [], 0], path);
  }
  assert.equal(JSON.stringify([env.db.rows('appointments'), env.db.rows('appointment_participants'), env.db.rows('alarms')]), before);
  assert.equal(kakao.state.calls, 3);
  assert.equal(datesOf(env.db, series).length, 4);
});

test('본인 길 · 배치가 동시에 같은 회차를 보면 회차는 한 번만 (길찾기만 두 번 쓸 수 있음)', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  const kakao = fakeKakao();
  const [own, batch] = await Promise.all([roll(env, 'own', MON_10, { lookup: kakao.lookup }), roll(env, 'batch', MON_10, { lookup: kakao.lookup })]);
  assert.equal(own.created.length + batch.created.length, 3);
  assert.deepEqual(datesOf(env.db, series), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);
  assert.equal(env.db.rows('appointment_participants').length, 4);
  assert.equal(env.db.rows('alarms').length, 16);
});

// ===========================================================================
// 사용자 경계
// ===========================================================================

// 쿼리마다 사용자(creator_id · user_id)로 좁혔는지 지켜보는 껍데기
function guarded(db: FakeDb, users: string[], violations: string[]) {
  const USER_COLUMN: Record<string, string> = {
    appointments: 'creator_id', appointment_participants: 'user_id', alarms: 'user_id', todos: 'user_id', roll_attempts: 'user_id', routines: 'user_id', profiles: 'user_id', daily_records: 'user_id',
  };
  const watch = (query: any, table: string) => {
    const eqs: Record<string, unknown> = {};
    const proxy: any = new Proxy(query, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        if (prop === 'then') {
          return (resolve: any, reject: any) => {
            const column = USER_COLUMN[table];
            if (!column || !users.includes(eqs[column] as string)) violations.push(`${table} 읽기 · 쓰기에 ${column ?? '?'} 조건이 없음`);
            return target.then(resolve, reject);
          };
        }
        return (...args: unknown[]) => {
          if (prop === 'eq') eqs[args[0] as string] = args[1];
          if (prop === 'insert' || prop === 'upsert') {
            const column = USER_COLUMN[table];
            const owners = new Set([args[0]].flat().map((r) => (r as Record<string, unknown>)[column]));
            if (owners.size === 1) eqs[column] = [...owners][0];
          }
          const out = value.apply(target, args);
          return out === target ? proxy : out;
        };
      },
    });
    return proxy;
  };
  return {
    from: (table: string) => watch(db.from(table), table),
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === 'roll_insert_occurrence' && !users.includes((args.p_appointment as { creator_id: string }).creator_id)) violations.push('roll_insert_occurrence의 creator_id가 사용자가 아님');
      return db.rpc(name, args);
    },
  } as unknown as Db;
}

test('배치는 남의 행을 안 건드림 (사용자 둘): 모든 쿼리가 사용자로 좁혀지고, 이어받기 · 기록 · 그날 첫 일정이 사람마다 따로', async () => {
  const env = setup(MON_10, [A, B]);
  const a = await seed(env, A, slot(), MON_10);
  const b = await seed(env, B, slot({ appointment: { ...slot().appointment, title: '동아리', destination: { name: '학생회관', lat: 37.56, lng: 127.0 } } }), MON_10);
  // B에게만 있는 것: 목요일 7:30 일회성 약속(켜진 기상 있음) · 같은 경로 이동 기록 3건 · 켜진 알람 많이
  await seed(env, B, { appointment: { title: '새벽 운동', appointment_at: iso('2026-10-29T07:30'), destination: { name: '체육관', lat: 37.5, lng: 127.0 } }, participant: slot().participant }, MON_10);
  for (let i = 0; i < 3; i++) addSample(env.db, B, 20);
  const snapshot = JSON.stringify(Object.fromEntries(['profiles', 'appointments', 'appointment_participants', 'alarms'].map((t) => [t, env.db.rows(t).map((r) => ({ ...r }))])));
  const before = JSON.parse(snapshot) as Record<string, Record<string, unknown>[]>;

  const violations: string[] = [];
  const db = guarded(env.db, [A, B], violations);
  env.db.now = MON_10;
  const kakao = fakeKakao();
  kakao.state.fail = 'TIMEOUT'; // 길찾기가 안 되는 날 — A 몫 폴백이 B의 기록(CACHED)을 가져다 쓰면 안 됨. 첫 알람이 12시간 밖이라 둘 다 미룸
  const res = await runRoll({ path: 'batch', now: MON_10, read: db, write: db, lookup: kakao.lookup, limits: { lookups: 50 }, log: () => {}, warn: (l) => env.warns.push(l) });
  assert.deepEqual(violations, []);
  assert.deepEqual(res.created, []);
  assert.equal(res.pending.length, 6); // A 3 + B 3 (B의 새벽 운동은 반복이 아님)
  assert.deepEqual(attempts(env.db).length, 6);

  // 성공하는 날: 사람마다 자기 묶음에만
  kakao.state.fail = null;
  env.db.tables.roll_attempts = [];
  const ok = await runRoll({ path: 'batch', now: MON_10, read: db, write: db, lookup: kakao.lookup, limits: { lookups: 50 }, log: () => {}, warn: (l) => env.warns.push(l) });
  assert.deepEqual(violations, []);
  assert.equal(ok.created.length, 6);
  assert.deepEqual(datesOf(env.db, a), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);
  assert.deepEqual(datesOf(env.db, b), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);
  for (const row of env.db.rows('appointments')) {
    const participant = participantOf(env.db, row.appointment_id);
    assert.equal(participant.user_id, row.creator_id);
    assert.ok(alarmsOf(env.db, row.appointment_id).every((al) => al.user_id === row.creator_id));
  }
  // 이어받기도 자기 것에서: B의 동아리 약속 장소(학생회관)가 A 회차로 새지 않음
  assert.deepEqual([occurrence(env.db, a, '2026-11-03')!.title, occurrence(env.db, a, '2026-11-03')!.dest_name, occurrence(env.db, b, '2026-11-03')!.title, occurrence(env.db, b, '2026-11-03')!.dest_name], ['세미나', '세종대학교', '동아리', '학생회관']);
  // 그날 첫 일정은 사람마다: B는 목요일 7:30 약속이 앞서서 9시 회차에 기상이 없고, A는 있음
  assert.deepEqual(lines(env.db, occurrence(env.db, a, '2026-10-29')!.appointment_id).map((l) => l.split(' ')[0]), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);
  assert.deepEqual(lines(env.db, occurrence(env.db, b, '2026-10-29')!.appointment_id).map((l) => l.split(' ')[0]), ['PREPARE', 'DEPARTURE', 'ARRIVE']);
  // 처음 있던 행은 하나도 안 바뀜
  for (const table of ['profiles', 'appointments', 'appointment_participants', 'alarms']) {
    for (const old of before[table]) {
      const now = env.db.rows(table).find((r) => JSON.stringify({ ...r, ...{} }) === JSON.stringify(old));
      assert.ok(now, `${table}의 기존 행이 바뀌었어요`);
    }
  }
});

test('A의 폴백은 B의 이동 기록을 안 씀: 길찾기가 안 되고 첫 알람이 12시간 안이면 A는 ESTIMATE (B만 3건이 있음)', async () => {
  const NOW = kst('2026-10-28T20:00');
  const env = setup(MON_10, [A, B]);
  await seed(env, A, slot(), MON_10);
  await seed(env, B, slot(), MON_10);
  for (let i = 0; i < 3; i++) addSample(env.db, B, 20);
  const kakao = fakeKakao();
  kakao.state.fail = 'TIMEOUT';
  const res = await roll(env, 'batch', NOW, { lookup: kakao.lookup, limits: { lookups: 50 } });
  const sourceOf = (user: string) => env.db.rows('appointments').filter((x) => x.creator_id === user && x.occurrence_on === '2026-10-29').map((x) => participantOf(env.db, x.appointment_id).travel_source);
  assert.deepEqual(sourceOf(A), ['ESTIMATE']); // 목 7:10 기상 — 지금(수 20시)부터 11시간 10분
  assert.deepEqual(sourceOf(B), ['CACHED']);
  assert.equal(res.created.length, 2);
});

test('본인 길: 요청 본문에 남의 id를 넣어도 내 행만 생김 (creator_id · user_id는 검증한 로그인 사용자에서만)', async () => {
  const env = setup(MON_10, [A, B]);
  const a = await seed(env, A, slot(), MON_10);
  const b = await seed(env, B, slot(), MON_10);
  // 본문은 series_id만 읽음 — 남의 id를 담은 칸은 무시
  assert.deepEqual(readRollRequest(Reader.root({ series_id: b, creator_id: B, user_id: B, appointment: { creator_id: B } })), { seriesId: b });
  assert.deepEqual(readRollRequest(Reader.root({})), {});
  const broken = Reader.root({ series_id: 'not-a-uuid' });
  readRollRequest(broken);
  assert.throws(() => broken.finish(), /입력값/);

  const kakao = fakeKakao();
  const res = await roll(env, 'own', MON_10, { userId: A, seriesId: b, lookup: kakao.lookup }); // 남의 묶음을 먼저 하라고 해도
  assert.equal(res.created.length, 3);
  assert.deepEqual(datesOf(env.db, b), ['2026-10-27']); // B 묶음은 그대로
  assert.deepEqual(datesOf(env.db, a), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);
  const creators = env.db.rpcCalls.filter((c) => c.name === 'roll_insert_occurrence').map((c) => (c.args.p_appointment as { creator_id: string }).creator_id);
  assert.deepEqual(creators, [A, A, A]);
  assert.ok(env.db.rows('appointments').filter((x) => x.series_id === a).every((x) => x.creator_id === A));
});

// ===========================================================================
// 이어받기 (설계 메모 2절 표)
// ===========================================================================

test('이어받기: 만들 종류 · 끈 종류 · 직접 시각(같은 시:분) · 직접 강도 · 출발지 · 수단 · 여유 · 직접 이동시간 · 준비물 · 메모 · 반경', async () => {
  const env = setup(MON_10);
  const body = slot({
    participant: { origin: { name: '기숙사', lat: 37.5, lng: 127.0 }, transport_type: 'SUBWAY', est_travel_minutes: 40, travel_source: 'MANUAL', buffer_minutes: 15, before_prepare_minutes: 30 },
    kinds: ['WAKE', 'DEPARTURE'], // 준비 알람은 안 만듦
    enabled: { WAKE: false }, // 기상은 꺼 둠
    manual_times: { WAKE: iso('2026-10-27T07:30') }, // 직접 고른 기상 시각
    levels: { vibration: 2 }, // 직접 고른 강도
  });
  const series = await seed(env, A, body, MON_10);
  const base = env.db.rows('appointments')[0];
  Object.assign(base, { memo: '교재 지참', dest_radius_m: 200, importance: 'HIGH' });
  env.db.rows('todos').push(
    { todo_id: 't1', user_id: A, appointment_id: base.appointment_id, title: '노트북', todo_type: 'ITEM', is_done: true },
    { todo_id: 't2', user_id: A, appointment_id: base.appointment_id, title: '충전기', todo_type: 'ITEM', is_done: false },
    { todo_id: 't3', user_id: A, appointment_id: base.appointment_id, title: '과제 내기', todo_type: 'TASK', is_done: false }, // 준비물이 아님
  );
  assert.deepEqual(lines(env.db, base.appointment_id), ['WAKE 07:30 off', 'DEPARTURE 08:05 on', 'ARRIVE 08:45 on']);

  const kakao = fakeKakao(99);
  const res = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.equal(res.kakao_calls, 0); // 직접 이동시간은 길찾기를 안 부름
  const thu = occurrence(env.db, series, '2026-10-29')!;
  const p = participantOf(env.db, thu.appointment_id);
  assert.deepEqual([p.origin_name, p.origin_lat, p.transport_type, p.buffer_minutes, p.est_travel_minutes, p.travel_source], ['기숙사', 37.5, 'SUBWAY', 15, 40, 'MANUAL']);
  assert.deepEqual(lines(env.db, thu.appointment_id), ['WAKE 07:30 off', 'DEPARTURE 08:05 on', 'ARRIVE 08:45 on']); // 같은 종류 · 같은 시:분 · 끈 채
  const wake = alarmsOf(env.db, thu.appointment_id)[0];
  assert.deepEqual([wake.time_source, wake.intensity_source, wake.intensity], ['MANUAL', 'MANUAL', 'STRONG']);
  assert.ok(alarmsOf(env.db, thu.appointment_id).every((a) => a.intensity === 'STRONG' && a.intensity_source === 'MANUAL'));
  assert.deepEqual([thu.title, thu.dest_name, thu.importance, thu.memo, thu.dest_radius_m, thu.recurrence_rule, thu.group_id], ['세미나', '세종대학교', 'HIGH', '교재 지참', 200, 'FREQ=WEEKLY;BYDAY=TU,TH', null]);
  const items = env.db.rows('todos').filter((t) => t.appointment_id === thu.appointment_id);
  assert.deepEqual(items.map((t) => [t.title, t.todo_type, t.is_done, t.due_date]), [['노트북', 'ITEM', false, '2026-10-29'], ['충전기', 'ITEM', false, '2026-10-29']]);
  // 켜진 알람만 꾸러미로 (끈 기상은 폰에 안 걸림)
  assert.deepEqual(res.ring_packages.filter((x) => x.atMillis === kst('2026-10-29T07:30').getTime()), []);
});

test('이어받기: 길찾기로 구한 이동시간(API)은 안 이어받고 회차마다 새로 구함, 준비시간도 새로 계산 (공통 P80 + 개인 보정)', async () => {
  const env = setup(MON_10);
  for (let d = 1; d <= 20; d += 1) env.db.rows('daily_records').push({ record_id: `r${d}`, user_id: A, record_date: `2026-10-${String(d).padStart(2, '0')}`, actual_prepare_minutes: 90 }); // 내 기상~출발 기록 20건 (P80 90)
  const series = await seed(env, A, slot(), MON_10);
  const basePrepare = participantOf(env.db, env.db.rows('appointments')[0].appointment_id).prepare_minutes as number;
  const kakao = fakeKakao();
  kakao.state.script = [35, 70, 55];
  await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  const minutes = ['2026-10-29', '2026-11-03', '2026-11-05'].map((d) => participantOf(env.db, occurrence(env.db, series, d)!.appointment_id));
  assert.deepEqual(minutes.map((p) => [p.est_travel_minutes, p.travel_source]), [[35, 'API'], [70, 'API'], [55, 'API']]);
  assert.ok(minutes.every((p) => (p.prepare_minutes as number) > 0));
  assert.notEqual(minutes[0].prepare_minutes, 50); // 내 기록(20건, 아침 P80 > 공통)으로 보정
  assert.equal(basePrepare, minutes[0].prepare_minutes); // 같은 통계라 첫 회차와도 같음 — 회차마다 같은 식으로 새로 계산
});

test('그날 첫 일정은 회차 날짜 기준: 기준 회차에 기상이 없던 게 그날 다른 기상에 밀려서였으면 새 회차가 첫 일정일 때 기상을 만듦, 사용자가 안 고른 거면 없는 채로', async () => {
  // 화요일에는 7:30 약속(기상 있음)이 앞서서 9시 약속에 기상이 없고, 목요일에는 앞선 약속이 없음
  const env = setup(MON_10);
  await seed(env, A, { appointment: { title: '새벽 운동', appointment_at: iso('2026-10-27T07:30'), destination: { name: '체육관', lat: 37.5, lng: 127.0 } }, participant: slot().participant }, MON_10);
  const series = await seed(env, A, slot(), MON_10);
  const base = env.db.rows('appointments').find((x) => x.series_id === series)!;
  assert.deepEqual(lines(env.db, base.appointment_id).map((l) => l.split(' ')[0]), ['PREPARE', 'DEPARTURE', 'ARRIVE']);
  const kakao = fakeKakao();
  await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.deepEqual(lines(env.db, occurrence(env.db, series, '2026-10-29')!.appointment_id).map((l) => l.split(' ')[0]), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']); // 목: 첫 일정
  assert.deepEqual(lines(env.db, occurrence(env.db, series, '2026-11-03')!.appointment_id).map((l) => l.split(' ')[0]), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);

  // 사용자가 기상을 안 고른 경우 (첫 일정인데 kinds에서 뺌) — 새 회차도 기상 없음
  const env2 = setup(MON_10);
  const s2 = await seed(env2, A, slot({ kinds: ['PREPARE', 'DEPARTURE'] }), MON_10);
  await roll(env2, 'own', MON_10, { lookup: fakeKakao().lookup });
  assert.deepEqual(lines(env2.db, occurrence(env2.db, s2, '2026-10-29')!.appointment_id).map((l) => l.split(' ')[0]), ['PREPARE', 'DEPARTURE', 'ARRIVE']);

  // 알람 없는 일정(kinds = [])은 새 회차도 알람 없음
  const env3 = setup(MON_10);
  const s3 = await seed(env3, A, slot({ kinds: [] }), MON_10);
  await roll(env3, 'own', MON_10, { lookup: fakeKakao().lookup });
  assert.equal(alarmsOf(env3.db, occurrence(env3.db, s3, '2026-10-29')!.appointment_id).length, 0);
  assert.equal(datesOf(env3.db, s3).length, 4);
});

// ===========================================================================
// 길찾기 실패 · 재시도 · 폴백
// ===========================================================================

test('길찾기 실패(TIMEOUT · HTTP · NO_ROUTE): 그 회차는 안 만들고 1 · 3 · 6시간 뒤 다시 — 기다리는 동안은 길찾기도 안 부름', async () => {
  for (const kind of ['TIMEOUT', 'HTTP', 'NO_ROUTE'] as const) {
    const env = setup(MON_10);
    const series = await seed(env, A, slot(), MON_10);
    const kakao = fakeKakao();
    kakao.state.fail = kind;
    const first = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
    assert.deepEqual([first.created.length, first.kakao_calls], [0, 3], kind);
    assert.deepEqual(first.pending.map((p) => [p.occurrence_on, p.reason]), [['2026-10-29', 'ROUTE_RETRY'], ['2026-11-03', 'ROUTE_RETRY'], ['2026-11-05', 'ROUTE_RETRY']]);
    assert.deepEqual(attempts(env.db), [`2026-10-29 1 ${kind} 2026-10-26 11:00`, `2026-11-03 1 ${kind} 2026-10-26 11:00`, `2026-11-05 1 ${kind} 2026-10-26 11:00`]);
    assert.equal(datesOf(env.db, series).length, 1);

    // 기다리는 동안: 본인 길도 배치도 길찾기를 안 부름 (배치는 roll_due_series가 대기 묶음을 안 줌)
    for (const path of ['own', 'batch'] as const) {
      const waiting = await roll(env, path, kst('2026-10-26T10:30'), { lookup: kakao.lookup });
      assert.deepEqual([waiting.created, waiting.pending, waiting.kakao_calls], [[], [], 0], `${kind} ${path}`);
    }
    // 1시간 뒤 또 실패 → 3시간 뒤, 그다음 6시간 뒤, 그 뒤로도 6시간
    const waits: string[] = [];
    let at = kst('2026-10-26T11:00');
    for (let i = 0; i < 4; i++) {
      await roll(env, 'batch', at, { lookup: kakao.lookup, limits: { lookups: 50 } });
      waits.push(attempts(env.db)[0]);
      at = new Date(Date.parse(env.db.rows('roll_attempts')[0].next_try_at as string));
    }
    assert.deepEqual(waits, [`2026-10-29 2 ${kind} 2026-10-26 14:00`, `2026-10-29 3 ${kind} 2026-10-26 20:00`, `2026-10-29 4 ${kind} 2026-10-27 02:00`, `2026-10-29 5 ${kind} 2026-10-27 08:00`]);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => retryAt(MON_10, n - 1).getTime() - MON_10.getTime()).map((ms) => ms / 3_600_000), [1, 3, 6, 6, 6, 6]);

    // 길찾기가 되돌아오면 만들고 기록을 지움
    kakao.state.fail = null;
    const done = await roll(env, 'own', new Date(at.getTime() + 1000), { lookup: kakao.lookup });
    assert.equal(done.created.length, 3, kind);
    assert.deepEqual(attempts(env.db), [], kind);
    assert.equal(datesOf(env.db, series).length, 4);
  }
});

test('길찾기를 쓴 뒤 저장(roll_insert_occurrence)이 던지면 재시도 기록을 남겨서, 5분 뒤 실행이 같은 회차로 카카오를 또 안 부름', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  const original = env.db.rpcHandlers.roll_insert_occurrence;
  let thrown = false;
  env.db.rpcHandlers.roll_insert_occurrence = (args) => {
    if (!thrown) {
      thrown = true;
      throw new Error('시험용 저장 실패 (세종대학교 37.55,127.07)');
    }
    return original(args);
  };
  const kakao = fakeKakao();

  // 첫 실행: 가까운 회차(10-29)의 저장이 한 번 던짐 → 길찾기는 이미 썼으니 재시도 기록(tries 1, 1시간 뒤), 나머지 두 회차는 만듦
  const first = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.deepEqual([first.created.length, first.kakao_calls, kakao.state.calls], [2, 3, 3]);
  assert.deepEqual(attempts(env.db), ['2026-10-29 1 INTERNAL 2026-10-26 11:00']);
  assert.ok(!JSON.stringify(env.db.rows('roll_attempts')).includes('세종'), '좌표 · 장소명은 기록에 안 남음');
  assert.equal(occurrence(env.db, series, '2026-10-29'), undefined);

  // 5분 뒤: 대기 중이라 카카오 0번 (본인 길 · 배치 모두)
  for (const path of ['own', 'batch'] as const) {
    const again = await roll(env, path, kst('2026-10-26T10:05'), { lookup: kakao.lookup });
    assert.deepEqual([again.created, again.pending, again.kakao_calls], [[], [], 0], path);
  }
  assert.equal(kakao.state.calls, 3);

  // 1시간 뒤엔 다시 시도해서 만들고 기록을 지움
  const later = await roll(env, 'own', kst('2026-10-26T11:00'), { lookup: kakao.lookup });
  assert.deepEqual([later.created.length, later.kakao_calls], [1, 1]);
  assert.deepEqual(attempts(env.db), []);
});

test('길찾기를 안 쓴 채 던지는 순수 계산 오류는 기존대로: 재시도 기록 없이 건너뜀 + 로그', async () => {
  const env = setup(MON_10);
  await seed(env, A, slot({ participant: { ...slot().participant, travel_source: 'MANUAL', est_travel_minutes: 50 } }), MON_10);
  env.db.rpcHandlers.roll_insert_occurrence = () => {
    throw new Error('시험용 저장 실패');
  };
  const kakao = fakeKakao();
  const run = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.deepEqual([run.created.length, kakao.state.calls], [0, 0]);
  assert.deepEqual(attempts(env.db), []);
  assert.ok(env.warns.some((w) => w.includes('series_skipped') && w.includes('process')));
});

test('RATE_LIMIT · AUTH: 이번 실행의 길찾기를 멈추고(첫 실패 1번만 씀) 다음 날 0시 뒤 다시', async () => {
  for (const kind of ['RATE_LIMIT', 'AUTH'] as const) {
    const env = setup(MON_10);
    const series = await seed(env, A, slot(), MON_10);
    const kakao = fakeKakao();
    kakao.state.fail = kind;
    const res = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
    assert.deepEqual([res.created.length, res.kakao_calls, kakao.state.calls], [0, 1, 1], kind);
    assert.equal(res.pending.length, 3);
    assert.ok(res.pending.every((p) => p.reason === 'ROUTE_RETRY'));
    assert.deepEqual(attempts(env.db), [`2026-10-29 1 ${kind} 2026-10-27 00:00`, `2026-11-03 0 ${kind} 2026-10-27 00:00`, `2026-11-05 0 ${kind} 2026-10-27 00:00`]);

    kakao.state.fail = null;
    const same = await roll(env, 'batch', kst('2026-10-26T23:50'), { lookup: kakao.lookup });
    assert.deepEqual([same.created, same.kakao_calls], [[], 0]);
    const next = await roll(env, 'batch', kst('2026-10-27T00:05'), { lookup: kakao.lookup });
    assert.equal(next.created.length, 3, kind);
    assert.equal(datesOf(env.db, series).length, 4);
    assert.deepEqual(attempts(env.db), []);
  }
});

test('길찾기 키가 없으면(lookup 없음) AUTH와 같게: 호출 0, 다음 날 0시 뒤 다시', async () => {
  const env = setup(MON_10);
  await seed(env, A, slot(), MON_10);
  const res = await roll(env, 'own', MON_10);
  assert.deepEqual([res.created.length, res.kakao_calls, res.pending.length], [0, 0, 3]);
  assert.deepEqual(attempts(env.db), [`2026-10-29 0 AUTH 2026-10-27 00:00`, `2026-11-03 0 AUTH 2026-10-27 00:00`, `2026-11-05 0 AUTH 2026-10-27 00:00`]);
});

test('첫 알람 12시간 전까지 길찾기가 안 되면 폴백 순서: 같은 경로 내 실측 3건 이상 중앙값(CACHED) → 직선 근사(ESTIMATE). 12시간 밖인 회차는 계속 미룸', async () => {
  assert.equal(FALLBACK_BEFORE_FIRST_ALARM_HOURS, 12);
  const NOW = kst('2026-10-28T20:00'); // 목 10/29 9시 약속의 기상(7:10)까지 11시간 10분
  // ① 실측 3건 → CACHED (이동 분은 actual_travel_minutes가 있으면 그 값, 없으면 도착 − 출발)
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  addSample(env.db, A, 40);
  addSample(env.db, A, 60, { actual: 30 }); // 도착 − 출발은 60분이지만 실측 분 30
  addSample(env.db, A, 50);
  const kakao = fakeKakao();
  kakao.state.fail = 'TIMEOUT';
  const res = await roll(env, 'own', NOW, { lookup: kakao.lookup });
  const thu = participantOf(env.db, occurrence(env.db, series, '2026-10-29')!.appointment_id);
  assert.deepEqual([thu.travel_source, thu.est_travel_minutes], ['CACHED', 40]); // 중앙값(30, 40, 50) — 질문 · 확인 없이 바로 저장
  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-10-29']);
  assert.deepEqual(lines(env.db, occurrence(env.db, series, '2026-10-29')!.appointment_id), ['WAKE 07:20 on', 'PREPARE 07:50 on', 'DEPARTURE 08:10 on', 'ARRIVE 08:50 on']);
  assert.deepEqual(res.pending.map((p) => p.occurrence_on), ['2026-11-03', '2026-11-05', '2026-11-10']); // 12시간 밖 — 폴백 없이 재시도
  assert.deepEqual(attempts(env.db), ['2026-11-03 1 TIMEOUT 2026-10-28 21:00', '2026-11-05 1 TIMEOUT 2026-10-28 21:00', '2026-11-10 1 TIMEOUT 2026-10-28 21:00']);
  assert.equal(res.kakao_calls, 4);

  // ② 실측이 2건뿐이면 → 직선 근사(ESTIMATE)
  const env2 = setup(MON_10);
  const s2 = await seed(env2, A, slot(), MON_10);
  addSample(env2.db, A, 40);
  addSample(env2.db, A, 50);
  await roll(env2, 'own', NOW, { lookup: kakao.lookup });
  const estimated = participantOf(env2.db, occurrence(env2.db, s2, '2026-10-29')!.appointment_id);
  assert.equal(estimated.travel_source, 'ESTIMATE');
  assert.ok((estimated.est_travel_minutes as number) > 0);

  // ③ 길찾기를 멈춘 경우(RATE_LIMIT)에도 12시간 안이면 같은 폴백
  const env3 = setup(MON_10);
  const s3 = await seed(env3, A, slot(), MON_10);
  const limited = fakeKakao();
  limited.state.fail = 'RATE_LIMIT';
  const r3 = await roll(env3, 'batch', NOW, { lookup: limited.lookup });
  assert.equal(participantOf(env3.db, occurrence(env3.db, s3, '2026-10-29')!.appointment_id).travel_source, 'ESTIMATE');
  assert.deepEqual([r3.created.length, r3.kakao_calls, r3.pending.length], [1, 1, 3]);

  // ④ 좌표가 없어서 근사도 못 내면 폴백 없이 미룸 (출발이 지나면 그 날짜는 건너뜀)
  const env4 = setup(MON_10);
  const s4 = await seed(env4, A, slot(), MON_10);
  Object.assign(env4.db.rows('appointment_participants')[0], { origin_lat: null, origin_lng: null, origin_name: '어딘가' });
  Object.assign(env4.db.rows('profiles')[0], { home_lat: null, home_lng: null });
  const r4 = await roll(env4, 'own', NOW, { lookup: kakao.lookup });
  assert.deepEqual([r4.created.length, r4.kakao_calls, datesOf(env4.db, s4).length], [0, 0, 1]);
  assert.deepEqual(r4.pending.map((p) => p.reason), ['ROUTE_RETRY', 'ROUTE_RETRY', 'ROUTE_RETRY', 'ROUTE_RETRY']);
  assert.match(attempts(env4.db)[0], /NO_COORDS/);
});

test('폴백으로 만든 회차를 기준으로 다음 회차를 만들 때는 그 분(CACHED · ESTIMATE)을 안 이어받고 새로 구함', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  Object.assign(env.db.rows('appointment_participants')[0], { travel_source: 'ESTIMATE', est_travel_minutes: 12 });
  const kakao = fakeKakao(48);
  await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  const p = participantOf(env.db, occurrence(env.db, series, '2026-10-29')!.appointment_id);
  assert.deepEqual([p.travel_source, p.est_travel_minutes], ['API', 48]);
});

// ===========================================================================
// 하루 몫 · 알람 상한 · 실행 한도
// ===========================================================================

test('하루 몫: 오늘 roll이 만든 회차 + 길찾기를 쓰고도 못 만든 날짜가 한도에 닿으면 DAILY_BUDGET으로 미루고 다음 날 0시 뒤 다시', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot({ appointment: { ...slot().appointment, recurrence_rule: 'FREQ=DAILY' } }), MON_10);
  const kakao = fakeKakao();
  kakao.state.script = [35, 35];
  const first = await roll(env, 'batch', MON_10, { lookup: kakao.lookup, limits: { dailyLookups: 2, lookups: 50 } });
  assert.deepEqual([first.created.length, first.kakao_calls], [2, 2]);
  assert.ok(first.pending.length > 0 && first.pending.every((p) => p.reason === 'DAILY_BUDGET'));
  assert.equal(first.pending.length, 11); // 매일 반복: 첫 회차 + 2 + 11 = 14
  assert.ok(attempts(env.db).every((a) => a.includes('DAILY_BUDGET 2026-10-27 00:00') && a.includes(' 0 DAILY_BUDGET'))); // 길찾기를 안 썼으니 tries 그대로
  assert.equal(datesOf(env.db, series).length, 3);

  // 같은 날 더 불러도 늘지 않음 (남은 날짜는 대기 중이라 배치는 묶음을 안 받음)
  const same = await roll(env, 'own', kst('2026-10-26T12:00'), { lookup: kakao.lookup, limits: { dailyLookups: 2 } });
  assert.deepEqual([same.created, same.kakao_calls], [[], 0]);
  // 다음 날 0시 뒤: 몫이 새로 시작
  const next = await roll(env, 'batch', kst('2026-10-27T00:05'), { lookup: kakao.lookup, limits: { dailyLookups: 5, lookups: 50 } });
  assert.deepEqual([next.created.length, next.kakao_calls], [5, 5]);
});

test('하루 몫 셈: 실패해서 못 만든 날짜도 센다 (오늘 만든 2 + 오늘 실패 1 = 3)', async () => {
  const env = setup(MON_10);
  await seed(env, A, slot({ appointment: { ...slot().appointment, recurrence_rule: 'FREQ=DAILY' } }), MON_10);
  const kakao = fakeKakao();
  kakao.state.script = ['TIMEOUT', 35, 35];
  const first = await roll(env, 'own', MON_10, { lookup: kakao.lookup, limits: { lookups: 3, dailyLookups: 3 } });
  assert.deepEqual([first.created.length, first.kakao_calls, attempts(env.db).length], [2, 3, 1]);
  // 1시간 뒤(같은 날) 재시도: 오늘 쓴 길찾기 3번(만든 2 + 실패 1) = 한도 → 길찾기 없이 DAILY_BUDGET
  const retry = await roll(env, 'own', kst('2026-10-26T11:01'), { lookup: kakao.lookup, limits: { lookups: 3, dailyLookups: 3 } });
  assert.equal(retry.kakao_calls, 0);
  assert.equal(retry.created.length, 0);
  assert.ok(retry.pending.every((p) => p.reason === 'DAILY_BUDGET'));
});

test('실행당 길찾기 한도: 본인 길 4회차, 넘는 회차는 RUN_LIMIT로 남겨 다음 실행(배치)이 만듦', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot({ appointment: { ...slot().appointment, recurrence_rule: 'FREQ=DAILY' } }), MON_10);
  const kakao = fakeKakao();
  const res = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.deepEqual([res.created.length, res.kakao_calls], [4, 4]);
  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']); // 가까운 회차부터
  assert.equal(res.pending.length, 9);
  assert.ok(res.pending.every((p) => p.reason === 'RUN_LIMIT'));
  assert.deepEqual(attempts(env.db), []); // 기록 없이 다음 실행으로
  const batch = await roll(env, 'batch', MON_10, { lookup: kakao.lookup });
  assert.equal(batch.kakao_calls, 9 > 20 ? 20 : 9);
  assert.equal(datesOf(env.db, series).length, 14);
});

test('요청의 series_id인 묶음 먼저: 한도가 모자라면 요청한 묶음의 가까운 회차부터', async () => {
  const env = setup(MON_10);
  const near = await seed(env, A, slot({ appointment: { ...slot().appointment, title: '매일', recurrence_rule: 'FREQ=DAILY' } }), MON_10);
  const wanted = await seed(env, A, slot({ appointment: { ...slot().appointment, title: '화목', appointment_at: iso('2026-10-27T13:00') } }), MON_10);
  const res = await roll(env, 'own', MON_10, { lookup: fakeKakao().lookup, seriesId: wanted });
  assert.equal(res.kakao_calls, 4);
  assert.deepEqual(res.created.map((c) => [c.series_id === wanted ? '화목' : '매일', c.occurrence_on]), [['화목', '2026-10-29'], ['화목', '2026-11-03'], ['화목', '2026-11-05'], ['매일', '2026-10-28']]);
  assert.ok(near);
});

test('앞으로 켜진 알람이 상한(400)이면 더 안 만듦: ALARM_CAP, 길찾기도 안 씀', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  for (let i = 0; i < 400; i++) {
    env.db.rows('alarms').push({ alarm_id: `bulk-${i}`, user_id: A, participant_id: 'pt-bulk', alarm_type: 'WAKE', scheduled_at: kst('2026-12-01T07:00').toISOString(), is_enabled: true });
  }
  const kakao = fakeKakao();
  const res = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.deepEqual([res.created.length, res.kakao_calls, datesOf(env.db, series).length], [0, 0, 1]);
  assert.deepEqual(res.pending.map((p) => p.reason), ['ALARM_CAP', 'ALARM_CAP', 'ALARM_CAP']);
  assert.deepEqual(attempts(env.db), []);
  // 꺼진 알람이나 지난 알람은 안 셈
  env.db.rows('alarms').length = env.db.rows('alarms').length - 400;
  for (let i = 0; i < 400; i++) env.db.rows('alarms').push({ alarm_id: `off-${i}`, user_id: A, alarm_type: 'WAKE', scheduled_at: kst('2026-12-01T07:00').toISOString(), is_enabled: false });
  const ok = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.equal(ok.created.length, 3);
});

test('상한은 만든 만큼 늘려 가며 적용: 상한 6 · 지금 4개 → 첫 회차(+4)까지 만들고 나머지는 ALARM_CAP', async () => {
  const env = setup(MON_10);
  await seed(env, A, slot(), MON_10);
  const kakao = fakeKakao();
  const res = await roll(env, 'own', MON_10, { lookup: kakao.lookup, limits: { alarmCap: 6 } });
  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-10-29']);
  assert.deepEqual(res.pending.map((p) => [p.occurrence_on, p.reason]), [['2026-11-03', 'ALARM_CAP'], ['2026-11-05', 'ALARM_CAP']]);
  assert.equal(res.kakao_calls, 1);
});

test('배치: 일이 있는 묶음 50개까지만, 40초가 지나면 남은 회차는 다음 실행으로', async () => {
  const env = setup(MON_10, Array.from({ length: 55 }, (_, i) => `u-${i}`));
  for (let i = 0; i < 55; i++) rawSeries(env.db, `u-${i}`, { ats: ['2026-11-02T09:00:00+09:00'], rule: 'FREQ=WEEKLY;BYDAY=MO' }); // 마지막 회차 11/2 → 11/9 9시가 새 회차 하나
  const kakao = fakeKakao();
  const first = await roll(env, 'batch', MON_10, { lookup: kakao.lookup, limits: { lookups: 1000 } });
  assert.equal(first.created.length, 50);
  const second = await roll(env, 'batch', MON_10, { lookup: kakao.lookup, limits: { lookups: 1000 } });
  assert.equal(second.created.length, 5);

  // 시간 제한: 첫 회차 뒤에 40초가 지난 것으로
  const env2 = setup(MON_10, ['u-a', 'u-b', 'u-c']);
  for (const u of ['u-a', 'u-b', 'u-c']) rawSeries(env2.db, u, { ats: ['2026-11-02T09:00:00+09:00'], rule: 'FREQ=WEEKLY;BYDAY=MO' });
  let t = 0;
  const slow = fakeKakao();
  const res = await roll(env2, 'batch', MON_10, { lookup: async (a) => ((t += 41_000), slow.lookup(a)), limits: { lookups: 100 } , });
  assert.ok(res.created.length >= 1);
  assert.equal(res.created.length + res.pending.length, 3);
  assert.ok(res.pending.every((p) => p.reason === 'RUN_LIMIT'));
  void t;
});

// ===========================================================================
// 한 묶음이 나머지를 멈추지 않음 · 못 읽는 규칙은 정상 건너뜀 · 할 일 없는 묶음은 싸게
// ===========================================================================

test('잘못된 값(읽을 수 없는 시각)을 가진 묶음은 건너뛰고 로그 한 줄(이유 글자만), 나머지 묶음은 계속', async () => {
  const env = setup(MON_10, [A, B]);
  const bad = rawSeries(env.db, B, { ats: ['2026-11-08T09:00:00+09:00'], rule: 'FREQ=DAILY', title: '비밀 일정' });
  env.db.rows('appointments').find((a) => a.appointment_id === bad)!.appointment_at = 'not-a-date';
  const good = await seed(env, A, slot(), MON_10);
  const original = env.db.rpcHandlers.roll_due_series;
  env.db.rpcHandlers.roll_due_series = (args) => [{ user_id: B, series_id: bad, kind: 'APPOINTMENT', template_id: bad }, ...(original(args) as object[])];
  const res = await roll(env, 'batch', MON_10, { lookup: fakeKakao().lookup });
  assert.equal(res.created.length, 3);
  assert.deepEqual(datesOf(env.db, good).length, 4);
  assert.deepEqual(env.warns.map((w) => JSON.parse(w)), [{ fn: 'alarm-roll', event: 'series_skipped', where: 'collect', reason: 'INVALID_VALUE' }]);
  assert.ok(!env.warns[0].includes('비밀') && !env.warns[0].includes(B) && !env.warns[0].includes(bad));
});

test('잘못된 루틴 단계 값도 그 루틴만 건너뜀', async () => {
  const env = setup(kst('2026-10-26T22:00'));
  env.db.rows('routines').push(
    { routine_id: 'r-bad', user_id: A, title: '이상한 루틴', repeat_days: 'MON~FRI', is_active: true, steps: [{ order: 1, title: 'x', offset: 1e308, minutes: 5, is_alarm: true }] },
    { routine_id: 'r-ok', user_id: A, title: '저녁 루틴', repeat_days: 'MON~FRI', is_active: true, steps: [{ order: 1, title: 'y', offset: 21 * 60 + 30, minutes: 15, is_alarm: true }] },
  );
  env.db.rows('alarms').push(
    { alarm_id: 'al-bad', user_id: A, routine_id: 'r-bad', step_order: 1, alarm_type: 'ROUTINE', scheduled_at: kst('2026-10-26T21:30').toISOString(), intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: true },
    { alarm_id: 'al-ok', user_id: A, routine_id: 'r-ok', step_order: 1, alarm_type: 'ROUTINE', scheduled_at: kst('2026-10-26T21:30').toISOString(), intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: true },
  );
  for (const path of ['own', 'batch'] as const) {
    env.warns.length = 0;
    env.db.rows('alarms').find((a) => a.alarm_id === 'al-ok')!.scheduled_at = kst('2026-10-26T21:30').toISOString();
    const res = await roll(env, path, kst('2026-10-26T22:00'), {});
    assert.deepEqual(res.moved_alarm_ids, ['al-ok'], path);
    assert.deepEqual(env.warns.map((w) => JSON.parse(w).reason), ['INVALID_VALUE'], path);
  }
});

test('두 모양(FREQ=DAILY · FREQ=WEEKLY;BYDAY=…) 밖의 규칙(옛 MONTHLY · INTERVAL)은 오류가 아니라 정상 건너뜀: 경고 · 대기 · 길찾기 없음', async () => {
  const env = setup(MON_10);
  const kakao = fakeKakao();
  for (const rule of ['FREQ=MONTHLY;BYMONTHDAY=3', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', 'FREQ=YEARLY', 'garbage']) {
    rawSeries(env.db, A, { ats: ['2026-10-29T09:00:00+09:00'], rule });
    env.db.rows('alarms').push({ alarm_id: `s-${rule}`, user_id: A, participant_id: null, routine_id: null, series_id: `s-${rule}`, occurrence_on: '2026-10-28', alarm_type: 'WAKE', scheduled_at: iso('2026-10-28T07:30'), is_enabled: true, recurrence_rule: rule });
  }
  for (const path of ['own', 'batch'] as const) {
    const res = await roll(env, path, MON_10, { lookup: kakao.lookup });
    assert.deepEqual([res.created, res.pending, res.kakao_calls], [[], [], 0], path);
  }
  assert.deepEqual(env.warns, []);
  assert.equal(env.db.rows('appointments').length, 4);
});

test('할 일 없는 묶음(마지막 회차가 +14일 안인 주간 묶음)이 앞줄을 채워도 일이 있는 묶음이 안 굶고, 빈 묶음은 기준 회차 한 줄만 읽고 넘김', async () => {
  const NOW = kst('2026-10-26T08:00'); // 창 끝 11/9 8시
  const users = Array.from({ length: 60 }, (_, i) => `e-${i}`);
  const env = setup(NOW, [...users, A]);
  // 빈 묶음 60개: 주간 월요일 — 10/26 · 11/2 9시가 있고 다음 11/9 9시는 창 밖이라 만들 게 없음. roll_due_series는 마지막 회차가 +14일 안이라 이들을 줌 (due_at이 더 이르니 앞줄)
  for (const u of users) rawSeries(env.db, u, { ats: ['2026-10-26T09:00:00+09:00', '2026-11-02T09:00:00+09:00'], rule: 'FREQ=WEEKLY;BYDAY=MO' });
  // 일이 있는 묶음 (뒷줄): 매일 7시, 10/27 ~ 11/8이 있고 11/9 7시가 새 회차
  const days = Array.from({ length: 13 }, (_, i) => new Date(kst('2026-10-27T07:00').getTime() + i * 86_400_000).toISOString());
  rawSeries(env.db, A, { ats: days, rule: 'FREQ=DAILY' });
  const due = (env.db.rpcHandlers.roll_due_series({ p_now: NOW.toISOString(), p_limit: 50 }) as { user_id: string }[]).map((r) => r.user_id);
  assert.ok(!due.includes(A)); // 한도 50만 읽으면 이 묶음은 굶었을 것
  assert.equal(due.length, 50);

  const calls0 = env.db.calls.length;
  const kakao = fakeKakao();
  const res = await roll(env, 'batch', NOW, { lookup: kakao.lookup });
  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-11-09']);
  assert.equal(res.kakao_calls, 1);
  const used = env.db.calls.slice(calls0);
  assert.equal(used.filter((c) => c === 'insert appointments').length, 0);
  assert.equal(used.filter((c) => c === 'select appointment_participants').length <= 3, true); // 빈 묶음은 참여 조건 · 알람 · 준비물을 읽지 않음
  assert.equal(used.filter((c) => c === 'select todos').length, 1);
  assert.equal(used.filter((c) => c === 'select roll_attempts').length, 2); // 재시도 기록 읽기 + 하루 몫 셈 — 둘 다 만들 회차가 남은 사람(A)만
  assert.equal(used.filter((c) => c === 'select profiles').length, 61); // 사람마다 한 번
  assert.equal(used.filter((c) => c === 'select appointments').length <= 2 * 61 + 1, true); // 빈 묶음 = 사람별 기준 회차 읽기 + 이미 있는 날짜 읽기 한 번씩 (묶음마다가 아님) // 빈 묶음 = 사람별 기준 회차 읽기 한 번씩
  assert.deepEqual(env.warns, []);
});

// ===========================================================================
// 날짜 · 창 · 예외
// ===========================================================================

test('서버가 며칠 못 돌았어도 지난 날은 안 메움 · 창 끝(지금 + 14일)은 포함 안 함', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  const later = kst('2026-11-02T10:00');
  const res = await roll(env, 'batch', later, { lookup: fakeKakao().lookup });
  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12']); // 10/29 목은 이미 지난 날
  assert.deepEqual(datesOf(env.db, series).slice(0, 2), ['2026-10-27', '2026-11-03']);
  const edge = setup(kst('2026-11-03T09:00'));
  const s2 = await seed(edge, A, slot(), MON_10);
  await roll(edge, 'batch', kst('2026-11-03T09:00'), { lookup: fakeKakao().lookup });
  assert.ok(!datesOf(edge.db, s2).includes('2026-11-17')); // 11/17 9시 = 정확히 지금 + 14일
  assert.ok(datesOf(edge.db, s2).includes('2026-11-12'));
});

test('기준 회차의 날짜 칸(occurrence_on)과 약속 시각의 날짜가 어긋나도(시각을 옮긴 행) 같은 날짜를 두 번 만들지 않음', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  // 11/5 목 회차를 만들어 둔 뒤 그 행의 시각만 11/4 수 23:00으로 옮김 — occurrence_on은 11/5 그대로
  const kakao = fakeKakao();
  await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  Object.assign(occurrence(env.db, series, '2026-11-05')!, { appointment_at: iso('2026-11-04T23:00') });
  const calls = kakao.state.calls;
  const res = await roll(env, 'own', kst('2026-11-02T10:00'), { lookup: kakao.lookup });
  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-11-10', '2026-11-12']); // 11/5는 이미 있으니 건너뜀 (약속 시각의 날짜인 11/4부터 이어 세지 않음)
  assert.equal(kakao.state.calls - calls, 2);
  const dates = datesOf(env.db, series);
  assert.equal(new Set(dates).size, dates.length);
});

test('새벽 1시 약속: 회차 날짜는 내 시간대(한국) 날짜, 기상은 전날 밤', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot({ appointment: { ...slot().appointment, appointment_at: iso('2026-10-28T01:00'), recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE' } }), MON_10);
  const res = await roll(env, 'own', MON_10, { lookup: fakeKakao().lookup });
  assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-11-04']);
  const row = occurrence(env.db, series, '2026-11-04')!;
  assert.equal(row.appointment_at, '2026-11-03T16:00:00.000Z'); // UTC로는 11/3
  assert.deepEqual(lines(env.db, row.appointment_id), ['WAKE 23:10 on', 'PREPARE 23:40 on', 'DEPARTURE 00:00 on', 'ARRIVE 00:50 on']);
  assert.equal(ymd(alarmsOf(env.db, row.appointment_id)[0].scheduled_at), '2026-11-03');
});

test('기상 · 준비 시각이 이미 지났으면 그 알람만 끄고 만듦, 출발까지 지났으면 그 날짜는 건너뛰고 기록(다시 안 만듦)', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  const kakao = fakeKakao();
  const res = await roll(env, 'own', kst('2026-10-29T07:20'), { lookup: kakao.lookup }); // 목 7:20 — 기상(7:10)은 지났고 준비(7:40)는 아직
  const thu = occurrence(env.db, series, '2026-10-29')!;
  assert.deepEqual(lines(env.db, thu.appointment_id), ['WAKE 07:10 off', 'PREPARE 07:40 on', 'DEPARTURE 08:00 on', 'ARRIVE 08:50 on']);
  assert.ok(!res.ring_packages.some((p) => p.type === 'WAKE' && p.atMillis === kst('2026-10-29T07:10').getTime())); // 꺼진 알람은 폰에 안 걸림

  const env2 = setup(MON_10);
  const s2 = await seed(env2, A, slot(), MON_10);
  const late = await roll(env2, 'own', kst('2026-10-29T08:30'), { lookup: kakao.lookup }); // 출발(8:00)이 지남
  assert.deepEqual(late.created.map((c) => c.occurrence_on), ['2026-11-03', '2026-11-05', '2026-11-10']);
  assert.equal(occurrence(env2.db, s2, '2026-10-29'), undefined);
  assert.deepEqual(attempts(env2.db), ['2026-10-29 1 DEPARTURE_PASSED skipped']);
  const calls = kakao.state.calls;
  const again = await roll(env2, 'batch', kst('2026-10-29T08:35'), { lookup: kakao.lookup });
  assert.deepEqual([again.created, again.kakao_calls], [[], 0]); // 건너뛴 날짜는 다시 안 봄
  assert.equal(kakao.state.calls, calls);
});

test('직접 고른 기상 시각이 새 회차 이동시간에서 출발보다 늦어지면 직접 시각을 버리고 자동 시각으로 (순서 어긋남)', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot({ manual_times: { WAKE: iso('2026-10-27T07:30') } }), MON_10);
  assert.equal(alarmsOf(env.db, env.db.rows('appointments')[0].appointment_id)[0].time_source, 'MANUAL');
  const kakao = fakeKakao();
  kakao.state.script = [120]; // 이동 120분 → 출발 6:50이 직접 기상 7:30보다 앞
  await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  const thu = occurrence(env.db, series, '2026-10-29')!;
  assert.deepEqual(lines(env.db, thu.appointment_id), ['WAKE 06:00 on', 'PREPARE 06:30 on', 'DEPARTURE 06:50 on', 'ARRIVE 08:50 on']);
  assert.equal(alarmsOf(env.db, thu.appointment_id)[0].time_source, 'AUTO');
  const normal = occurrence(env.db, series, '2026-11-03')!;
  assert.deepEqual(lines(env.db, normal.appointment_id)[0], 'WAKE 07:30 on'); // 이동이 보통이면 직접 시각 그대로
});

test('공동 약속(group_id 있음)은 반복이어도 회차를 안 만듦 — 본인 길 · 배치 모두', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  env.db.rows('appointments')[0].group_id = 'g1';
  for (const path of ['own', 'batch'] as const) {
    const res = await roll(env, path, MON_10, { lookup: fakeKakao().lookup });
    assert.deepEqual([res.created, res.pending, res.kakao_calls], [[], [], 0], path);
  }
  assert.deepEqual(datesOf(env.db, series), ['2026-10-27']);
});

// ===========================================================================
// 일정 없는 반복 알람 · 루틴
// ===========================================================================

async function seedStandalone(env: Env, user: string, over: { at: string; rule: string; enabled?: boolean }, now: Date) {
  const db = env.db as unknown as Db;
  const saved = await commitStandalone({ userId: user, userDb: db, service: db, now }, { alarm: { scheduledAt: new Date(over.at), recurrenceRule: over.rule, isEnabled: over.enabled }, edits: [], timeZone: 'Asia/Seoul' });
  return env.db.rows('alarms').find((a) => a.alarm_id === saved.alarm_id)!.series_id as string;
}

test('일정 없는 반복 알람: 회차마다 alarms 새 행(같은 묶음 · 날짜 칸), 길찾기 없음, 두 번 불러도 한 번만 · 꺼 둔 알람은 꺼진 채 이어받음', async () => {
  const env = setup(MON_10);
  const series = await seedStandalone(env, A, { at: '2026-10-27T07:30:00+09:00', rule: 'FREQ=DAILY' }, MON_10);
  const kakao = fakeKakao();
  const res = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.equal(res.created.length, 13); // 10/28 ~ 11/9 (7:30, 11/9 10:00 앞)
  assert.deepEqual([res.created[0].occurrence_on, res.created[12].occurrence_on, res.created[0].appointment_id], ['2026-10-28', '2026-11-09', null]);
  assert.equal(res.kakao_calls, 0);
  const rows = env.db.rows('alarms').filter((a) => a.series_id === series);
  assert.equal(rows.length, 14);
  assert.ok(rows.every((a) => a.participant_id == null && a.routine_id == null && a.alarm_type === 'WAKE' && a.user_id === A && a.recurrence_rule === 'FREQ=DAILY'));
  assert.deepEqual([...new Set(rows.map((a) => a.occurrence_on))].length, 14);
  assert.ok(rows.every((a) => hm(a.scheduled_at) === '07:30' && ymd(a.scheduled_at) === a.occurrence_on));
  assert.equal(res.ring_packages.length, 13);
  assert.deepEqual([res.ring_packages[0].title, res.ring_packages[0].subtitle, res.ring_packages[0].type], ['알람', '오전 7:30', 'WAKE']);
  const again = await roll(env, 'batch', MON_10, { lookup: kakao.lookup });
  assert.deepEqual([again.created, again.pending], [[], []]);
  assert.equal(env.db.rows('alarms').filter((a) => a.series_id === series).length, 14);

  // 꺼 둔 반복 알람도 회차를 유지 — 새 회차가 꺼진 상태를 이어받음 (L6 안건후보: 꺼 둔 반복 알람도 회차 유지 기본안)
  const off = setup(MON_10);
  const s2 = await seedStandalone(off, A, { at: '2026-10-27T07:30:00+09:00', rule: 'FREQ=WEEKLY;BYDAY=TU', enabled: false }, MON_10);
  const r2 = await roll(off, 'batch', MON_10, { lookup: kakao.lookup });
  assert.deepEqual(r2.created.map((c) => c.occurrence_on), ['2026-11-03']);
  assert.equal(off.db.rows('alarms').find((a) => a.series_id === s2 && a.occurrence_on === '2026-11-03')!.is_enabled, false);
});

test('루틴: 같은 행의 시각만 다음 발생으로 옮김 (새 행 없음) — 지난 단계 알람만, 켜진 것만, 먼저 옮긴 쪽만', async () => {
  const NOW = kst('2026-10-30T22:00'); // 금 밤 — 'MON~FRI'의 다음은 월
  const env = setup(NOW);
  env.db.rows('routines').push({
    routine_id: 'r1', user_id: A, title: '저녁 루틴', repeat_days: 'MON~FRI', is_active: true,
    steps: [{ order: 1, title: '정리', offset: 21 * 60 + 30, minutes: 15, is_alarm: true }, { order: 2, title: '샤워', offset: 21 * 60 + 45, minutes: 20, is_alarm: true }, { order: 3, title: '독서', offset: 22 * 60 + 5, minutes: 30, is_alarm: false }],
  });
  const row = (id: string, step: number, at: string, enabled = true) => ({ alarm_id: id, user_id: A, routine_id: 'r1', step_order: step, participant_id: null, alarm_type: 'ROUTINE', scheduled_at: kst(at).toISOString(), intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: enabled });
  env.db.rows('alarms').push(row('al1', 1, '2026-10-30T21:30'), row('al2', 2, '2026-10-30T21:45'), row('al3', 3, '2026-10-30T22:30', true), row('al4', 2, '2026-10-30T21:45', false));
  env.db.rows('routines').push({ routine_id: 'r2', user_id: A, title: '꺼 둔 루틴', repeat_days: 'MON~FRI', is_active: false, steps: [{ order: 1, title: 'x', offset: 60, minutes: 5, is_alarm: true }] });
  env.db.rows('alarms').push({ ...row('al5', 1, '2026-10-30T01:00'), routine_id: 'r2' });

  const [own, batch] = await Promise.all([roll(env, 'own', NOW), roll(env, 'batch', NOW)]); // 동시에 와도 먼저 옮긴 쪽만
  assert.deepEqual([...own.moved_alarm_ids, ...batch.moved_alarm_ids].sort(), ['al1', 'al2']);
  const at = (id: string) => env.db.rows('alarms').find((a) => a.alarm_id === id)!.scheduled_at as string;
  assert.deepEqual([ymd(at('al1')), hm(at('al1')), ymd(at('al2')), hm(at('al2'))], ['2026-11-02', '21:30', '2026-11-02', '21:45']); // 월요일, 같은 단계 시각
  assert.equal(at('al3'), kst('2026-10-30T22:30').toISOString()); // 아직 안 지난 알람은 그대로
  assert.equal(at('al4'), kst('2026-10-30T21:45').toISOString()); // 꺼진 알람은 그대로
  assert.equal(at('al5'), kst('2026-10-30T01:00').toISOString()); // 꺼 둔 루틴
  assert.equal(env.db.rows('alarms').length, 5); // 새 행 없음
  const packages = own.ring_packages.length ? own : batch;
  assert.equal(own.ring_packages.length + batch.ring_packages.length, own.moved_alarm_ids.length); // 본인 길만 꾸러미
  assert.ok(packages === own || packages.ring_packages.length === 0);
  const again = await roll(env, 'own', NOW);
  assert.deepEqual(again.moved_alarm_ids, []);
});

test('루틴 본인 길 꾸러미: 제목은 루틴 이름, 부제 없음', async () => {
  const NOW = kst('2026-10-27T22:00');
  const env = setup(NOW);
  env.db.rows('routines').push({ routine_id: 'r1', user_id: A, title: '저녁 루틴', repeat_days: 'MON,WED', is_active: true, steps: [{ order: 1, title: '정리', offset: 21 * 60 + 30, minutes: 15, is_alarm: true }] });
  env.db.rows('alarms').push({ alarm_id: 'al1', user_id: A, routine_id: 'r1', step_order: 1, participant_id: null, alarm_type: 'ROUTINE', scheduled_at: kst('2026-10-27T21:30').toISOString(), intensity: 'NORMAL', sound_key: null, snooze_limit: 3, is_enabled: true });
  const res = await roll(env, 'own', NOW);
  assert.deepEqual(res.moved_alarm_ids, ['al1']);
  assert.deepEqual(res.ring_packages.map((p) => [p.alarmId, p.type, p.title, p.subtitle, p.atMillis]), [['al1', 'ROUTINE', '저녁 루틴', undefined, kst('2026-10-28T21:30').getTime()]]); // 화 밤 → 수
});

// ===========================================================================
// 순수 계산
// ===========================================================================

test('routineStepStarts: 앱 parseSteps와 같은 읽기 — order 순, 첫 offset이 시작, minutes → 다음 offset 간격 → 5분을 쌓아 감, 못 읽으면 null', () => {
  assert.deepEqual(routineStepStarts([{ order: 1, offset: 1290, minutes: 15 }, { order: 2, offset: 1305, minutes: 20 }, { order: 3, offset: 1325, minutes: 30 }]), [1290, 1305, 1325]);
  assert.deepEqual(routineStepStarts([{ order: 2, offset: 1305, minutes: 20 }, { order: 1, offset: 1290, minutes: 15 }]), [1290, 1305]); // order 순
  assert.deepEqual(routineStepStarts([{ offset: 600 }, { offset: 640 }, { title: 'x' }]), [600, 640, 645]); // minutes 없음 → 간격 40, 다음 단계 없음 → 5분 기본
  assert.deepEqual(routineStepStarts([{ order: 1, title: 'x', minutes: 10 }, { order: 2, minutes: 0 }]), [21 * 60 + 30, 21 * 60 + 40]); // offset 없음 → 21:30
  assert.deepEqual(routineStepStarts([{ order: 1, offset: 23 * 60, minutes: 90 }, { order: 2 }]), [1380, 1470]); // 자정을 넘으면 1440 이상
  assert.deepEqual(routineStepStarts([null, 3, { offset: 100, minutes: 5 }]), [100]);
  for (const bad of [null, undefined, 'x', {}, [], [1, 'a']]) assert.equal(routineStepStarts(bad), null);
});

test('retryAt: 실패 횟수 0 · 1 · 2 → 1 · 3 · 6시간, 그 뒤로도 6시간', () => {
  const now = new Date('2026-10-26T01:00:00Z');
  assert.deepEqual([0, 1, 2, 3, 9].map((n) => (retryAt(now, n).getTime() - now.getTime()) / 3_600_000), [1, 3, 6, 6, 6]);
});

// planOccurrence — 계산만 (DB 없이)
const profile: ProfileRow = { timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng };
const ctxAt = (now: Date): RollPlanCtx => ({ userId: A, now, profile, timeZone: 'Asia/Seoul', stats: { sampleCount: 0, p80: null }, lateCount4w: 0 });
const baseAppointment: SeriesAppointmentRow = {
  appointment_id: 'ap0', creator_id: A, group_id: null, title: '세미나', appointment_at: kst('2026-10-27T09:00').toISOString(), dest_name: '세종대학교', dest_lat: SCHOOL.lat, dest_lng: SCHOOL.lng,
  importance: 'NORMAL', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU,TH', series_id: 'ap0', occurrence_on: '2026-10-27', memo: null, dest_radius_m: null,
};
const baseParticipant: ParticipantRow = {
  participant_id: 'pt0', appointment_id: 'ap0', user_id: A, origin_name: '집', origin_lat: HOME.lat, origin_lng: HOME.lng, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', prepare_minutes: 50, buffer_minutes: 10,
};
const baseAlarm = (type: AlarmRow['alarm_type'], at: string, over: Partial<AlarmRow> = {}): AlarmRow => ({
  alarm_id: `a-${type}`, participant_id: 'pt0', user_id: A, alarm_type: type, scheduled_at: kst(at).toISOString(), intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: null, is_enabled: true, snooze_limit: 3,
  time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null, ...over,
});
const fullAlarms = () => [baseAlarm('WAKE', '2026-10-27T07:10'), baseAlarm('PREPARE', '2026-10-27T07:40'), baseAlarm('DEPARTURE', '2026-10-27T08:00'), baseAlarm('ARRIVE', '2026-10-27T08:50')];
const baseOf = (alarms: AlarmRow[]): RollBase => ({ appointment: baseAppointment, participant: baseParticipant, alarms, items: ['노트북'] });
const API_50 = { minutes: 50, source: 'API' as const, needsConfirmation: false, note: '' };
const THU = { date: '2026-10-29', at: kst('2026-10-29T09:00') };

test('planOccurrence: 이동시간만 주면 자동 시각 · 켜진 알람 4개 · 준비물 제목, 참여 칸은 기준 회차에서', () => {
  const planned = planOccurrence(ctxAt(MON_10), baseOf(fullAlarms()), THU, { travel: API_50, sameDayWake: false });
  assert.ok(planned.ok);
  if (!planned.ok) return;
  assert.deepEqual(planned.alarms.map((a) => [a.alarm_type, hm(a.scheduled_at), a.is_enabled, a.time_source]), [['WAKE', '07:10', true, 'AUTO'], ['PREPARE', '07:40', true, 'AUTO'], ['DEPARTURE', '08:00', true, 'AUTO'], ['ARRIVE', '08:50', true, 'AUTO']]);
  assert.deepEqual(planned.payload.items, [{ title: '노트북', due_date: '2026-10-29' }]);
  assert.deepEqual(planned.payload.appointment.creator_id, A);
  assert.equal(planned.payload.appointment.occurrence_on, '2026-10-29');
  assert.equal(planned.payload.appointment.series_id, 'ap0');
  assert.equal(firstAlarmAt(planned.plan).getTime(), kst('2026-10-29T07:10').getTime());
});

test('shiftManualTimes: 같은 시:분으로, 약속 날짜와 알람 날짜가 다른 알람(전날 밤 기상)은 그 날 수 차이를 그대로', () => {
  const base = kst('2026-10-28T01:00'); // 새벽 1시 약속 (수)
  const alarms = [baseAlarm('WAKE', '2026-10-27T23:30', { time_source: 'MANUAL' }), baseAlarm('PREPARE', '2026-10-27T23:50'), baseAlarm('DEPARTURE', '2026-10-28T00:10', { time_source: 'MANUAL' })];
  const shifted = shiftManualTimes(alarms, base, '2026-11-04', 'Asia/Seoul');
  assert.deepEqual(Object.fromEntries(Object.entries(shifted).map(([k, v]) => [k, `${ymd(v)} ${hm(v)}`])), { WAKE: '2026-11-03 23:30', DEPARTURE: '2026-11-04 00:10' });
});

test('inheritedKinds: 기준 회차에 기상이 없어도 그날 다른 기상에 밀려서였을 때만 새 회차가 첫 일정이면 기상을 더함', () => {
  const noWake = [baseAlarm('PREPARE', '2026-10-27T07:40'), baseAlarm('DEPARTURE', '2026-10-27T08:00')];
  const kinds = (alarms: AlarmRow[], withWake: boolean, baseHadEarlierWake: boolean): RingKind[] => inheritedKinds(alarms, { withWake, baseHadEarlierWake });
  assert.deepEqual(kinds(noWake, true, true), ['WAKE', 'PREPARE', 'DEPARTURE']);
  assert.deepEqual(kinds(noWake, true, false), ['PREPARE', 'DEPARTURE']); // 사용자가 안 고름
  assert.deepEqual(kinds(noWake, false, true), ['PREPARE', 'DEPARTURE']); // 새 회차도 첫 일정이 아님
  assert.deepEqual(kinds([], true, true), []); // 알람 없는 일정
  assert.deepEqual(kinds([baseAlarm('WAKE', '2026-10-27T07:10')], true, false), ['WAKE']);
  assert.deepEqual([...RING_KINDS], ['WAKE', 'PREPARE', 'DEPARTURE']);
});

test('카카오 partial(앞뒤 도보 구간 빠짐)은 API가 아니라 ESTIMATE로 저장 — 분은 그대로, 재시도 기록 없음', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot({ appointment: { title: '세미나', appointment_at: iso('2026-10-27T09:00'), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU' } }), MON_10);
  const kakao = fakeKakao(40);
  kakao.state.partial = true;
  const result = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.ok(result.created.length >= 1);
  const second = occurrence(env.db, series, '2026-11-03')!;
  const participant = participantOf(env.db, second.appointment_id);
  assert.equal(participant.travel_source, 'ESTIMATE');
  assert.equal(participant.est_travel_minutes, 40);
  assert.equal(env.db.rows('roll_attempts').length, 0);
});

// ---- 학습 루프 기초 a (이슈 #266): 반복 다음 회차는 직전 회차 준비값 ±10분 안에서만 (D62 처음 2주 몫) ----

// 회차를 이어서 계산 — 매 회차 직전 회차의 준비값을 기준으로 삼고(planOccurrence의 기준 참여 조건), 그날까지 쌓인 기록으로 통계를 다시 냄
function simulate(days: number, options: { onboarding: number; recordsBefore?: number[]; actual: number }) {
  const records: number[] = [...(options.recordsBefore ?? [])]; // 쌓인 순서 — 아래에서 뒤집어 최신순으로 넘김
  let previous = options.onboarding;
  const out: { day: number; prepare: number; source: string; n: number; label: string }[] = [];
  for (let day = 0; day < days; day += 1) {
    const stats = prepareStatsOf([...records].reverse());
    const ctx: RollPlanCtx = { ...ctxAt(MON_10), profile: { ...profile, default_prepare_minutes: options.onboarding }, stats };
    const base: RollBase = { ...baseOf(fullAlarms()), participant: { ...baseParticipant, prepare_minutes: previous } };
    const planned = planOccurrence(ctx, base, THU, { travel: API_50, sameDayWake: false });
    assert.ok(planned.ok);
    if (!planned.ok) throw new Error('unreachable');
    previous = planned.plan.prepare.minutes;
    out.push({ day, prepare: previous, source: planned.plan.prepare.source, n: planned.plan.prepare.sampleCount, label: prepareSourceLabel(planned.plan.prepare.sampleCount) });
    records.push(options.actual);
  }
  return out;
}
const steps = (rows: { prepare: number }[], first: number) => rows.map((r, i) => Math.abs(r.prepare - (i === 0 ? first : rows[i - 1].prepare)));

test('[5절] 매일 실제 85분 (온보딩 70분): 매 회차 직전 값에서 ±10분 넘게 안 움직이고, 5건부터 "내 기록 기반 5건"', () => {
  const rows = simulate(12, { onboarding: 70, actual: 85 });
  assert.equal(rows[0].prepare, 70); // 기록 0건 = 첫 값 그대로
  assert.deepEqual([rows[0].source, rows[0].label], ['DEFAULT', '배우는 중 0/5']);
  assert.ok(steps(rows, 70).every((d) => d <= 10), `하루 폭: ${steps(rows, 70)}`);
  assert.deepEqual([rows[4].label, rows[5].label, rows[5].source], ['배우는 중 4/5', '내 기록 기반 5건', 'PERSONAL']);
  assert.ok(rows.every((r, i) => i === 0 || r.prepare >= rows[i - 1].prepare), '85분 쪽으로만 천천히 당겨짐');
  assert.ok(rows[11].prepare > 70 && rows[11].prepare <= 85);
});

test('상한이 실제로 걸리는 경우: 기록 30건(120분)이 한꺼번에 있는 사람이 첫 값 50에서 시작하면 회차마다 10분씩만 올라 목표(103)에 닿음', () => {
  const rows = simulate(7, { onboarding: 50, recordsBefore: Array.from({ length: 30 }, () => 120), actual: 120 });
  assert.deepEqual(rows.map((r) => r.prepare), [60, 70, 80, 90, 100, 103, 103]); // 상한이 없으면 첫 회차부터 103
  assert.ok(steps(rows, 50).every((d) => d <= 10));
  assert.equal(rows[0].label, '내 기록 기반 30건');
});

test('기준 회차에 기상 알람이 없으면 상한을 걸지 않고, 새 회차가 기상 없는 일정(15분)이면 그대로 15분', () => {
  const noWake = [baseAlarm('PREPARE', '2026-10-27T07:40'), baseAlarm('DEPARTURE', '2026-10-27T08:00')];
  const stats = prepareStatsOf(Array.from({ length: 30 }, () => 120));
  const ctx: RollPlanCtx = { ...ctxAt(MON_10), stats };
  const base: RollBase = { ...baseOf(noWake), participant: { ...baseParticipant, prepare_minutes: 15 } };
  // 새 회차에 기상이 생기는 경우(기준은 기상 없는 회차, 그날 다른 기상에 밀렸던 것) — 비교 대상이 다른 종류(15분)라 상한을 안 걸어 기록 보정이 그대로 반영됨
  const withWake = planOccurrence(ctx, base, THU, { travel: API_50, sameDayWake: false, baseHadEarlierWake: true });
  assert.ok(withWake.ok && withWake.plan.withWake && withWake.plan.prepare.minutes > 25);
  // 새 회차가 그날 두 번째 일정이면 15분
  const second = planOccurrence(ctx, baseOf(fullAlarms()), THU, { travel: API_50, sameDayWake: true });
  assert.ok(second.ok && !second.plan.withWake && second.plan.prepare.minutes === 15);
});

// ===========================================================================
// 일정 수정 · 삭제(appointment-edit, PR 4b)와 맞물림 — 예외 회차(exception_kind)는 기준 회차에서 빠지고 날짜 자리는 그대로
// ===========================================================================

const editCtx = (env: Env, over: Partial<EditCtx> = {}): EditCtx => ({ userId: A, userDb: env.db as unknown as Db, service: env.db as unknown as Db, now: MON_10, ...over });
const THU_1105 = kst('2026-11-05T10:30');
const AFTER_WEEK = kst('2026-11-02T10:00'); // 이때의 창 = 11/16 10:00 앞까지 → 11/10 화 · 11/12 목 09:00이 새로 들어옴

test('이번만 고친 회차는 기준 회차에서 빠짐: 다음 회차는 이번만 고치기 전의 시각 · 제목으로 만들어짐 (본인 길 · 배치 모두), 고친 회차의 날짜 자리는 그대로라 다시 안 만듦', async () => {
  for (const path of ['own', 'batch'] as const) {
    const env = setup(MON_10);
    const series = await seed(env, A, slot(), MON_10);
    await roll(env, 'own', MON_10, { lookup: fakeKakao().lookup }); // 10/29 · 11/03 · 11/05
    const last = occurrence(env.db, series, '2026-11-05')!;
    const edited = await updateAppointment(editCtx(env), { action: 'UPDATE', appointmentId: last.appointment_id as string, scope: 'this', confirmed: true, patch: { at: THU_1105, title: '특강' } });
    assert.ok(edited.saved);
    assert.equal(last.exception_kind, 'EDITED');

    const kakao = fakeKakao();
    const res = await roll(env, path, AFTER_WEEK, { lookup: kakao.lookup });
    assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-11-10', '2026-11-12'], path);
    assert.deepEqual(res.created.map((c) => hm(occurrence(env.db, series, c.occurrence_on)!.appointment_at)), ['09:00', '09:00'], path); // 10:30이 아님
    assert.deepEqual(res.created.map((c) => occurrence(env.db, series, c.occurrence_on)!.title), ['세미나', '세미나'], path); // 특강이 아님
    assert.deepEqual([hm(last.appointment_at), last.title, last.occurrence_on], ['10:30', '특강', '2026-11-05'], path); // 고친 회차는 그대로
    assert.deepEqual(datesOf(env.db, series), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12'], path);
  }
});

test('이번만 지운 날짜는 roll이 다시 안 만듦 (행을 두므로) — 본인 길 · 배치 모두 길찾기도 0번. 행을 진짜 지우면 다시 만들어짐(그래서 행을 두는 것)', async () => {
  const env = setup(MON_10);
  const series = await seed(env, A, slot(), MON_10);
  await roll(env, 'own', MON_10, { lookup: fakeKakao().lookup });
  const tue = occurrence(env.db, series, '2026-11-03')!;
  const res = await deleteAppointment(editCtx(env), { action: 'DELETE', appointmentId: tue.appointment_id as string, scope: 'this' });
  assert.equal(res.mode, 'CANCEL_THIS');
  assert.deepEqual(res.canceled_alarm_ids.length, 4);

  const kakao = fakeKakao();
  for (const path of ['own', 'batch', 'own'] as const) assert.deepEqual((await roll(env, path, MON_10, { lookup: kakao.lookup })).created, [], path);
  assert.equal(kakao.state.calls, 0);
  assert.deepEqual(datesOf(env.db, series), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);

  // 대조: 행을 진짜 지우면 roll이 그 날짜를 다시 만듦
  env.db.tables.appointments = env.db.rows('appointments').filter((a) => a.appointment_id !== tue.appointment_id);
  const again = await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  assert.deepEqual(again.created.map((c) => c.occurrence_on), ['2026-11-03']);
});

test('예외 회차뿐인 묶음: 이번만 고친 회차만 남아 있으면 그 회차가 기준이 되어 묶음이 멈추지 않음, 이번만 지운 회차뿐이면 다음 회차를 안 만듦', async () => {
  for (const path of ['own', 'batch'] as const) {
    const edited = setup(MON_10);
    const series = await seed(edited, A, slot(), MON_10);
    const first = occurrence(edited.db, series, '2026-10-27')!;
    await updateAppointment(editCtx(edited), { action: 'UPDATE', appointmentId: first.appointment_id as string, scope: 'this', confirmed: true, patch: { at: kst('2026-10-27T09:30') } });
    const res = await roll(edited, path, MON_10, { lookup: fakeKakao().lookup });
    assert.deepEqual(res.created.map((c) => c.occurrence_on), ['2026-10-29', '2026-11-03', '2026-11-05'], path);
    assert.deepEqual(res.created.map((c) => hm(occurrence(edited.db, series, c.occurrence_on)!.appointment_at)), ['09:30', '09:30', '09:30'], path); // 예외뿐이라 그 회차의 시각을 이어받음 (작성자 판단)

    const canceled = setup(MON_10);
    const series2 = await seed(canceled, A, slot(), MON_10);
    await deleteAppointment(editCtx(canceled), { action: 'DELETE', appointmentId: occurrence(canceled.db, series2, '2026-10-27')!.appointment_id as string, scope: 'this' });
    const kakao = fakeKakao();
    assert.deepEqual((await roll(canceled, path, MON_10, { lookup: kakao.lookup })).created, [], path);
    assert.equal(kakao.state.calls, 0, path);
  }
});

test('#320: 저녁 반복(18:00)은 기상 없이 준비 · 출발 · 도착만 만들어짐 (아침 반복의 기상은 위 기존 시험들이 확인)', async () => {
  const env = setup(MON_10);
  const evening = await seed(env, A, slot({ appointment: { title: '저녁 스터디', appointment_at: iso('2026-10-27T18:00'), destination: { name: '세종대학교', ...SCHOOL }, importance: 'NORMAL', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU,TH' } }), MON_10);
  const base = env.db.rows('appointments').find((x) => x.series_id === evening)!;
  assert.deepEqual(lines(env.db, base.appointment_id).map((l) => l.split(' ')[0]), ['PREPARE', 'DEPARTURE', 'ARRIVE']);
  const kakao = fakeKakao();
  await roll(env, 'own', MON_10, { lookup: kakao.lookup });
  for (const d of ['2026-10-29', '2026-11-03', '2026-11-05']) {
    assert.deepEqual(lines(env.db, occurrence(env.db, evening, d)!.appointment_id).map((l) => l.split(' ')[0]), ['PREPARE', 'DEPARTURE', 'ARRIVE'], d);
  }
});
