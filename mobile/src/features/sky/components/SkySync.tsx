import { useEffect, useState, useSyncExternalStore } from 'react';

import { now } from '@/lib/clock';
import { setSkyTone } from '@/lib/skyTone';

import { getSky } from '../api';
import { onSkyPreview, skyPreview } from '../preview';
import { DEFAULT_SKY, SKY_REFRESH_MS, skyAccent, skyBase, skyPhase, skyTop, type Sky } from '../sky';

const TICK_MS = 30_000;

// 지금 하늘의 바탕 톤 · 포인트 색을 lib/skyTone에 넣어 둠 — 루트에 하나만 두고 아무것도 그리지 않음
//   모든 화면 틀(Screen)의 바탕과 버튼 · 스위치의 포인트 색이 이 값을 읽음. 탭 밖 화면(로그인 · 온보딩 · 설정 …)도 같은 톤
//   날씨는 30분마다, 시간대는 30초마다 다시 판정 (useSky와 같은 주기). 개발용 미리 보기 값이 있으면 그 값
export function SkySync() {
  const [sky, setSky] = useState<Sky>(DEFAULT_SKY);
  const [current, setCurrent] = useState(() => now());
  const preview = useSyncExternalStore(onSkyPreview, skyPreview, skyPreview);

  useEffect(() => {
    let alive = true;
    const read = () => void getSky().then((next) => alive && setSky(next));
    read();
    const weather = setInterval(read, SKY_REFRESH_MS);
    const clock = setInterval(() => setCurrent(now()), TICK_MS);
    return () => {
      alive = false;
      clearInterval(weather);
      clearInterval(clock);
    };
  }, []);

  const top = preview ? skyTop(preview.kind, preview.phase) : skyTop(sky.kind, skyPhase(current, sky.sunrise, sky.sunset));
  useEffect(() => {
    setSkyTone({ base: skyBase(top), accent: skyAccent(top) });
  }, [top]);

  return null;
}
