// 친구가 보낸 깨우기 알림(푸시 종류 WAKE_PING) 거두기 — 내가 일어나 기상을 확정하면 알림창에 남은 깨우기 알림은 의미가 없음 (폰 NEW-1)
//   expo-notifications는 안드로이드에서만 부름 (웹 · 시험에서 불러오기만 해도 경고가 나므로 부를 때 require — features/location/native와 같은 방식)
//   못 거둬도(권한 · 이미 사라짐) 던지지 않음 — 알림이 남아도 기상 기록에는 영향 없음
import { Platform } from 'react-native';

export async function clearWakePingNotices(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 안드로이드일 때만 읽음
    const notifications = require('expo-notifications') as typeof import('expo-notifications');
    const shown = await notifications.getPresentedNotificationsAsync();
    await Promise.allSettled(
      shown.filter((n) => n.request.content.data?.kind === 'WAKE_PING').map((n) => notifications.dismissNotificationAsync(n.request.identifier)),
    );
  } catch {
    // 알림창을 못 읽으면 그대로 둠
  }
}
