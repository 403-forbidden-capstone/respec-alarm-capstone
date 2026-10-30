import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { confirm } from '@/components/ui';
import { getLocationStatus, LOCATION_DISCLOSURE, openLocationSettings, requestLocationAccessFlow, type LocationStatus } from '@/features/location/permissions';

// 고지 문단 사이 빈 줄 (줄바꿈 두 개)
const PARAGRAPH = String.fromCharCode(10, 10);

// 권한 안내 단계의 위치 줄 — 상태 읽기 + [켜기]
//   · status: 마운트 때, 그리고 앱이 앞에 올 때(설정 화면에서 돌아옴) 다시 읽음. 읽기 전에는 'unsupported'라 줄이 안 그려짐
//   · request: 처음이면 눈에 띄는 고지(구글 정책: 권한 창 전에 이유 안내) → [계속]이면 앱 사용 중 창 → 항상 허용 설정 화면까지 이어 부름.
//     [나중에]면 아무것도 안 함(단계에서 [다음]으로 지나가고 위치는 설정 카드에서 켬). 앞 권한만 있어도 고지는 거침(본 적이 없을 수 있음), 정확한 위치만 켜면 되는 coarse는 바로 설정 화면
//   · 위치 자동 기록 스위치는 건드리지 않음 (설정 카드 몫)
export function useLocationRow() {
  const [status, setStatus] = useState<LocationStatus>('unsupported');

  useEffect(() => {
    let alive = true;
    const read = () => {
      void getLocationStatus().then((next) => {
        if (alive) setStatus(next);
      });
    };
    read();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') read();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  // 던지지 않음 — 실패해도 줄은 그대로 두고 사용자가 다시 누르면 됨
  const request = useCallback(async () => {
    try {
      const current = await getLocationStatus();
      // 정확한 위치만 켜면 되는 'coarse'는 이미 고지 뒤라 바로 설정 화면
      if (current === 'coarse') {
        await openLocationSettings();
        return;
      }
      // 앞 권한만 있는 사람도 고지를 거침 — 앱 밖에서 허용했거나 온보딩을 안 거쳤으면 고지를 한 번도 못 봤을 수 있고,
      // 구글 정책은 백그라운드 위치(항상 허용 설정 화면)를 요청하기 전에 눈에 띄는 고지를 요구함
      const message = [LOCATION_DISCLOSURE.body, ...LOCATION_DISCLOSURE.bullets].join(PARAGRAPH);
      if (!(await confirm({ title: LOCATION_DISCLOSURE.title, message, okLabel: '계속', cancelLabel: '나중에' }))) return;
      if (current === 'foreground-only') await openLocationSettings(); // 앞 권한은 이미 있어 시스템 창 없이 항상 허용 설정 화면으로
      else await requestLocationAccessFlow();
    } catch {
      // 시스템 창 · 설정 화면을 못 열었음 — 아래에서 상태만 다시 읽음
    } finally {
      setStatus(await getLocationStatus().catch(() => 'unsupported' as const));
    }
  }, []);

  return { status, request };
}
