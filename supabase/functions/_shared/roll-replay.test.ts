// 하루 재생 시험 2 (설계 메모 L1_PR3_설계메모.md 7절) — 반복 일정을 저장한 뒤 며칠 동안 서버(alarm-roll)가 어떻게 도는지를
// 가짜 시계 · 가짜 카카오(분 고정, 부른 수 셈) · 가짜 DB(FakeDb)로 차례로 재생해 단계마다 확인
//   ① 월 10:00 저장 → 본인 길 roll → 회차 수 · 카카오 호출 수  ② 화 아침 기록(해제 · 출발 · 도착) → 배치가 창을 하루 민 새 회차
//   ③ 수: 앱을 안 열어도 서버에 수요일 알람이 이미 있음 · RATE_LIMIT → 대기 → 다음 날 0시 뒤 만들어짐  ④ 목: 배치 두 번 = 변화 없음 · 요일 · 새벽 1시 약속
// 달력: 2026-10-26 월 · 27 화 · 28 수 · 29 목 · 30 금 · 11-03 화 · 04 수 · 05 목 · 10 화 · 11 수 · 12 목
// 서버에서 안 보이는 단계(폰이 알람을 거는 모습 · 앱 화면)는 이 시험 밖. 도구는 roll.test.ts의 것을 필요한 만큼 복사함
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commitStandalone, persistAppointment } from './commit.ts';
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
const kst = (local: string) => new Date(`${local}:00+09:00`); // '2026-10-26T10:00'
const iso = (local: string) => `${local}:00+09:00`;
const hm = (value: unknown) => {
  const m = (new Date(value as string).getUTCHours() * 60 + new Date(value as string).getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const ymd = (value: unknown) => localDateKey(new Date(value as string), 'Asia/Seoul');
const weekday = (date: string) => '일월화수목금토'[new Date(`${date}T00:00:00Z`).getUTCDay()];
const HOME = { lat: 37.5547, lng: 126.9707 };
const SCHOOL = { lat: 37.55, lng: 127.07 };

// ---- 도구 (roll.test.ts에서 복사) ----

type Env = { db: FakeDb; logs: string[]; warns: string[] };

function setup(now: Date, users: string[]): Env {
  const db = new FakeDb().withRollRpc();
  db.now = now;
  for (const user_id of users) {
    db.rows('profiles').push({ user_id, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: HOME.lat, home_lng: HOME.lng } satisfies ProfileRow & { user_id: string });
  }
  return { db, logs: [], warns: [] };
}

// 가짜 카카오 — 분 고정, 부른 수를 셈. fail을 정하면 부를 때마다 그 실패
function fakeKakao(minutes = 50) {
  const state = { calls: 0, minutes, fail: null as KakaoFailure | null };
  const lookup: TravelLookup = async () => {
    state.calls += 1;
    if (state.fail) throw new KakaoError(state.fail, '시험용 실패');
    return { minutes: state.minutes, partial: false };
  };
  return { state, lookup };
}

function roll(env: Env, path: 'own' | 'batch', now: Date, lookup: TravelLookup, userId = A): Promise<RollResult> {
  env.db.now = now;
  const db = env.db as unknown as Db;
  return runRoll({ path, now, read: db, write: db, lookup, log: (l) => env.logs.push(l), warn: (l) => env.warns.push(l) }, path === 'own' ? { userId } : {});
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

// 일정 없는 반복 알람 첫 회차 저장
async function seedStandalone(env: Env, user: string, over: { at: string; rule: string }, now: Date): Promise<string> {
  const db = env.db as unknown as Db;
  const saved = await commitStandalone({ userId: user, userDb: db, service: db, now }, { alarm: { scheduledAt: new Date(over.at), recurrenceRule: over.rule }, edits: [], timeZone: 'Asia/Seoul' });
  return env.db.rows('alarms').find((a) => a.alarm_id === saved.alarm_id)!.series_id as string;
}

const occurrence = (db: FakeDb, series: string, date: string) => db.rows('appointments').find((a) => a.series_id === series && a.occurrence_on === date);
const datesOf = (db: FakeDb, series: string) => db.rows('appointments').filter((a) => a.series_id === series).map((a) => a.occurrence_on as string).sort();
const standaloneDates = (db: FakeDb, series: string) => db.rows('alarms').filter((a) => a.series_id === series).map((a) => a.occurrence_on as string).sort();
const participantOf = (db: FakeDb, appointmentId: unknown) => db.rows('appointment_participants').find((p) => p.appointment_id === appointmentId)!;
const alarmsOf = (db: FakeDb, appointmentId: unknown) => {
  const participant = participantOf(db, appointmentId);
  return db.rows('alarms').filter((a) => a.participant_id === participant.participant_id).sort((x, y) => Date.parse(x.scheduled_at as string) - Date.parse(y.scheduled_at as string));
};
const lines = (db: FakeDb, appointmentId: unknown) => alarmsOf(db, appointmentId).map((a) => `${a.alarm_type} ${hm(a.scheduled_at)} ${a.is_enabled ? 'on' : 'off'}`);
const attempts = (db: FakeDb) => db.rows('roll_attempts').map((r) => `${r.occurrence_on} ${r.tries} ${r.last_error} ${r.skipped ? 'skipped' : ymd(r.next_try_at) + ' ' + hm(r.next_try_at)}`).sort();

// 시험용 간단 행 (alarm-commit을 거치지 않고) — 사용자 B의 일정 한 줄. ats마다 회차 한 줄 (첫 줄의 id가 묶음 번호)
let rawSeq = 0;
function rawSeries(db: FakeDb, user: string, over: { ats: string[]; rule: string | null; title?: string }): string {
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

// ---- 재생용 보조 ----

const S2_FIRST_14 = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];

const TABLES = ['appointments', 'appointment_participants', 'alarms'] as const;
const PRIMARY_KEY = { appointments: 'appointment_id', appointment_participants: 'participant_id', alarms: 'alarm_id' } as const;

// 지금 행 전부의 모양을 떠 둠 — 나중에 "처음 있던 행이 그대로인가"를 봄
const snapshot = (db: FakeDb) => Object.fromEntries(TABLES.map((t) => [t, new Map(db.rows(t).map((r) => [r[PRIMARY_KEY[t]] as string, JSON.stringify(r)]))]));
type Snapshot = ReturnType<typeof snapshot>;

// before에 있던 행 중 except(표 이름 → 행 id) 말고는 모두 그대로인지
function assertUnchanged(db: FakeDb, before: Snapshot, except: Partial<Record<(typeof TABLES)[number], Set<string>>> = {}, label = '') {
  for (const table of TABLES) {
    const now = new Map(db.rows(table).map((r) => [r[PRIMARY_KEY[table]] as string, JSON.stringify(r)]));
    for (const [id, json] of before[table]) {
      if (except[table]?.has(id)) continue;
      assert.equal(now.get(id), json, `${label} ${table} ${id} 행이 바뀌었어요`);
    }
  }
}

test('하루 재생 2: 반복 일정 저장 → 본인 길 → 화 기록 · 배치 → 수 앱 안 염 · RATE_LIMIT 재시도 → 목 배치 두 번', async () => {
  const MON = kst('2026-10-26T10:00');
  const env = setup(MON, [A, B]);
  const kakao = fakeKakao(50);

  // ===== ① 월 10:00 저장 =====
  // S1 매주 화 · 목 09:00 대중교통 약속 · S3 매주 수 새벽 1:00 약속(UTC로는 전날) · S2 일정 없는 매일 07:30 기상 — 모두 첫 회차 한 줄씩
  const s1 = await seed(env, A, slot(), MON);
  const s3 = await seed(env, A, slot({ appointment: { ...slot().appointment, title: '야간 스터디', appointment_at: iso('2026-10-28T01:00'), recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE' } }), MON);
  const s2 = await seedStandalone(env, A, { at: '2026-10-27T07:30:00+09:00', rule: 'FREQ=DAILY' }, MON);
  // 사용자 B의 일정 한 줄 — A의 화요일 약속과 같은 날 · 같은 시각, 반복 규칙이 없어 roll이 다룰 일 없음. 끝까지 그대로여야 함
  const bSeries = rawSeries(env.db, B, { ats: [iso('2026-10-27T09:00')], rule: null, title: 'B의 수업' });
  const bRows = () => JSON.stringify([env.db.rows('appointments').filter((r) => r.creator_id === B), env.db.rows('appointment_participants').filter((r) => r.user_id === B), env.db.rows('alarms').filter((r) => r.user_id === B)]);
  const bJson = bRows();
  assert.ok(bSeries && bJson.includes('B의 수업'));
  assert.deepEqual([datesOf(env.db, s1), datesOf(env.db, s3), standaloneDates(env.db, s2)], [['2026-10-27'], ['2026-10-28'], ['2026-10-27']]);
  const s3First = occurrence(env.db, s3, '2026-10-28')!;
  assert.equal(s3First.appointment_at, '2026-10-27T16:00:00.000Z'); // 새벽 1시 약속은 UTC로 전날 — 회차 날짜는 한국 날짜

  // 본인 길 roll: 앞으로 14일(~11/9 10:00) 안 회차를 만듦
  const own = await roll(env, 'own', MON, kakao.lookup);
  assert.deepEqual(datesOf(env.db, s1), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']); // 화 · 목 4회차 (11/10 화 9시는 창 밖)
  assert.deepEqual(datesOf(env.db, s3), ['2026-10-28', '2026-11-04']); // 수 2회차 (11/11 새벽 1시는 창 밖)
  assert.deepEqual(standaloneDates(env.db, s2), S2_FIRST_14); // 10/27 ~ 11/9 14회차 (11/10 7:30은 창 밖)
  // 카카오는 길찾기가 필요한 약속 회차 수만큼 (S1 3 + S3 1), 일정 없는 알람 S2는 길찾기 없음
  assert.equal(own.created.length, 3 + 1 + 13);
  assert.equal(own.kakao_calls, 4);
  assert.equal(kakao.state.calls, 4);
  assert.deepEqual([own.pending, own.moved_alarm_ids, own.canceled_alarm_ids], [[], [], []]);
  assert.ok(own.created.filter((c) => c.series_id === s2).every((c) => c.appointment_id === null));
  // 새 회차의 알람은 첫 회차와 같은 모양으로 — 출발 = 약속 − 여유 10 − 이동 50
  const tue2 = occurrence(env.db, s1, '2026-11-03')!;
  assert.equal(participantOf(env.db, tue2.appointment_id).est_travel_minutes, 50);
  assert.deepEqual(lines(env.db, tue2.appointment_id).map((l) => l.split(' ')[0]), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);
  assert.equal(lines(env.db, tue2.appointment_id)[2], 'DEPARTURE 08:00 on');
  assert.equal(env.db.rows('appointments').length, 4 + 2 + 1);
  assert.equal(env.db.rows('appointment_participants').length, 4 + 2 + 1);
  assert.equal(env.db.rows('alarms').length, (4 + 2) * 4 + 4 + 14); // 약속 알람 4개씩 + B 4개 + S2 14개
  assert.deepEqual(env.logs.map((l) => JSON.parse(l)), [{ fn: 'alarm-roll', path: 'own', kakao_calls: 4, created: 17, pending: 0 }]);
  assert.equal(bRows(), bJson);

  // ===== ② 화 10/27: 아침 해제 · 출발 · 도착 기록 =====
  // 해제(기상 알람 두 개: 약속 S1의 기상 · 일정 없는 S2의 화요일 알람), 출발 8:10, 도착 8:55 — 앱이 쓰는 칸을 가짜로 채움
  const tue1 = occurrence(env.db, s1, '2026-10-27')!;
  const tue1Participant = participantOf(env.db, tue1.appointment_id);
  const tue1Wake = alarmsOf(env.db, tue1.appointment_id).find((a) => a.alarm_type === 'WAKE')!;
  const s2Tue = env.db.rows('alarms').find((a) => a.series_id === s2 && a.occurrence_on === '2026-10-27')!;
  for (const [i, alarm] of [tue1Wake, s2Tue].entries()) {
    env.db.rows('alarm_events').push({ event_id: i + 1, alarm_id: alarm.alarm_id, user_id: A, event_type: 'DISMISSED', event_at: iso('2026-10-27T07:31'), sequence_no: 1 });
  }
  Object.assign(tue1Participant, { departed_at: iso('2026-10-27T08:10'), arrived_at: iso('2026-10-27T08:55') });
  const recorded = snapshot(env.db);
  const eventsBefore = JSON.stringify(env.db.rows('alarm_events'));

  // 같은 날 오전 10시 배치: 창이 하루 밀려 (10/27 10:00, 11/10 10:00) — 11/10 화 9시 약속과 7:30 알람이 새로 들어옴
  const tuesday = await roll(env, 'batch', kst('2026-10-27T10:00'), kakao.lookup);
  assert.deepEqual(tuesday.created.map((c) => [c.series_id === s1 ? 'S1' : c.series_id === s2 ? 'S2' : '?', c.occurrence_on]).sort(), [['S1', '2026-11-10'], ['S2', '2026-11-10']]);
  assert.deepEqual([tuesday.kakao_calls, tuesday.pending, tuesday.ring_packages], [1, [], []]); // 길찾기는 S1 새 회차 하나 (배치 길은 꾸러미를 안 돌려줌)
  assert.deepEqual(datesOf(env.db, s1), ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05', '2026-11-10']);
  assert.deepEqual(datesOf(env.db, s3), ['2026-10-28', '2026-11-04']); // 11/11 새벽 1시는 아직 창 밖
  assert.deepEqual(standaloneDates(env.db, s2), [...S2_FIRST_14, '2026-11-10']);
  // 기록은 지난 회차 참여 행에 그대로, 다른 회차 · 다른 사람 행은 안 건드림
  assert.deepEqual([tue1Participant.departed_at, tue1Participant.arrived_at], [iso('2026-10-27T08:10'), iso('2026-10-27T08:55')]);
  assert.deepEqual(
    env.db.rows('appointment_participants').filter((p) => p.departed_at != null || p.arrived_at != null).map((p) => p.participant_id),
    [tue1Participant.participant_id],
  );
  assertUnchanged(env.db, recorded, {}, '②'); // 배치 앞에 있던 모든 행(기록 포함)이 그대로, 새 행만 늘어남
  assert.equal(JSON.stringify(env.db.rows('alarm_events')), eventsBefore);
  assert.equal(participantOf(env.db, occurrence(env.db, s1, '2026-11-10')!.appointment_id).departed_at ?? null, null); // 새 회차는 기록 없음
  assert.equal(bRows(), bJson);

  // ===== ③ 수 10/28: 앱을 안 열었다고 보고 배치만 =====
  // 수요일 07:30 알람(S2)은 ①에서 미리 만든 행 — 폰이 앱을 안 열었어도 서버에는 이미 있음
  const wedAlarm = env.db.rows('alarms').find((a) => a.series_id === s2 && a.occurrence_on === '2026-10-28')!;
  assert.deepEqual([wedAlarm.user_id, wedAlarm.alarm_type, hm(wedAlarm.scheduled_at), ymd(wedAlarm.scheduled_at), wedAlarm.is_enabled], [A, 'WAKE', '07:30', '2026-10-28', true]);
  const wedBefore = snapshot(env.db);

  // 아침 8시 배치: 창 끝이 11/11 8:00 — S3 11/11 새벽 1시 회차(길찾기 필요)와 S2 11/11 7:30 알람이 들어옴. 카카오가 RATE_LIMIT를 한 번 터뜨림
  kakao.state.fail = 'RATE_LIMIT';
  const wedRun = await roll(env, 'batch', kst('2026-10-28T08:00'), kakao.lookup);
  assert.deepEqual(wedRun.created.map((c) => [c.series_id === s2 ? 'S2' : '?', c.occurrence_on]), [['S2', '2026-11-11']]); // 길찾기 안 쓰는 알람은 계속 만들어짐
  assert.equal(wedRun.kakao_calls, 1); // 실패한 한 번 뒤로 그 실행은 길찾기를 멈춤
  assert.deepEqual(wedRun.pending, [{ series_id: s3, occurrence_on: '2026-11-11', reason: 'ROUTE_RETRY' }]);
  assert.equal(occurrence(env.db, s3, '2026-11-11'), undefined);
  assert.deepEqual(attempts(env.db), ['2026-11-11 1 RATE_LIMIT 2026-10-29 00:00']); // 다음 날 0시 뒤 다시
  assertUnchanged(env.db, wedBefore, {}, '③ RATE_LIMIT');

  // 같은 날 밤 11:50: 아직 기다리는 중 — 만들 것도 길찾기도 없음
  kakao.state.fail = null;
  const callsBefore = kakao.state.calls;
  const wait = await roll(env, 'batch', kst('2026-10-28T23:50'), kakao.lookup);
  assert.deepEqual([wait.created, wait.kakao_calls, kakao.state.calls - callsBefore], [[], 0, 0]);
  assert.deepEqual(wait.pending, []);
  assert.deepEqual(attempts(env.db), ['2026-11-11 1 RATE_LIMIT 2026-10-29 00:00']);

  // 10/29 0시 5분 배치: 기다림이 끝나 S3 11/11 회차가 만들어짐 (기록은 지워짐)
  const retry = await roll(env, 'batch', kst('2026-10-29T00:05'), kakao.lookup);
  assert.deepEqual(retry.created.map((c) => [c.series_id === s3 ? 'S3' : '?', c.occurrence_on]), [['S3', '2026-11-11']]);
  assert.deepEqual([retry.kakao_calls, retry.pending], [1, []]);
  assert.deepEqual(attempts(env.db), []);
  assert.deepEqual(datesOf(env.db, s3), ['2026-10-28', '2026-11-04', '2026-11-11']);
  assert.equal(bRows(), bJson);

  // ===== ④ 목 10/29 =====
  // 아침 9:30 배치: 창 끝이 11/12 9:30 — S1 11/12 목 9시(길찾기 1번)와 S2 11/12 7:30
  const thuFirst = await roll(env, 'batch', kst('2026-10-29T09:30'), kakao.lookup);
  assert.deepEqual(thuFirst.created.map((c) => [c.series_id === s1 ? 'S1' : c.series_id === s2 ? 'S2' : '?', c.occurrence_on]).sort(), [['S1', '2026-11-12'], ['S2', '2026-11-12']]);
  assert.equal(thuFirst.kakao_calls, 1);

  // 이어서 배치를 한 번 더: 변화 없음 — 만든 것 0 · 길찾기 0 · 어떤 행도 안 바뀜
  const settled = snapshot(env.db);
  const calls = kakao.state.calls;
  const thuSecond = await roll(env, 'batch', kst('2026-10-29T09:30'), kakao.lookup);
  assert.deepEqual([thuSecond.created, thuSecond.pending, thuSecond.moved_alarm_ids, thuSecond.canceled_alarm_ids, thuSecond.kakao_calls], [[], [], [], [], 0]);
  assert.equal(kakao.state.calls, calls);
  assertUnchanged(env.db, settled, {}, '④');
  assert.deepEqual(TABLES.map((t) => env.db.rows(t).length), TABLES.map((t) => settled[t].size));

  // S1은 화 · 목에만, 수 · 금 회차 없음. 날짜는 겹치지 않음
  const s1Dates = datesOf(env.db, s1);
  assert.deepEqual(s1Dates, ['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12']);
  assert.deepEqual(s1Dates.map(weekday), ['화', '목', '화', '목', '화', '목']);
  assert.equal(new Set(s1Dates).size, s1Dates.length);
  assert.equal(env.db.rows('appointments').filter((a) => a.series_id === s1 && ['수', '금'].includes(weekday(a.occurrence_on as string))).length, 0);
  assert.equal(env.db.rows('appointments').filter((a) => a.series_id === s1).every((a) => hm(a.appointment_at) === '09:00' && ymd(a.appointment_at) === a.occurrence_on), true);

  // 일정 없는 알람(S2)의 같은 날 7:30 기상이 있어도 S1 회차마다 기상 · 준비 · 출발 · 도착이 모두 생김
  for (const date of s1Dates) assert.deepEqual(lines(env.db, occurrence(env.db, s1, date)!.appointment_id), ['WAKE 07:10 on', 'PREPARE 07:40 on', 'DEPARTURE 08:00 on', 'ARRIVE 08:50 on'], date);

  // S3 새벽 1시 약속: 회차는 수요일, 기상(화요일 밤 23시대)은 전날 밤 — 알람 시각 날짜 ≠ 약속 날짜
  const s3Dates = datesOf(env.db, s3);
  assert.deepEqual(s3Dates.map(weekday), ['수', '수', '수']);
  for (const [date, eve] of [['2026-10-28', '2026-10-27'], ['2026-11-04', '2026-11-03'], ['2026-11-11', '2026-11-10']]) {
    const row = occurrence(env.db, s3, date)!;
    assert.equal(hm(row.appointment_at), '01:00');
    const wake = alarmsOf(env.db, row.appointment_id).find((a) => a.alarm_type === 'WAKE')!;
    assert.equal(weekday(ymd(wake.scheduled_at)), '화');
    assert.deepEqual([ymd(wake.scheduled_at), hm(wake.scheduled_at).slice(0, 2)], [eve, '23']);
    assert.notEqual(ymd(wake.scheduled_at), row.occurrence_on);
    assert.equal(ymd(row.appointment_at), row.occurrence_on);
  }

  // 마무리: 카카오는 새 약속 회차(S1 5 + S3 2)마다 한 번, 거기에 RATE_LIMIT로 실패한 한 번
  assert.equal(kakao.state.calls, 5 + 2 + 1);
  // A의 행은 모두 A 몫, B의 일정 한 줄은 끝까지 그대로
  assert.ok(env.db.rows('appointments').filter((a) => a.creator_id === A).length === 6 + 3);
  assert.ok(env.db.rows('appointment_participants').filter((p) => p.user_id === A).length === 6 + 3);
  assert.ok(env.db.rows('alarms').filter((a) => a.user_id === A).length === 9 * 4 + 17);
  assert.equal(env.db.rows('appointments').filter((a) => a.creator_id === B).length, 1);
  assert.equal(bRows(), bJson);
  assert.deepEqual(env.warns, []);
});
