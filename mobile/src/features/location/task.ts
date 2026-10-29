// 지오펜스 신호 받기 — 폰 OS가 영역을 드나든 것을 알리면 앱이 (꺼져 있어도) 깨어 이 작업을 돌림 (expo-task-manager)
//   불러오기만 해도 작업이 정의되므로 루트 레이아웃이 맨 위에서 import함: 백그라운드로 앱이 깨는 때는 화면이 없어 루트 레이아웃 모듈만 읽힘
//   · 신호 한 건 → 보관한 상태 · 계획으로 해석(transitions interpretSignals) → 상태 저장 + 쓸 기록 보관 → 서버에 씀(못 쓰면 보관해 둔 채 다음에) — actions.ts
//   · 판정 시각 = 신호를 받은 때. expo-location이 주는 신호에는 시각이 없어서, OS가 알려 준 지연(보통 2분 · 최대 6분)이 그대로 들어감 (7.13.7 · 핵심선별 A)
//   · 상태 읽기 → 해석 → 저장은 줄(lock.ts) 안에서 — 앱 화면 쪽 등록(register.ts)과 겹치지 않게
//   좌표는 여기서도 안 다룸 — 영역 id만
import { Platform } from 'react-native';

import { now } from '@/lib/clock';
import { isMock } from '@/lib/mode';

import { announce, commitStep, flushActions } from './actions';
import { withLock } from './lock';
import { errorText, nativeLocation, nativeTasks } from './native';
import { loadPlan, loadState } from './store';
import { interpretSignals, type GeoSignal } from './transitions';

export const GEOFENCE_TASK = 'respec-geofence';

// 작업이 받는 것 중 쓰는 칸 — data = { eventType: GeofencingEventType, region: { identifier, ... } }
export type GeofenceTaskBody = {
  data?: { eventType?: number; region?: { identifier?: string } } | null;
  error?: { message?: string } | null;
};

function toSignal(data: GeofenceTaskBody['data'], at: number): GeoSignal | null {
  const { GeofencingEventType } = nativeLocation();
  const type = data?.eventType === GeofencingEventType.Enter ? 'ENTER' : data?.eventType === GeofencingEventType.Exit ? 'EXIT' : null;
  const regionId = data?.region?.identifier;
  if (!type || typeof regionId !== 'string') return null;
  return { regionId, type, at };
}

// 끝날 때까지 기다려야 함 — expo-task-manager는 이 약속이 끝나야 작업이 끝난 것으로 알림. 던지지 않음
export async function handleGeofenceEvent({ data, error }: GeofenceTaskBody): Promise<void> {
  const at = now().getTime(); // 받은 때 — 줄을 기다리는 시간이 판정 시각에 들어가지 않게 맨 먼저
  if (error) {
    if (__DEV__) console.warn('[location] 지오펜스 작업 오류', error.message);
    return;
  }
  if (isMock()) return; // 가짜 모드는 위치로 기록하지 않음 (L2 1절)
  try {
    const signal = toSignal(data, at);
    if (!signal) return;
    const notices = await withLock(async () => {
      const [state, plan] = await Promise.all([loadState(), loadPlan()]);
      return commitStep(interpretSignals(state, [signal], plan, now().getTime()));
    });
    announce(notices);
  } catch (e) {
    if (__DEV__) console.warn('[location] 신호 해석 실패', errorText(e));
  }
  // 이전에 못 쓴 기록도 같이 — 보관함 순서대로 (이번 신호의 기록은 맨 뒤)
  await flushActions();
}

// 안드로이드만 — 웹 · iOS는 지오펜스를 안 씀. 옛 개발용 APK처럼 네이티브가 없어도 앱 시작은 막지 않음
if (Platform.OS === 'android') {
  try {
    nativeTasks().defineTask(GEOFENCE_TASK, handleGeofenceEvent);
  } catch (e) {
    if (__DEV__) console.warn('[location] 지오펜스 작업 정의 실패', errorText(e));
  }
}
