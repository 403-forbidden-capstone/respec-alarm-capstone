// buildPlan(DB에서 읽기 + 이동시간 정하기) — 가짜 DB로. 좌표가 없을 때의 폴백, 미리 보기 = 저장 대조
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertPersistable, persistAppointment, type CommitCtx } from './commit.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { buildPlan, loadPrepareStats, loadProfile, loadSameDayWake, TravelRequiredError, type PlanContext } from './plan.ts';
import { toSuggestion, toTravelRequiredSuggestion } from './plan-core.ts';
import { Reader } from './read.ts';
import { readCommitRequest, readSuggestRequest } from './requests.ts';
import type { Db } from './supabase.ts';

const USER = 'u-me';
const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
const iso = (day: number, minutes: number) => {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `2025-05-${day}T${h}:${m}:00+09:00`;
};
const hm = (value: unknown) => {
  const d = new Date(value as string);
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

function setup(now = kst(22, 400)) {
  const db = new FakeDb();
  db.rows('profiles').push({ user_id: USER, timezone: 'Asia/Seoul', default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: 37.5547, home_lng: 126.9707 });
  const ctx: PlanContext = { userId: USER, db: db as unknown as Db, now };
  const commitCtx: CommitCtx = { userId: USER, userDb: db as unknown as Db, service: db as unknown as Db, now };
  return { db, ctx, commitCtx };
}
const draftOf = (body: unknown) => {
  const r = Reader.root(body);
  const draft = readSuggestRequest(r);
  r.finish();
  return draft;
};

// ---- 좌표가 없을 때 (이동시간 폴백의 마지막 단계) ----

const NO_COORDS = { appointment: { appointment_at: iso(22, 600), destination: { name: '세종대학교' } } };

test('좌표가 없고 직접 입력도 없으면 TravelRequiredError (502 ROUTE_UNAVAILABLE + manual_required) — alarm-commit은 이 오류를 그대로 돌려줌', async () => {
  const { ctx } = setup();
  await assert.rejects(
    () => buildPlan(ctx, draftOf(NO_COORDS)),
    (e: unknown) =>
      e instanceof TravelRequiredError &&
      e instanceof HttpError &&
      e.status === 502 &&
      e.code === 'ROUTE_UNAVAILABLE' &&
      (e.details as { manual_required: boolean }).manual_required === true &&
      (e.details as { warnings: { code: string }[] }).warnings.some((w) => w.code === 'NO_COORDINATES'),
  );
});

test('alarm-suggest는 그 오류를 200 응답으로: 이동시간만 비우고 직접 입력을 안내, 준비 · 강도는 그대로', async () => {
  const { ctx } = setup();
  const err = await buildPlan(ctx, draftOf(NO_COORDS)).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof TravelRequiredError);
  const s = toTravelRequiredSuggestion(err.inputs, err.travel);

  // 보통 응답과 같은 칸 이름 (앱이 같은 타입으로 읽을 수 있게)
  const normal = await buildPlan(setup().ctx, draftOf({ ...NO_COORDS, participant: { est_travel_minutes: 50, travel_source: 'MANUAL' } }));
  assert.deepEqual(Object.keys(s), Object.keys(toSuggestion(normal.plan)));
  assert.deepEqual(Object.keys(s.travel), Object.keys(toSuggestion(normal.plan).travel));

  assert.deepEqual([s.travel.minutes, s.travel.source, s.travel.manual_required, s.travel.needs_confirmation], [null, null, true, true]);
  assert.deepEqual([s.alarms, s.wake_at, s.departure_at, s.arrive_at], [[], null, null, null]);
  assert.deepEqual([s.check.ok, s.check.reason], [false, 'TRAVEL_REQUIRED']);
  assert.deepEqual([s.prepare.minutes, s.prepare.common_p80, s.intensity.level, s.with_wake], [50, 50, 'NORMAL', true]); // 이동시간과 상관없는 칸
  assert.deepEqual(s.warnings.map((w) => w.code), ['NO_COORDINATES']); // 자리표시 계산의 경고가 새어 나오지 않음
});

test('직접 입력한 이동시간(MANUAL)이 있으면 좌표가 없어도 시각까지 계산됨', async () => {
  const { ctx } = setup();
  const { plan } = await buildPlan(ctx, draftOf({ ...NO_COORDS, participant: { est_travel_minutes: 40, travel_source: 'MANUAL', before_prepare_minutes: 30 } }));
  assert.deepEqual([plan.travel.chosen?.source, plan.travelMinutes], ['MANUAL', 40]);
  assert.deepEqual(plan.chain.map((a) => `${a.kind} ${hm(a.at.toISOString())}`), ['WAKE 08:20', 'PREPARE 08:50', 'DEPARTURE 09:10', 'ARRIVE 09:50']);
});

test('좌표가 있고 카카오 키 · 기록이 없으면 직선거리 근사(ESTIMATE) — 사용자 확인이 필요하다고 알림', async () => {
  const { ctx } = setup();
  const body = { appointment: { appointment_at: iso(22, 600), destination: { name: '세종대학교', lat: 37.55, lng: 127.07 } }, participant: { origin: { name: '집', lat: 37.5547, lng: 126.9707 } } };
  const { plan } = await buildPlan(ctx, draftOf(body), { wantAutoTravel: true });
  assert.equal(plan.travel.chosen?.source, 'ESTIMATE');
  const s = toSuggestion(plan);
  assert.deepEqual([s.travel.source, s.travel.needs_confirmation, s.travel.manual_required], ['ESTIMATE', true, false]);
  assert.ok(s.warnings.some((w) => w.code === 'KAKAO_NOT_CONFIGURED'));
});

// ---- 미리 보기(alarm-suggest)와 저장(alarm-commit)이 같은 초안에서 같은 시각을 냄 ----

const FULL = {
  appointment: { title: '팀 주간회의', appointment_at: iso(22, 600), destination: { name: '세종대학교', lat: 37.55, lng: 127.07 }, importance: 'NORMAL' },
  participant: { origin: { name: '집', lat: 37.5547, lng: 126.9707 }, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', buffer_minutes: 10, before_prepare_minutes: 30 },
};

const scenarios: { name: string; body: object; now?: Date }[] = [
  { name: '기본', body: FULL },
  { name: '직접 고른 기상 시각', body: { ...FULL, manual_times: { WAKE: iso(22, 450) } } },
  { name: '고른 종류만', body: { ...FULL, kinds: ['WAKE', 'DEPARTURE'] } },
  { name: '알람 하나 끄기', body: { ...FULL, enabled: { PREPARE: false } } },
  { name: '기상이 이미 지난 때(그 알림만 끄고 저장)', body: FULL, now: kst(22, 478) },
  { name: '직접 고른 이동 · 준비', body: { ...FULL, participant: { ...FULL.participant, est_travel_minutes: 35, travel_source: 'MANUAL', prepare_minutes: 45 } } },
];

type Env = ReturnType<typeof setup>;
const ORDER = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];
const line = (a: { alarm_type?: unknown; scheduled_at?: unknown; is_enabled?: unknown; time_source?: unknown }) => `${a.alarm_type} ${a.scheduled_at} ${a.is_enabled} ${a.time_source}`;

// 앱은 같은 초안 하나를 alarm-suggest와 alarm-commit에 그대로 보냄 → 미리 보여 준 알람과 저장된 알람
async function previewAndSave({ db, ctx, commitCtx }: Env, body: object) {
  const preview = await buildPlan(ctx, draftOf(body), { wantAutoTravel: true, mode: 'preview' });
  const shown = toSuggestion(preview.plan, preview.inputs).alarms.map(line);

  const request = readCommitRequest(Reader.root(body));
  assert.equal(request.type, 'APPOINTMENT');
  if (request.type !== 'APPOINTMENT') throw new Error('unreachable');
  const built = await buildPlan(ctx, request.draft);
  assertPersistable(built.plan);
  const body2 = await persistAppointment(commitCtx, {
    plan: built.plan,
    inputs: built.inputs,
    created: request.appointment,
    draft: request.draft,
    replaceExisting: request.replaceExisting,
    edits: request.edits,
    timeZone: built.timeZone,
  });
  const saved = db
    .rows('alarms')
    .filter((a) => a.participant_id === body2.participant_id)
    .sort((x, y) => ORDER.indexOf(x.alarm_type as string) - ORDER.indexOf(y.alarm_type as string))
    .map(line);
  return { shown, saved, appointmentId: body2.appointment_id };
}

for (const s of scenarios) {
  test(`미리 보기 = 저장: ${s.name}`, async () => {
    const { shown, saved } = await previewAndSave(setup(s.now), s.body);
    assert.deepEqual(saved, shown);
    assert.ok(saved.length > 0);
  });
}

test('미리 보기 = 저장: 사용자가 끈 알람은 다시 저장해도 꺼진 채, 요청의 enabled가 먼저 (기존 약속)', async () => {
  const env = setup();
  const first = await previewAndSave(env, FULL);
  const prepare = env.db.rows('alarms').find((a) => a.alarm_type === 'PREPARE')!;
  prepare.is_enabled = false; // H02에서 끔

  const again = { appointment_id: first.appointmentId, participant: { est_travel_minutes: 50, travel_source: 'API' as const } };
  const kept = await previewAndSave(env, again);
  assert.deepEqual(kept.saved, kept.shown);
  assert.match(kept.saved[1], /^PREPARE .* false /); // 꺼진 채로

  const turnedOn = await previewAndSave(env, { ...again, enabled: { PREPARE: true } });
  assert.deepEqual(turnedOn.saved, turnedOn.shown);
  assert.match(turnedOn.saved[1], /^PREPARE .* true /);
});

// ---- 그날 첫 일정 판정: 내 참여 → 약속 시각 + 기상 알람을 읽고 약속 시각이 앞선 것만 셈 ----
// 가짜 DB는 PostgREST 임베드(`appointments!inner`)를 흉내 못 내서, 부른 쿼리 모양은 기록 도우미로 확인하고 판정은 읽어 온 행으로 시험함

// 쿼리 빌더 호출을 기록하고 준비해 둔 행을 돌려주는 도우미
function recordingDb(rows: unknown[]) {
  const calls: unknown[][] = [];
  const query: unknown = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
        return (...args: unknown[]) => {
          calls.push([name, ...args]);
          return query;
        };
      },
    },
  );
  const db = { from: (table: string) => (calls.push(['from', table]), query) } as unknown as Db;
  return { db, calls };
}

// 그날 내 참여 한 줄: 약속 시각 + 기상 알람(켜짐 여부)
const wakeRow = (appointmentId: string, appointmentMinutes: number, isEnabled = true) => ({
  appointment_id: appointmentId,
  appointments: { appointment_at: iso(22, appointmentMinutes) },
  alarms: [{ is_enabled: isEnabled }],
});

test('그날 첫 일정: 10시 약속(기상 8:00)이 있는 날 8:30 새 약속은 기상 있음, 8:00 약속이 있는 날 10:00 새 약속은 기상 없음', async () => {
  const withTen = recordingDb([wakeRow('ap-ten', 600)]);
  assert.equal(await loadSameDayWake(withTen.db, USER, kst(22, 510), 'Asia/Seoul'), false);

  const withEight = recordingDb([wakeRow('ap-eight', 480)]);
  assert.equal(await loadSameDayWake(withEight.db, USER, kst(22, 600), 'Asia/Seoul'), true);
});

test('그날 첫 일정: 같은 시각 약속 둘은 둘 다 기상, 꺼 둔 기상 · 자기 자신의 기상은 안 셈', async () => {
  assert.equal(await loadSameDayWake(recordingDb([wakeRow('ap-other', 600)]).db, USER, kst(22, 600), 'Asia/Seoul'), false);
  assert.equal(await loadSameDayWake(recordingDb([wakeRow('ap-other', 480, false)]).db, USER, kst(22, 600), 'Asia/Seoul'), false);
  assert.equal(await loadSameDayWake(recordingDb([wakeRow('ap-self', 480)]).db, USER, kst(22, 600), 'Asia/Seoul', 'ap-self'), false);
  assert.equal(await loadSameDayWake(recordingDb([wakeRow('ap-self', 480), wakeRow('ap-other', 540)]).db, USER, kst(22, 600), 'Asia/Seoul', 'ap-self'), true);
});

test('그날 첫 일정: 임베드가 객체로 와도 배열로 와도 읽음, 약속 시각을 못 읽는 행은 건너뜀', async () => {
  const mixedShapes = { appointment_id: 'a', appointments: [{ appointment_at: iso(22, 480) }], alarms: { is_enabled: true } };
  assert.equal(await loadSameDayWake(recordingDb([mixedShapes]).db, USER, kst(22, 600), 'Asia/Seoul'), true);
  const broken = [{ appointment_id: 'b', appointments: null, alarms: [{ is_enabled: true }] }, { appointment_id: 'c', appointments: { appointment_at: 'x' }, alarms: [{ is_enabled: true }] }];
  assert.equal(await loadSameDayWake(recordingDb(broken).db, USER, kst(22, 600), 'Asia/Seoul'), false);
});

test('그날 첫 일정: 내 참여만, 기상 알람만, 내 시간대 하루(0시 ~ 다음 0시)의 약속 시각으로 읽음', async () => {
  const { db, calls } = recordingDb([]);
  await loadSameDayWake(db, USER, kst(22, 600), 'Asia/Seoul');
  assert.deepEqual(calls[0], ['from', 'appointment_participants']);
  const select = calls.find((c) => c[0] === 'select');
  assert.match(String(select?.[1]), /appointments!inner\(appointment_at\)/);
  assert.match(String(select?.[1]), /alarms!inner\(is_enabled\)/);
  const filters = calls.filter((c) => c[0] !== 'from' && c[0] !== 'select').map((c) => c.join(' '));
  assert.deepEqual(filters.sort(), [
    `eq alarms.alarm_type WAKE`,
    `eq user_id ${USER}`,
    `gte appointments.appointment_at ${kst(22, 0).toISOString()}`,
    `lt appointments.appointment_at ${kst(23, 0).toISOString()}`,
  ]);
});

// ---- 기존 약속을 다시 저장할 때 직접 입력한 이동시간 이어받기 (시각 · 강도의 직접 값과 같은 규칙) ----

// 카카오로 나가는 호출을 세는 fetch. 부르면 실패 응답을 줘서 다음 단계(기록 → 근사)로 넘어감
function countingFetch() {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    state.calls += 1;
    return new Response('{}', { status: 500 });
  }) as unknown as NonNullable<PlanContext['fetchImpl']>;
  return { state, fetchImpl };
}

const AP = '00000000-0000-4000-8000-0000000000a1';

// 저장된 약속 하나 (10시 · 좌표 있음 · 저장된 이동시간은 travelSource로)
function storedAppointment(db: FakeDb, over: { source: 'API' | 'MANUAL' | 'CACHED'; minutes: number | null }) {
  db.rows('appointments').push({
    appointment_id: AP, creator_id: USER, group_id: null, title: '팀 주간회의', appointment_at: iso(22, 600),
    dest_name: '세종대학교', dest_lat: 37.55, dest_lng: 127.07, importance: 'NORMAL', recurrence_rule: null,
  });
  db.rows('appointment_participants').push({
    participant_id: 'pt1', appointment_id: AP, user_id: USER, origin_name: '집', origin_lat: 37.5547, origin_lng: 126.9707,
    transport_type: 'TRANSIT', est_travel_minutes: over.minutes, travel_source: over.source, prepare_minutes: 60, buffer_minutes: 10,
  });
}

test('이동시간 이어받기: 요청에 이동시간이 없고 저장된 게 MANUAL이면 저장된 분을 그대로, 길찾기는 안 부름', async () => {
  const { db, ctx } = setup();
  storedAppointment(db, { source: 'MANUAL', minutes: 70 });
  const { fetchImpl, state } = countingFetch();
  const { plan } = await buildPlan({ ...ctx, kakaoKey: 'k', fetchImpl }, draftOf({ appointment_id: AP }));
  assert.deepEqual([plan.travel.chosen?.source, plan.travelMinutes, plan.travel.chosen?.needsConfirmation], ['MANUAL', 70, false]);
  assert.equal(state.calls, 0);
  assert.deepEqual(plan.chain.map((a) => `${a.kind} ${hm(a.at.toISOString())}`), ['WAKE 07:50', 'PREPARE 08:10', 'DEPARTURE 08:40', 'ARRIVE 09:50']); // 출발 = 10:00 − 여유 10 − 이동 70
});

test('이동시간 이어받기: 미리 보기도 같은 값(MANUAL 70분)에 "자동으로 되돌리기" 값만 따로 구함', async () => {
  const { db, ctx } = setup();
  storedAppointment(db, { source: 'MANUAL', minutes: 70 });
  const { fetchImpl, state } = countingFetch();
  const { plan } = await buildPlan({ ...ctx, kakaoKey: 'k', fetchImpl }, draftOf({ appointment_id: AP }), { wantAutoTravel: true });
  assert.deepEqual([plan.travel.chosen?.source, plan.travelMinutes], ['MANUAL', 70]);
  assert.ok(plan.travel.auto); // 되돌리기 후보
  assert.ok(state.calls > 0);
});

test('이동시간 이어받기: 요청에 이동시간이 있으면 그 값이 먼저 (MANUAL · API 둘 다)', async () => {
  const { db, ctx } = setup();
  storedAppointment(db, { source: 'MANUAL', minutes: 70 });
  const manual = await buildPlan(ctx, draftOf({ appointment_id: AP, participant: { est_travel_minutes: 35, travel_source: 'MANUAL' } }));
  assert.deepEqual([manual.plan.travel.chosen?.source, manual.plan.travelMinutes], ['MANUAL', 35]);
  const api = await buildPlan(ctx, draftOf({ appointment_id: AP, participant: { est_travel_minutes: 45, travel_source: 'API' } }));
  assert.deepEqual([api.plan.travel.chosen?.source, api.plan.travelMinutes], ['API', 45]);
});

test('이동시간 이어받기: 저장된 게 API · CACHED면 이어받지 않고 다시 구함 (D5), MANUAL인데 분이 비면 이어받을 게 없음', async () => {
  for (const source of ['API', 'CACHED'] as const) {
    const { db, ctx } = setup();
    storedAppointment(db, { source, minutes: 70 });
    const { fetchImpl, state } = countingFetch();
    const { plan } = await buildPlan({ ...ctx, kakaoKey: 'k', fetchImpl }, draftOf({ appointment_id: AP }));
    assert.notEqual(plan.travel.chosen?.source, 'MANUAL');
    assert.notEqual(plan.travelMinutes, 70);
    assert.ok(state.calls > 0); // 길찾기를 다시 부름
  }
  const { db, ctx } = setup();
  storedAppointment(db, { source: 'MANUAL', minutes: null });
  const { plan } = await buildPlan(ctx, draftOf({ appointment_id: AP }));
  assert.equal(plan.travel.chosen?.source, 'ESTIMATE');
});

test('이동시간 이어받기: 키 · 기록이 없어도 다시 저장되고 직접 입력은 MANUAL 그대로 남음 (예전에는 502)', async () => {
  const env = setup();
  const first = await previewAndSave(env, { ...FULL, participant: { ...FULL.participant, est_travel_minutes: 70, travel_source: 'MANUAL' } });
  const again = await previewAndSave(env, { appointment_id: first.appointmentId });
  assert.deepEqual(again.saved, again.shown);
  const row = env.db.rows('appointment_participants').find((p) => p.appointment_id === first.appointmentId);
  assert.deepEqual([row?.travel_source, row?.est_travel_minutes], ['MANUAL', 70]);
});

test('지난 알림 경고 문구: alarm-suggest(preview)는 "저장할 때 꺼져요", alarm-commit(기본 save)은 "끄고 저장했어요", 코드는 같음', async () => {
  const now = kst(22, 490); // 기상 8:10이 곧 지나는 때 (지금 + 5분보다 앞)
  const preview = await buildPlan(setup(now).ctx, draftOf(FULL), { wantAutoTravel: true, mode: 'preview' });
  const save = await buildPlan(setup(now).ctx, draftOf(FULL));
  assert.deepEqual(preview.plan.warnings.map((w) => [w.code, w.message]), [['PAST_ALARM_DISABLED', '이미 지난 알림은 저장할 때 꺼져요']]);
  assert.deepEqual(save.plan.warnings.map((w) => [w.code, w.message]), [['PAST_ALARM_DISABLED', '이미 지난 알림은 끄고 저장했어요']]);
  assert.deepEqual(toSuggestion(preview.plan, preview.inputs).warnings, preview.plan.warnings); // 앱이 받는 미리 보기 응답에 그 문구
});

// ---- 준비 통계: 내 기상~출발 기록 최근 30건 · 10~240분만 (학습 루프 기초 ③) ----

// 날짜(record_date)만 다른 기록 줄들 — daysAgo가 클수록 오래됨
const record = (user: string, daysAgo: number, minutes: number | null) => ({
  record_id: `r-${user}-${daysAgo}`,
  user_id: user,
  record_date: new Date(Date.UTC(2025, 4, 22) - daysAgo * 86_400_000).toISOString().slice(0, 10),
  actual_prepare_minutes: minutes,
});

test('준비 통계는 내 user_id 줄만: 다른 사람 기록이 같이 보여도 오류 없이 내 값 (친구 기록 조회 정책이 생겨도)', async () => {
  const { db, ctx } = setup();
  db.rows('daily_records').push(record('u-friend', 1, 100), ...[40, 41, 42, 43, 44].map((m, i) => record(USER, i, m)));
  const mine = await loadPrepareStats(db as unknown as Db, USER);
  assert.equal(mine.sampleCount, 5);
  assert.equal(mine.p80, 43.2); // 40 41 42 43 44의 0.8 분위수 (선형 보간)
  assert.deepEqual(await loadPrepareStats(db as unknown as Db, 'u-nobody'), { sampleCount: 0, p80: null, values: [] });
  assert.deepEqual(mine.values, [40, 41, 42, 43, 44]); // 최신순 (daysAgo 0이 40)
  const { plan } = await buildPlan(ctx, draftOf(FULL));
  assert.equal(plan.prepare.sampleCount, 5);
});

test('준비 통계는 최근 30건만, 10~240분만: 31번째 오래된 기록과 5분 · 400분 · 빈 값은 무시', async () => {
  const { db } = setup();
  // 최근 30일은 60분, 그 전 31번째 날(daysAgo 30)은 200분 — 30건 창 밖이라 무시돼야 함
  for (let d = 0; d < 30; d += 1) db.rows('daily_records').push(record(USER, d, 60));
  db.rows('daily_records').push(record(USER, 30, 200));
  // 범위 밖 · 빈 값 — 가장 최근 날짜(-1 ~ -5일 전)에 있어도 30건 창을 차지하지 않고 무시
  db.rows('daily_records').push(record(USER, -1, 5), record(USER, -2, 400), record(USER, -3, null), record(USER, -4, 9), record(USER, -5, 241));
  const stats = await loadPrepareStats(db as unknown as Db, USER);
  assert.deepEqual(stats, { sampleCount: 30, p80: 60, values: Array.from({ length: 30 }, () => 60) });
  // 경계값 10 · 240은 쓴다
  const edge = setup().db;
  edge.rows('daily_records').push(record(USER, 0, 10), record(USER, 1, 240));
  assert.deepEqual(await loadPrepareStats(edge as unknown as Db, USER), { sampleCount: 2, p80: 194, values: [10, 240] });
});

test('뷰 v_prepare_time_stats는 더 읽지 않음: 뷰에 값이 있어도 기록이 없으면 0건', async () => {
  const { db } = setup();
  db.rows('v_prepare_time_stats').push({ user_id: USER, sample_count: 12, p80_minutes: 41.5 });
  assert.deepEqual(await loadPrepareStats(db as unknown as Db, USER), { sampleCount: 0, p80: null, values: [] });
});

// ---- 학습 루프 기초 b (이슈 #272): 프로필의 잠귀 · 깨우는 여유 ----

test('loadProfile이 잠귀(wake_sensitivity)와 깨우는 여유(wake_margin) 두 칸을 읽음 — 프로필이 없으면 둘 다 보통', async () => {
  const { db } = setup();
  Object.assign(db.rows('profiles')[0], { wake_sensitivity: 'HEAVY', wake_margin: 'LOOSE' });
  const mine = await loadProfile(db as unknown as Db, USER);
  assert.deepEqual([mine.wake_sensitivity, mine.wake_margin], ['HEAVY', 'LOOSE']);
  const none = await loadProfile(db as unknown as Db, 'u-nobody');
  assert.deepEqual([none.wake_sensitivity, none.wake_margin], ['NORMAL', 'NORMAL']);
});

test('buildPlan: 프로필의 두 칸이 계산에 닿음 — 잠귀 깊음 → 강, 넉넉 → 같은 기록에서 준비가 더 김, 응답에 최근 값', async () => {
  const body = { appointment: { appointment_at: iso(22, 600), destination: { name: '세종대학교', lat: 37.55, lng: 127.07 } }, participant: { est_travel_minutes: 50, travel_source: 'MANUAL' } };
  const run = async (profile: Record<string, unknown>) => {
    const { db, ctx } = setup();
    Object.assign(db.rows('profiles')[0], profile);
    // 최근 10일 기록 (최신이 앞): 70 100 40 80 45 75 55 60 50 65
    [70, 100, 40, 80, 45, 75, 55, 60, 50, 65].forEach((m, d) => db.rows('daily_records').push(record(USER, d, m)));
    const { plan } = await buildPlan(ctx, draftOf(body));
    return toSuggestion(plan);
  };
  const normal = await run({});
  const tuned = await run({ wake_sensitivity: 'HEAVY', wake_margin: 'LOOSE' });
  assert.deepEqual([normal.intensity.level, normal.prepare.minutes], ['NORMAL', 63]);
  assert.deepEqual([tuned.intensity.level, tuned.prepare.minutes], ['STRONG', 66]);
  assert.deepEqual(tuned.prepare.recent, [70, 100, 40, 80, 45]);
  assert.equal((await run({ wake_margin: 'TIGHT' })).prepare.minutes, 61);
});


test('onboarding pure prep is the only new automatic preparation baseline, independent of pilot flags', async () => {
  const input = draftOf(FULL);
  const check = async (pure: number | null, legacy: number) => {
    const { db, ctx } = setup();
    Object.assign(db.rows('profiles')[0], {
      default_outing_prep_minutes: pure,
      default_prepare_minutes: legacy,
    });
    return (await buildPlan(ctx, input)).plan;
  };
  const first = await check(30, 120);
  const edited = await check(45, 120);
  assert.equal(first.prepareTarget, 'PREPARE_START_TO_DEPART');
  assert.equal(edited.prepareTarget, 'PREPARE_START_TO_DEPART');
  assert.equal(first.prepare.minutes, 60); // pure 30 + explicit 30 min before-prep
  assert.equal(edited.prepare.minutes, 75); // only pure duration is changed
  assert.deepEqual(first.chain.map(a => a.kind + ' ' + hm(a.at.toISOString())),
    ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(edited.chain.map(a => a.kind + ' ' + hm(a.at.toISOString())),
    ['WAKE 07:45', 'PREPARE 08:15', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  const changedOldLegacy = await check(45, 180);
  assert.deepEqual(changedOldLegacy.chain, edited.chain);
  // Legacy accounts with no explicit pure time retain existing fallback.
  const legacy = await check(null, 70);
  assert.equal(legacy.prepareTarget, 'WAKE_TO_DEPART');
  assert.equal(legacy.prepare.minutes, 70);
});

test('group participant AUTO uses only their profile pure time, without group history inference', async () => {
  const { db, ctx } = setup();
  Object.assign(db.rows('profiles')[0], {
    default_outing_prep_minutes: 40,
    default_prepare_minutes: 130,
  });
  const groupDraft = { ...draftOf(FULL), groupId: 'g1' };
  const result = await buildPlan(ctx, groupDraft);
  assert.equal(result.plan.prepareTarget, 'PREPARE_START_TO_DEPART');
  assert.equal(result.plan.prepare.minutes, 70);
  assert.equal(result.plan.prepare.source, 'DEFAULT');
  const override = draftOf({ ...FULL, participant: { ...FULL.participant, prepare_minutes: 85 } });
  override.groupId = 'g1';
  const manual = await buildPlan(ctx, override);
  assert.equal(manual.plan.prepareTarget, 'WAKE_TO_DEPART');
  assert.equal(manual.plan.prepare.source, 'MANUAL');
  assert.equal(manual.plan.prepare.minutes, 85);
});


test('FakeDb scenario: profile 30m -> commit -> value 45m -> preview -> explicit recommit -> reread', async () => {
  const env = setup();
  const profile = env.db.rows('profiles')[0];
  // New onboarded users never supply the former wake-to-departure estimate.
  Object.assign(profile, { default_outing_prep_minutes: 30, default_prepare_minutes: 150 });
  const first = await previewAndSave(env, FULL);
  assert.deepEqual(first.saved, first.shown);
  const savedBefore = env.db.rows('alarms').filter(a => a.participant_id ===
    env.db.rows('appointment_participants').find(p => p.appointment_id === first.appointmentId)?.participant_id)
    .map(a => ({ kind: a.alarm_type, at: a.scheduled_at }));
  assert.equal(savedBefore.find(a => a.kind === 'WAKE')?.at, new Date(iso(22, 480)).toISOString());
  assert.equal(savedBefore.find(a => a.kind === 'PREPARE')?.at, new Date(iso(22, 510)).toISOString());

  // This is an in-memory profile-value change, NOT the mobile settings-save API
  // or PostgreSQL preference-epoch trigger. It verifies that unchanged alarm
  // rows are not rewritten merely by mutating the FakeDb profile object.
  profile.default_outing_prep_minutes = 45;
  const originalPersisted = env.db.rows('alarms').filter(a => a.participant_id ===
    env.db.rows('appointment_participants').find(p => p.appointment_id === first.appointmentId)?.participant_id)
    .map(a => ({ kind: a.alarm_type, at: a.scheduled_at }));
  assert.deepEqual(originalPersisted, savedBefore);

  const body = {
    appointment_id: first.appointmentId,
    participant: { est_travel_minutes: 50, travel_source: 'API' as const },
  };
  const preview = await buildPlan(env.ctx, draftOf(body), { wantAutoTravel: true, mode: 'preview' });
  assert.equal(preview.plan.prepareTarget, 'PREPARE_START_TO_DEPART');
  assert.equal(preview.plan.prepare.minutes, 75);
  assert.deepEqual(preview.plan.chain.map(a => a.kind + ' ' + hm(a.at.toISOString())),
    ['WAKE 07:45', 'PREPARE 08:15', 'DEPARTURE 09:00', 'ARRIVE 09:50']);

  // A conscious resave through alarm-commit applies precisely the previewed schedule.
  const second = await previewAndSave(env, body);
  assert.deepEqual(second.saved, second.shown);
  const participant = env.db.rows('appointment_participants').find(p => p.appointment_id === first.appointmentId);
  assert.equal(participant?.outing_prep_minutes, 45);
  assert.equal(participant?.outing_prep_source, 'PROFILE');
  assert.equal(participant?.prepare_minutes, 75);
  const actual = env.db.rows('alarms').filter(a => a.participant_id === participant?.participant_id);
  assert.equal(hm(actual.find(a => a.alarm_type === 'WAKE')?.scheduled_at), '07:45');
  assert.equal(hm(actual.find(a => a.alarm_type === 'PREPARE')?.scheduled_at), '08:15');
  assert.equal(hm(actual.find(a => a.alarm_type === 'DEPARTURE')?.scheduled_at), '09:00');
  assert.equal(env.db.rows('appointments').length, 1, 'resave must not duplicate appointments');
  assert.equal(env.db.rows('appointment_participants').length, 1, 'resave must not duplicate participants');
});

test('E2E simulation: pre-pure legacy profile retains its old wake-to-departure time on save', async () => {
  const env = setup();
  Object.assign(env.db.rows('profiles')[0], {
    default_prepare_minutes: 70,
    default_outing_prep_minutes: null,
  });
  const first = await previewAndSave(env, FULL);
  assert.deepEqual(first.saved, first.shown);
  const row = env.db.rows('appointment_participants')[0];
  assert.equal(row.prepare_minutes, 70);
  assert.equal(row.outing_prep_minutes, null);
  const next = await previewAndSave(env, {
    appointment_id: first.appointmentId,
    participant: { est_travel_minutes: 50, travel_source: 'API' },
  });
  assert.deepEqual(next.saved, next.shown);
  assert.equal(env.db.rows('appointment_participants')[0].prepare_minutes, 70);
});


test('10 verified CatBoost v2 observations change the actual AUTO alarm and persisted preparation provenance', async () => {
  const { db, ctx, commitCtx } = setup();
  Object.assign(db.rows('profiles')[0], { default_outing_prep_minutes: 40, default_prepare_minutes: 120 });
  let calls = 0;
  ctx.purePrepModelRunner = async (input) => {
    calls++;
    assert.equal(input.mode, 'live');
    assert.equal(input.purePlan, true);
    assert.equal(input.personalAppointment, true);
    assert.equal(input.manualOverride, false);
    return {
      status: 'PREDICTED', model: 'prep_start_ratio_v2',
      training_target: 'alarm_dismiss_location_proxy',
      predicted_pure_minutes: 55, history_baseline_minutes: 42,
      personalized_baseline_minutes: 40, raw_model_prediction_minutes: 57,
      onboarding_pure_minutes: 40,
      valid_records: 10, required_records: 10, applied_to_alarm: true,
    };
  };
  const draft = draftOf(FULL);
  const shown = await buildPlan(ctx, draft, { mode: 'preview' });
  const save = await buildPlan(ctx, draft, { mode: 'save' });
  assert.equal(calls, 2);
  assert.equal(shown.plan.prepareTarget, 'PREPARE_START_TO_DEPART');
  assert.equal(shown.plan.prepare.source, 'MODEL');
  assert.equal(shown.plan.prepare.mlModel, 'prep_start_ratio_v2');
  assert.equal(shown.plan.prepare.minutes, 85); // pure 55 + fixed 30 before prep
  assert.deepEqual(shown.plan.chain, save.plan.chain);
  assert.deepEqual(shown.plan.chain.map(a => a.kind + ' ' + hm(a.at.toISOString())),
    ['WAKE 07:35', 'PREPARE 08:05', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  const request = readCommitRequest(Reader.root(FULL));
  assert.equal(request.type, 'APPOINTMENT');
  if (request.type !== 'APPOINTMENT') throw new Error('not an appointment');
  const committed = await persistAppointment(commitCtx, {
    plan: save.plan, inputs: save.inputs, created: request.appointment,
    draft, edits: [], timeZone: 'Asia/Seoul',
  });
  assert.ok(committed.participant_id);
  const row = db.rows('appointment_participants').find(p => p.participant_id === committed.participant_id);
  assert.equal(row?.outing_prep_source, 'MODEL');
  assert.equal(row?.outing_prep_model, 'prep_start_ratio_v2');
  assert.equal(row?.outing_prep_minutes, 55);
  assert.equal(row?.prepare_minutes, 85);
  assert.equal(db.rows('alarms').find(a=>a.participant_id===committed.participant_id && a.alarm_type==='PREPARE')?.scheduled_at,
    new Date(iso(22, 485)).toISOString());
});

test('9 observations, unavailable model and malformed prediction all fall back; manual and group bypass the runner', async () => {
  const env = setup();
  Object.assign(env.db.rows('profiles')[0], { default_outing_prep_minutes: 40 });
  let calls = 0;
  env.ctx.purePrepModelRunner = async () => {
    calls++;
    return {
      status: 'PREDICTED', model: 'prep_start_ratio_v2', training_target: 'alarm_dismiss_location_proxy',
      predicted_pure_minutes: 55, history_baseline_minutes: 42,
      personalized_baseline_minutes: 40, raw_model_prediction_minutes: 57,
      onboarding_pure_minutes: 40, valid_records: 9, required_records: 10, applied_to_alarm: false,
    };
  };
  const underTen = await buildPlan(env.ctx, draftOf(FULL));
  assert.equal(underTen.plan.prepare.source, 'DEFAULT');
  assert.equal(underTen.plan.prepare.minutes, 70);
  env.ctx.purePrepModelRunner = async () => {
    calls++;
    return { status: 'MODEL_UNAVAILABLE', valid_records: 10, required_records: 10 };
  };
  const offline = await buildPlan(env.ctx, draftOf(FULL));
  assert.equal(offline.plan.prepare.minutes, 70);
  const manual = await buildPlan(env.ctx, draftOf({
    ...FULL, participant: {...FULL.participant, prepare_minutes: 80},
  }));
  assert.equal(manual.plan.prepare.source, 'MANUAL');
  assert.equal(calls, 2);
  const group = await buildPlan(env.ctx, {...draftOf(FULL), groupId: 'g1'});
  assert.equal(group.plan.prepare.source, 'DEFAULT');
  assert.equal(calls, 2);
});
