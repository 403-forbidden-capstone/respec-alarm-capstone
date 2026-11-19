import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

// 기상 판정을 다시 읽는 주기 — H08(wake.tsx)과 홈 "기상 확인 중" 카드가 같은 값 (관찰 10분이 끝나면 확정 · 확인 알림으로 넘어감)
export const WAKE_POLL_MS = 15_000;

// 홈의 "기상 확인 중" 카드가 떠 있는 동안(active) 홈 내용을 주기적으로 다시 읽음 — 판정(getWakeInProgress → getWakeCheck)은 읽을 때 확정되므로
//   화면을 포커스할 때만 읽으면 조건을 채워도 카드가 상세 화면에 들어갈 때까지 남음. 카드가 없으면 타이머를 만들지 않고, 사라지면(active=false) 멈춤 · 홈 화면이 가려져 있어도 멈춤
export function useWakeCardRefresh(active: boolean, reload: () => unknown) {
  useFocusEffect(
    useCallback(() => {
      if (!active) return;
      const id = setInterval(() => void reload(), WAKE_POLL_MS);
      return () => clearInterval(id);
    }, [active, reload]),
  );
}
