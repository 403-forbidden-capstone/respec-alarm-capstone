// 환경 변수 읽기 — Supabase가 넣어 주는 값과 `supabase secrets set`으로 넣는 값 (supabase/functions/.env.example)
//   기본 제공: SUPABASE_URL · SUPABASE_ANON_KEY · SUPABASE_SERVICE_ROLE_KEY (legacy),
//              SUPABASE_PUBLISHABLE_KEYS · SUPABASE_SECRET_KEYS (새 키, JSON 사전). 이름이 SUPABASE_로 시작하는 비밀값은 직접 못 만듦
//   직접 넣는 것: KAKAO_REST_API_KEY · ANTHROPIC_API_KEY · ANTHROPIC_MODEL (선택) · EXPO_ACCESS_TOKEN (선택)
import { HttpError } from './errors.ts';
import { parseKeyDictionary } from './keys.ts';

export function getEnv(name: string): string | undefined {
  // Node-based pure function / FakeDb tests have no Deno global. Treat all
  // flags as disabled there, without reading unrelated process.env secrets.
  const value = typeof Deno === 'undefined' ? undefined : Deno.env.get(name);
  return value && value.trim() ? value.trim() : undefined;
}

export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) throw new HttpError('NOT_CONFIGURED', `서버 설정이 아직 안 됐어요 (${name})`);
  return value;
}

export function supabaseUrl(): string {
  return requireEnv('SUPABASE_URL');
}

// 앱 쪽 키(RLS를 따름): legacy anon 키, 없으면 새 publishable 키
export function anonKey(): string {
  const key = getEnv('SUPABASE_ANON_KEY') ?? parseKeyDictionary(getEnv('SUPABASE_PUBLISHABLE_KEYS'))[0];
  if (!key) throw new HttpError('NOT_CONFIGURED', '서버 설정이 아직 안 됐어요 (SUPABASE_ANON_KEY)');
  return key;
}

// 서버 키(RLS를 건너뜀): 서버 함수 안에서만 씀
export function serviceKeys(): string[] {
  const keys = [getEnv('SUPABASE_SERVICE_ROLE_KEY'), ...parseKeyDictionary(getEnv('SUPABASE_SECRET_KEYS'))];
  return keys.filter((k): k is string => !!k);
}

export function serviceKey(): string {
  const key = serviceKeys()[0];
  if (!key) throw new HttpError('NOT_CONFIGURED', '서버 설정이 아직 안 됐어요 (SUPABASE_SERVICE_ROLE_KEY)');
  return key;
}
