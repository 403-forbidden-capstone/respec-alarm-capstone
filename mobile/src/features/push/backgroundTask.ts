// 조용한 데이터 푸시 받기 — 앱이 완전히 꺼진 채 다른 사람이 공동 약속 시각을 바꾸거나 취소하면 서버가 보내는 문구 없는 데이터 푸시(supabase _shared/notify.ts sendGroupPush)로
//   폰이 앱 화면 없이 JS만 깨워(헤드리스) 폰 알람을 서버와 다시 맞춤 (G2). expo-notifications 백그라운드 알림 작업(expo-task-manager)
//   · 불러오기만 해도 작업이 정의되므로 앱 진입 파일(mobile/index.js)이 expo-router보다 먼저 import함 — 지오펜스 작업(features/location/task)과 같은 이유
//     (앱이 꺼진 채 푸시로 깨면 화면(_layout)은 평가되지 않아 진입 파일에서 정의해야 함). 작업 등록(registerAsync)은 앱을 열 때마다 usePushLinks가 함(등록은 앱을 한 번 열어야 생김)
//   · 받는 사람이 지금 로그인한 계정일 때만 맞춤 (needsAlarmSync — 앞에 떠 있을 때 받는 리스너와 같은 판정). 알림은 안 띄움
//   · 맞추기는 앞에 있을 때와 같은 syncNow(기록 올리기 → 반복 회차 → 서버 ↔ 폰 맞추기). 세션 · supabase 클라이언트는 AsyncStorage에서 읽으므로 화면 없이도 동작(만료됐으면 getSession이 새로 고침)
//     가짜 데이터 모드는 아무것도 안 함(지오펜스 작업과 같음)
//   · 작업이 받는 body 모양은 안드로이드에서 data.dataString(JSON 글자) · data.data · data.notification… 등 버전에 따라 달라서 pushDataOf가 모양을 가리지 않고 푸시 data를 찾음
//     (실기기 확인 필요 — 보고서 '실기기에서 볼 것')
//   · 끝날 때까지 기다려야 함 — expo-task-manager는 이 약속이 끝나야 작업이 끝난 것으로 알림. 던지지 않음
import { Platform } from 'react-native';

import { nativeNotifications, nativeTasks, errorText } from '@/features/location/native';
import { syncNow } from '@/lib/alarmSync';
import { isMock } from '@/lib/mode';
import { isPushData, isSilentPush } from '@/lib/push/kinds';
import { currentUserId } from '@/lib/user';

import { needsAlarmSync } from './link';

export const PUSH_TASK = 'respec-push-reconcile';

const MAX_DEPTH = 5;

// 작업 body 어디에 있든 서버 푸시 data(kind가 있는 객체)를 찾음 — JSON 글자는 풀어 보고, 못 찾으면 null
export function pushDataOf(body: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_DEPTH || body == null) return null;
  if (typeof body === 'string') {
    if (!body.startsWith('{') && !body.startsWith('[')) return null;
    try {
      return pushDataOf(JSON.parse(body), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof body !== 'object') return null;
  if (isPushData(body)) return body as Record<string, unknown>;
  const values = Array.isArray(body) ? body : Object.values(body as Record<string, unknown>);
  for (const value of values) {
    const found = pushDataOf(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// 한 번 받은 푸시 처리 — 조용한 데이터 푸시 중 알람 맞추기가 필요한 것만 (보이는 알림은 앱이 꺼져 있으면 이 작업이 안 돎, 앞 · 뒤에 있을 땐 같은 푸시를 받음 리스너가 맞춤)
export async function handlePushTask(body: { data?: unknown; error?: unknown } | null | undefined): Promise<void> {
  try {
    if (!body || body.error) return;
    if (isMock()) return;
    const data = pushDataOf(body.data);
    if (!data || !isSilentPush(data)) return;
    const me = await currentUserId();
    if (!needsAlarmSync(data, me)) return;
    await syncNow();
  } catch (e) {
    if (__DEV__) console.warn('[push] 백그라운드 푸시 처리 실패', errorText(e));
  }
}

// 앱을 열 때마다 부름 — 같은 작업을 다시 등록해도 됨. 안드로이드만, 네이티브가 없으면(옛 개발용 APK) 조용히 못 함 → false
export async function registerPushTask(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    await nativeNotifications().registerTaskAsync(PUSH_TASK);
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[push] 백그라운드 푸시 작업 등록 실패', errorText(e));
    return false;
  }
}

// 안드로이드만 — 웹 · iOS는 안 씀. 옛 개발용 APK처럼 네이티브가 없어도 앱 시작은 막지 않음
if (Platform.OS === 'android') {
  try {
    nativeTasks().defineTask(PUSH_TASK, handlePushTask);
  } catch (e) {
    if (__DEV__) console.warn('[push] 백그라운드 푸시 작업 정의 실패', errorText(e));
  }
}
