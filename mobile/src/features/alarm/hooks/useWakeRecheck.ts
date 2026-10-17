import { useEffect } from 'react';
import { AppState } from 'react-native';

import { recheckRecentWakes } from '../api';

// 로그인 직후 한 번, 그 뒤 앱이 앞에 올 때마다 — 최근 12시간에 끈 기상 알람 중 아직 확정이 없는 것을 H08과 같은 판정으로 다시 보고 조건을 채웠으면 확정 기록 (루트 레이아웃에서 한 번 부름)
//   알람을 끈 뒤 H08을 안 열면 앱 JS가 판정을 못 돌려 서버가 약 49분 뒤 기상 미확인(MISSED)으로 적기 때문 (7장 A "판정은 해제 10분 뒤에 나고")
//   active = useAlarmSync와 같은 조건(실데이터 모드 + 앱 화면을 쓸 수 있는 상태). 실패는 개발 중에만 콘솔 — 다음 기회에 다시 보고, H08에서도 같은 판정이 돎
export function useWakeRecheck({ active, userId }: { active: boolean; userId: string | null }) {
  useEffect(() => {
    if (!active || !userId) return;
    const run = () => {
      recheckRecentWakes().catch((e: unknown) => {
        if (__DEV__) console.warn('[wake] 기상 판정 다시 보기 실패', e);
      });
    };
    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => subscription.remove();
  }, [active, userId]);
}
