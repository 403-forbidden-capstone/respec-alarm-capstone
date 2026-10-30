// 웹 미리보기용 샘플 권한 상태 — 웹은 폰 권한을 못 읽어 점검표 줄 · [켜기] · 홈 빨간 줄이 안 보이므로, 개발 화면 목록(/dev/screens)에서 골라 가짜 상태를 읽게 함
//   순수 함수만 (고른 값을 들고 있는 곳은 read.ts, 웹이 아니면 쓰이지 않음)
import type { PermissionSnapshot } from './types';

export type PermissionSample = 'none' | 'allOn' | 'notifyOff' | 'fullScreenOff';

// 개발 화면 목록의 고르는 칸 [값, 보이는 글자] — none은 샘플 없이 지금처럼 "읽지 못함"
export const PERMISSION_SAMPLES = [
  ['none', '읽지 못함'],
  ['allOn', '모두 켜짐'],
  ['notifyOff', '알림 꺼짐'],
  ['fullScreenOff', '전체화면 꺼짐'],
] as const;

// none이면 null (진짜 읽기로 넘어감). 알림 꺼짐은 "물어본 적 있음"까지 켜서 홈 빨간 줄이 바로 보임
export function sampleSnapshot(sample: PermissionSample): PermissionSnapshot | null {
  if (sample === 'none') return null;
  return {
    supported: true,
    notifications: sample === 'notifyOff' ? 'off' : 'on',
    notificationsAsked: sample === 'notifyOff',
    fullScreen: sample === 'fullScreenOff' ? 'off' : 'on',
    exactAlarm: 'on',
    usageAccess: 'on',
  };
}
