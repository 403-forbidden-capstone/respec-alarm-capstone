// 호출한 쪽 확인
//   requireUser — 사용자 토큰(Authorization: Bearer)을 Auth 서버에 물어 확인 (auth.getUser). 게이트웨이의 JWT 검증(verify_jwt)이 한 번 더 막음
//   requireServiceCall — 배치 · 서버끼리 부르는 함수. 서비스 키와 같은 키를 실었는지 직접 비교 (config.toml에서 verify_jwt = false인 함수만)
//   isServiceCall — 같은 비교를 던지지 않고 true · false로 (alarm-roll처럼 한 함수가 배치 길 · 본인 길을 둘 다 가질 때 길을 가름)
import { serviceKeys } from './env.ts';
import { HttpError } from './errors.ts';
import { matchesAnyKey } from './keys.ts';
import { createUserClient, type Db } from './supabase.ts';

export type AuthedUser = {
  userId: string;
  token: string;
  db: Db; // 이 사용자의 RLS를 따르는 클라이언트
};

export async function requireUser(req: Request): Promise<AuthedUser> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new HttpError('AUTH_REQUIRED', '로그인이 필요해요');
  const token = match[1].trim();
  const db = createUserClient(`Bearer ${token}`);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError('AUTH_REQUIRED', '로그인이 만료됐어요. 다시 로그인해 주세요');
  return { userId: data.user.id, token, db };
}

export function isServiceCall(req: Request): boolean {
  return matchesAnyKey(req.headers, serviceKeys());
}

export function requireServiceCall(req: Request): void {
  if (!isServiceCall(req)) {
    throw new HttpError('AUTH_REQUIRED', '서버 전용 함수예요');
  }
}
