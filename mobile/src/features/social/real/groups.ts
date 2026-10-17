// ② 그룹 실데이터 — G01 그룹 목록 · H01 그룹 요약 · G02 그룹 상세, 새 UI용 그룹 만들기 · 코드로 참여 · 초대 코드 다시 만들기 · 기상 공유 동의
//   groups · group_members(JOINED) · 연결 일정 appointments.group_id · 기상 공유 동의 wake_share_opt_in (docs/screen-data-map.md G01 · G02)
//   그룹원 기상 상태는 get_group_wake_status — 그 그룹 약속이 있는 날만 행을 줌 (D57), 기상까지만 (D59)
//   date = 기상 신호(lib/realtime)가 알려 준 날. 없으면 함수가 내 시간대의 오늘
import { now } from '@/lib/clock';
import { parseDbTime } from '@/lib/dbTime';
import { startOfDay } from '@/lib/format';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { sinceLabel, wakeStateOf, wokeCountOf, initialOf } from '../map';
import { canSeeWakeIn, groupShareSet, joinedIds, myGroup, myGroups, myOptIn, personOf, receivedFrom } from '../snapshot';
import { mergeGrants } from '../grants';
import type { CreatedGroup, GroupDetail, GroupItem, GroupSummary } from '../types';
import { invalidateSnapshot, loadSnapshot, loadWakeRows } from './load';

// 연결 일정은 오늘부터 앞으로 (지난 약속은 안 보임 — 작성자 판단), 많아도 이만큼
const APPOINTMENT_LIMIT = 20;

export async function listGroups(date?: string | null): Promise<GroupItem[]> {
  const s = await loadSnapshot();
  const groups = myGroups(s);
  const wake = await Promise.all(groups.map((g) => loadWakeRows(g.group_id, date)));
  return groups.map((g, i) => ({
    id: g.group_id,
    name: g.group_name,
    initial: initialOf(g.group_name),
    memberCount: joinedIds(s, g.group_id).length,
    wokeCount: wokeCountOf(wake[i]),
    grants: groupShareSet(s, g.group_id),
    canSeeWake: canSeeWakeIn(s, g.group_id),
  }));
}

export async function getGroupSummary(groupId: string, date?: string | null): Promise<GroupSummary | null> {
  const s = await loadSnapshot();
  const group = myGroup(s, groupId);
  if (!group) return null;
  const rows = await loadWakeRows(groupId, date);
  return {
    id: group.group_id,
    name: group.group_name,
    members: joinedIds(s, groupId).map((id) => ({ person: personOf(s, id), state: wakeStateOf(rows.find((r) => r.user_id === id), rows.length > 0) })),
    wokeCount: wokeCountOf(rows),
  };
}

export async function getGroup(groupId: string, date?: string | null): Promise<GroupDetail | null> {
  const s = await loadSnapshot();
  const group = myGroup(s, groupId);
  if (!group) return null;
  const [rows, appointments] = await Promise.all([loadWakeRows(groupId, date), loadAppointments(groupId)]);
  return {
    id: group.group_id,
    name: group.group_name,
    since: sinceLabel(group.created_at),
    grants: groupShareSet(s, groupId),
    appointments,
    inviteCode: group.invite_code,
    members: joinedIds(s, groupId).map((id) => ({
      person: personOf(s, id),
      isMe: id === s.me,
      state: wakeStateOf(rows.find((r) => r.user_id === id), rows.length > 0),
      received: id === s.me ? mergeGrants([]) : receivedFrom(s, id),
    })),
    isOwner: group.owner_id === s.me,
    wakeShareOptIn: myOptIn(s, groupId),
  };
}

async function loadAppointments(groupId: string): Promise<GroupDetail['appointments']> {
  const { data, error } = await supabase
    .from('appointments')
    .select('appointment_id, title, appointment_at, dest_name, importance')
    .eq('group_id', groupId)
    .gte('appointment_at', startOfDay(now()).toISOString())
    .order('appointment_at')
    .limit(APPOINTMENT_LIMIT);
  if (error) throw error;
  return (data ?? []).map((a) => ({ id: a.appointment_id, title: a.title, at: parseDbTime(a.appointment_at), place: a.dest_name, importance: a.importance }));
}

// ---------------------------------------------------------------------------
// 새 UI용 — 화면은 나중, api만
// ---------------------------------------------------------------------------

// 그룹 만들기 — 만든 사람은 DB 트리거(add_owner_as_member)가 바로 참여(JOINED)로 넣고, 초대 코드는 기본값으로 생김
export async function createGroup(name: string): Promise<CreatedGroup> {
  const me = await requireUserId();
  const trimmed = name.trim();
  if (!trimmed) throw new UserError('그룹 이름을 입력해 주세요');
  if ([...trimmed].length > 50) throw new UserError('그룹 이름은 50자까지 쓸 수 있어요');
  const { data, error } = await supabase.from('groups').insert({ group_name: trimmed, owner_id: me }).select('group_id, invite_code').single();
  invalidateSnapshot();
  if (error) throw error;
  return { id: data.group_id, inviteCode: data.invite_code };
}

// 초대 코드로 참여 — 대소문자 · 앞뒤 공백은 DB 함수가 맞춤. 참여한 그룹 id를 돌려줌 (다시 참여하면 기상 공유 동의는 꺼진 채로 시작)
export async function joinGroupByCode(code: string): Promise<string> {
  const trimmed = code.trim();
  if (!trimmed) throw new UserError('초대 코드를 입력해 주세요');
  const { data, error } = await supabase.rpc('join_group_by_invite_code', { p_invite_code: trimmed });
  invalidateSnapshot();
  if (error) {
    if (error.code === 'P0001') throw new UserError('초대 코드가 맞지 않아요'); // raise exception '초대 코드가 맞지 않음'
    throw error;
  }
  return data;
}

// 초대 코드 새로 받기 — 만든 사람만. 옛 코드는 바로 못 씀
export async function regenerateInviteCode(groupId: string): Promise<string> {
  const { data, error } = await supabase.rpc('regenerate_invite_code', { p_group_id: groupId });
  invalidateSnapshot();
  if (error) {
    if (error.code === '42501') throw new UserError('그룹을 만든 사람만 초대 코드를 바꿀 수 있어요'); // insufficient_privilege
    throw error;
  }
  return data;
}

// 이 그룹에 내 기상 상태를 공유하는 것에 동의 (group_members.wake_share_opt_in) — 본인 행만 고칠 수 있음 (RLS group_members_update_self)
//   D19 열림: F03에서 기상 상태 조회를 켤 때 같이 켤지 따로 둘지 정해지기 전이라 F03 저장은 이 값을 건드리지 않음
export async function setWakeShareOptIn(groupId: string, on: boolean) {
  const me = await requireUserId();
  const { data, error } = await supabase
    .from('group_members')
    .update({ wake_share_opt_in: on })
    .eq('group_id', groupId)
    .eq('user_id', me)
    .eq('invite_status', 'JOINED')
    .select('group_member_id');
  invalidateSnapshot();
  if (error) throw error;
  if (!data?.length) throw new UserError('참여 중인 그룹이 아니에요');
}
