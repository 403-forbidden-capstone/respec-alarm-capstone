// 감지 안내 알림 자리 — 출발 후보가 생기거나(DEPART_PENDING) 5분 안에 돌아와 취소되면(DEPART_CANCEL) 불림
//   지금은 아무것도 안 함. PR 6이 여기서 소리 없는 "출발 8:30 감지 [아니에요]" 알림을 띄우고 거둠 (lib/push/channels DETECT_CHANNEL_ID)
//   부르는 쪽(actions.ts announce)이 던지는 것을 삼킴 — 안내 실패가 기록을 막지 않게
import type { GeoAction } from './transitions';

export function onDetectionNotice(action: GeoAction): void {
  void action;
}
