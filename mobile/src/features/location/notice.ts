// 감지 안내 알림 — 위치로 출발 · 도착이 잡혔을 때 소리 없이 알리고(채널 detect_v1), 눌러서 정정(/detection)하게 함
//   · DEPART_PENDING  이탈 순간 → "출발 오전 8:30 감지" 알림 (확정은 5분 뒤지만 안내는 바로, 틀렸으면 그때 눌러 정정)
//   · DEPART_CANCEL   5분 안 재진입 → 그 알림을 거둠
//   · ARRIVE          서버에 도착을 쓴 뒤(actions.ts) → "도착 오전 9:52 감지" 알림
//   폰 안에서 만드는 로컬 알림이라 서버 푸시가 아님 (docs/screen-data-map.md). 알림 권한이 없으면 묻지 않고 조용히 건너뜀
//   안드로이드가 아니면 아무것도 안 함. 부르는 쪽(actions.ts announce)이 던지는 것을 삼키고, 여기서도 비동기 실패는 던지지 않음 — 안내 실패가 기록을 막지 않게
import { Platform } from 'react-native';

import { formatTime } from '@/lib/format';
import { DETECT_CHANNEL_ID } from '@/lib/push/channels';

import type { DetectionKind } from './detections';
import { buildDetectionLink, detectionNoticeId, type DetectionLink } from './link';
import { errorText, nativeNotifications } from './native';
import type { GeoAction } from './transitions';

const KIND_LABEL: Record<DetectionKind, string> = { DEPART: '출발', ARRIVE: '도착' };

async function show(link: DetectionLink): Promise<void> {
  const notifications = nativeNotifications();
  if (!(await notifications.getPermissionsAsync()).granted) return; // 권한은 묻지 않음 — 설정 · 점검표에서 켬
  await notifications.scheduleNotificationAsync({
    identifier: detectionNoticeId(link),
    content: {
      title: `${KIND_LABEL[link.kind]} ${formatTime(new Date(link.at))} 감지`,
      body: '아니면 눌러서 정정해요',
      data: { url: buildDetectionLink(link) },
      sound: false, // 채널도 소리 · 진동 없음 — 채널을 사용자가 바꿔도 이 알림 자체는 조용히
    },
    trigger: { channelId: DETECT_CHANNEL_ID }, // 바로 띄움
  });
}

async function withdraw(link: DetectionLink): Promise<void> {
  const notifications = nativeNotifications();
  const id = detectionNoticeId(link);
  // 둘 중 하나가 실패해도 다른 하나는 해 봄 (이미 사라졌으면 오류가 날 수 있음)
  await Promise.allSettled([notifications.dismissNotificationAsync(id), notifications.cancelScheduledNotificationAsync(id)]);
}

// [아니에요]로 위치 감지를 지운 뒤 — 알림창에 남은 그 감지 안내(출발 · 도착)를 거둠. 이미 사라졌거나 실패해도 던지지 않음 (정정이 이 때문에 막히면 안 됨)
export function withdrawDetectionNotice(link: DetectionLink): void {
  if (Platform.OS !== 'android') return;
  withdraw(link).catch((e) => {
    if (__DEV__) console.warn('[location] 감지 안내 알림 거두기 실패', errorText(e));
  });
}

export function onDetectionNotice(action: GeoAction): void {
  if (Platform.OS !== 'android') return;
  let task: Promise<void>;
  if (action.type === 'DEPART_PENDING') task = show({ kind: 'DEPART', participantId: action.participantId, at: action.at });
  else if (action.type === 'DEPART_CANCEL') task = withdraw({ kind: 'DEPART', participantId: action.participantId, at: action.at });
  else if (action.type === 'ARRIVE') task = show({ kind: 'ARRIVE', participantId: action.participantId, at: action.at });
  else return;
  task.catch((e) => {
    if (__DEV__) console.warn('[location] 감지 안내 알림 실패', errorText(e));
  });
}
