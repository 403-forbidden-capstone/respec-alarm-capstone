// ② 친구 실데이터 — F01 친구 · 받은 요청, 새 UI용 아이디 검색 · 요청 보내기 (docs/screen-data-map.md F01 · G01)
//   friends 표는 마이그레이션 그대로: 요청은 내가 PENDING으로만 만들고, 수락은 받은 사람이 UPDATE (RLS friends_insert_request · friends_update_addressee)
//   남의 프로필은 공개 칸(닉네임 · 사진 · 아이디)만 — get_public_profiles · search_by_handle · search_related_by_name이 줌
import { cleanHandle } from '@/features/onboarding/validate';
import { HANDLE_PATTERN } from '@/features/profile/types';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { friendLinkFromRpc, handleSearchFromRpc, openedLinkFromRpc, personFromProfile, type ProfileRow } from '../map';
import { mergeHits } from '../searchView';
import { MESSAGE_FRIEND_LIMIT, MESSAGE_GONE, messageLimit } from '../relationMessages';
import { friendIds, givenTo, personOf, requestIds, sentRequestIds, type Snapshot } from '../snapshot';
import type { FriendItem, FriendLink, FriendRelation, HandleSearch, OpenedLink, PeopleSearch, Person, PersonHit } from '../types';
import { invalidateSnapshot, loadSnapshot } from './load';

export async function listFriends(): Promise<FriendItem[]> {
  const s = await loadSnapshot();
  return friendIds(s).map((id) => ({ person: personOf(s, id), grantCount: givenTo(s, id).count }));
}

export async function listFriendRequests(): Promise<Person[]> {
  const s = await loadSnapshot();
  return requestIds(s).map((id) => personOf(s, id));
}

// 내가 보낸 대기 요청 — 받는 사람 목록, 최근 보낸 순 (F01 보낸 요청 · [취소])
export async function listSentRequests(): Promise<Person[]> {
  const s = await loadSnapshot();
  return sentRequestIds(s).map((id) => personOf(s, id));
}

// 친구 관계 서버 함수 하나를 부르고 {status}를 돌려줌 — 오류는 원문 그대로 던짐, 성공 · 실패 모두 읽어 둔 목록을 비움(다음 읽기에서 새로)
//   친구 요청 · 수락 · 거절 · 취소 · 끊기는 friends 표를 직접 쓰지 않음 (3장부터, 서버가 횟수 · 100명 · 동시 요청 · 권한 삭제를 함)
async function callRelation(name: 'send_friend_request' | 'accept_friend_request' | 'decline_friend_request' | 'cancel_friend_request' | 'remove_friend', args: Record<string, string>) {
  const { data, error } = await supabase.rpc(name, args as never);
  invalidateSnapshot();
  if (error) throw error;
  const r = (data ?? {}) as { status?: string; retry_after_seconds?: number };
  if (typeof r.status !== 'string') throw new Error(`${name} 응답에 status가 없어요`);
  return r as { status: string; retry_after_seconds?: number };
}

const unknownStatus = (name: string, status: string) => new Error(`알 수 없는 ${name} 상태: ${status}`);

// 요청 수락 — 받은 사람(나)만. 친구가 돼도 공유는 아직 없음 (권한 행은 F03에서 저장할 때 생김). 수락 시각은 서버가 정함 (3-26)
//   두 번 눌러 ALREADY_FRIEND가 와도 성공 (3-29). GONE = 상대가 그 사이 취소 (3-28)
export async function acceptFriend(requesterId: string): Promise<void> {
  const { status } = await callRelation('accept_friend_request', { p_requester_id: requesterId });
  if (status === 'ACCEPTED' || status === 'ALREADY_FRIEND') return;
  if (status === 'GONE') throw new UserError(MESSAGE_GONE);
  if (status === 'FRIEND_LIMIT') throw new UserError(MESSAGE_FRIEND_LIMIT);
  throw unknownStatus('accept_friend_request', status);
}

// 받은 요청 거절 — 행이 지워지고 알림은 없음. A 화면은 보낸 목록에서 사라지고 [친구 요청]으로 돌아감 (3-03)
export async function declineFriend(requesterId: string): Promise<void> {
  const { status } = await callRelation('decline_friend_request', { p_requester_id: requesterId });
  if (status === 'DECLINED') return;
  if (status === 'GONE') throw new UserError(MESSAGE_GONE);
  throw unknownStatus('decline_friend_request', status);
}

// 보낸 요청 취소 — 행 삭제 (3-04). 취소해도 하루 요청 횟수는 안 줄어듦(서버)
export async function cancelFriendRequest(addresseeId: string): Promise<void> {
  const { status } = await callRelation('cancel_friend_request', { p_addressee_id: addresseeId });
  if (status === 'CANCELED') return;
  if (status === 'GONE') throw new UserError(MESSAGE_GONE);
  throw unknownStatus('cancel_friend_request', status);
}

// 친구 끊기 — 행 삭제 + 양쪽 친구 출처 권한 삭제(그룹 출처는 그대로), 알림 없음 (3-14 · 3-15 · 3-41)
export async function removeFriend(userId: string): Promise<void> {
  const { status } = await callRelation('remove_friend', { p_user_id: userId });
  if (status === 'REMOVED') return;
  if (status === 'GONE') throw new UserError(MESSAGE_GONE);
  throw unknownStatus('remove_friend', status);
}

// ---------------------------------------------------------------------------
// 새 UI용 — 화면은 나중, api만
// ---------------------------------------------------------------------------

// 요청 중인 사이도 알아야 [친구 요청]을 또 누르게 하지 않음 — 이름 검색(친구 · 같은 그룹)은 관계 값을 FRIEND · GROUP까지만 줘서 내 목록으로 보충
function relationOf(s: Snapshot, otherId: string): FriendRelation {
  const f = s.friends.find((x) => (x.requester_id === s.me && x.addressee_id === otherId) || (x.requester_id === otherId && x.addressee_id === s.me));
  if (!f) return 'NONE';
  if (f.status === 'ACCEPTED') return 'FRIEND';
  if (f.status === 'PENDING') return f.requester_id === s.me ? 'SENT' : 'RECEIVED';
  return 'NONE'; // 차단 — 검색 함수가 이미 숨김
}

// 아이디 정확 일치로 한 명 찾기 (search_by_handle). 1분 10회(성공 · 실패 모두 셈)라 아이디 모양이 아닌 글자는 묻지 않음
//   없음 · 탈퇴 · 차단(어느 쪽이든) · 온보딩 전은 서버가 같은 NOT_FOUND로 줌 (2-14 · 2-34). 앱 쪽 정리는 서버와 같은 규칙: 앞뒤 공백 · 맨 앞 @ · 소문자
export async function searchByHandle(query: string): Promise<HandleSearch> {
  const clean = cleanHandle(query);
  if (!HANDLE_PATTERN.test(clean)) return { status: 'NOT_FOUND' }; // 전각 · 한글 · 3자 미만은 서버도 못 찾음 (2-11 · 2-31)
  const { data, error } = await supabase.rpc('search_by_handle', { p_query: clean });
  if (error) throw error;
  return handleSearchFromRpc(data);
}

// 친구 · 같은 그룹(둘 다 참여 중) 안에서 닉네임 부분 일치 (search_related_by_name). 1~30자, 아니면 빈 결과 (2-46 · 2-47)
export async function searchRelatedByName(query: string): Promise<PersonHit[]> {
  const q = query.trim();
  if (!q || [...q].length > 30) return [];
  const { data, error } = await supabase.rpc('search_related_by_name', { p_query: q });
  if (error) throw error;
  const rows = (data ?? []) as (ProfileRow & { relation: string })[];
  if (!rows.length) return [];
  const s = await loadSnapshot();
  return rows.map((row) => {
    const via = row.relation === 'FRIEND' ? 'FRIEND' : 'GROUP';
    return { person: personFromProfile(row), relation: via === 'FRIEND' ? 'FRIEND' : relationOf(s, row.user_id), via };
  });
}

// F01 검색칸 — 아이디 정확 일치가 먼저(D64 #7), 이름 검색은 친구 · 같은 그룹 안에서만. 아이디 모양이 아니면 아이디 검색 횟수를 쓰지 않음
export async function searchPeople(query: string): Promise<PeopleSearch> {
  const q = query.trim().replace(/^@/, '').trim();
  const empty: PeopleSearch = { rows: [], self: null, limitSeconds: null, notFound: false };
  if (!q) return empty;
  const [byHandle, byName] = await Promise.all([searchByHandle(q), searchRelatedByName(q)]);
  const exact: PersonHit | null = byHandle.status === 'FOUND' ? { person: byHandle.person, relation: byHandle.relation, via: 'HANDLE' } : null;
  const rows = mergeHits(exact, byName);
  const self = byHandle.status === 'SELF' ? byHandle.person : null;
  const limitSeconds = byHandle.status === 'LIMIT' ? byHandle.retryAfterSeconds : null;
  return { rows, self, limitSeconds, notFound: !rows.length && !self && limitSeconds == null };
}

// 내 친구 링크 — 없거나 만료면 서버가 새로 만듦, renew면 새로 만들고 옛 링크는 바로 무효 (7일)
export async function myFriendLink(renew = false): Promise<FriendLink> {
  const { data, error } = await supabase.rpc('my_friend_link', { p_renew: renew });
  if (error) throw error;
  return friendLinkFromRpc(data);
}

// 친구 링크 착지 — 요청은 보내지 않음 (착지 화면 [친구 요청]이 요청 함수를 부름)
export async function openFriendLink(token: string): Promise<OpenedLink> {
  const t = token.trim();
  if (!t) return { status: 'EXPIRED' };
  const { data, error } = await supabase.rpc('open_friend_link', { p_token: t });
  if (error) throw error;
  return openedLinkFromRpc(data);
}

// 친구 요청 보내기 (send_friend_request) — 돌려주는 값은 이 사람과의 새 관계: 보냄(SENT) · 친구(FRIEND)
//   상대가 먼저 보낸 대기가 있으면 서버가 맞요청으로 자동 수락 → ACCEPTED = 바로 친구 (3-05). 이미 보냈으면 SENT · 이미 친구면 FRIEND 그대로 (3-06 · 3-07)
//   1분 10회 · 하루 50회 · 친구 100명은 서버가 판단 — LIMIT은 기다릴 시간, FRIEND_LIMIT은 상한 문구 (3-10 · 3-11 · 3-12)
export async function sendFriendRequest(userId: string): Promise<'SENT' | 'FRIEND'> {
  const { status, retry_after_seconds } = await callRelation('send_friend_request', { p_target_id: userId });
  switch (status) {
    case 'REQUESTED':
    case 'ALREADY_REQUESTED':
      return 'SENT';
    case 'ACCEPTED':
    case 'ALREADY_FRIEND':
      return 'FRIEND';
    case 'SELF':
      throw new UserError('나에게는 친구 요청을 보낼 수 없어요');
    case 'NOT_FOUND':
      throw new UserError('사용자를 찾을 수 없어요'); // 없음 · 탈퇴 · 온보딩 전 · 차단 쌍이 같은 응답
    case 'LIMIT':
      throw new UserError(messageLimit(retry_after_seconds ?? 1));
    case 'FRIEND_LIMIT':
      throw new UserError(MESSAGE_FRIEND_LIMIT);
    default:
      throw unknownStatus('send_friend_request', status);
  }
}
