import { useEffect } from 'react';
import { AppState } from 'react-native';

import { onAlarmsSynced, setDepartByLocationProvider } from '@/lib/alarmSync';
import { onSignOut } from '@/lib/session';

import { errorText } from './native';
import { clearOnSignOut, locationTrackedParticipantIds, syncLocation } from './register';

// 알람 맞추기가 출발 알람에 "위치로 출발 판단"을 실을 때 부르는 곳 — 불러오기만 해도 등록됨 (맞추기가 이 훅보다 먼저 돌 수 있어 훅 안이 아니라 모듈 위쪽)
setDepartByLocationProvider(locationTrackedParticipantIds);

// 위치 감지가 앱 전체에 거는 훅 — 루트 레이아웃에서 한 번 (useAlarmSync 옆)
//   · 로그인한 동안 못 쓴 기록 쓰기 → 지오펜스 등록을 로그인 직후 한 번(바로), 그 뒤 앱이 앞에 올 때마다(5분에 한 번까지) — register.ts syncLocation
//     실데이터 모드 · 안드로이드 · 위치 권한 · 자동 기록 스위치 조건은 syncLocation 안에서 따짐 (아니면 아무것도 안 함)
//     알람 맞추기 완료 후에도 5분 제한 없이 다시 읽어 약속 변경을 반영함
//   · 로그아웃 때 지오펜스를 끄고 폰에 둔 위치 기억을 지우도록 등록 — 다음 계정에 안 섞이게
// active = useAlarmSync와 같은 값 (실데이터 모드 + 로그인 + 프로필까지), userId가 바뀌면(계정 전환) 다시 시작
export function useLocationSync({ active, userId }: { active: boolean; userId: string | null }) {
  useEffect(
    () =>
      onSignOut(() => {
        clearOnSignOut().catch((e: unknown) => {
          if (__DEV__) console.warn('[location] 로그아웃 정리 실패', errorText(e));
        });
      }),
    [],
  );

  useEffect(() => {
    if (!active || !userId) return;
    void syncLocation({ ignoreThrottle: true });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncLocation();
    });
    const unsubscribe = onAlarmsSynced(() => syncLocation({ ignoreThrottle: true }));
    return () => {
      subscription.remove();
      unsubscribe();
    };
  }, [active, userId]);
}
