// 알림창 비우기 — 로그아웃 때 앞 계정의 알림(감지 안내 · 서버 푸시 · 깨우기 · 예약해 둔 로컬 알림)이 폰에 남지 않게 (사건 뒤 정리, 로그아웃 G11)
//   알람 코어가 띄운 알림(일정 알림 · 확인 알림)은 AlarmCore.cancelAll이 따로 거둠. 여기는 expo-notifications 쪽
//   안드로이드만 — expo-notifications는 웹에서 불러오기만 해도 경고 로그가 나므로 안드로이드일 때만 불러옴. 던지지 않음 (부르는 쪽이 삼킴)
import { Platform } from 'react-native';

export async function clearNotificationTray(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 웹에서는 모듈을 읽지 않으려고 안드로이드일 때 여기서만 읽음
  const Notifications = require('expo-notifications') as typeof import('expo-notifications');
  await Promise.allSettled([Notifications.dismissAllNotificationsAsync(), Notifications.cancelAllScheduledNotificationsAsync()]);
}
