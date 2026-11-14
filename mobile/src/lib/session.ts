// 로그아웃 정리 — 계정이 바뀔 때 앞 계정의 것이 폰에 남지 않게 (전체작업계획 7절 "계정 전환")
// 로그아웃 버튼(설정 · 개발 메뉴 · 프로필 다시 시도 화면)은 lib/auth의 signOut이 아니라 이 함수를 부름
//
//   0. 로그아웃 중 표시를 켬 — 이 뒤의 폰 예약 맞추기(reconcile)는 서버 알람을 폰에 걸지 않고 건너뜀 (로그인 상태가 남은 사이에 앞 계정 알람을 다시 걸지 않게)
//   1. 올리지 못한 울림 기록을 먼저 올려 봄 — 실패해도 로그아웃은 계속
//   2. 폰 알람 전부 취소 (AlarmCore.cancelAll, 무음 알림 포함, 맞추기와 같은 줄에서 — 앞에 서 있던 맞추기가 끝난 뒤에). 이게 실패하면 로그아웃하지 않음 — 앞 계정의 알람이 폰에 남아 울리면 안 되므로
//   3. 그래도 폰에 남은 울림 기록은 버림 — 다음 계정에 섞이지 않게 (1에서 못 올린 것도 여기서 버려짐)
//   4. 푸시 토큰 지우기 (이 기기의 토큰 행, 아래) · 백그라운드 브리핑 갱신 기기 키 지우기 (서버 줄 + 폰 Keystore 저장소, #515)
//   5. 실시간 구독 끊기 (그룹 기상 신호) · 기능이 onSignOut으로 등록한 메모리 정리
//   6. 로그아웃 (supabase.auth.signOut)
// 데이터 모드 저장값은 그대로 둠 (로그아웃해도 모드가 바뀌지 않음)
// 다시 로그인하면 useAlarmSync가 로그아웃 중 표시를 끄고 reconcile이 서버 알람으로 폰 예약을 다시 채움 (로그아웃이 중간에 멈추면 여기서 바로 끔)
import { cancelAllPhoneAlarms, discardPendingEvents, setSigningOut, uploadEvents } from './alarmSync';
import { forgetBriefingDevice } from './alarmSync/briefingDevice';
import { signOut } from './auth';
import { UserError } from './errors';
import { removePushToken } from './push/token';
import { unsubscribeAll } from './realtime';

// 푸시 토큰 지우기 — 로그인 직후 register_push_token으로 등록한 이 기기의 토큰을 push_tokens에서 지움 (세션이 있는 지금이어야 RLS를 통과함)
// 못 지워도(오프라인) 로그아웃은 계속 — 다음 로그인이 같은 토큰을 새 주인으로 옮김 (lib/push/token.ts)
export const clearPushToken = removePushToken;

// 기능 쪽 메모리 정리 — lib는 기능 폴더를 가져오지 않으므로 기능이 여기에 등록함 (예: 알람의 장소 좌표 · 읽어 둔 설정 · 저장 대기 기록)
const signOutCleanups = new Set<() => void>();
export function onSignOut(cleanup: () => void): () => void {
  signOutCleanups.add(cleanup);
  return () => {
    signOutCleanups.delete(cleanup);
  };
}

// 로그아웃 없이 하는 폰 · 메모리 정리 (위 2~5단계) — 로그아웃 정리와 개발용 "내 시험 데이터 지우기"(cleanupAfterDataReset)가 같이 씀
// 폰 알람을 못 지우면 cancelFailed 문구의 UserError를 던지고 뒤 단계는 하지 않음 (부르는 쪽이 자기 문구를 줌). 그 뒤 단계의 예외는 문구를 바꾸지 않고 그대로 전파
// forgetPushToken = 로그아웃일 때만 이 기기의 푸시 토큰 행을 지움 (시험 데이터 지우기는 로그인 그대로라 알림이 계속 와야 함)
async function cleanupLocalUserState(cancelFailed: string, forgetPushToken: boolean): Promise<void> {
  try {
    await cancelAllPhoneAlarms();
  } catch {
    throw new UserError(cancelFailed);
  }
  await discardPendingEvents().catch(() => {});
  if (forgetPushToken) await clearPushToken().catch(() => {});
  // 기기 키는 로그아웃 때만 (시험 데이터 지우기는 로그인 그대로라 새벽 갱신이 계속 돌아야 함). 폰 알람은 위에서 지웠으니 갱신 예약도 이미 없음
  if (forgetPushToken) await forgetBriefingDevice({ revoke: true }).catch(() => {});
  unsubscribeAll();
  signOutCleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch {
      // 메모리 정리 실패로 이어서 하는 일을 막지 않음
    }
  });
}

export async function signOutAndCleanup(): Promise<void> {
  setSigningOut(true);
  try {
    await uploadEvents().catch(() => {});
    await cleanupLocalUserState('폰에 걸린 알람을 지우지 못해 로그아웃하지 못했어요. 다시 해 주세요', true);
    await signOut();
  } catch (e) {
    setSigningOut(false); // 로그아웃이 안 됐으니 로그인 상태 그대로 — 맞추기를 다시 돌게
    throw e;
  }
}

// 계정 삭제 뒤 이 기기 정리 (친구 12장) — 서버 계정은 이미 없으므로 로그아웃과 순서가 반대: 서버가 먼저 지우고(실패하면 이 기기는 그대로) 그 뒤에 기기를 비움
//   폰 알람 · 올리지 못한 기록 · 푸시 토큰은 서버에서 이미 없어졌으니 못 지워도 멈추지 않음(남은 알람은 앱을 다시 열 때 맞추기가 정리). 로그아웃은 서버를 못 불러도 이 기기 로그인은 지움
export async function cleanupAfterAccountDelete(): Promise<void> {
  setSigningOut(true);
  await cancelAllPhoneAlarms().catch(() => {});
  await discardPendingEvents().catch(() => {});
  // 푸시 토큰 행은 서버가 계정과 함께 지움(prepare_account_delete) — 로그인이 이미 무효라 앱에서 지우려 해도 거절됨
  // 기기 키 서버 줄도 계정과 같이 지워짐(briefing_devices → profiles cascade) — 폰 키만 지움
  await forgetBriefingDevice({ revoke: false }).catch(() => {});
  unsubscribeAll();
  signOutCleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch {
      // 메모리 정리 실패로 이어서 하는 일을 막지 않음
    }
  });
  await signOut().catch(() => {});
}

// 개발용 "내 시험 데이터 지우기"(/dev/screens) 뒤의 폰 정리 — 서버에서 내 일정 · 알람을 지운 다음에 부름. 로그인은 그대로
//   로그아웃 정리와 다른 점 둘:
//   · 못 올린 울림 기록은 올리지 않고 버림 (서버 알람이 이미 없어 올려도 거절됨)
//   · "로그아웃 중" 표시를 켜지 않음 — 맞추기(reconcile)는 계속 돌아야 하고, 폰 알람 취소가 맞추기와 같은 줄에서 돌아 끼어들지 못하며
//     지운 뒤의 맞추기는 서버에서 빈 목록을 읽음 (표시를 켰다 끄면 시간대 · 반복 회차 시각 기억도 같이 비워져 로그인 상태에서는 오히려 해로움)
export async function cleanupAfterDataReset(): Promise<void> {
  await cleanupLocalUserState('서버의 시험 데이터는 지웠지만 폰에 걸린 알람은 지우지 못했어요. 다시 눌러 주세요', false);
}
