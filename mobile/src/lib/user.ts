// 지금 로그인한 사용자 — 가볍게 가져다 쓰도록 lib/auth(expo-linking · 브라우저 로그인)와 따로 둠
// 실데이터 쿼리(features/*/real.ts)가 "내 것"으로 좁힐 때 requireUserId()를 부름 (RLS는 친구에게 받은 알람 · 그룹원 정보도 보여 주므로 user_id로 한 번 더 좁힘)
import { UserError } from './errors';
import { supabase } from './supabase';

export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

// 로그인 화면이 막고 있어 실데이터 모드에서는 늘 있어야 하지만, 세션이 막 끝난 순간(만료 · 다른 기기 로그아웃)을 위해 던짐
export async function requireUserId(): Promise<string> {
  const id = await currentUserId();
  if (!id) throw new UserError('로그인이 필요해요');
  return id;
}
