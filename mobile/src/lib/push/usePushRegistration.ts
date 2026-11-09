import { useEffect } from 'react';
import { AppState } from 'react-native';

import { registerPushToken } from './token';

const REFRESH_MS = 6 * 60 * 60_000; // 앞에 올 때 다시 등록하는 최소 간격 — 같은 토큰이면 last_seen_at만 갱신

// 로그인한 동안 푸시 토큰을 서버에 등록 — 로그인 직후 · 계정이 바뀔 때 · 앱이 앞에 올 때(6시간 넘었으면)
//   active = 실데이터 모드이고 앱 화면을 쓸 수 있는 상태 (useAlarmSync와 같은 값). 루트 레이아웃에서 한 번 부름
export function usePushRegistration({ active, userId }: { active: boolean; userId: string | null }) {
  useEffect(() => {
    if (!active || !userId) return;
    let last = 0;
    const register = async () => {
      last = Date.now();
      if ((await registerPushToken()) === 'failed') last = 0; // 실패하면 다음 기회에 바로 다시
    };
    void register();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - last >= REFRESH_MS) void register();
    });
    return () => subscription.remove();
  }, [active, userId]);
}
