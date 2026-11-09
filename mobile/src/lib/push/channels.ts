// 알림 채널 — expo-notifications로 만드는 채널(로컬 · 푸시)의 id와 등록 코드는 이 파일 한 곳에만 둠
// 알람 코어(Kotlin)가 따로 만드는 채널은 여기 없음: alarm_notice_v1(AlarmNotifications.kt) · wake_alarm_native_v1(AlarmPlaybackService.kt)
// 채널은 만든 뒤 이름 · 설명 말고는 못 바꾸므로(안드로이드 규칙) 설정을 바꿀 땐 id를 새로 정함 (detect_v1 → detect_v2)
//
// 감지 안내(detect_v1) — 출발 · 도착을 위치로 자동 기록했을 때 알리는 알림. L6 안건후보: 감지 안내 정정 · 채널 기본안 — 소리 · 진동 없는 채널 (사용자가 시스템 설정에서 바꿀 수는 있음)
// 푸시 5개(친구 논리설계 11장) — 서버(supabase/functions/_shared/push-copy.ts CHANNEL_IDS)가 알림마다 채널 id를 실어 보냄.
//   기기에 그 id의 채널이 없으면 안드로이드가 알림을 안 보여 주므로, 토큰 등록(lib/push/token.ts)보다 먼저 만듦
import { Platform } from 'react-native';

export const DETECT_CHANNEL_ID = 'detect_v1';

export const FRIEND_CHANNEL_ID = 'friend_v1'; // 깨우기 · 그룹원이 아직 안 일어났어요 · 후속
export const ALARM_CHANGE_CHANNEL_ID = 'alarm_change_v1'; // 친구가 내 알람을 바꿈
export const REQUEST_CHANNEL_ID = 'request_v1'; // 친구 요청 · 수락
export const GROUP_CHANNEL_ID = 'group_v1'; // 새 멤버 · 공동 약속 바뀜 · 취소
export const MISSED_CHANNEL_ID = 'missed_v1'; // 내 기상 확인이 안 됨

type PushChannel = { id: string; name: string; description: string; importance: 'HIGH' | 'DEFAULT' };

// 방해가 큰 것(깨우기 · 내 알람 · 기상 미확인)은 소리 · 헤드업, 요청 · 그룹 소식은 기본
export const PUSH_CHANNELS: readonly PushChannel[] = [
  { id: FRIEND_CHANNEL_ID, name: '친구 깨우기', description: '친구가 깨울 때 · 그룹원이 아직 안 일어났을 때 알려요', importance: 'HIGH' },
  { id: ALARM_CHANGE_CHANNEL_ID, name: '내 알람 바뀜', description: '친구가 내 공유 알람을 바꿨을 때 알려요', importance: 'HIGH' },
  { id: REQUEST_CHANNEL_ID, name: '친구 요청', description: '친구 요청이 오거나 수락됐을 때 알려요', importance: 'DEFAULT' },
  { id: GROUP_CHANNEL_ID, name: '그룹 알림', description: '새 멤버가 들어오거나 공동 약속이 바뀔 때 알려요', importance: 'DEFAULT' },
  { id: MISSED_CHANNEL_ID, name: '기상 확인', description: '기상 확인이 안 됐을 때 알려요', importance: 'HIGH' },
];

// 앱을 켤 때마다 불러도 됨 (같은 id면 덮어쓰기). 안드로이드만 — 웹 · iOS에는 채널이 없어 아무 일도 안 함
// expo-notifications는 웹에서 불러오기만 해도 경고 로그가 나므로 안드로이드일 때만 불러옴 (파일 위쪽 import 대신 여기서 require)
// 채널 하나가 안 만들어져도 나머지는 계속 만들고, 하나라도 실패하면 false (토큰 등록 쪽은 그래도 진행 — 다음 시작에 다시 만듦)
export async function ensureNotificationChannels(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  let ok = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 웹에서는 모듈을 읽지 않으려고 안드로이드일 때 여기서만 읽음
    const { AndroidImportance, setNotificationChannelAsync } = require('expo-notifications') as typeof import('expo-notifications');
    try {
      await setNotificationChannelAsync(DETECT_CHANNEL_ID, {
        name: '자동 기록 확인',
        description: '출발 · 도착을 위치로 자동 기록했을 때 소리 없이 알려요',
        importance: AndroidImportance.LOW,
        sound: null,
        enableVibrate: false,
      });
    } catch (e) {
      ok = false;
      warn(e);
    }
    for (const channel of PUSH_CHANNELS) {
      try {
        await setNotificationChannelAsync(channel.id, {
          name: channel.name,
          description: channel.description,
          importance: channel.importance === 'HIGH' ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
        });
      } catch (e) {
        ok = false;
        warn(e);
      }
    }
  } catch (e) {
    // 모듈을 못 읽어도 앱은 그대로 — 다음 시작 때 다시 만듦 (옛 개발용 APK처럼 네이티브가 없을 때도)
    warn(e);
    return false;
  }
  return ok;
}

function warn(e: unknown) {
  if (__DEV__) console.warn('[push] 알림 채널 만들기 실패', e);
}
