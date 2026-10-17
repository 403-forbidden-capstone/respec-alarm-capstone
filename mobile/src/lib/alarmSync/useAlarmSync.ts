import { useEffect } from 'react';
import { AppState } from 'react-native';

import { setSigningOut, syncNow } from './index';

// 로그인한 동안 폰 예약 · 울림 기록을 서버와 맞춤 — 로그인 직후 한 번, 그 뒤 앱이 앞에 올 때마다 (루트 레이아웃에서 한 번 부름)
// active = 실데이터 모드이고 앱 화면을 쓸 수 있는 상태 (로그인 + 프로필까지), userId가 바뀌면(계정 전환) 다시 시작
export function useAlarmSync({ active, userId, timeZone }: { active: boolean; userId: string | null; timeZone?: string | null }) {
  // 로그인(계정이 null → 값으로 바뀜)하면 앞 로그아웃이 켜 둔 "로그아웃 중" 표시를 끔. userId만 보므로 로그아웃 도중(userId는 아직 그대로)에는 안 풀림. 아래 효과보다 먼저 선언해야 첫 맞추기가 안 막힘
  useEffect(() => {
    if (userId) setSigningOut(false);
  }, [userId]);

  useEffect(() => {
    if (!active || !userId) return;
    void syncNow({ timeZone });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncNow({ timeZone });
    });
    return () => subscription.remove();
  }, [active, userId, timeZone]);
}
