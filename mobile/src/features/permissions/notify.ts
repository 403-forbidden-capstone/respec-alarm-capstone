// 알림 허용 묻기 (Android 13+ POST_NOTIFICATIONS) — 첫 알람 저장 뒤 · 친구 추가 뒤 · 설정의 [켜기]
//   시스템 창은 두 번 거절하면 더 안 뜸 → 우리 안내 시트로 이유를 먼저 말하고, 거절한 뒤에는 조르지 않음 (홈 빨간 줄 · L04 점검표가 맡음)
//   웹 · 가짜 · 옛 APK는 아무 창도 없이 'unsupported'
import { PermissionsAndroid } from 'react-native';

import { showNotifyPrompt } from './components/PermissionPromptHost';
import { openAppNotificationSettings } from './open';
import { canReadPhone, needsNotifyPermission, notifyPermissionsChanged, readNotifyRecord, writeNotifyRecord } from './read';
import type { NotifyReason, NotifyResult } from './types';

const PROMPT_TITLE = '알람이 잠금화면에 뜨려면 알림이 필요해요';
const PROMPT_WHY = {
  alarm: '알림을 켜야 기상 알람 화면과 준비 · 출발 알림이 떠요.',
  friend: '알림을 켜야 친구가 깨우거나 일정을 바꿀 때 알려 드려요.',
} as const;
const PROMPT_HOW = "다음 화면에서 '허용'을 눌러 주세요.";
const PROMPT_HOW_BLOCKED = '설정에서 알림을 켜 주세요.'; // 시스템 창이 더는 안 뜨는 상태

const warn = (e: unknown) => {
  if (__DEV__) console.warn('[permissions] 알림 묻기 실패', e);
};

// 더 물을 필요가 없는 경우의 결과 — 물어야 하면 null
async function settled(): Promise<NotifyResult | null> {
  if (!canReadPhone()) return 'unsupported';
  if (!needsNotifyPermission()) return 'granted'; // 13 미만은 시스템 창이 없음 (꺼짐 읽기는 PR 6)
  if (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) return 'granted';
  return null;
}

async function turnOn(reason: NotifyReason): Promise<NotifyResult> {
  const done = await settled();
  if (done) return done;
  const record = await readNotifyRecord();
  // 두 번 거절한 바로 그 순간에 설정을 열지 않으려고 blocked를 기록해 두고, 다음 누름부터 설정을 엶
  if (record.blocked) {
    await openAppNotificationSettings();
    return 'blocked';
  }
  // 시스템 창을 띄우므로 "물어봄"으로 남김
  const asked = { ...record, prompted: { ...record.prompted, [reason]: record.prompted[reason] ?? new Date().toISOString() } };
  await writeNotifyRecord(asked);
  const answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  let result: NotifyResult = 'denied';
  if (answer === PermissionsAndroid.RESULTS.GRANTED) {
    result = 'granted';
  } else if (answer === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    result = 'blocked';
    await writeNotifyRecord({ ...asked, blocked: true });
  }
  notifyPermissionsChanged();
  return result;
}

// 안내 시트 없이 바로 시스템 창 (이미 막혔으면 설정). 던지지 않음
// reason = 기록에 남길 계기 (직접 누른 [켜기]는 기본 'settings')
export async function turnOnNotifications(reason: NotifyReason = 'settings'): Promise<NotifyResult> {
  try {
    return await turnOn(reason);
  } catch (e) {
    warn(e);
    return 'denied';
  }
}

// 알림이 필요한 순간에 부름. 던지지 않음
//   onboarding · settings = 사용자가 직접 [켜기]를 누른 것 → 시트 없이 바로 시스템 창
//   alarm · friend = 저장 · 친구 추가 뒤 자동으로 부름 → 이유마다 한 번만 시트를 띄우고, 거절하면 다시 안 띄움
export async function askNotifications(reason: NotifyReason): Promise<NotifyResult> {
  try {
    const done = await settled();
    if (done) return done;
    if (reason === 'onboarding' || reason === 'settings') return await turnOnNotifications(reason);

    const record = await readNotifyRecord();
    if (record.prompted[reason]) return 'denied'; // 이미 한 번 물어봤음 — 조르지 않음
    await writeNotifyRecord({ ...record, prompted: { ...record.prompted, [reason]: new Date().toISOString() } });
    const ok = await showNotifyPrompt({
      title: PROMPT_TITLE,
      message: `${PROMPT_WHY[reason]} ${record.blocked ? PROMPT_HOW_BLOCKED : PROMPT_HOW}`,
      okLabel: record.blocked ? '설정 열기' : '알림 켜기',
      cancelLabel: '나중에',
    });
    if (!ok) {
      notifyPermissionsChanged(); // "물어봤음"이 기록됐으니 홈 줄이 다시 읽게
      return 'denied';
    }
    return await turnOnNotifications(reason);
  } catch (e) {
    warn(e);
    return 'denied';
  }
}
