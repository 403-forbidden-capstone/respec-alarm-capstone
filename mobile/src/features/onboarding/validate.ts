// 온보딩 입력 검사 — 순수 함수 (시험: __tests__/validate.test.ts)
import { HANDLE_PATTERN } from '@/features/profile/types';

export const NICKNAME_MAX = 30; // profiles.nickname varchar(30)

// 아이디로 쓸 글자 — 앞뒤 공백과 앞의 @를 떼고 소문자로
export function cleanHandle(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

export function isHandleFormat(input: string): boolean {
  return HANDLE_PATTERN.test(cleanHandle(input));
}

// 닉네임으로 쓸 글자 — 앞뒤 공백을 뗌
export function cleanNickname(input: string): string {
  return input.trim();
}

// 공백만이거나 30자를 넘으면 못 씀
export function isNicknameOk(input: string): boolean {
  const nickname = cleanNickname(input);
  return nickname.length > 0 && nickname.length <= NICKNAME_MAX;
}

// 아이디를 저장(중복 확인 포함)해야 하는지 — 이미 저장해 둔 아이디와 같으면 안 함. saved = 지금까지 저장한 아이디 (처음엔 프로필의 값)
export function shouldSaveHandle(clean: string, saved: string | null | undefined): boolean {
  return clean !== (saved ?? null);
}
