// 호출한 쪽 확인 보안 시험 — verify_jwt = false로 두 길을 코드에서 가르는 함수(alarm-roll · voice-commit)의 문지기
//   진짜 auth.ts를 불러옴: supabase-js(npm:)만 가짜로 바꾸고(Auth 서버 = 정해 둔 토큰만 사용자로 인정), 환경 변수는 Deno.env 흉내
//   본다: 서비스 키만 배치 길(isServiceCall) · 사용자 토큰 · anon 키 · 빈 키는 배치 길 못 탐 / 본인 길(requireUser)은 Auth 서버가 인정한 토큰만
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-jwt',
  SUPABASE_SECRET_KEYS: '{"default":"sb_secret_abc"}',
};
(globalThis as { Deno?: unknown }).Deno = { env: { get: (k: string) => ENV[k] } };
(globalThis as { __getUser?: unknown }).__getUser = async (token: string) =>
  token === 'user-jwt' ? { data: { user: { id: 'u-1' } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('npm:@supabase/supabase-js')) {
      return { url: 'data:text/javascript,export const createClient = () => ({ auth: { getUser: (t) => globalThis.__getUser(t) } });', shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { isServiceCall, requireUser } = await import('./auth.ts');
const { HttpError } = await import('./errors.ts');

const req = (headers: Record<string, string>) => new Request('https://x.supabase.co/functions/v1/voice-commit', { method: 'POST', headers });

async function rejected(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    return e.code;
  }
  assert.fail('거절돼야 함');
}

test('isServiceCall: 서비스 키(legacy JWT · sb_secret_)만 배치 길', () => {
  assert.equal(isServiceCall(req({ authorization: 'Bearer service-role-jwt', apikey: 'service-role-jwt' })), true); // pg_net 배치 모양
  assert.equal(isServiceCall(req({ apikey: 'sb_secret_abc' })), true);
  assert.equal(isServiceCall(req({ authorization: 'Bearer user-jwt', apikey: 'anon-key' })), false); // 앱 요청
  assert.equal(isServiceCall(req({ authorization: 'Bearer anon-key' })), false);
  assert.equal(isServiceCall(req({})), false);
  assert.equal(isServiceCall(req({ authorization: 'Bearer service-role-jwtX' })), false);
  assert.equal(isServiceCall(req({ authorization: 'Bearer ', apikey: '' })), false);
});

test('isServiceCall: 서버에 서비스 키가 없으면 아무도 배치 길을 못 탐 (빈 키로 뚫리지 않음)', () => {
  const saved = { ...ENV };
  delete ENV.SUPABASE_SERVICE_ROLE_KEY;
  delete ENV.SUPABASE_SECRET_KEYS;
  try {
    assert.equal(isServiceCall(req({ authorization: 'Bearer service-role-jwt' })), false);
    assert.equal(isServiceCall(req({ apikey: '' })), false);
  } finally {
    Object.assign(ENV, saved);
  }
});

test('requireUser: Auth 서버가 인정한 토큰만 — 없음 · 모양 틀림 · anon 키 · 서비스 키 · 가짜 토큰은 AUTH_REQUIRED', async () => {
  assert.equal((await requireUser(req({ authorization: 'Bearer user-jwt' }))).userId, 'u-1');
  assert.equal(await rejected(requireUser(req({}))), 'AUTH_REQUIRED');
  assert.equal(await rejected(requireUser(req({ authorization: 'user-jwt' }))), 'AUTH_REQUIRED');
  assert.equal(await rejected(requireUser(req({ authorization: 'Bearer anon-key', apikey: 'anon-key' }))), 'AUTH_REQUIRED');
  assert.equal(await rejected(requireUser(req({ authorization: 'Bearer service-role-jwt' }))), 'AUTH_REQUIRED');
  assert.equal(await rejected(requireUser(req({ authorization: 'Bearer forged.jwt.token' }))), 'AUTH_REQUIRED');
});
