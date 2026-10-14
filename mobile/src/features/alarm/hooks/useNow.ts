import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { now } from '@/lib/clock';

// 화면에 떠 있는 동안 지금 시각을 주기적으로 다시 읽음 — "N분 뒤" · 지남 표시가 화면을 연 때 값에 멈춰 있지 않게
// 화면에 돌아올 때도 바로 다시 읽음. 가짜 데이터 모드의 시각(lib/clock)은 시나리오 시각이라 안 변함
export function useNow(intervalMs = 30_000) {
  const [current, setCurrent] = useState(() => now());
  useFocusEffect(
    useCallback(() => {
      setCurrent(now());
      const id = setInterval(() => setCurrent(now()), intervalMs);
      return () => clearInterval(id);
    }, [intervalMs]),
  );
  return current;
}
