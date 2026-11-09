import { router, type Href } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { syncNow } from '@/lib/alarmSync';
import { isPushData } from '@/lib/push/kinds';

import { needsAlarmSync, needsGroupTabBelow, pushHref } from './link';

// 서버 푸시(친구 · 그룹 알림)를 눌렀을 때 화면 이동 · 받았을 때 폰 알람 맞추기 — 안드로이드만, 웹 · 시험에서는 expo-notifications를 읽지 않음
//   active = 앱 화면이 열릴 수 있는 때(로그인 · 온보딩 끝) — 그 전에 누른 알림은 기억해 뒀다가 열린 뒤에 이동 (로그인 전에 눌렀으면 로그인 뒤 그 화면, 11-23)
//   userId = 지금 로그인한 계정 — 알림의 받는 사람과 다르면 홈 (11-24). 이동하는 순간의 값으로 판단 (기억해 두는 동안 계정이 바뀔 수 있음)
//   감지 안내 같은 로컬 알림(data.kind 없음)은 건드리지 않음 — features/location/hooks/useDetectionLinks가 맡음
//   앞에 떠 있는 동안 알림 배너는 useDetectionLinks가 건 핸들러가 띄움(lib/push/kinds showsInForeground)
type Response = import('expo-notifications').NotificationResponse;
type Incoming = import('expo-notifications').Notification;

const handled = new Set<string>(); // 이미 이동한 응답 — 같은 응답을 두 번 처리하지 않음 (실행 동안)
const keyOf = (r: Response): string => `${r.notification.request.identifier}@${r.notification.date}`;

// 시험용
export function resetPushLinks() {
  handled.clear();
}

// 알림으로 열린 화면에서 뒤로 가면 그 탭 첫 화면 (친구 14-자) — 그룹 쪽은 그룹 탭을 밑에 깔고 올림. 이미 화면이 쌓여 있으면 걷어 내고 탭으로 (navigate만 쓰면 탭 묶음이 하나 더 쌓임)
function openPushHref(href: Href) {
  if (needsGroupTabBelow(href)) {
    const tab = { pathname: '/group', params: { seg: 'group', open: String(Date.now()) } } as const;
    if (router.canDismiss()) router.dismissTo(tab);
    else router.navigate(tab);
  }
  router.push(href);
}

export function usePushLinks({ active, userId }: { active: boolean; userId: string | null }) {
  const pending = useRef<Response | null>(null);
  const live = useRef({ active, userId });

  // 기억해 둔 응답이 있고 화면을 열 수 있으면 이동
  const flush = useRef(() => {
    const response = pending.current;
    const { active: canOpen, userId: me } = live.current;
    if (!response || !canOpen) return;
    pending.current = null;
    const key = keyOf(response);
    if (handled.has(key)) return;
    const data = response.notification.request.content.data;
    const href = pushHref(data, me);
    if (!href) return; // 푸시가 아닌 알림 — 건드리지 않음
    handled.add(key);
    if (needsAlarmSync(data, me)) void syncNow();
    try {
      openPushHref(href);
    } catch (e) {
      if (__DEV__) console.warn('[push] 알림 화면으로 이동하지 못함', e);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- 안드로이드일 때만 읽음
      (require('expo-notifications') as typeof import('expo-notifications')).clearLastNotificationResponse();
    } catch {
      // 지우지 못해도 handled가 같은 실행 안의 되풀이를 막음
    }
  });

  // 열릴 수 있게 되면(로그인 · 온보딩 끝) · 계정이 바뀌면 기억해 둔 응답을 처리 — 아래 응답 받기보다 먼저 선언해야 값이 최신
  useEffect(() => {
    live.current = { active, userId };
    if (active) flush.current();
  }, [active, userId]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- 안드로이드일 때만 읽음
      const notifications = require('expo-notifications') as typeof import('expo-notifications');
      const last = notifications.getLastNotificationResponse(); // 앱이 꺼진 채 알림으로 열린 경우
      if (last && isPushData(last.notification.request.content.data)) pending.current = last;
      flush.current();
      const tapped = notifications.addNotificationResponseReceivedListener((response) => {
        if (!isPushData(response.notification.request.content.data)) return;
        pending.current = response;
        flush.current();
      });
      // 앞에 떠 있는 동안 받으면 폰 알람만 다시 맞춤 (화면은 안 옮김). 조용한 푸시도 여기로 옴
      const received = notifications.addNotificationReceivedListener((n: Incoming) => {
        const data = n.request.content.data;
        if (needsAlarmSync(data, live.current.userId)) void syncNow();
      });
      return () => {
        tapped.remove();
        received.remove();
      };
    } catch (e) {
      // 옛 개발용 APK처럼 네이티브가 없으면 알림 탭 이동만 안 됨 — 앱은 그대로
      if (__DEV__) console.warn('[push] 알림 처리를 붙이지 못함', e);
    }
  }, []);


}
