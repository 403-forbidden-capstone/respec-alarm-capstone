// 아래 탭 '그룹' 아이콘 배지 — 받은 친구 요청 + 받은 그룹 초대 수
//   · 탭 막대(layout)가 열릴 때 한 번 읽고, 그룹 탭 화면이 목록을 읽을 때 · 친구와 그룹 화면에서 수락 · 거절할 때 그 화면이 새 값을 넣음(setSocialBadge)
//   · 로그아웃 정리(lib/session onSignOut)에서 0으로 — 앞 계정 숫자가 남지 않게. 못 읽을 때도 0 (덧붙임이라 화면은 그대로, 배지만 안 보임)
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { onSignOut } from '@/lib/session';
import { listFriendRequests, listGroupInvites } from '@/features/social/api';

let count = 0;
// 로그아웃 · 계정 전환 때 비움
onSignOut(() => setSocialBadge(0));

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
      () => setSocialBadge(0),
    );
  }, []);
  useEffect(refresh, [refresh]);
  return value;
}
