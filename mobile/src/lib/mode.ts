// 데이터 모드 — 실데이터(real: 로그인 · Supabase) · 가짜(mock: 목업 시나리오, 로그인 없이 바로 탭)
//   기본값: 실데이터를 쓸 수 있으면(Supabase 연결 + lib/flags REAL_DATA_READY) real, 아니면 mock. 못 쓰면 real로 못 바꿈
//   지금은 REAL_DATA_READY = false라 늘 mock — 로그인 · 온보딩을 붙일 때까지 (#116)
//   바꾸는 곳: /dev/screens 맨 위 · 설정 화면 개발 절 · 웹 주소 ?mode=mock 또는 ?mode=real (보드 패널 버튼)
//   저장: 폰 AsyncStorage, 웹 localStorage — 앱을 다시 열어도 유지
//   api.ts는 함수마다 isMock()으로 가짜 · Supabase를 고름 (기능을 붙일 때 그 함수만 바꿈)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { setRealTime } from './clock';
import { REAL_DATA_READY } from './flags';
import { isSupabaseConfigured } from './supabase';

export type DataMode = 'real' | 'mock';

type State = { mode: DataMode; ready: boolean }; // ready = 저장된 값을 읽었음 (폰은 비동기)

const KEY = 'respec.dataMode';

// 실데이터를 쓸 수 있는지 — 못 쓰면 주소 ?mode=real · 저장된 real도 가짜로 돎
export const canUseRealData = isSupabaseConfigured && REAL_DATA_READY;
const DEFAULT: DataMode = canUseRealData ? 'real' : 'mock';

const parse = (v: unknown): DataMode | null => (v === 'real' || v === 'mock' ? v : null);
const allowed = (m: DataMode): DataMode => (m === 'real' && !canUseRealData ? 'mock' : m);

let state: State = { mode: DEFAULT, ready: false };
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
    if (fromUrl) globalThis.localStorage?.setItem(KEY, allowed(fromUrl));
  } catch {
    // 저장소를 막은 브라우저 — 이번 실행에만 씀
  }
  return allowed(fromUrl ?? saved ?? DEFAULT);
}

if (Platform.OS === 'web') {
  emit({ mode: readWeb(), ready: true });
} else {
  emit(state);
  AsyncStorage.getItem(KEY)
    .then((v) => emit({ mode: allowed(parse(v) ?? DEFAULT), ready: true }))
    .catch(() => emit({ ...state, ready: true })); // 못 읽으면 기본값으로 시작
}

export function getMode(): DataMode {
  return state.mode;
}

export function isMock(): boolean {
  return state.mode === 'mock';
}

// 바꾼 모드를 돌려줌 — 실데이터를 못 쓰는데 real을 고르면 mock 그대로
export function setMode(next: DataMode): DataMode {
  const mode = allowed(next);
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
