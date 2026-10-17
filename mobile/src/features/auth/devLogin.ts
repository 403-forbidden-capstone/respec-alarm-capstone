// 개발 메뉴 이메일 로그인 폼의 보내기 조건 (시험: __tests__/devLogin.test.ts) — 버튼의 disabled와 키보드 엔터(onSubmitEditing)가 같은 조건을 쓰게 한 곳에 둠
export const canSubmitDevLogin = (email: string, password: string): boolean => email.trim().length > 0 && password.length > 0;
