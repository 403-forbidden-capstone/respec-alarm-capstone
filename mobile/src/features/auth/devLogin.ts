// 개발 메뉴 이메일 로그인 폼의 보내기 조건 (시험: __tests__/devLogin.test.ts) — 버튼의 disabled와 키보드 엔터(onSubmitEditing)가 같은 조건을 쓰게 한 곳에 둠
export const canSubmitDevLogin = (email: string, password: string): boolean => email.trim().length > 0 && password.length > 0;

// 데모(시드) 계정 — supabase/seed. 로그인 화면의 [데모 계정으로 로그인]은 첫 계정으로 바로 들어감
export const DEMO_ACCOUNTS = ['demo-me@example.com', 'demo-suyeon@example.com', 'demo-jihyeong@example.com', 'demo-junseong@example.com'] as const;

// 데모 비밀번호 — 개발자용 배포 APK의 EAS 환경 변수(preview) EXPO_PUBLIC_DEMO_PASSWORD. 시드 계정 전용 값이라 번들에 들어가도 되고, 실배포 APK에는 안 넣음
//   비었으면 null → 로그인 화면은 바로 로그인 대신 개발 메뉴의 입력 칸으로 보냄
export const demoPasswordOf = (value: string | undefined): string | null => (value && value.length > 0 ? value : null);
export const DEMO_PASSWORD = demoPasswordOf(process.env.EXPO_PUBLIC_DEMO_PASSWORD);
