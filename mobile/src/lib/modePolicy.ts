// 데이터 모드 규칙 — 판단만 하는 순수 함수 (Platform · __DEV__ · 환경 변수 · 저장소는 lib/mode.ts가 읽어서 넘김, 시험은 __tests__/modePolicy.test.ts)
//
//   실데이터(real) = 로그인 · Supabase, 가짜(mock) = 목업 시나리오(로그인 없이 바로 탭)
//
//   환경                                 | 모드를 바꿀 수 있나 | 기본값 | 그 밖
//   -------------------------------------|---------------------|--------|----------------------------------------------
//   REAL_DATA_READY = false              | 아니오 (늘 가짜)     | 가짜   | 실데이터를 붙이기 전 상태로 되돌리는 스위치
//   폰 + 출시용 빌드(__DEV__ false)       | 아니오 (실데이터 고정) | 실데이터 | 로그인해야만 씀 · Supabase 값이 없으면 "설정 오류" 화면 (가짜로 돌지 않음)
//   폰 + 개발용(__DEV__ true)             | 예                  | 실데이터 | Supabase 값이 없으면 가짜만
//   웹                                   | 예                  | 가짜   | 주소 ?mode=real이면 실데이터. Supabase 값이 없으면 가짜만
//
// 근거: 개발환경_v1.md "지형님이 정한 것" 10/14 (로그인해야만 씀 · 가짜 모드는 폰 앱에서만 막음, 웹 미리보기 · 개발용은 그대로), 전체작업계획 8.1 Q8 A
export type DataMode = 'real' | 'mock';

export type ModeEnv = {
  web: boolean; // Platform.OS === 'web'
  dev: boolean; // __DEV__ — 폰 개발용 빌드 (출시용 APK는 false)
  configured: boolean; // Supabase 주소 · 키 값이 이 빌드에 들어 있음
  ready: boolean; // lib/flags REAL_DATA_READY
  devApk?: boolean; // 개발자용 배포 APK (EXPO_PUBLIC_APP_VARIANT=dev, eas.json preview) — 실데이터 고정은 출시용과 같고 데모 로그인만 보임
};

export type ModePolicy = {
  canUseReal: boolean; // 실데이터 모드로 돌 수 있음
  locked: boolean; // 사용자가 모드를 못 바꿈 — 실데이터 고정 (폰 출시용 빌드)
  configError: boolean; // 잠긴 빌드인데 Supabase 값이 없음 → 가짜로 돌지 않고 설정 오류 화면
  defaultMode: DataMode;
};

export function modePolicy(env: ModeEnv): ModePolicy {
  if (!env.ready) return { canUseReal: false, locked: false, configError: false, defaultMode: 'mock' };
  const locked = !env.web && !env.dev;
  if (locked) return { canUseReal: env.configured, locked: true, configError: !env.configured, defaultMode: 'real' };
  return { canUseReal: env.configured, locked: false, configError: false, defaultMode: env.web || !env.configured ? 'mock' : 'real' };
}

// 이번에 쓸 모드 — 주소(?mode=, 웹) → 저장값 → 기본값 순. 잠겼으면 늘 실데이터, 실데이터를 못 쓰면 요청이 real이어도 가짜
export function resolveMode(policy: ModePolicy, input: { url?: DataMode | null; saved?: DataMode | null } = {}): DataMode {
  if (policy.locked) return 'real';
  const wanted = input.url ?? input.saved ?? policy.defaultMode;
  return wanted === 'real' && !policy.canUseReal ? 'mock' : wanted;
}

// 화면 번호(H01 등) 표시 — 개발용 폰 빌드와 웹 미리보기에서만, 출시용 폰 빌드(__DEV__ false)에선 숨김 (D16 "출시 빌드에 개발용 요소를 숨김"과 같은 판정, 실데이터 · Supabase 값과 상관없음)
export function showScreenIds(env: ModeEnv): boolean {
  return env.web || env.dev;
}

// 데모(시드) 계정 이메일 로그인 — 로그인 화면 · 개발 메뉴(/dev/screens). 웹 · 폰 개발용 · 개발자용 배포 APK에서만, 실배포(v1) APK에는 안 보임
export function showDevLogin(env: ModeEnv): boolean {
  return env.ready && env.configured && (env.web || env.dev || env.devApk === true);
}

// 빌드 종류 — EXPO_PUBLIC_APP_VARIANT. 'release'(실배포)만 실배포로 보고, 비었거나 다른 값이면 개발자용 (값을 빠뜨린 빌드가 테스터에게 막히지 않게)
export type AppVariant = 'dev' | 'release';
export const appVariantOf = (value: string | undefined): AppVariant => (value?.trim() === 'release' ? 'release' : 'dev');
