import { useEffect } from 'react';
import { AppState } from 'react-native';

import { syncNow } from './index';

// 로그인한 동안 폰 예약 · 울림 기록을 서버와 맞춤 — 로그인 직후 한 번, 그 뒤 앱이 앞에 올 때마다 (루트 레이아웃에서 한 번 부름)
// active = 실데이터 모드이고 앱 화면을 쓸 수 있는 상태 (로그인 + 프로필까지), userId가 바뀌면(계정 전환) 다시 시작
export function useAlarmSync({ active, userId, timeZone }: { active: boolean; userId: string | null; timeZone?: string | null }) {
  useEffect(() => {
    if (!active || !userId) return;
    void syncNow({ timeZone });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncNow({ timeZone });
    });
    return () => subscription.remove();
  }, [active, userId, timeZone]);
}
