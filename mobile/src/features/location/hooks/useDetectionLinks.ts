import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { parseDetectionLink } from '../link';
import { errorText, nativeNotifications } from '../native';

// 감지 안내 알림을 누르면 정정 화면(/detection)으로 — 앱이 켜져 있을 때(리스너)와 꺼진 채 알림으로 열렸을 때(getLastNotificationResponse) 둘 다
//   active = 앱 화면이 열릴 수 있는 때(로그인 · 온보딩 끝) — 그 전에 누른 알림은 기억해 뒀다가 열린 뒤에 이동 (Stack이 그려지기 전에 이동하면 오류)
//   안드로이드만. 웹 · 시험에서는 expo-notifications를 읽지 않음
//   같은 알림 응답을 두 번 처리하지 않음 — 처리한 응답은 폰 쪽 "마지막 응답"도 지워서 JS가 다시 켜져도 되풀이되지 않게
type Response = import('expo-notifications').NotificationResponse;

// 앱 전체에서 하나 — 훅이 다시 그려져도 · 두 번 붙어도 같은 응답을 한 번만 처리
const handled = new Set<string>(); // 이미 이동한 응답 — 알림 번호 + 누른 알림의 시각
const retried = new Set<string>(); // 이동에 한 번 실패해 다시 시도한 응답 — 두 번째도 실패하면 포기 (무한 반복 막기)
let pending: Response | null = null; // 누른 뒤 아직 이동하지 못한 응답
let canOpen = false;

const keyOf = (r: Response): string => `${r.notification.request.identifier}@${r.notification.date}`;

// 기억해 둔 응답이 있고 화면을 열 수 있으면 이동
function flush() {
  const response = pending;
  if (!response || !canOpen) return;
  pending = null;
  const key = keyOf(response);
  if (handled.has(key)) return;
  const link = parseDetectionLink(response.notification.request.content.data?.url);
  if (!link) return; // 감지 안내가 아닌 알림 — 이동하지 않고, 폰 쪽 마지막 응답도 건드리지 않음 (다른 알림 처리가 읽을 수 있게)
  try {
    router.push({ pathname: '/detection', params: { kind: link.kind, participantId: link.participantId, at: String(link.at) } });
  } catch (e) {
    if (__DEV__) console.warn('[location] 정정 화면으로 이동하지 못함', errorText(e));
    // 한 번은 다음 기회(화면이 다시 열릴 수 있게 된 때)에 다시 시도, 두 번째도 실패하면 포기하고 폰 쪽 응답을 지워 앱을 다시 켜도 되풀이하지 않음
    if (!retried.has(key)) {
      retried.add(key);
      pending = response;
      return;
    }
  }
  handled.add(key);
  clearLast();
}

// 처리한 응답은 폰 쪽 "마지막 응답"도 지워서 JS가 다시 켜져도 되풀이되지 않게 — 지우지 못해도 handled가 같은 실행 안에서는 막아 줌
function clearLast() {
  try {
    nativeNotifications().clearLastNotificationResponse();
  } catch {
    // 무시
  }
}

// 시험용 — 모듈 값 되돌리기
export function resetDetectionLinks() {
  handled.clear();
  retried.clear();
  pending = null;
  canOpen = false;
}

export function useDetectionLinks({ active }: { active: boolean }) {
  // 응답 받기 — 꺼진 채 열렸으면 마지막 응답이 이미 있고, 켜진 동안 누르면 리스너가 받음
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    try {
      const notifications = nativeNotifications();
      // 앞에 떠 있는 동안에도 감지 안내는 보이게 — 소리 없이. 다른 알림은 지금 앱에 없어서 그대로 안 보임(푸시를 붙일 때 L3가 이 핸들러를 넓힘)
      notifications.setNotificationHandler({
        handleNotification: async (n) => {
          const show = parseDetectionLink(n.request.content.data?.url) != null;
          return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false };
        },
      });
      pending = notifications.getLastNotificationResponse() ?? pending;
      flush();
      const subscription = notifications.addNotificationResponseReceivedListener((response) => {
        pending = response;
        flush();
      });
      return () => subscription.remove();
    } catch (e) {
      // 옛 개발용 APK처럼 네이티브가 없으면 알림 탭 이동만 안 됨 — 앱은 그대로
      if (__DEV__) console.warn('[location] 알림 탭 처리를 붙이지 못함', errorText(e));
    }
  }, []);

  useEffect(() => {
    canOpen = active;
    if (active) flush();
  }, [active]);
}
