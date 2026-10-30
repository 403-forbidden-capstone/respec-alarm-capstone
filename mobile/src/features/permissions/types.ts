// 폰 권한 — 알림 · 전체화면 알림 · 정확한 알람 · 사용 정보 접근 (홈 빨간 줄 · L04 점검표 · 알림 안내)
// features/social/permissions.ts의 "공유 권한"(친구에게 내 알람을 보여 주는 범위)과는 다른 것 — 여기는 폰(OS)이 앱에 준 권한

export type Allowed = 'on' | 'off' | 'unknown';

export type PermissionSnapshot = {
  supported: boolean; // Android + 알람 코어 모듈이 든 APK (웹 · 가짜 · 옛 APK는 false → 권한 줄을 안 띄움)
  notifications: Allowed; // 13(API 33)+ POST_NOTIFICATIONS. 13 미만은 'unknown' (앱 알림 꺼짐 읽기는 PR 6 네이티브)
  notificationsAsked: boolean; // 이 앱이 알림을 한 번이라도 물어봤는지 (AsyncStorage 기록)
  fullScreen: Allowed; // AlarmCore.canUseFullScreenIntent
  exactAlarm: Allowed; // AlarmCore.canScheduleExactAlarms
  usageAccess: Allowed; // AlarmCore.hasUsageAccess
};

// 알림을 묻는 계기 — alarm = 첫 알람 저장 뒤, friend = 친구 추가 뒤, onboarding · settings = 사용자가 직접 [켜기]를 누름
export type NotifyReason = 'alarm' | 'friend' | 'onboarding' | 'settings';

export type NotifyResult = 'granted' | 'denied' | 'blocked' | 'unsupported';

export type BannerLine = { key: 'notifications' | 'fullScreen' | 'failed'; text: string };
