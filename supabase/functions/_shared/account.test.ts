// 계정 삭제 본문 (친구 논리설계 12장, 시험케이스 12장 함수 층) — 순서 · 본인만 · 중간 실패 뒤 이어서 · 응답 모양을 가짜 서비스로
//   로그인 없음(12-14) · 삭제 직후 같은 토큰(12-16)은 index.ts의 requireUser가 막음(auth.getUser가 없는 계정을 돌려주지 않음) — 여기서는 요청 읽기와 처리 순서만
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type AccountService, readAccountDeleteRequest, runAccountDelete } from './account.ts';
import { HttpError } from './errors.ts';
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
  prepare?: () => { data: unknown; error: { message: string; code?: string } | null };
  deleteUser?: () => { error: { message: string; status?: number; code?: string } | null };
};
function fakeService(opts: Opts = {}) {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const service: AccountService = {
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(opts.prepare ? opts.prepare() : { data: { groups_left: 3, groups_deleted: 1, personal_deleted: 2, group_appointments_kept: 4 }, error: null });
    },
    auth: {
      admin: {
        deleteUser: async (id) => {
          calls.push({ name: 'auth.admin.deleteUser', args: { id } });
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
  assert.deepEqual(calls, [{ name: 'prepare_account_delete', args: { p_user_id: ME } }, { name: 'auth.admin.deleteUser', args: { id: ME } }]);
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

test('이미 지워진 계정(auth에서 404 · user_not_found)을 다시 지우려 하면 끝난 것으로 봄', async () => {
  for (const error of [{ message: 'User not found', status: 404 }, { message: 'gone', code: 'user_not_found' }]) {
    const { service } = fakeService({ deleteUser: () => ({ error }) });
    assert.equal((await runAccountDelete(service, ME)).deleted, true);
  }
});

test('12-15: 본인만 — 요청이 비었거나 내 id면 통과(대소문자 무시), 다른 사람 id면 403, 형식이 틀린 id는 400, 모르는 칸은 무시', () => {
  readAccountDeleteRequest(Reader.root({}), ME);
  readAccountDeleteRequest(Reader.root({ userId: ME }), ME);
  readAccountDeleteRequest(Reader.root({ userId: ME.toUpperCase() }), ME);
  readAccountDeleteRequest(Reader.root({ userId: ME }), ME.toUpperCase()); // 로그인한 사람 id가 대문자여도 같은 사람
  assert.throws(() => readAccountDeleteRequest(Reader.root({ userId: OTHER }), ME), (e: unknown) => e instanceof HttpError && e.status === 403);
  assert.throws(() => readAccountDeleteRequest(Reader.root({ userId: 'not-a-uuid' }), ME), (e: unknown) => e instanceof HttpError && e.status === 400);
  readAccountDeleteRequest(Reader.root({ confirm: true }), ME); // 모르는 칸은 무시 (삭제 대상은 로그인한 사람뿐이라 영향 없음)
});
