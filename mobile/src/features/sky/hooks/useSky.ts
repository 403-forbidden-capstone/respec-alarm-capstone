import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useNow } from '@/features/alarm/hooks/useNow';

import { getSky } from '../api';
import { skyPreview } from '../preview';
import { DEFAULT_SKY, SKY_REFRESH_MS, skyPhase, type Sky, type SkyKind, type SkyPhase } from '../sky';

// 화면에 떠 있는 동안의 하늘 — 날씨는 30분마다 다시 읽고(탭끼리 같은 값을 나눠 씀), 시간대는 30초마다 지금 시각으로 판정
// 날씨를 읽기 전 · 못 읽었을 때는 맑음 (시간대 색만)
// preview: 개발용 미리 보기 값인지 — 맞으면 홈이 인사말도 그 시간대에 맞춤
export function useSky(): { kind: SkyKind; phase: SkyPhase; preview: boolean } {
  const current = useNow();
  const [sky, setSky] = useState<Sky>(DEFAULT_SKY);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const read = () => void getSky().then((next) => alive && setSky(next));
      read();
      const id = setInterval(read, SKY_REFRESH_MS);
      return () => {
        alive = false;
        clearInterval(id);
      };
    }, []),
  );
  const preview = skyPreview(); // 개발용 — /dev/sky에서 고른 값이 있으면 그걸 그림
  if (preview) return { ...preview, preview: true };
  return { kind: sky.kind, phase: skyPhase(current, sky.sunrise, sky.sunset), preview: false };
}
