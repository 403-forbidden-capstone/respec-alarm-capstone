// buildPlan(DB에서 읽기 + 이동시간 정하기) — 가짜 DB로. 좌표가 없을 때의 폴백, 미리 보기 = 저장 대조
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertPersistable, persistAppointment, type CommitCtx } from './commit.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { buildPlan, TravelRequiredError, type PlanContext } from './plan.ts';
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
  const preview = await buildPlan(ctx, draftOf(body), { wantAutoTravel: true });
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
