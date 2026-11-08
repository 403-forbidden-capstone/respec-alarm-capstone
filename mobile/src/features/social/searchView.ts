// F01 검색 결과를 화면 문구 · 버튼으로 바꾸는 순수 함수 (시험: __tests__/search.test.ts, 시험케이스 2장)
import { formatWait } from '@/lib/format';

import type { FriendRelation, PeopleSearch, PersonHit } from './types';

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
