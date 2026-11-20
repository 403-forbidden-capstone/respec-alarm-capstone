// ② 친구 · 그룹 실데이터 — 읽기 공용 (쿼리만, 화면 모양으로 바꾸는 일은 snapshot.ts · map.ts)
//   · loadSnapshot: 친구 · 그룹 · 구성원 · 권한 · 공개 프로필을 한 번에 읽음. 같은 시각에 여러 함수가 부르면(홈이 그룹마다 부름) 한 번만 읽음 — 쓰기 뒤에는 invalidateSnapshot()
//   · loadWakeRows: get_group_wake(칸 7개, 친구 7장). date = 기상 신호가 알려 준 날 (없거나 어제~내일 밖이면 함수가 내 시간대의 오늘)
//   · loadWakeHides: 내가 기상을 숨긴 사람들 (wake_hides — 내 줄만 읽힘, 쓰기는 set_wake_hidden으로만)
import { addDays, lifeDayKey } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import type { WakeRow } from '../map';
import type { Snapshot } from '../snapshot';

async function fetchSnapshot(me: string): Promise<Snapshot> {
  const [friends, groups, members, perms, profiles] = await Promise.all([
    supabase.from('friends').select('friend_id, requester_id, addressee_id, status, requested_at'),
    supabase.from('groups').select('group_id, group_name, created_at').order('created_at'),
    supabase.from('group_members').select('group_id, user_id, invite_status, wake_share_opt_in, trip_share_opt_in, joined_at, notifications_off'),
    supabase.from('sharing_permissions').select('owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm, can_view_wake'),
    supabase.rpc('get_public_profiles'),
  ]);
  for (const r of [friends, groups, members, perms, profiles]) if (r.error) throw r.error;
  return {
    me,
    friends: friends.data ?? [],
    groups: groups.data ?? [],
    members: members.data ?? [],
    perms: perms.data ?? [],
    profiles: profiles.data ?? [],
  };
}

let inflight: { me: string; version: number; promise: Promise<Snapshot> } | null = null;
let version = 0;

// 쓰기(친구 수락 · 권한 저장 · 그룹 만들기 · 동의 바꾸기) 뒤에 부름 — 읽는 중이던 옛 값을 다음 사람이 받지 않게
export function invalidateSnapshot() {
  version++;
  inflight = null;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const me = await requireUserId();
  if (inflight && inflight.me === me && inflight.version === version) return inflight.promise;
  const entry = { me, version, promise: fetchSnapshot(me) };
  inflight = entry;
  const clear = () => {
    if (inflight === entry) inflight = null;
  };
  entry.promise.then(clear, clear);
  return entry.promise;
}

// 서버 get_group_wake는 날짜를 어제 · 오늘 · 내일만 받음(밖이면 줄 없음, 친구의 지난 기상을 거슬러 읽는 길 막기). 폰이 오래 꺼졌다 올라온 기상 신호의
//   날짜는 그 밖일 수 있어 — 이때는 날짜 없이 불러 오늘 기준으로 읽음. 앱은 새벽 4시 기준일(lifeDayKey, 서버 wake_date_in_range · 그룹 화면의 하루와 같은 규칙, 11/20)로 어제~내일을 봄
export function wakeDateInRange(date: string | null | undefined, now: Date = new Date()): string | null {
  if (!date) return null;
  return date >= lifeDayKey(addDays(now, -1)) && date <= lifeDayKey(addDays(now, 1)) ? date : null;
}

export async function loadWakeRows(groupId: string, date?: string | null): Promise<WakeRow[]> {
  const day = wakeDateInRange(date);
  const { data, error } = await supabase.rpc('get_group_wake', day ? { p_group_id: groupId, p_date: day } : { p_group_id: groupId });
  if (error) throw error;
  return data ?? [];
}

export async function loadWakeHides(): Promise<Set<string>> {
  const { data, error } = await supabase.from('wake_hides').select('hidden_from_id');
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.hidden_from_id));
}
