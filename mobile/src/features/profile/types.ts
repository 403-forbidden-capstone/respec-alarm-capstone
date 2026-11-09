// 내 프로필 — supabase/migrations의 profiles 칼럼과 같은 이름
// (타입 생성 `npx supabase gen types` 뒤에는 생성된 타입으로 바꿈)

export type TransportType = 'WALK' | 'TRANSIT' | 'BUS' | 'SUBWAY' | 'CAR';

// 잠귀 한 문항 (D69) — 가벼움 · 보통 · 깊음. 계산 반영은 L1
export type WakeSensitivity = 'LIGHT' | 'NORMAL' | 'HEAVY';
// 깨우는 여유 (D63) — 빠듯 · 보통 · 넉넉 = 기록의 0.7 · 0.8 · 0.9 분위수. 계산 반영은 L1
export type WakeMargin = 'TIGHT' | 'NORMAL' | 'LOOSE';

export type Profile = {
  user_id: string;
  nickname: string;
  handle: string | null; // 가입하면 서버가 자동 아이디(respec_…)를 채움. 바꾸기는 change_my_handle(DB 함수)로만
  handle_changed_at: string | null; // 직접 바꾼 마지막 시각 — 비어 있으면 자동 아이디 그대로('바꿔 보세요')
  handle_next_change_at: string | null; // 다음 변경 가능 시각 — 비어 있으면 언제든
  profile_image_url: string | null;
  default_prepare_minutes: number;
  default_buffer_minutes: number;
  home_name: string | null;
  home_lat: number | null;
  home_lng: number | null;
  home_radius_m: number | null; // 집 감지 범위(m, 100~500). 비었으면 앱 기본값 200 (location/constants HOME_RADIUS_M)
  default_transport: TransportType;
  timezone: string;
  onboarded_at: string | null; // null = 아직 온보딩 안 끝남
  wake_sensitivity: WakeSensitivity;
  wake_margin: WakeMargin;
  privacy_agreed_at: string | null; // privacy_version과 같이 있거나 같이 없음
  privacy_version: number | null;
  wake_ping_enabled: boolean; // 친구 깨우기 받기 — 기본 켬. 꺼 두면 보낸 쪽에 '지금은 깨울 수 없어요'만 (친구 8장)
};

// 한 번에 바꿀 수 있는 칸 — 온보딩 단계마다 · 설정에서 쓰는 만큼만 저장 (profile/api.ts saveProfileFields). 아이디는 여기 없음 — changeMyHandle
export type ProfileFields = Partial<
  Pick<
    Profile,
    | 'nickname'
    | 'home_name'
    | 'home_lat'
    | 'home_lng'
    | 'home_radius_m'
    | 'default_prepare_minutes'
    | 'default_buffer_minutes'
    | 'default_transport'
    | 'wake_sensitivity'
    | 'wake_margin'
    | 'privacy_agreed_at'
    | 'privacy_version'
    | 'wake_ping_enabled'
  >
>;

// 아이디 규칙 — DB 제약과 같음 (^[a-z0-9_]{3,20}$, 대소문자 무시 유일)
export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
