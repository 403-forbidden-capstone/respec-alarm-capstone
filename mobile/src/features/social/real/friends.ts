// ② 친구 실데이터 — F01 친구 · 받은 요청, 새 UI용 아이디 검색 · 요청 보내기 (docs/screen-data-map.md F01 · G01)
//   friends 표는 마이그레이션 그대로: 요청은 내가 PENDING으로만 만들고, 수락은 받은 사람이 UPDATE (RLS friends_insert_request · friends_update_addressee)
//   남의 프로필은 공개 칸(닉네임 · 사진 · 아이디)만 — get_public_profiles · find_profile_by_handle가 줌
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { personFromProfile } from '../map';
import { friendIds, givenTo, personOf, requestIds, type Snapshot } from '../snapshot';
import type { FriendItem, FriendRelation, HandleSearchResult, Person } from '../types';
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

function relationOf(s: Snapshot, otherId: string): FriendRelation {
  if (otherId === s.me) return 'SELF';
  const f = s.friends.find((x) => (x.requester_id === s.me && x.addressee_id === otherId) || (x.requester_id === otherId && x.addressee_id === s.me));
  if (!f) return 'NONE';
  if (f.status === 'ACCEPTED') return 'FRIEND';
  if (f.status === 'PENDING') return f.requester_id === s.me ? 'SENT' : 'RECEIVED';
  return 'NONE'; // 차단 — find_profile_by_handle가 이미 숨김
}

// 아이디(@ 있어도 없어도, 대소문자 무관)로 한 명 찾기. 없으면 null. 친구가 아니어도 닉네임 · 사진 · 아이디만 보임
export async function searchByHandle(handle: string): Promise<HandleSearchResult | null> {
  const clean = handle.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(clean)) return null; // profiles_handle_format과 같은 모양이 아니면 DB에 물을 필요도 없음
  const { data, error } = await supabase.rpc('find_profile_by_handle', { p_handle: clean });
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  const s = await loadSnapshot();
  return { person: personFromProfile(row), relation: relationOf(s, row.user_id) };
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
