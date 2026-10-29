// '@/lib/user' 껍데기 (loader.mjs 참고) — 하네스에는 로그인한 사용자가 없음
export async function requireUserId(): Promise<string> {
  throw new Error('sim-week: requireUserId는 하네스에서 못 부름 — 순수 함수만 부를 것');
}
export async function currentUserId(): Promise<string | null> {
  return null;
}
