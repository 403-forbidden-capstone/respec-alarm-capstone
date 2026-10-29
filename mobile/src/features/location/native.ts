// 네이티브 모듈(expo-location · expo-task-manager)은 안드로이드에서만 불러옴 — 웹 · 시험에서 읽지 않으려고 파일 위쪽 import 대신 부를 때 require (lib/push/channels와 같은 방식)
//   부르는 쪽이 Platform.OS === 'android'를 먼저 확인할 것

export function nativeLocation(): typeof import('expo-location') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 안드로이드일 때만 읽음
  return require('expo-location') as typeof import('expo-location');
}

export function nativeTasks(): typeof import('expo-task-manager') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 안드로이드일 때만 읽음
  return require('expo-task-manager') as typeof import('expo-task-manager');
}

// 오류 글 — 로그에는 이것만 남김 (좌표는 로그에 안 남김. 7.13.7 저장 범위)
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
