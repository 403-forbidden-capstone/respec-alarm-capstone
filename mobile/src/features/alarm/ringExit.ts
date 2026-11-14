// 알람 울림(H07)을 끈 뒤 갈 곳 — 해제 · 미루기 · 준비 · 출발 안내의 [확인]이 같이 씀 (시험: __tests__/ringExit.test.ts)
//   울림 화면은 가드 없이 늘 열리지만, 홈(/) · 기상 확인(/wake)은 로그인 · 온보딩을 끝내야 열림 (app/_layout.tsx Stack.Protected)
//   막힌 화면으로 이동하면 아무 일도 안 일어나서, 로그인 전에 울린 알람을 끄면 울림 화면에 갇혔음 (11/12 에뮬레이터 — "개발 메뉴 알람이 안 꺼져요")
//   그래서 지금 열 수 있는 화면을 먼저 고름:
//     개발 화면 시험 알람(id 앞머리 de70a1a0-) → 알람 테스트 화면으로 돌아감 (서버에 행이 없어 기상 확인을 열 이유가 없음)
//     로그인 전 → 로그인 · 온보딩 전 → 온보딩 · 동의 다시 받기 전 → 동의 화면
//     그 밖 → 홈, 기상 알람 해제면 홈 위에 기상 확인
import type { RingKind } from './types';

export type RingExitState = {
  devAlarm: boolean; // 개발 화면 시험 알람 (lib/alarmSync/devAlarm isDevAlarmId)
  enabled: boolean; // 실데이터 모드라 로그인이 필요함 (useAuth().enabled)
  signedIn: boolean;
  needsOnboarding: boolean;
  needsReconsent: boolean;
};

export type RingExitHref = '/' | '/dev/alarm-test' | '/login' | '/onboarding' | '/reconsent';

export type RingExit = { href: RingExitHref; openWake: boolean };

// 지금 열 수 있는 첫 화면 — 홈이 막혀 있으면 로그인 · 온보딩 · 동의 화면 (가드 밖 화면의 "← 이전"도 씀: 알람 테스트)
export function openableHome(state: Omit<RingExitState, 'devAlarm'>): Exclude<RingExitHref, '/dev/alarm-test'> {
  if (state.enabled && !state.signedIn) return '/login';
  if (state.needsOnboarding) return '/onboarding';
  if (state.needsReconsent) return '/reconsent';
  return '/';
}

export function ringExit(kind: RingKind, action: 'dismiss' | 'snooze' | 'done', state: RingExitState): RingExit {
  if (state.devAlarm) return { href: '/dev/alarm-test', openWake: false };
  const href = openableHome(state);
  return { href, openWake: href === '/' && action === 'dismiss' && kind === 'WAKE' };
}
