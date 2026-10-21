import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { getMyProfile, MOCK_PROFILE } from '@/features/profile/api';
import type { Profile } from '@/features/profile/types';
import { userMessage } from '@/lib/errors';
import { ONBOARDING_IN_FLOW } from '@/lib/flags';
import { canUseRealData, useMode } from '@/lib/mode';
import { supabase } from '@/lib/supabase';

import { shouldOnboard } from './onboardingGate';

type AuthState = {
  session: Session | null;
  profile: Profile | null; // 내 profiles 행 (가입하면 DB가 만들어 둠)
  profileError: string | null; // 프로필을 못 읽었으면 문자열(보여 줄 이유, 없으면 ''), 읽었으면 null. 못 읽었을 때는 온보딩으로 보내지 않고 다시 시도
  loading: boolean; // 저장된 세션 · 프로필을 읽는 중
  enabled: boolean; // 실데이터 모드라 로그인이 필요한지 (false면 가짜 데이터 모드 — 로그인 없이 가짜 프로필로 탭)
  needsOnboarding: boolean; // 로그인했고 프로필도 읽었는데 아이디를 아직 안 정함. 온보딩을 흐름에서 뺀 동안(lib/flags ONBOARDING_IN_FLOW = false)은 늘 false
  refreshProfile: () => Promise<void>; // 다시 읽음. 실패하면 기존 프로필은 그대로 두고 오류를 던짐
};

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  profileError: null,
  loading: true,
  enabled: false,
  needsOnboarding: false,
  refreshProfile: async () => {},
});

// 어느 사용자의 프로필인지 같이 들고 있어야, 로그인 직후 프로필을 읽기 전에 온보딩이 잠깐 뜨지 않음
// "못 읽음"(error)과 "읽었는데 아이디가 없음"(profile.handle이 null)은 다른 상태 — 못 읽었을 때 온보딩으로 보내면 저장해 둔 기본값을 덮어씀
type Loaded = { userId: string | null; profile: Profile | null; error: string | null };
const EMPTY: Loaded = { userId: null, profile: null, error: null };

// 못 읽은 이유 — UserError일 때만 그 이유, Supabase · 네트워크 원문은 빈 글자 (CLAUDE.md 화면 규칙). 빈 글자여도 "못 읽음"은 맞음
const errorMessage = (e: unknown) => userMessage(e, '');

// 로그인 상태 · 내 프로필을 앱 전체에 알려 줌 — 화면에서는 useAuth()
// 데이터 모드(lib/mode.ts)가 가짜면 세션은 그대로 두고(로그인 유지) 화면에는 가짜 프로필만 보여 줌
// 세션 · 프로필은 모드와 상관없이 읽어 둠 — 실데이터로 돌아올 때 프로필을 다시 읽느라 화면 묶음이 비지 않게
// 실데이터를 못 쓰면(Supabase 연결 안 됨 · lib/flags REAL_DATA_READY = false) 세션 · 프로필을 아예 읽지 않음 (#116)
export function AuthProvider({ children }: { children: ReactNode }) {
  const { mode, ready: modeReady } = useMode();
  const real = canUseRealData && mode === 'real';
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(canUseRealData);
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!canUseRealData) return;
    // 저장된 세션을 못 읽어도(AsyncStorage 오류 등) 시작 화면에 멈추지 않게 함
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => setSession(null))
      .finally(() => setSessionLoading(false));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  // 로그인한 사용자가 바뀌면 프로필을 읽음. 로그아웃하면 비워서 다음 로그인 때 이전 프로필이 잠깐 쓰이지 않게 함
  useEffect(() => {
    if (!userId) {
      setLoaded((prev) => (prev.userId == null ? prev : EMPTY));
      return;
    }
    let cancelled = false;
    getMyProfile(userId)
      .then((profile) => {
        if (!cancelled) setLoaded({ userId, profile, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoaded({ userId, profile: null, error: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // 온보딩 · 설정에서 저장한 뒤, 또는 못 읽은 뒤 다시 시도할 때 — 실패하면 기존 값은 그대로 두고 호출한 쪽에 오류를 넘김
  const refreshProfile = useCallback(async () => {
    if (!userId) return;
    const profile = await getMyProfile(userId);
    setLoaded({ userId, profile, error: null });
  }, [userId]);

  const profileReady = userId == null || loaded.userId === userId;
  const current = userId != null && loaded.userId === userId ? loaded : EMPTY;

  const value: AuthState = real
    ? {
        session,
        profile: current.profile,
        profileError: current.error,
        loading: !modeReady || sessionLoading || !profileReady,
        enabled: true,
        // 읽기에 성공했는데 아이디가 없을 때만 온보딩 — 못 읽은 경우는 루트 레이아웃이 다시 시도 화면을 보여 줌 (판단은 onboardingGate.ts)
        needsOnboarding: shouldOnboard({
          inFlow: ONBOARDING_IN_FLOW,
          signedIn: session != null,
          profileReady,
          profileFailed: current.error != null,
          handle: current.profile?.handle,
        }),
        refreshProfile,
      }
    : {
        session: null,
        profile: MOCK_PROFILE,
        profileError: null,
        loading: !modeReady,
        enabled: false,
        needsOnboarding: false,
        refreshProfile,
      };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
