// 계정 삭제 본문 (친구 논리설계 12장, 시험케이스 12장 함수 층) — 순서 · 본인만 · 중간 실패 뒤 이어서 · 응답 모양을 가짜 서비스로
//   로그인 없음(12-14) · 삭제 직후 같은 토큰(12-16)은 index.ts의 requireUser가 막음(auth.getUser가 없는 계정을 돌려주지 않음) — 여기서는 요청 읽기와 처리 순서만
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type AccountService, handleAccountDelete, readAccountDeleteBody, readAccountDeleteRequest, runAccountDelete } from './account.ts';
import { HttpError } from './errors.ts';
import { jsonResponse, serve } from './http.ts';
import { Reader } from './read.ts';

const ME = 'abcdef12-1111-4111-8111-aabbccddeeff'; // 16진 글자가 있어야 대소문자 비교를 시험할 수 있음
const OTHER = '22222222-2222-4222-8222-222222222222';

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

type Opts = {
  prepare?: () => { data: unknown; error: { message: string; code?: string; details?: string } | null };
  deleteUser?: () => { error: { message: string; status?: number; code?: string; details?: string } | null };
};
function fakeService(opts: Opts = {}) {
  const calls: { name: string; args?: Record<string, unknown>; argc?: number }[] = [];
  const service: AccountService = {
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(opts.prepare ? opts.prepare() : { data: { groups_left: 3, groups_deleted: 1, personal_deleted: 2, group_appointments_kept: 4 }, error: null });
    },
    auth: {
      admin: {
        deleteUser: async (...args: [string, ...unknown[]]) => {
          calls.push({ name: 'auth.admin.deleteUser', args: { id: args[0] }, argc: args.length });
          return opts.deleteUser ? opts.deleteUser() : { error: null };
        },
      },
    },
  };
  return { service, calls };
}

test('12-01 · 12-17: 준비(개인 약속 · 그룹 나가기 · 토큰) → 계정 삭제 순서, 인자 이름 p_user_id, 응답은 나간 그룹 수 · 사라진 그룹 수 · 남긴 공동 약속 수', async () => {
  const { service, calls } = fakeService();
  const result = await runAccountDelete(service, ME);
  assert.deepEqual(result, { deleted: true, groups_left: 3, groups_deleted: 1, group_appointments_kept: 4 });
  assert.deepEqual(calls.map((c) => [c.name, c.args]), [['prepare_account_delete', { p_user_id: ME }], ['auth.admin.deleteUser', { id: ME }]]);
});

test('준비가 실패하면(DB 오류) 계정을 지우지 않고 일반 문구의 500 — 이유가 사용자에게 새지 않음', async () => {
  const { service, calls } = fakeService({ prepare: () => ({ data: null, error: { message: 'secret detail', code: 'XX000' } }) });
  await quiet(() =>
    assert.rejects(
      () => runAccountDelete(service, ME),
      (e: unknown) => e instanceof HttpError && e.status === 500 && !e.message.includes('secret'),
    ),
  );
  assert.deepEqual(calls.map((c) => c.name), ['prepare_account_delete']); // deleteUser는 안 불림
});

test('준비 응답이 약속과 다르면 계정을 지우지 않음 (준비가 됐는지 확실하지 않을 때)', async () => {
  for (const data of [null, {}, { groups_left: 'x', groups_deleted: 0, group_appointments_kept: 0 }, { groups_left: 1, groups_deleted: -1, group_appointments_kept: 0 }, { groups_left: 1.5, groups_deleted: 0, group_appointments_kept: 0 }, { groups_left: 1, groups_deleted: 0, group_appointments_kept: 'x' }, { groups_left: 1, groups_deleted: 'x', group_appointments_kept: 0 }]) {
    const { service, calls } = fakeService({ prepare: () => ({ data, error: null }) });
    await quiet(() => assert.rejects(() => runAccountDelete(service, ME), (e: unknown) => e instanceof HttpError && e.status === 500));
    assert.equal(calls.filter((c) => c.name === 'auth.admin.deleteUser').length, 0);
  }
});

test('12-17: 계정 삭제 단계가 실패해도 오류만 알리고, 다시 부르면 이어서 끝남 (준비는 두 번째에 모두 0)', async () => {
  let attempt = 0;
  const { service, calls } = fakeService({
    prepare: () => ({ data: attempt === 0 ? { groups_left: 2, groups_deleted: 0, personal_deleted: 1, group_appointments_kept: 1 } : { groups_left: 0, groups_deleted: 0, personal_deleted: 0, group_appointments_kept: 0 }, error: null }),
    deleteUser: () => (attempt++ === 0 ? { error: { message: 'auth down', status: 500 } } : { error: null }),
  });
  await quiet(() => assert.rejects(() => runAccountDelete(service, ME), (e: unknown) => e instanceof HttpError && e.status === 500 && !e.message.includes('auth down')));
  const again = await runAccountDelete(service, ME);
  assert.equal(again.deleted, true);
  assert.deepEqual(calls.map((c) => c.name), ['prepare_account_delete', 'auth.admin.deleteUser', 'prepare_account_delete', 'auth.admin.deleteUser']);
});

test('이미 지워진 계정(auth에서 user_not_found, 또는 "User not found" 404)을 다시 지우려 하면 끝난 것으로 봄 — 이유 없는 일반 404(주소 오류 · 게이트웨이)는 실패', async () => {
  for (const error of [{ message: 'User not found', status: 404 }, { message: 'gone', code: 'user_not_found' }, { message: 'gone', status: 404, code: 'user_not_found' }]) {
    const { service } = fakeService({ deleteUser: () => ({ error }) });
    assert.equal((await runAccountDelete(service, ME)).deleted, true);
  }
  for (const error of [{ message: 'Not Found', status: 404 }, { message: 'upstream', status: 404, code: 'something_else' }, { message: 'User not found but 500', status: 500 }]) {
    const { service } = fakeService({ deleteUser: () => ({ error }) });
    await quiet(() => assert.rejects(() => runAccountDelete(service, ME), (e: unknown) => e instanceof HttpError && e.status === 500));
  }
});

test('오류의 상세(details)·원문은 사용자에게 새지 않음 — 준비 실패 · 삭제 실패 모두 일반 문구, 권한 오류(42501)도 403이 아니라 500', async () => {
  const secret = { message: 'secret message', code: 'XX000', details: 'secret detail' };
  const cases: [string, Opts][] = [
    ['prepare', { prepare: () => ({ data: null, error: secret }) }],
    ['prepare-42501', { prepare: () => ({ data: null, error: { ...secret, code: '42501' } }) }],
    ['delete', { deleteUser: () => ({ error: { ...secret, status: 500 } }) }],
  ];
  for (const [name, opts] of cases) {
    const { service } = fakeService(opts);
    await quiet(() =>
      assert.rejects(
        () => runAccountDelete(service, ME),
        (e: unknown) => e instanceof HttpError && e.status === 500 && e.details === undefined && !e.message.includes('secret') && !JSON.stringify(e.details ?? {}).includes('secret'),
        name,
      ),
    );
  }
});

test('계정 삭제는 되돌릴 수 있는 소프트 삭제가 아니라 완전 삭제 — deleteUser는 계정 id 하나만 받아 부름', async () => {
  const { service, calls } = fakeService();
  await runAccountDelete(service, ME);
  const del = calls.find((c) => c.name === 'auth.admin.deleteUser')!;
  assert.deepEqual([del.args, del.argc], [{ id: ME }, 1]);
});

test('준비 응답의 수는 0 이상의 정수만 — 숫자 문자열 · null · true · 소수는 확실하지 않은 응답으로 보고 계정을 지우지 않음', async () => {
  for (const bad of ['1', null, true, 1.5, -1, Number.NaN]) {
    const { service, calls } = fakeService({ prepare: () => ({ data: { groups_left: bad, groups_deleted: 0, group_appointments_kept: 0 }, error: null }) });
    await quiet(() => assert.rejects(() => runAccountDelete(service, ME), (e: unknown) => e instanceof HttpError && e.status === 500));
    assert.equal(calls.filter((c) => c.name === 'auth.admin.deleteUser').length, 0, String(bad));
  }
});

test('12-15: 본인만 — 요청이 비었거나 내 id면 통과(대소문자 무시), 다른 사람 id면 403, 형식이 틀린 id는 400, 모르는 칸은 무시', () => {
  readAccountDeleteRequest(Reader.root({}), ME);
  readAccountDeleteRequest(Reader.root({ userId: ME }), ME);
  readAccountDeleteRequest(Reader.root({ userId: ME.toUpperCase() }), ME);
  readAccountDeleteRequest(Reader.root({ userId: ME }), ME.toUpperCase()); // 로그인한 사람 id가 대문자여도 같은 사람
  assert.throws(() => readAccountDeleteRequest(Reader.root({ userId: OTHER }), ME), (e: unknown) => e instanceof HttpError && e.status === 403);
  assert.throws(() => readAccountDeleteRequest(Reader.root({ userId: 'not-a-uuid' }), ME), (e: unknown) => e instanceof HttpError && e.status === 400);
  readAccountDeleteRequest(Reader.root({ confirm: true }), ME); // 모르는 칸은 무시 (삭제 대상은 늘 로그인한 사람뿐이라 영향 없음)
  // id가 앞부분이 같고 끝만 다른 다른 사람도 거절
  assert.throws(() => readAccountDeleteRequest(Reader.root({ userId: ME.slice(0, -1) + '0' }), ME), (e: unknown) => e instanceof HttpError && e.status === 403);
  assert.throws(() => readAccountDeleteRequest(Reader.root({ userId: ME.slice(0, 30) + '99' + ME.slice(32) }), ME), (e: unknown) => e instanceof HttpError && e.status === 403);
});

test('12-15: 본문 읽기 — 본문이 아예 없거나 비었거나 공백뿐이거나 {}면 본인으로 통과(앱은 본문 없이 부름), 다른 사람 id는 403, 깨진 JSON은 400', async () => {
  const post = (body?: string) => new Request('http://localhost/account-delete', { method: 'POST', ...(body === undefined ? {} : { body }) });
  await readAccountDeleteBody(post(), ME);                         // 본문 자체가 없음
  await readAccountDeleteBody(post(''), ME);
  await readAccountDeleteBody(post('  \n '), ME);
  await readAccountDeleteBody(post('{}'), ME);
  await readAccountDeleteBody(post(JSON.stringify({ userId: ME })), ME);
  await assert.rejects(() => readAccountDeleteBody(post(JSON.stringify({ userId: OTHER })), ME), (e: unknown) => e instanceof HttpError && e.status === 403);
  await assert.rejects(() => readAccountDeleteBody(post('not json'), ME), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(() => readAccountDeleteBody(post('[1]'), ME), (e: unknown) => e instanceof HttpError && e.status === 400);   // 객체가 아님
});

// ---- 로그인 확인 · 연결 (12-14 · 12-15 · 12-16) — index.ts가 하는 일을 handleAccountDelete + serve로 시험 ----

function endpoint() {
  const fake = fakeService();
  let serviceBuilt = 0;
  const requireUser = async (req: Request) => {
    const header = req.headers.get('authorization') ?? '';
    if (header === 'Bearer deleted-token') throw new HttpError('AUTH_REQUIRED', '로그인이 만료됐어요. 다시 로그인해 주세요');   // 계정이 지워진 뒤의 같은 토큰
    if (header !== 'Bearer me') throw new HttpError('AUTH_REQUIRED', '로그인이 필요해요');
    return { userId: ME };
  };
  const handler = serve(async (req) => jsonResponse(await handleAccountDelete(req, { requireUser, service: () => { serviceBuilt++; return fake.service; } })));
  const post = (init: { auth?: string; body?: string; method?: string } = {}) =>
    handler(new Request('http://localhost/account-delete', {
      method: init.method ?? 'POST',
      headers: init.auth === undefined ? {} : { authorization: init.auth },
      ...(init.body === undefined ? {} : { body: init.body }),
    }));
  return { post, calls: fake.calls, built: () => serviceBuilt };
}

test('12-14 · 12-16: 로그인이 없거나 틀리거나 계정이 지워진 뒤의 같은 토큰이면 401 — 서비스 키를 쓰지도 않고 아무것도 지우지 않음', async () => {
  const { post, calls, built } = endpoint();
  for (const auth of [undefined, '', 'Bearer', 'Basic me', 'Bearer wrong', 'Bearer deleted-token']) {
    const res = await post({ auth, body: '{}' });
    assert.equal(res.status, 401, String(auth));
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'AUTH_REQUIRED');
  }
  assert.deepEqual([calls.length, built()], [0, 0]);
});

test('12-15: 로그인한 사람의 요청 — 본문이 없거나 {}면 본인 계정만 지우고 응답이 약속과 같음, 다른 사람 id · 깨진 본문은 서비스 키를 쓰기 전에 403 · 400', async () => {
  const bad = endpoint();
  for (const [body, status] of [[JSON.stringify({ userId: OTHER }), 403], ['not json', 400], ['[1]', 400], [JSON.stringify({ userId: 'x' }), 400]] as const) {
    const res = await bad.post({ auth: 'Bearer me', body });
    assert.equal(res.status, status, body);
  }
  assert.deepEqual([bad.calls.length, bad.built()], [0, 0]);

  const ok = endpoint();
  const res = await ok.post({ auth: 'Bearer me' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true, groups_left: 3, groups_deleted: 1, group_appointments_kept: 4 });
  assert.deepEqual(ok.calls.map((c) => [c.name, c.args]), [['prepare_account_delete', { p_user_id: ME }], ['auth.admin.deleteUser', { id: ME }]]);
});

test('12-14: POST 외의 메서드는 405, OPTIONS(CORS)는 아무것도 안 하고 통과', async () => {
  const { post, calls, built } = endpoint();
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await post({ auth: 'Bearer me', method })).status, 405, method);
  const options = await post({ method: 'OPTIONS' });
  assert.equal(options.status, 200);
  assert.deepEqual([calls.length, built()], [0, 0]);
});
