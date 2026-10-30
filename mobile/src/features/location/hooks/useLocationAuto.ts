import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useAction } from '@/lib/useAction';

import { getLocationStatus, openLocationSettings, requestLocationAccess, setLocationAuto, type LocationStatus } from '../permissions';
import { syncLocation } from '../register';
import { getLocationAuto } from '../store';

type Read = { status: LocationStatus; auto: boolean | null };

// 권한 · 스위치를 읽음 (던지지 않음). 폰 저장소를 못 읽으면 auto는 null
async function readAll(): Promise<Read> {
  const [status, auto] = await Promise.all([getLocationStatus(), getLocationAuto().catch(() => null)]);
  return { status, auto };
}

// 설정 카드 "출발 · 도착 자동 기록"의 상태 · 동작 (LocationAutoCard에 값 · 콜백으로 넘김)
//   · status = 위치 권한 상태, auto = 자동 기록 스위치(폰 저장, 처음엔 켜짐). 읽기 전에는 'unsupported'라 카드가 안 그려짐 (깜박임 방지)
//   · 켤 때: 앞 권한이 아예 없으면 시스템 창으로 묻고, 어느 쪽이든 스위치 값은 저장함 — 항상 허용이 모자라도 켜 둠 (권한이 생기면 바로 등록)
//   · 설정 앱에서 돌아오면(앱이 앞에 옴) 권한을 다시 읽고, 다 켜졌으면 바로 감시 목록 등록
export function useLocationAuto() {
  const [read, setRead] = useState<{ status: LocationStatus; auto: boolean }>({ status: 'unsupported', auto: true });
  const { busy, run } = useAction();

  // 화면에 반영하고 권한 상태를 돌려줌. 스위치를 못 읽었으면(auto null) 화면 값은 그대로
  const apply = useCallback((next: Read): LocationStatus => {
    setRead((prev) => ({ status: next.status, auto: next.auto ?? prev.auto }));
    return next.status;
  }, []);
  const refresh = useCallback(() => readAll().then(apply), [apply]);

  useEffect(() => {
    void readAll().then(apply);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void readAll()
        .then(apply)
        .then((next) => {
          if (next === 'on') void syncLocation({ ignoreThrottle: true });
        });
    });
    return () => subscription.remove();
  }, [apply]);

  const toggle = useCallback(
    (on: boolean) =>
      run(async () => {
        if (on && (await getLocationStatus()) === 'off') await requestLocationAccess(); // 항상 허용은 창으로 못 받음 — 카드가 설정 열기로 안내
        await setLocationAuto(on);
        await refresh();
      }, '설정을 바꾸지 못했어요'),
    [run, refresh],
  );

  const openSettings = useCallback(() => run(openLocationSettings, '설정을 열지 못했어요'), [run]);

  return { status: read.status, auto: read.auto, busy, toggle, openSettings };
}
