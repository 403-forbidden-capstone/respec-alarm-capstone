// 데이터 모드 — 실데이터(real: 로그인 · Supabase) · 가짜(mock: 목업 시나리오, 로그인 없이 바로 탭)
//   규칙은 lib/modePolicy.ts (순수 함수 + 표). 여기서는 Platform · __DEV__ · 환경 변수 · 저장소를 읽어 규칙에 넘기고 상태를 들고 있음
//     · 폰 + 출시용 빌드(__DEV__ false): 실데이터 고정 — 가짜로 못 바꿈, 로그인해야만 탭, Supabase 값이 없으면 설정 오류 화면 (configError)
//     · 폰 개발용(__DEV__ true) · 웹: 바꿀 수 있음. 웹 기본은 가짜이고 주소 ?mode=real이면 실데이터, 폰 개발용 기본은 실데이터
//     · 실데이터를 못 쓰면(Supabase 값 없음 · lib/flags REAL_DATA_READY = false) 늘 가짜, real로 못 바꿈
//   바꾸는 곳: /dev/screens 맨 위 · 설정 화면 개발 절 · 웹 미리보기 왼쪽 패널 "데이터 모드" (모두 잠긴 빌드에선 안 보임) · 웹 주소 ?mode=mock 또는 ?mode=real (보드 패널 버튼)
//   저장: 폰 AsyncStorage, 웹 localStorage — 앱을 다시 열어도 유지. 로그아웃해도 그대로
//   api.ts는 함수마다 isMock()으로 가짜 · Supabase를 고름 (기능을 붙일 때 그 함수만 바꿈)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { setRealTime } from './clock';
import { REAL_DATA_READY } from './flags';
import { appVariantOf, modePolicy, resolveMode, showDevLogin, type DataMode, type ModeEnv } from './modePolicy';
import { isSupabaseConfigured } from './supabase';

export type { DataMode } from './modePolicy';

type State = { mode: DataMode; ready: boolean }; // ready = 저장된 값을 읽었음 (폰은 비동기)

const KEY = 'respec.dataMode';

// 빌드 종류 (eas.json 프로필 env · app.config.js와 같은 값) — 개발자용 배포 APK면 로그인 화면에 데모 로그인
export const appVariant = appVariantOf(process.env.EXPO_PUBLIC_APP_VARIANT);
const env: ModeEnv = { web: Platform.OS === 'web', dev: __DEV__, configured: isSupabaseConfigured, ready: REAL_DATA_READY, devApk: appVariant === 'dev' };
const policy = modePolicy(env);

// 실데이터를 쓸 수 있는지 — 못 쓰면 주소 ?mode=real · 저장된 real도 가짜로 돎
export const canUseRealData = policy.canUseReal;
// 모드를 못 바꾸는 빌드(폰 출시용) — 토글을 숨김
export const modeLocked = policy.locked;
// 잠긴 빌드인데 Supabase 값이 없음 — 루트 레이아웃이 설정 오류 화면을 보여 줌
export const configError = policy.configError;
// 개발 메뉴의 이메일 로그인을 보일지
export const devLoginVisible = showDevLogin(env);

const parse = (v: unknown): DataMode | null => (v === 'real' || v === 'mock' ? v : null);

let state: State = { mode: resolveMode(policy), ready: policy.locked };
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  setRealTime(next.mode === 'real'); // 가짜 모드는 목업 시나리오 시각, 실데이터는 지금 시각
  listeners.forEach((listener) => listener());
}

// 웹은 주소 → 저장값 → 기본값 순으로 바로 읽어 첫 화면부터 맞는 모드로 엶. 주소로 받은 값은 저장해 둠
function readWeb(): DataMode {
  const fromUrl = parse(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('mode'));
  let saved: DataMode | null = null;
  try {
    saved = parse(globalThis.localStorage?.getItem(KEY));
    if (fromUrl) globalThis.localStorage?.setItem(KEY, resolveMode(policy, { url: fromUrl }));
  } catch {
    // 저장소를 막은 브라우저 — 이번 실행에만 씀
  }
  return resolveMode(policy, { url: fromUrl, saved });
}

if (Platform.OS === 'web') {
  emit({ mode: readWeb(), ready: true });
} else if (policy.locked) {
  emit(state); // 실데이터 고정 — 저장값을 읽을 것이 없음
} else {
  emit(state);
  AsyncStorage.getItem(KEY)
    .then((v) => emit({ mode: resolveMode(policy, { saved: parse(v) }), ready: true }))
    .catch(() => emit({ ...state, ready: true })); // 못 읽으면 기본값으로 시작
}

export function getMode(): DataMode {
  return state.mode;
}

export function isMock(): boolean {
  return state.mode === 'mock';
}

// 바꾼 모드를 돌려줌 — 실데이터를 못 쓰는데 real을 고르면 mock 그대로, 잠긴 빌드(폰 출시용)는 늘 real 그대로
export function setMode(next: DataMode): DataMode {
  if (policy.locked) return 'real';
  const mode = resolveMode(policy, { url: next });
  emit({ mode, ready: true });
  // 저장 실패는 이번 실행에만 적용. 웹은 읽을 때(readWeb)와 같은 localStorage에 바로 씀
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(KEY, mode);
    } catch {
      // 저장소를 막은 브라우저
    }
  } else {
    AsyncStorage.setItem(KEY, mode).catch(() => {});
  }
  return mode;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => state;

export function useMode(): State {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
