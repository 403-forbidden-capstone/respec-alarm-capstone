import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { getMyProfile } from '@/features/profile/api';
import type { Profile } from '@/features/profile/types';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

type AuthState = {
  session: Session | null;
  profile: Profile | null; // 내 profiles 행 (가입하면 DB가 만들어 둠)
  loading: boolean; // 저장된 세션 · 프로필을 읽는 중
  enabled: boolean; // Supabase가 연결돼 있어 로그인이 필요한지 (false면 목업 모드)
  needsOnboarding: boolean; // 로그인했지만 아이디를 아직 안 정함
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  loading: true,
  enabled: false,
  needsOnboarding: false,
  refreshProfile: async () => {},
});

// 로그인 상태 · 내 프로필을 앱 전체에 알려 줌 — 화면에서는 useAuth()
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(isSupabaseConfigured);
  // 어느 사용자의 프로필인지 같이 들고 있어야, 로그인 직후 프로필을 읽기 전에 온보딩이 잠깐 뜨지 않음
  const [loaded, setLoaded] = useState<{ userId: string | null; profile: Profile | null }>({ userId: null, profile: null });
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  // 로그인한 사용자가 바뀌면 프로필을 읽음. 못 읽으면 온보딩으로 보냄 — 저장할 때 오류가 화면에 보임
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    getMyProfile(userId)
      .then((profile) => {
        if (!cancelled) setLoaded({ userId, profile });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ userId, profile: null });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // 온보딩 · 설정에서 저장한 뒤 다시 읽을 때
  const refreshProfile = useCallback(async () => {
    if (!userId) return;
    try {
      setLoaded({ userId, profile: await getMyProfile(userId) });
    } catch {
      setLoaded({ userId, profile: null });
    }
  }, [userId]);

  const profileReady = userId == null || loaded.userId === userId;
  const profile = userId != null && loaded.userId === userId ? loaded.profile : null;

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        loading: sessionLoading || !profileReady,
        enabled: isSupabaseConfigured,
        needsOnboarding: isSupabaseConfigured && session != null && profileReady && !profile?.handle,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
