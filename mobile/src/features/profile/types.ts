// 내 프로필 — supabase/migrations의 profiles 칼럼과 같은 이름
// (타입 생성 `npx supabase gen types` 뒤에는 생성된 타입으로 바꿈)

export type TransportType = 'WALK' | 'TRANSIT' | 'BUS' | 'SUBWAY' | 'CAR';

export type Profile = {
  user_id: string;
  nickname: string;
  handle: string | null; // 온보딩 전엔 null
  profile_image_url: string | null;
  default_prepare_minutes: number;
  default_buffer_minutes: number;
  home_name: string | null;
  home_lat: number | null;
  home_lng: number | null;
  default_transport: TransportType;
  timezone: string;
};

export type OnboardingInput = Pick<
  Profile,
  'nickname' | 'handle' | 'home_name' | 'default_prepare_minutes' | 'default_buffer_minutes' | 'default_transport'
>;

// 아이디 규칙 — DB 제약과 같음 (^[a-z0-9_]{3,20}$, 대소문자 무시 유일)
export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
