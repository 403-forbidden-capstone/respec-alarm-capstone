// notify 본문 (친구 논리설계 11장, 시험케이스 11장 함수 층) — 종류별 고정 문구 · 권한 거절 · 그룹은 받는 사람을 서버가 고름 ·
// 토큰 없음 · 만료 토큰 삭제 · 영수증 표 · 채널 · 받는 사람 id를 가짜 DB(rpc 포함)와 가짜 Expo 서버로
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { readNotifyRequest, runNotify, type NotifyRequest } from './notify.ts';
import { Reader } from './read.ts';
import type { Db } from './supabase.ts';

const SENDER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ALARM = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';
const APPT = '66666666-6666-4666-8666-666666666666';
const R1 = '77777777-7777-4777-8777-777777777777';
const R2 = '88888888-8888-4888-8888-888888888888';
const T1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const T2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const T3 = 'ExponentPushToken[cccccccccccccccccccccc]';
const T4 = 'ExponentPushToken[dddddddddddddddddddddd]';

const request = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({ kind: 'ALARM_CHANGED', targetUserId: TARGET, ...over });

type Sent = { to: string; title: string; body: string; channelId?: string; data: Record<string, unknown> };

// can_send_push는 DB 함수라 여기서는 종류별로 "SENDER → TARGET이면 허용"으로 흉내 (WAKE_PING은 8장 전이라 늘 거절)
function setup(allowed: string[] = ['ALARM_CHANGED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED']) {
  const db = new FakeDb();
  db.rpcHandlers.can_send_push = (a) => allowed.includes(String(a.p_kind)) && a.p_sender_id === SENDER && a.p_target_id === TARGET;
  db.rows('alarms').push({ alarm_id: ALARM, user_id: TARGET });
  db.rows('profiles').push({ user_id: SENDER, nickname: '수연', timezone: 'Asia/Seoul' }, { user_id: TARGET, nickname: '지형', timezone: 'Asia/Seoul' }, { user_id: OTHER, nickname: '남', timezone: 'Asia/Seoul' });
  db.rows('push_tokens').push({ user_id: TARGET, token: T1 }, { user_id: TARGET, token: T2 }, { user_id: OTHER, token: T3 });
  const pushes: Sent[] = [];
  let calls = 0;
  const fetchImpl = (tickets: (to: string, i: number) => unknown) => async (_url: string, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(init?.body as string) as Sent[];
    pushes.push(...body);
    return new Response(JSON.stringify({ data: body.map((b, i) => tickets(b.to, i)) }));
  };
  return { db, service: db as unknown as Db, pushes, fetchImpl, calls: () => calls };
}
const okAll = (to: string) => ({ status: 'ok', id: `ticket-${to.slice(-6, -1)}` });
const noSleep = async () => {};

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

test('권한이 있으면 받는 사람의 토큰 전부(폰 2대)에 보냄 — 다른 사람 토큰은 안 건드림, can_send_push 인자 이름, 문구는 서버가 정함 (11-05 · 11-08)', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  const result = await runNotify(service, SENDER, request({ alarmId: ALARM, previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:10:00Z' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep });

  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.deepEqual(db.rpcCalls, [{ name: 'can_send_push', args: { p_sender_id: SENDER, p_target_id: TARGET, p_kind: 'ALARM_CHANGED' } }]);
  assert.deepEqual(pushes.map((p) => p.to).sort(), [T1, T2]);
  assert.equal(pushes[0].title, '알람이 바뀌었어요');
  assert.equal(pushes[0].body, '수연님이 알람을 바꿨어요 · 07:00 → 07:10');
  assert.equal(pushes[0].channelId, 'alarm_change_v1');
  // 알림 데이터: 종류 · 받는 사람 id(앱이 계정 대조) · 이동 경로 · 알람 id
  assert.deepEqual(pushes[0].data, { kind: 'ALARM_CHANGED', recipientUserId: TARGET, path: '/alarms', alarmId: ALARM });
});

test('알람 바뀜 문구의 시각은 받는 사람 시간대의 HH:mm', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  db.rows('profiles').find((p) => p.user_id === TARGET)!.timezone = 'America/New_York';
  await runNotify(service, SENDER, request({ previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:10:00Z' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.equal(pushes[0].body, '수연님이 알람을 바꿨어요 · 17:00 → 17:10');
});

test('11-09: 옛 앱이 보낸 title · body · data는 무시하고 고정 문구를 씀 — 요청은 받음 (남이 쓴 문구가 알림이 되지 않음)', async () => {
  const { service, pushes, fetchImpl } = setup();
  const req = readNotifyRequest(Reader.root({ kind: 'FRIEND_REQUEST', targetUserId: TARGET, title: '무료 쿠폰', body: '링크를 누르세요', data: { path: '/evil', recipientUserId: OTHER } }));
  assert.deepEqual(req, { kind: 'FRIEND_REQUEST', targetUserId: TARGET });
  await runNotify(service, SENDER, req, { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.ok(pushes.every((p) => p.title === '친구 요청' && p.body === '새 친구 요청이 도착했어요'));
  assert.ok(pushes.every((p) => p.data.recipientUserId === TARGET && p.data.path === '/friends'));
});

test('11-11: 권한이 없으면 403 — 토큰도 Expo도 건드리지 않음', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  await assert.rejects(
    () => runNotify(service, OTHER, request(), { fetchImpl: fetchImpl(okAll), sleep: noSleep }),
    (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === 'FORBIDDEN' && e.message.includes('권한'),
  );
  assert.deepEqual(pushes, []);
  assert.ok(!db.calls.includes('select push_tokens'));
});

test('깨우기(WAKE_PING)는 8장 전이라 DB 함수가 거절하는 대로 403, 허용되면 보낸 사람 이름이 든 고정 문구 (11-05 · 11-28)', async () => {
  const { service, pushes, fetchImpl } = setup();
  await assert.rejects(
    () => runNotify(service, SENDER, request({ kind: 'WAKE_PING' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep }),
    (e: unknown) => e instanceof HttpError && e.status === 403 && e.message.includes('깨우기'),
  );
  assert.deepEqual(pushes, []);

  const open = setup(['WAKE_PING']);
  const result = await runNotify(open.service, SENDER, request({ kind: 'WAKE_PING' }), { fetchImpl: open.fetchImpl(okAll), sleep: noSleep });
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.deepEqual(open.pushes.map((p) => [p.title, p.body, p.channelId, p.data.path]), [['깨우기', '수연님이 깨워요', 'friend_v1', '/wake'], ['깨우기', '수연님이 깨워요', 'friend_v1', '/wake']]);
});

test('11-12 · 11-13: 친구 요청은 받는 사람에게만, 수락은 요청한 사람에게만 — 요청 채널, 고정 문구', async () => {
  const { service, pushes, fetchImpl } = setup();
  await runNotify(service, SENDER, request({ kind: 'FRIEND_REQUEST' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  await runNotify(service, SENDER, request({ kind: 'FRIEND_ACCEPTED' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.ok(pushes.every((p) => p.channelId === 'request_v1' && p.data.recipientUserId === TARGET));
  assert.deepEqual([...new Set(pushes.map((p) => p.body))].sort(), ['새 친구 요청이 도착했어요', '친구 요청이 수락됐어요']);
  assert.ok(!pushes.some((p) => p.to === T3)); // 남의 토큰에는 안 감
});

test('알람 id는 받는 사람의 알람이어야 함 (남의 알람 id로 알림을 꾸미지 못함)', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  db.rows('alarms').push({ alarm_id: '99999999-9999-4999-8999-999999999999', user_id: OTHER });
  await assert.rejects(
    () => runNotify(service, SENDER, request({ alarmId: '99999999-9999-4999-8999-999999999999' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep }),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
  assert.deepEqual(pushes, []);
});

test('11-22: 받는 사람의 토큰이 없으면(권한 거부 · 앱 삭제) 오류가 아니라 { sent: 0, reason: NO_TOKENS }', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  db.tables.push_tokens = [];
  assert.deepEqual(await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(okAll), sleep: noSleep }), { sent: 0, failed: 0, reason: 'NO_TOKENS' });
  assert.deepEqual(pushes, []);
});

<<<<<<< HEAD
test('11-17: 받는 사람이 탈퇴해 프로필이 없으면 권한 판정 · 토큰 조회 없이 조용히 무시 (NO_TOKENS와 같은 응답)', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  db.tables.profiles = db.rows('profiles').filter((p) => p.user_id !== TARGET);
  const result = await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.deepEqual(result, { sent: 0, failed: 0, reason: 'NO_TOKENS' });
  assert.deepEqual(pushes, []);
  assert.deepEqual(db.rpcCalls, []);
=======
test('11-17 · 15-나: 없는 · 탈퇴한 · 권한 없는 · 차단된 대상은 모두 같은 403 — 권한 판정이 먼저라 사용자 존재 여부가 응답으로 드러나지 않음', async () => {
  const GHOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const outcome = async (target: string, kind: NotifyRequest['kind'] = 'ALARM_CHANGED', mutate?: (db: FakeDb) => void) => {
    const { db, service, pushes, fetchImpl } = setup();
    mutate?.(db);
    try {
      await runNotify(service, SENDER, request({ kind, targetUserId: target }), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
      return { ok: true, pushes: pushes.length };
    } catch (e) {
      return { status: e instanceof HttpError ? e.status : -1, message: (e as Error).message, pushes: pushes.length };
    }
  };
  for (const kind of ['ALARM_CHANGED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'WAKE_PING'] as const) {
    const noPermission = await outcome(OTHER, kind);                               // 있지만 권한 없음(차단도 같은 거절)
    const neverExisted = await outcome(GHOST, kind);                               // 처음부터 없는 id
    const withdrawn = await outcome(TARGET, kind, (db) => {                         // 탈퇴: 프로필이 사라지고 권한 판정도 거절
      db.tables.profiles = db.rows('profiles').filter((p) => p.user_id !== TARGET);
      db.rpcHandlers.can_send_push = () => false;
    });
    assert.equal(noPermission.status, 403, kind);
    assert.deepEqual(neverExisted, noPermission, kind);
    assert.deepEqual(withdrawn, noPermission, kind);
  }
});

test('11-17(순서): 권한이 있는 대상만 프로필 · 토큰을 읽음 — 권한 거절이면 프로필 · 토큰 조회 없이 끝', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  const reads: string[] = [];
  const from = db.from.bind(db);
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => { reads.push(t); return from(t); };
  await assert.rejects(() => runNotify(service, SENDER, request({ targetUserId: OTHER }), { fetchImpl: fetchImpl(okAll), sleep: noSleep }), (e: unknown) => e instanceof HttpError && e.status === 403);
  assert.deepEqual(reads, []);
  assert.deepEqual(pushes, []);
>>>>>>> origin/main
});

test('11-06: 접수된 푸시는 영수증 표에 기록하고(영수증은 15분 뒤 배치가 확인), 접수 단계에서 만료로 돌아온 토큰은 바로 지움', async () => {
  const { db, service, fetchImpl } = setup();
  const tickets = (to: string) => (to === T2 ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket-1' });
  const result = await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(tickets), sleep: noSleep });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.deepEqual(db.rows('push_tokens').filter((t) => t.user_id === TARGET).map((t) => t.token), [T1]);
  assert.equal(db.rows('push_tokens').filter((t) => t.user_id === OTHER).length, 1); // 다른 사람 토큰은 그대로
  assert.deepEqual(db.rows('push_tickets').map((t) => ({ ticket_id: t.ticket_id, user_id: t.user_id, token: t.token, kind: t.kind })), [{ ticket_id: 'ticket-1', user_id: TARGET, token: T1, kind: 'ALARM_CHANGED' }]);
});

test('영수증 표에 넣다 실패해도 푸시 자체는 성공으로 돌려줌 (기록은 다음 배치를 위한 것)', async () => {
  const { db, service, fetchImpl } = setup();
  db.failOn.push({ table: 'push_tickets', op: 'insert' });
  const result = await quiet(() => runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(okAll), sleep: noSleep }));
  assert.deepEqual(result, { sent: 2, failed: 0 });
});

test('11-20 · 11-21: Expo 장애는 한 번 다시 보내 보고 안 되면 요청은 성공 + PUSH_UNAVAILABLE, 설정 없음(FCM 키 · 401)은 PUSH_NOT_CONFIGURED', async () => {
  const { service, fetchImpl } = setup();
  const noKey = await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(() => ({ status: 'error', message: 'no fcm', details: { error: 'InvalidCredentials' } })), sleep: noSleep });
  assert.deepEqual(noKey, { sent: 0, failed: 2, reason: 'PUSH_NOT_CONFIGURED' });
  const unauthorized = await runNotify(service, SENDER, request(), { accessToken: 'WRONG', fetchImpl: async () => new Response('{}', { status: 401 }), sleep: noSleep });
  assert.deepEqual(unauthorized, { sent: 0, failed: 2, reason: 'PUSH_NOT_CONFIGURED' });
  let attempts = 0;
  const down = await runNotify(service, SENDER, request(), { fetchImpl: async () => { attempts += 1; return new Response('{}', { status: 503 }); }, sleep: noSleep });
  assert.equal(down.reason, 'PUSH_UNAVAILABLE');
  assert.equal(attempts, 2); // 처음 + 다시 한 번
});

test('11-20: 한 번 실패 뒤 다시 보내서 되면 성공', async () => {
  const { service } = setup();
  let attempts = 0;
  const result = await runNotify(service, SENDER, request(), {
    sleep: noSleep,
    fetchImpl: async (_url, init) => {
      attempts += 1;
      if (attempts === 1) return new Response('{}', { status: 502 });
      const body = JSON.parse(init?.body as string) as Sent[];
      return new Response(JSON.stringify({ data: body.map((b) => okAll(b.to)) }));
    },
  });
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.equal(attempts, 2);
});

test('권한 판정 DB 함수가 실패하면 일반 문구의 500 (원문은 안 보임)', async () => {
  const { db, service } = setup();
  db.rpcHandlers.can_send_push = () => {
    throw new Error('relation "secret_table" missing');
  };
  await quiet(() =>
    assert.rejects(
      () => runNotify(service, SENDER, request()),
      (e: unknown) => e instanceof HttpError && e.status === 500 && !e.message.includes('secret_table'),
    ),
  );
});

test('11-18 · 11-19: 연달아 5건도 건마다 하나씩(합치거나 건너뛰지 않음), 새벽이든 낮이든 시각으로 막지 않음 — 재촉 · 묶음 필드 없음', async () => {
  const { service, pushes, fetchImpl, calls } = setup();
  for (let i = 0; i < 5; i += 1) await runNotify(service, SENDER, request({ kind: 'FRIEND_REQUEST' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.equal(calls(), 5);
  assert.equal(pushes.length, 10); // 폰 2대 × 5건
  assert.ok(pushes.every((p) => !('collapseId' in p) && !('ttl' in p) && !('_contentAvailable' in p)));
});

// ---- 그룹 알림 ------------------------------------------------------------------------------

function groupSetup(plan: unknown) {
  const s = setup();
  s.db.rpcHandlers.plan_group_push = () => plan;
  // 받는 사람은 R1 · R2, 보낸 사람 쪽 TARGET과 앱이 지정해 본 OTHER의 토큰은 가면 안 되는 토큰
  s.db.tables.push_tokens = [{ user_id: TARGET, token: T1 }, { user_id: R1, token: T3 }, { user_id: R2, token: T4 }, { user_id: OTHER, token: 'ExponentPushToken[eeeeeeeeeeeeeeeeeeeeee]' }];
  return s;
}

test('11-14 · 11-15: 새 멤버 알림 — 앱은 그룹 id만 보내고 받는 사람은 서버가 고름(앱이 넘긴 대상 id는 무시), 그룹 채널 · 그룹 이름만 든 문구(사람 이름 없음)', async () => {
  const { db, service, pushes, fetchImpl } = groupSetup({ status: 'OK', group_name: '캡스톤팀', appointment_title: null, recipients: [R1, R2] });
  const req = readNotifyRequest(Reader.root({ kind: 'GROUP_MEMBER_JOINED', groupId: GROUP, targetUserId: OTHER }));
  assert.deepEqual(req, { kind: 'GROUP_MEMBER_JOINED', groupId: GROUP });
  const result = await runNotify(service, SENDER, req, { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.deepEqual(db.rpcCalls, [{ name: 'plan_group_push', args: { p_sender_id: SENDER, p_group_id: GROUP, p_kind: 'GROUP_MEMBER_JOINED', p_appointment_id: null } }]);
  assert.deepEqual(pushes.map((p) => [p.to, p.data.recipientUserId]).sort(), [[T3, R1], [T4, R2]]); // 보낸 사람 · 앱이 지정한 OTHER 토큰은 안 감
  assert.ok(pushes.every((p) => p.title === '캡스톤팀' && p.body === '새 멤버가 들어왔어요' && p.channelId === 'group_v1' && p.data.path === '/group' && p.data.groupId === GROUP));
  assert.ok(!JSON.stringify(pushes).includes('수연'));
});

test('공동 약속 변경 알림: 약속 id를 DB 함수에 넘기고 약속 제목이 든 문구, 알림 데이터에 약속 id', async () => {
  const { db, service, pushes, fetchImpl } = groupSetup({ status: 'OK', group_name: '캡스톤팀', appointment_title: '팀 회의', recipients: [R1] });
  const result = await runNotify(service, SENDER, { kind: 'GROUP_APPT_CHANGED', groupId: GROUP, appointmentId: APPT }, { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.deepEqual(db.rpcCalls[0].args, { p_sender_id: SENDER, p_group_id: GROUP, p_kind: 'GROUP_APPT_CHANGED', p_appointment_id: APPT });
  assert.deepEqual(pushes[0].body, '‘팀 회의’ 약속이 바뀌었어요');
  assert.deepEqual(pushes[0].data, { kind: 'GROUP_APPT_CHANGED', recipientUserId: R1, path: '/group', groupId: GROUP, appointmentId: APPT });
});

test('그룹 알림 권한 없음(FORBIDDEN)은 403 — 토큰 조회 없음, 받는 사람이 아무도 없거나 토큰이 없으면 NO_TOKENS', async () => {
  const forbidden = groupSetup({ status: 'FORBIDDEN' });
  await assert.rejects(
    () => runNotify(forbidden.service, SENDER, { kind: 'GROUP_MEMBER_JOINED', groupId: GROUP }, { fetchImpl: forbidden.fetchImpl(okAll), sleep: noSleep }),
    (e: unknown) => e instanceof HttpError && e.status === 403,
  );
  assert.deepEqual(forbidden.pushes, []);
  assert.ok(!forbidden.db.calls.includes('select push_tokens'));

  const empty = groupSetup({ status: 'OK', group_name: '혼자', appointment_title: null, recipients: [] });
  assert.deepEqual(await runNotify(empty.service, SENDER, { kind: 'GROUP_MEMBER_JOINED', groupId: GROUP }, { fetchImpl: empty.fetchImpl(okAll), sleep: noSleep }), { sent: 0, failed: 0, reason: 'NO_TOKENS' });
  assert.ok(!empty.db.calls.includes('select push_tokens'));

  const noTokens = groupSetup({ status: 'OK', group_name: '토큰없음', appointment_title: null, recipients: [OTHER] });
  noTokens.db.tables.push_tokens = [];
  assert.deepEqual(await runNotify(noTokens.service, SENDER, { kind: 'GROUP_MEMBER_JOINED', groupId: GROUP }, { fetchImpl: noTokens.fetchImpl(okAll), sleep: noSleep }), { sent: 0, failed: 0, reason: 'NO_TOKENS' });
});

test('그룹 알림 DB 함수가 이상한 값을 돌려주면(모양 밖) 일반 문구의 500', async () => {
  const { service, fetchImpl } = groupSetup({ weird: true });
  await quiet(() =>
    assert.rejects(
      () => runNotify(service, SENDER, { kind: 'GROUP_MEMBER_JOINED', groupId: GROUP }, { fetchImpl: fetchImpl(okAll), sleep: noSleep }),
      (e: unknown) => e instanceof HttpError && e.status === 500,
    ),
  );
});

// ---- 요청 읽기 -----------------------------------------------------------------------------

test('요청 읽기: 종류별 필수 칸 — 한 사람 종류는 targetUserId, 그룹 종류는 groupId(약속 변경은 appointmentId도), 모르는 종류 · 서버 전용 종류 · 이상한 UUID · 시각은 한 번에 알려 줌 (11-10)', () => {
  const ok = readNotifyRequest(Reader.root({ kind: 'ALARM_CHANGED', targetUserId: TARGET, alarmId: ALARM, previousAt: '2026-11-08T22:00:00Z', newAt: '2026-11-08T22:10:00Z' }));
  assert.deepEqual(ok, { kind: 'ALARM_CHANGED', targetUserId: TARGET, alarmId: ALARM, previousAt: '2026-11-08T22:00:00.000Z', newAt: '2026-11-08T22:10:00.000Z' }); // 시각은 ISO로 정리

  const issues = (input: unknown) => {
    try {
      readNotifyRequest(Reader.root(input));
      return 'no-error';
    } catch (e) {
      assert.ok(e instanceof HttpError && e.status === 400);
      return (e.details as { issues: { path: string }[] }).issues.map((i) => i.path).sort().join();
    }
  };
  assert.equal(issues({ kind: 'SPAM', targetUserId: 'x' }), 'kind,targetUserId');
  assert.equal(issues({ kind: 'WAKE_MISSED', targetUserId: TARGET }), 'kind'); // 미확인 본인은 서버 배치만
  assert.equal(issues({ kind: 'WAKE_PING' }), 'targetUserId');
  assert.equal(issues({ kind: 'FRIEND_REQUEST', targetUserId: 'not-a-uuid' }), 'targetUserId');
  assert.equal(issues({ kind: 'GROUP_MEMBER_JOINED' }), 'groupId');
  assert.equal(issues({ kind: 'GROUP_APPT_CHANGED', groupId: GROUP }), 'appointmentId');
  assert.equal(issues({ kind: 'ALARM_CHANGED', targetUserId: TARGET, previousAt: 'yesterday', newAt: 'x'.repeat(50) }), 'newAt,previousAt');
  assert.equal(issues({}), 'kind');
  assert.equal(issues({ kind: 'GROUP_APPT_CHANGED', groupId: GROUP, appointmentId: APPT }), 'no-error');
});

test('알람 id는 알람 바뀜에만 — 다른 종류에 실려 와도 읽을 때 버리고, 알림 데이터에도 안 실림 (남의 알람 id를 시험하는 길을 막음)', async () => {
  const parsed = readNotifyRequest(Reader.root({ kind: 'FRIEND_REQUEST', targetUserId: TARGET, alarmId: ALARM }));
  assert.deepEqual(parsed, { kind: 'FRIEND_REQUEST', targetUserId: TARGET });
  const { db, service, pushes, fetchImpl } = setup();
  db.rows('alarms').push({ alarm_id: '99999999-9999-4999-8999-999999999999', user_id: OTHER });
  // 이미 읽은 요청에 알람 id가 남아 있어도(직접 부른 경우) 다른 종류는 알람을 조회하지도 데이터에 싣지도 않음
  const result = await runNotify(service, SENDER, request({ kind: 'FRIEND_REQUEST', alarmId: '99999999-9999-4999-8999-999999999999' }), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
  assert.equal(result.sent, 2);
  assert.ok(pushes.every((p) => !('alarmId' in p.data)));
});

test('11-20: 보내지 못한 이유(설정 없음 · Expo 장애)는 서버 로그에 남고, 잘 보내면 로그 없음', async () => {
  const { service, fetchImpl } = setup();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(() => ({ status: 'error', message: 'no fcm', details: { error: 'InvalidCredentials' } })), sleep: noSleep });
    await runNotify(service, SENDER, request(), { fetchImpl: async () => new Response('{}', { status: 503 }), sleep: noSleep });
    const clean = logged.length;
    await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(okAll), sleep: noSleep });
    assert.equal(logged.length, clean);
  } finally {
    console.error = original;
  }
  assert.match(logged[0], /PUSH_NOT_CONFIGURED/);
  assert.match(logged[1], /PUSH_UNAVAILABLE/);
});
