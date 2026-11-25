// F01 검색 결과를 화면 문구 · 버튼으로 바꾸는 순수 함수 (시험: __tests__/search.test.ts, 시험케이스 2장)
import { formatWait } from '@/lib/format';

import type { FriendRelation, PeopleSearch, PersonHit } from './types';

// 못 찾았을 때 먼저 — 이름은 이미 친구 · 같은 그룹인 사람 안에서만 찾아서, 앱을 쓰는 친구는 아이디로 찾아야 함 (D-04)
export const SEARCH_SCOPE_HINT = '이름은 친구와 같은 그룹 사람 중에서만 찾아요. 앱을 쓰는 친구는 아이디로 찾아 보세요.';

export type SearchNotice = { text: string; invite: boolean }; // invite = [카톡으로 초대]를 같이 보일지

// 결과 위에 보일 한 줄. 제한이 가장 먼저 — 누구를 찾든 같은 문구라 "찾을 수 없어요"와 섞이지 않음 (2-37)
export function searchNotice(search: PeopleSearch): SearchNotice | null {
  if (search.limitSeconds != null) return { text: `잠시 뒤 다시 해 주세요(${formatWait(search.limitSeconds)})`, invite: false };
  if (search.self) return { text: '내 아이디예요', invite: false };
  if (search.notFound) return { text: '찾을 수 없어요', invite: true }; // 없음 · 탈퇴 · 차단(어느 쪽이든)이 같은 문구 (2-14)
  return null;
}

export type RelationAction = 'request' | 'accept' | 'none';

// 결과 줄 오른쪽 상태 버튼 — 관계대로 (2-다). none = 눌러도 아무 일 없는 표시
export function relationButton(relation: FriendRelation): { label: string; action: RelationAction } {
  switch (relation) {
    case 'NONE':
      return { label: '친구 요청', action: 'request' };
    case 'SENT':
      return { label: '요청 보냄', action: 'none' };
    case 'RECEIVED':
      return { label: '수락', action: 'accept' };
    case 'FRIEND':
      return { label: '친구', action: 'none' };
  }
}

// 아이디 정확 일치를 맨 앞에, 이름 검색 결과는 뒤에. 같은 사람은 한 번만
export function mergeHits(exact: PersonHit | null, byName: PersonHit[]): PersonHit[] {
  const rows = exact ? [exact] : [];
  for (const hit of byName) if (!rows.some((r) => r.person.id === hit.person.id)) rows.push(hit);
  return rows;
}

// 검색 결과 줄의 관계 — 지금 읽어 둔 목록이 서버 값보다 새로움. 요청을 보내거나 받거나 거절 · 취소 · 끊기를 한 뒤에도 목록만 새로 읽으면 맞게 돌아옴 (3-03 · 3-09)
export function relationFromLists(
  id: string,
  lists: { friends: readonly string[]; requests: readonly string[]; sent: readonly string[] },
): FriendRelation {
  if (lists.friends.includes(id)) return 'FRIEND';
  if (lists.requests.includes(id)) return 'RECEIVED';
  if (lists.sent.includes(id)) return 'SENT';
  return 'NONE';
}
