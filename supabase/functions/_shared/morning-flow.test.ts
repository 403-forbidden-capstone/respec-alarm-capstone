// 하루 재생 (이슈 #230 PR 1a) — 약속 하나를 저장한 날 서버에서 볼 수 있는 단계를 가짜 시계 · 가짜 카카오 · 가짜 DB로 차례로 확인
//   저장(길찾기 → commit) → 꾸러미 문구(준비 · 출발 · 기상 voiceText) → 기상 시각별 여유 → 출발 시각 → 늦게 일어난 날 → 새벽 1시 약속
// 서버에서 안 보이는 단계는 PR 1b: 앱의 기상 확정(H08) · 아침 흐름 화면 · 홈 카드와 getMorningPlan · 폰이 알림을 띄우는 모습
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { departNow, departSlack } from './calc/depart.ts';
import { MINUTE_MS } from './calc/time.ts';
import { assertPersistable, persistAppointment, type CommitCtx } from './commit.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import type { FetchLike } from './kakao.ts';
import { buildPlan, type PlanContext } from './plan.ts';
import { Reader } from './read.ts';
import { readCommitRequest } from './requests.ts';
import type { Db } from './supabase.ts';
import { formatKoTime } from './tz.ts';

const USER = 'u-me';
const TZ = 'Asia/Seoul';
// 2025년 5월 day일 한국 시각 minutes분 — 가짜 시계의 지금
const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * MINUTE_MS);
const iso = (day: number, minutes: number) => `2025-05-${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00+09:00`;
const ko = (d: Date | number) => formatKoTime(new Date(d), TZ);

// 가짜 카카오 대중교통: 앞뒤가 도보인 한 경로(도보 API를 더 안 부름), 총 seconds초
const transit = (seconds: number) => ({
  status: 'OK',
  routes: [
    {
      properties: { type: 'SUBWAY', totalTime: seconds },
      steps: [
        { properties: { type: 'WALKING' }, path: { points: [[127.0, 37.5], [127.01, 37.51]] } },
        { properties: { type: 'SUBWAY' }, path: { points: [[127.01, 37.51], [127.05, 37.54]] } },
        { properties: { type: 'WALKING' }, path: { points: [[127.05, 37.54], [127.07, 37.55]] } },
      ],
    },
  ],
});
const fakeKakao =
  (seconds: number): FetchLike =>
  async (input) =>
    new URL(input).pathname.endsWith('/publictraffic') ? new Response(JSON.stringify(transit(seconds)), { status: 200 }) : new Response('not found', { status: 404 });

function setup(now: Date, travelSeconds: number) {
  const db = new FakeDb();
  db.rows('profiles').push({ user_id: USER, timezone: TZ, default_buffer_minutes: 10, default_transport: 'TRANSIT', home_name: '집', home_lat: 37.5, home_lng: 127.0 });
  const ctx: PlanContext = { userId: USER, db: db as unknown as Db, now, kakaoKey: 'KEY', fetchImpl: fakeKakao(travelSeconds) };
  const commitCtx: CommitCtx = { userId: USER, userDb: db as unknown as Db, service: db as unknown as Db, now };
  return { db, ctx, commitCtx };
}

// 앱이 보내는 요청 그대로: 이동은 안 보내서 가짜 카카오가 구함, 준비 60분 · 준비 전 활동 · 여유 10분
const request = (appointmentAt: string, beforePrepareMinutes: number) => ({
  appointment: { title: '전공 수업', appointment_at: appointmentAt, destination: { name: '광개토관', lat: 37.55, lng: 127.07 }, importance: 'NORMAL' },
  participant: { origin: { name: '집', lat: 37.5, lng: 127.0 }, transport_type: 'TRANSIT', buffer_minutes: 10, prepare_minutes: 60, before_prepare_minutes: beforePrepareMinutes },
});

async function commit(env: ReturnType<typeof setup>, body: object) {
  const req = readCommitRequest(Reader.root(body));
  if (req.type !== 'APPOINTMENT') throw new Error('unreachable');
  const built = await buildPlan(env.ctx, req.draft);
  assertPersistable(built.plan);
  const saved = await persistAppointment(env.commitCtx, {
    plan: built.plan,
    inputs: built.inputs,
    created: req.appointment,
    draft: req.draft,
    replaceExisting: req.replaceExisting,
    edits: req.edits,
    timeZone: built.timeZone,
  });
  return { plan: built.plan, packages: Object.fromEntries(saved.ring_packages.map((p) => [p.type, p])) };
}

test('하루 재생: 10시 수업 저장 → 문구 → 기상 시각별 여유 → 출발 시각 → 늦잠', async () => {
  // 오전 6:40 저장. 가짜 카카오가 대중교통 50분을 줌
  const env = setup(kst(22, 400), 3000);
  const { plan, packages } = await commit(env, request(iso(22, 600), 30));

  // 1. 저장 — 알람 시각은 기존 계산 그대로 (기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 9:50)
  assert.equal(plan.travelMinutes, 50);
  assert.deepEqual(Object.values(packages).map((p) => `${p.type} ${ko(p.atMillis)}`), ['WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);

  // 2. 꾸러미 문구 — 새 알림을 늘리지 않고 준비 · 출발 알림에 합침, 기상은 voiceText만
  assert.equal(packages.PREPARE.notice, '오전 9:00 출발까지 30분');
  assert.equal(packages.DEPARTURE.notice, '지금 나가면 오전 9:50 도착 · 여유 10분');
  assert.equal(packages.WAKE.voiceText, '좋은 아침이에요. 오늘 첫 일정은 오전 10시 전공 수업이에요. 오전 9시에 나가면 돼요.');
  assert.equal(packages.WAKE.notice, undefined);
  assert.deepEqual([packages.ARRIVE.notice, packages.ARRIVE.voiceText], [undefined, undefined]);
  assert.equal(packages.WAKE.subtitle, '오전 10:00 · 광개토관'); // 부제는 그대로

  // 3. 기상 시각별 여유 (상세설계서 7.5.2 표) — 앱이 기상을 확정한 시각(PR 1b)을 넣을 자리
  const afterWake = (wake: Date) => departSlack({ appointmentAt: plan.basics.at, travelMinutes: plan.travelMinutes, now: wake, remainingMinutes: plan.prepare.minutes });
  assert.deepEqual(afterWake(kst(22, 480)), { slackMinutes: 10, status: 'COMFORT' }); // 정시 기상
  assert.deepEqual(afterWake(kst(22, 485)), { slackMinutes: 5, status: 'TIGHT' }); // 5분 미룸
  assert.deepEqual(afterWake(kst(22, 505)), { slackMinutes: -15, status: 'LATE_RISK' }); // 늦잠

  // 4. 출발 시각 — 출발 알림 글자의 도착 · 여유와 departNow가 같은 값
  const leave = departNow({ appointmentAt: plan.basics.at, travelMinutes: plan.travelMinutes, now: new Date(packages.DEPARTURE.atMillis) });
  assert.deepEqual([ko(leave.arriveAt), leave.slackMinutes, leave.status], ['오전 9:50', 10, 'COMFORT']);

  // 5. 늦게 일어난 날 — 출발 시각(9:00)이 지난 9:20에 일어남: 준비를 다 하면 지각 위험, 바로 나가도 10분 늦음
  assert.deepEqual(afterWake(kst(22, 560)), { slackMinutes: -70, status: 'LATE_RISK' });
  const lateLeave = departNow({ appointmentAt: plan.basics.at, travelMinutes: plan.travelMinutes, now: kst(22, 560) });
  assert.deepEqual([ko(lateLeave.arriveAt), lateLeave.slackMinutes], ['오전 10:10', -10]);
  // 서버는 출발 시각이 지난 뒤의 다시 저장을 지금도 막음 (문구는 저장할 때 정해진 채 그대로, 다시 계산하지 않음)
  const after = setup(kst(22, 545), 3000);
  const req = readCommitRequest(Reader.root(request(iso(22, 600), 30)));
  if (req.type !== 'APPOINTMENT') throw new Error('unreachable');
  const built = await buildPlan(after.ctx, req.draft);
  assert.throws(() => assertPersistable(built.plan), (e: unknown) => e instanceof HttpError && e.code === 'UNPROCESSABLE' && (e.details as { reason: string }).reason === 'DEPARTURE_PASSED');
});

test('새벽 1시 약속(하루 경계): 알람은 전날 밤에 울리고 문구는 그 시각 그대로 — 날짜는 글자에 안 나옴', async () => {
  // 21:00 저장, 다음 날 새벽 1:00 약속, 이동 30분 → 출발 0:20 · 기상 전날 23:20 · 준비 23:40 (준비 전 활동 20분)
  const env = setup(kst(22, 1260), 1800);
  const { plan, packages } = await commit(env, request(iso(23, 60), 20));

  assert.deepEqual(
    Object.values(packages).map((p) => [p.type, new Date(p.atMillis).toISOString()]),
    [
      ['WAKE', kst(22, 1400).toISOString()], // 22일 23:20 — 약속(23일 1:00)보다 하루 앞선 날짜
      ['PREPARE', kst(22, 1420).toISOString()],
      ['DEPARTURE', kst(23, 20).toISOString()], // 23일 0:20
      ['ARRIVE', kst(23, 50).toISOString()],
    ],
  );
  assert.equal(packages.PREPARE.notice, '오전 12:20 출발까지 40분');
  assert.equal(packages.DEPARTURE.notice, '지금 나가면 오전 12:50 도착 · 여유 10분');
  assert.equal(packages.WAKE.voiceText, '좋은 아침이에요. 오늘 첫 일정은 오전 1시 전공 수업이에요. 오전 12시 20분에 나가면 돼요.');

  // 여유 계산은 날짜를 보지 않고 밀리초 차이라 자정을 넘어도 같은 표
  const afterWake = (wake: Date) => departSlack({ appointmentAt: plan.basics.at, travelMinutes: plan.travelMinutes, now: wake, remainingMinutes: plan.prepare.minutes });
  assert.deepEqual(afterWake(kst(22, 1400)), { slackMinutes: 10, status: 'COMFORT' });
  assert.deepEqual(afterWake(kst(22, 1405)), { slackMinutes: 5, status: 'TIGHT' });
  assert.deepEqual(afterWake(kst(22, 1425)), { slackMinutes: -15, status: 'LATE_RISK' });
});
