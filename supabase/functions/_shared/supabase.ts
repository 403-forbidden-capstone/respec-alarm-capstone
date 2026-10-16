// Supabase 클라이언트 두 가지
//   createUserClient — 부른 사람의 토큰을 실어서 RLS를 그대로 따름 (읽기 · 권한 확인에 우선 씀)
//   createServiceClient — 서비스 키라 RLS를 건너뜀. 쓰기 전에 꼭 직접 권한을 확인하고, 사용자가 보낸 값으로 쿼리를 만들지 않음
// npm: 가져오기는 이 파일 한 군데에서만 (버전 관리 한 곳). 서버 함수에는 세션 저장이 필요 없음
// 버전은 앱(mobile/package.json)이 쓰는 supabase-js와 같은 정확한 버전으로 고정 — 배포 시점마다 다른 2.x가 묶이지 않게. 앱을 올리면 여기도 같이
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.2';

import { anonKey, serviceKey, supabaseUrl } from './env.ts';

// 생성된 앱 타입(mobile/src/types/database.ts)은 함수 폴더 밖이라 배포에 안 실림 → 타입 없는 클라이언트 + 각 파일의 행 타입
// deno-lint-ignore no-explicit-any
export type Db = SupabaseClient<any, 'public', any>;

const SERVER_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export function createUserClient(authorization: string): Db {
  return createClient(supabaseUrl(), anonKey(), {
    global: { headers: { Authorization: authorization } },
    auth: SERVER_AUTH,
  });
}

export function createServiceClient(): Db {
  return createClient(supabaseUrl(), serviceKey(), { auth: SERVER_AUTH });
}
