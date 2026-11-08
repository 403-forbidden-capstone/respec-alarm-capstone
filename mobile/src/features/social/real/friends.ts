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
import { friendIds, givenTo, personOf, requestIds, type Snapshot } from '../snapshot';
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

// 요청 수락 — 받은 사람(나)만. 친구가 돼도 공유는 아직 없음 (권한 행은 F03에서 저장할 때 생김)
export async function acceptFriend(requesterId: string) {
  const me = await requireUserId();
  const { data, error } = await supabase
    .from('friends')
    .update({ status: 'ACCEPTED', accepted_at: new Date().toISOString() })
    .eq('requester_id', requesterId)
    .eq('addressee_id', me)
    .eq('status', 'PENDING')
    .select('friend_id');
  if (error) throw error;
  invalidateSnapshot();
  // 이미 수락했거나 상대가 요청을 취소한 경우 RLS는 오류 없이 0행을 바꿈
  if (!data?.length) throw new UserError('친구 요청을 찾을 수 없어요. 이미 처리됐을 수 있어요');
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

// 친구 요청 보내기 — 같은 두 사람 사이는 방향과 상관없이 한 건만 (friends_pair_key)
export async function sendFriendRequest(userId: string) {
  const me = await requireUserId();
  if (userId === me) throw new UserError('나에게는 친구 요청을 보낼 수 없어요');
  const { error } = await supabase.from('friends').insert({ requester_id: me, addressee_id: userId, status: 'PENDING' });
  invalidateSnapshot();
  if (!error) return;
  if (error.code === '23505') throw new UserError('이미 친구이거나 요청이 진행 중이에요'); // unique_violation
  if (error.code === '23503') throw new UserError('사용자를 찾을 수 없어요'); // foreign_key_violation
  throw error;
}
