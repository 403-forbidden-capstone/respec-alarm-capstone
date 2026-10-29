// 알림 채널 — expo-notifications로 만드는 채널(로컬 · 푸시)의 id와 등록 코드는 이 파일 한 곳에만 둠
// 알람 코어(Kotlin)가 따로 만드는 채널은 여기 없음: alarm_notice_v1(AlarmNotifications.kt) · wake_alarm_native_v1(AlarmPlaybackService.kt)
// 푸시 채널은 푸시 토큰을 붙일 때 여기에 더함 (L3). 채널은 만든 뒤 이름 · 설명 말고는 못 바꾸므로(안드로이드 규칙) 설정을 바꿀 땐 id를 새로 정함 (detect_v1 → detect_v2)
//
// 감지 안내(detect_v1) — 출발 · 도착을 위치로 자동 기록했을 때 알리는 알림. L6 안건후보: 감지 안내 정정 · 채널 기본안 — 소리 · 진동 없는 채널 (사용자가 시스템 설정에서 바꿀 수는 있음)
import { Platform } from 'react-native';

export const DETECT_CHANNEL_ID = 'detect_v1';

// 앱을 켤 때마다 불러도 됨 (같은 id면 덮어쓰기). 안드로이드만 — 웹 · iOS에는 채널이 없어 아무 일도 안 함
// expo-notifications는 웹에서 불러오기만 해도 경고 로그가 나므로 안드로이드일 때만 불러옴 (파일 위쪽 import 대신 여기서 require)
export async function ensureNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 웹에서는 모듈을 읽지 않으려고 안드로이드일 때 여기서만 읽음
    const { AndroidImportance, setNotificationChannelAsync } = require('expo-notifications') as typeof import('expo-notifications');
    await setNotificationChannelAsync(DETECT_CHANNEL_ID, {
      name: '자동 기록 확인',
      description: '출발 · 도착을 위치로 자동 기록했을 때 소리 없이 알려요',
      importance: AndroidImportance.LOW,
      sound: null,
      enableVibrate: false,
    });
  } catch (e) {
    // 채널을 못 만들어도 앱은 그대로 — 다음 시작 때 다시 만듦 (옛 개발용 APK처럼 네이티브가 없을 때도)
    if (__DEV__) console.warn('[push] 알림 채널 만들기 실패', e);
  }
}
