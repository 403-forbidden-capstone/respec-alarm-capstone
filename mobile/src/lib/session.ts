// 로그아웃 정리 — 계정이 바뀔 때 앞 계정의 것이 폰에 남지 않게 (전체작업계획 7절 "계정 전환")
// 로그아웃 버튼(설정 · 개발 메뉴 · 프로필 다시 시도 화면)은 lib/auth의 signOut이 아니라 이 함수를 부름
//
//   1. 올리지 못한 울림 기록을 먼저 올려 봄 — 실패해도 로그아웃은 계속
//   2. 폰 알람 전부 취소 (AlarmCore.cancelAll, 무음 알림 포함). 이게 실패하면 로그아웃하지 않음 — 앞 계정의 알람이 폰에 남아 울리면 안 되므로
//   3. 그래도 폰에 남은 울림 기록은 버림 — 다음 계정에 섞이지 않게 (1에서 못 올린 것도 여기서 버려짐)
//   4. 푸시 토큰 지우기 (자리만, 아래)
//   5. 실시간 구독 끊기 (그룹 기상 신호) · 기능이 onSignOut으로 등록한 메모리 정리
//   6. 로그아웃 (supabase.auth.signOut)
// 데이터 모드 저장값은 그대로 둠 (로그아웃해도 모드가 바뀌지 않음)
// 다시 로그인하면 lib/alarmSync의 reconcile이 서버 알람으로 폰 예약을 다시 채움
import * as AlarmCore from '@capstone/alarm-core';

import { discardPendingEvents, uploadEvents } from './alarmSync';
import { signOut } from './auth';
import { UserError } from './errors';
import { unsubscribeAll } from './realtime';

// 푸시 토큰 지우기 자리 — 지금은 푸시 토큰을 등록하지 않아(Expo Push는 붙일 때, #23 · #80 · Q12) 할 일이 없음
// 붙일 때: 로그인 직후 register_push_token으로 등록한 이 기기의 토큰을 push_tokens에서 지움 (세션이 있는 지금이어야 RLS를 통과함)
export async function clearPushToken(): Promise<void> {}

// 기능 쪽 메모리 정리 — lib는 기능 폴더를 가져오지 않으므로 기능이 여기에 등록함 (예: 알람의 장소 좌표 · 읽어 둔 설정 · 저장 대기 기록)
const signOutCleanups = new Set<() => void>();
export function onSignOut(cleanup: () => void): () => void {
  signOutCleanups.add(cleanup);
  return () => {
    signOutCleanups.delete(cleanup);
  };
}

export async function signOutAndCleanup(): Promise<void> {
  await uploadEvents().catch(() => {});
  try {
    await AlarmCore.cancelAll();
  } catch {
    throw new UserError('폰에 걸린 알람을 지우지 못해 로그아웃하지 못했어요. 다시 해 주세요');
  }
  await discardPendingEvents().catch(() => {});
  await clearPushToken().catch(() => {});
  unsubscribeAll();
  signOutCleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch {
      // 메모리 정리 실패로 로그아웃을 막지 않음
    }
  });
  await signOut();
}
