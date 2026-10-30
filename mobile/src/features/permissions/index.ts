// 폰 권한 (알림 · 전체화면 알림 · 정확한 알람 · 사용 정보 접근) — 화면에서는 이 파일에서 가져옴
//   친구에게 내 알람을 보여 주는 "공유 권한"(features/social/permissions.ts)과는 다른 것
export { bannerLines, bannerSummary } from './banner';
export { PermissionBanner } from './components/PermissionBanner';
export { PermissionPromptHost } from './components/PermissionPromptHost';
export { useFailedAlarmCount, usePermissions } from './hooks/usePermissions';
export { askNotifications, turnOnNotifications } from './notify';
export { openAppNotificationSettings, openBatterySettings, openExactAlarmSettings, openFullScreenSettings, openUsageAccessSettings } from './open';
export { readPermissions } from './read';
export type { Allowed, BannerLine, NotifyReason, NotifyResult, PermissionSnapshot } from './types';
