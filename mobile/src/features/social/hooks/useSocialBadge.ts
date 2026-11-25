// 아래 탭 '그룹' 아이콘 배지 — 받은 친구 요청 + 받은 그룹 초대 수
//   · 탭 막대(layout)가 열릴 때 · 그룹 탭이 앞에 올 때 읽고, 친구와 그룹 화면에서 수락 · 거절하면 그 화면이 바로 새 값을 넣음(setSocialBadge)
//   · 못 읽으면 배지만 안 보임 (덧붙임이라 화면은 그대로)
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { listFriendRequests, listGroupInvites } from '@/features/social/api';

let count = 0;
const listeners = new Set<() => void>();

export function setSocialBadge(next: number) {
  if (next === count) return;
  count = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useSocialBadge(): number {
  const value = useSyncExternalStore(subscribe, () => count);
  const refresh = useCallback(() => {
    Promise.all([listFriendRequests(), listGroupInvites()]).then(
      ([requests, invites]) => setSocialBadge(requests.length + invites.length),
      () => undefined,
    );
  }, []);
  useEffect(refresh, [refresh]);
  return value;
}
