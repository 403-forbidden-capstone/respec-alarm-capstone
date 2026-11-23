// 기능 스위치 — 아직 안 붙인 기능을 앱 흐름에서 빼 둠
// REAL_DATA_READY: 로그인 · 온보딩 · 실데이터(Supabase)를 붙였는지 (P6, #166에서 true)
//   true면 데이터 모드 규칙이 lib/modePolicy.ts 표대로 돎: 폰 출시용 빌드는 실데이터만 · 로그인 필수, 웹 · 폰 개발용은 모드를 바꿀 수 있음
//   false로 되돌리면 Supabase가 연결된 빌드도 가짜 데이터로만 돌고, 목업에 없는 로그인 · 온보딩 · 설정 화면으로 가지 않음 (#116)
export const REAL_DATA_READY = true;

// ALARM_AXES_PICKER: 알람 설정(H03)에서 배경음 · 말소리 · 진동을 따로 고르게 보일지 (D1 A, #312 · #316)
//   지형님 10/30: "강도를 다 설정하게 하면 UX가 과함" → 결정 안건(투표)으로 올림. 결과가 나올 때까지는 켜 둠(true)
//   false: H03 "알람 강도" 카드가 자동 강도 한 줄만 보임. 이미 저장된 축 값(sound_key · voice_tone · vibration)은 지우지 않되 서버 · 폰 계산이 무시하고 모두 강도를 따름 —
//   숨긴 설정이 몰래 알람에 영향을 주지 않게 (헤드 확정 10/30). 값은 서버와 같은 상수 하나(_shared/calc/intensity.ts AXES_PICKER_ENABLED)이고 여기서 다시 내보냄 — 끄려면 거기서 false로, 서버 함수 재배포도 같이
export { AXES_PICKER_ENABLED as ALARM_AXES_PICKER } from '@shared/calc/intensity.ts';

// ONBOARDING_IN_FLOW: 단계 온보딩(app/onboarding.tsx)을 앱 흐름에 넣을지 (임시 온보딩을 단계 온보딩으로 바꿈, #25)
//   true: 로그인한 뒤 프로필의 onboarded_at이 비어 있으면 온보딩부터 (판정은 features/auth/onboardingGate.ts). 어느 단계를 거칠지는 아래 ONBOARDING_STEPS
//   false로 되돌리면 온보딩 없이 바로 홈 — 화면 파일은 그대로 두고 길만 막음 (주소로도 안 열림)
//   아이디(profiles.handle)가 비어 있으면 친구가 @아이디로 나를 못 찾을 뿐, 나머지 화면은 그대로 동작함
export const ONBOARDING_IN_FLOW = true;

// 온보딩 단계 id — 순서는 features/onboarding/steps.ts ONBOARDING_ORDER
export type OnboardingStepId =
  | 'handle'
  | 'nickname'
  | 'sleep'
  | 'home'
  | 'prepare'
  | 'timetable'
  | 'consent'
  | 'permissions'
  | 'share'
  | 'first'
  | 'mic';

// 단계마다 켜고 끄는 표 — 10/29 지형님: 일단 다 넣고 보면서 뺌 → 단계마다 flag (D38 기본안 C)
//   끈 단계는 건너뛰고 진행 표시(n / 전체)도 켠 단계만 셈. 화면을 만들면 켬
//   permissions: 권한 안내 단계 — PR 7에서 켬. 위치 줄은 아래 ONBOARDING_LOCATION_ROWS로 따로
//   mic: 마이크 권한 — L4(음성) 뒤에 켬. 매니페스트에 RECORD_AUDIO가 아직 없음
export const ONBOARDING_STEPS: Record<OnboardingStepId, boolean> = {
  handle: true,
  nickname: true,
  sleep: true,
  home: true,
  prepare: true,
  timetable: true,
  consent: true,
  permissions: true,
  share: true,
  first: true,
  mic: false,
};

// 시간표 채우기 길 (D66-1) — 직접 입력은 위 ONBOARDING_STEPS.timetable, 아래 둘은 그 단계 · 학교 시간표 화면에서 쓰는 가져오기 입구. "되게 해 놓고 빼면 된다"(지형님 10/30) → 길마다 끄고 켬
//   photo: [시간표 사진으로 넣기] — 사진 고르기 → 서버 함수 timetable-extract(Claude가 읽음) → 확인 화면
//   calendar: [폰 캘린더에서 가져오기] — 캘린더 읽기 → 앞으로 2주 매주 반복 일정 후보(규칙, AI 없음) → 확인 화면
export const TIMETABLE_PATHS = {
  photo: true,
  calendar: true,
};

// 권한 안내 단계에 위치 줄(전경 · 항상)을 넣을지 — L2 permissions.ts가 들어와서 켬 (안건 2 A)
export const ONBOARDING_LOCATION_ROWS = true;

// Optional research pilot. OFF by default and restricted again in the RPC.
export const PREP_START_SELF_REPORT_PILOT = process.env.EXPO_PUBLIC_PREP_START_SELF_REPORT_PILOT === '1';
