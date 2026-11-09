// 웹 미리보기 패널용 — 실데이터에서 화면 목록의 가짜 id 자리에 넣을 내 데이터(첫 친구 · 첫 그룹 · 다음 알람)를 읽음
//   로그인한 실데이터 모드에서만 읽고, 화면을 옮길 때마다 다시 읽음(친구를 맺거나 약속을 만든 뒤 바로 반영). 읽는 중에는 앞에서 읽은 값을 그대로 둠
//   읽기에 실패한 것은 없는 것으로 봄 (그 줄은 흐리게 보임) — 개발용 패널이라 오류 문구는 띄우지 않음
import { useEffect, useState } from 'react';

import { getNextAlarm } from '@/features/alarm/api';
import { listFriends, listGroups } from '@/features/social/api';

import { EMPTY_TARGETS } from './screenNav';
import type { ScreenTargets } from './screenList';

export function useScreenTargets(enabled: boolean, refreshKey: string): { targets: ScreenTargets; loading: boolean } {
  const [state, setState] = useState<{ targets: ScreenTargets; loaded: boolean }>({ targets: EMPTY_TARGETS, loaded: false });

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void Promise.all([listFriends().catch(() => []), listGroups().catch(() => []), getNextAlarm().catch(() => null)]).then(([friends, groups, next]) => {
      if (!live) return;
      setState({
        loaded: true,
        targets: {
          friendId: friends[0]?.person.id ?? null,
          groupId: groups[0]?.id ?? null,
          appointmentId: next?.appointment.id ?? null,
          alarmId: next?.alarm.id ?? null,
        },
      });
    });
    return () => {
      live = false;
    };
  }, [enabled, refreshKey]);

  // 꺼져 있으면(가짜 모드 · 로그인 전) 읽은 값을 쓰지 않음
  return enabled ? { targets: state.targets, loading: !state.loaded } : { targets: EMPTY_TARGETS, loading: false };
}
