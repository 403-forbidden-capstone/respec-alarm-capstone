// 친구 · 그룹 화면 초안(U01 · U06 · U07)의 순수 함수 — 화면 · 부품 밖에 둬서 시험하기 쉽게 (시험: __tests__/draft.test.ts)
import { HANDLE_PATTERN } from '@/features/profile/types';

import type { FriendRelation } from './types';

// 아이디 규칙 안내 한 줄 — 온보딩 · 아이디 바꾸기 · 친구 찾기가 같은 글자를 씀
export const HANDLE_RULE = '영문 소문자 · 숫자 · 밑줄(_) 3~20자, @는 빼고 적어요.';

// 아이디 입력 정리 — 앞뒤 공백 · 앞 @를 떼고 소문자로 (searchByHandle · 온보딩과 같은 규칙)
export function cleanHandle(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

// 정리한 아이디가 DB 규칙(profiles_handle_format)에 맞는지
export const isValidHandle = (clean: string): boolean => HANDLE_PATTERN.test(clean);

// 초대 코드 정리 — 공백을 모두 빼고 대문자로 (코드는 대문자 + 숫자. 가짜 모드 코드는 CAP-6KQ3처럼 -가 들어가 -는 그대로 둠)
export function cleanInviteCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

// 코드를 다른 앱으로 보낼 때 문구 (G02 초대 시트 · 그룹 만들기 결과가 같이 씀)
export const inviteMessage = (groupName: string, code: string): string => `Re:Spec 알람 '${groupName}' 그룹에 초대해요. 초대 코드: ${code}`;

// 아이디로 찾은 사람과의 관계 → 결과 카드의 버튼 글자 · 종류
//   action이 있으면 누르는 버튼(request = 친구 요청 보내기, accept = 받은 요청 수락), null이면 누를 것 없는 상태 글자
export type RelationAction = { label: string; action: 'request' | 'accept' | null };

const RELATION_ACTION: Record<FriendRelation, RelationAction> = {
  NONE: { label: '친구 요청', action: 'request' },
  RECEIVED: { label: '수락', action: 'accept' },
  SENT: { label: '요청 보냄', action: null },
  FRIEND: { label: '이미 친구예요', action: null },
  SELF: { label: '내 아이디예요', action: null },
};

export const relationAction = (relation: FriendRelation): RelationAction => RELATION_ACTION[relation];
