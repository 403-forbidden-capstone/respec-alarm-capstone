// ② 그룹 실데이터 — G01 그룹 목록 · H01 그룹 요약 · G02 그룹 상세, 새 UI용 그룹 만들기 · 코드로 참여 · 초대 코드 다시 만들기 · 기상 공유 동의
//   groups · group_members(JOINED) · 연결 일정 appointments.group_id · 기상 공유 동의 wake_share_opt_in (docs/screen-data-map.md G01 · G02)
//   그룹원 기상 상태는 get_group_wake — 그 그룹 약속이 있는 날만 줄을 줌(D57): 나 + 그 그룹에서 기상 공유에 동의한 멤버 − 나를 숨긴 사람 − 차단 (친구 7장)
//   date = 기상 신호(lib/realtime)가 알려 준 날. 없으면 함수가 내 시간대의 오늘
import { now } from '@/lib/clock';
import { parseDbTime } from '@/lib/dbTime';
import { startOfDay } from '@/lib/format';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { sinceLabel, tripCountsOf, wakeStateOf, wokeCountOf, initialOf } from '../map';
import { friendIds, groupShareSet, joinedIds, myGroup, myGroups, myJoinedAt, myNotificationsOff, myOptIn, myTripOptIn, personOf, receivedFrom } from '../snapshot';
import { mergeGrants } from '../grants';
import { CODE_EXPIRED, CODE_NOT_FOUND, GROUP_FULL, GROUP_NOT_MEMBER, GROUP_TOO_MANY, cleanCode, groupNameProblem } from '../groupTexts';
import { MESSAGE_GONE, messageLimit } from '../relationMessages';
import type { AppointmentJoiner, CreatedGroup, GroupCode, GroupDetail, GroupInvite, GroupItem, GroupPreview, GroupSummary, InvitableFriend, JoinedGroup } from '../types';
import { invalidateSnapshot, loadSnapshot, loadWakeHides, loadWakeRows } from './load';
import { sendPush } from './push';

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
    trip: tripCountsOf(wake[i]),
    grants: groupShareSet(s, g.group_id),
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
    trip: tripCountsOf(rows),
  };
}

export async function getGroup(groupId: string, date?: string | null): Promise<GroupDetail | null> {
  const s = await loadSnapshot();
  const group = myGroup(s, groupId);
  if (!group) return null;
  const [rows, appointments, hides] = await Promise.all([loadWakeRows(groupId, date), loadAppointments(groupId, s.me), loadWakeHides()]);
  return {
    id: group.group_id,
    name: group.group_name,
    since: sinceLabel(myJoinedAt(s, groupId) ?? group.created_at), // 내가 들어온 날 (5-41)
    grants: groupShareSet(s, groupId),
    appointments,
    members: joinedIds(s, groupId).map((id) => ({
      person: personOf(s, id),
      isMe: id === s.me,
      state: wakeStateOf(rows.find((r) => r.user_id === id), rows.length > 0),
      received: id === s.me ? mergeGrants([]) : receivedFrom(s, id),
      wakeHidden: hides.has(id),
    })),
    wakeShareOptIn: myOptIn(s, groupId),
    tripShareOptIn: myTripOptIn(s, groupId),
    notificationsOff: myNotificationsOff(s, groupId),
  };
}

// 연결 일정 (친구 9장) — 오늘부터의 그룹 약속 + 인원수 · 내 참여(서버가 셈). 인원수를 못 읽은 약속은 0명 · 안 참여
async function loadAppointments(groupId: string, me: string): Promise<GroupDetail['appointments']> {
  const [list, counts] = await Promise.all([
    supabase
      .from('appointments')
      .select('appointment_id, title, appointment_at, dest_name, importance, creator_id')
      .eq('group_id', groupId)
      .gte('appointment_at', startOfDay(now()).toISOString())
      .order('appointment_at')
      .limit(APPOINTMENT_LIMIT),
    supabase.rpc('group_appointment_counts', { p_group_id: groupId }),
  ]);
  if (list.error) throw list.error;
  if (counts.error) throw counts.error;
  const byId = new Map((counts.data ?? []).map((c) => [c.appointment_id, c]));
  const current = now().getTime();
  return (list.data ?? []).map((a) => {
    const at = parseDbTime(a.appointment_at);
    const c = byId.get(a.appointment_id);
    return {
      id: a.appointment_id,
      title: a.title,
      at,
      place: a.dest_name,
      importance: a.importance,
      joinedCount: c?.joined_count ?? 0,
      iJoined: c?.i_joined ?? false,
      past: at.getTime() <= current,
      mine: a.creator_id === me,
      creatorUnknown: a.creator_id == null,
    };
  });
}

// 연결 일정을 열었을 때 참여자 줄 — 서버가 그 그룹 참여 멤버마다 참여 · 알람 없음 · 숨김(차단 쌍)을 줌, 나 먼저 (9-42 · 9-33)
export async function getAppointmentJoiners(appointmentId: string): Promise<AppointmentJoiner[]> {
  const [s, { data, error }] = await Promise.all([loadSnapshot(), supabase.rpc('appointment_joiners', { p_appointment_id: appointmentId })]);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    person: personOf(s, r.user_id),
    isMe: r.user_id === s.me,
    state: r.hidden ? 'HIDDEN' : r.joined ? 'JOINED' : 'NO_ALARM',
  }));
}

// ---------------------------------------------------------------------------
// 5장 쓰기 · 코드 · 초대 — 상태 값은 문구로 (서버 판단은 DB 함수, 앱은 호출 모양 · 문구 · 갱신만)
// ---------------------------------------------------------------------------

// 5장 함수가 돌려주는 jsonb — 함수마다 일부 칸만 옴 (세션약속 1절)
type GroupFnResult = {
  status?: string;
  group_id?: string;
  group_name?: string;
  member_count?: number;
  full?: boolean;
  already_joined?: boolean;
  expires_at?: string | null;
  retry_after_seconds?: number;
  code?: string;
};
type InviteRow = { group_id: string; group_name: string; member_count: number; invited_by_nickname: string | null; invited_at: string };

// 통신 오류 · 모르는 상태는 UserError가 아니게 그대로 던짐 — 화면이 기본 문구를 보임
function unexpected(name: string, status: unknown): never {
  throw new Error(`${name}: 알 수 없는 상태 ${String(status)}`);
}

// 그룹 만들기 — 만든 사람은 DB 트리거(add_owner_as_member)가 바로 참여(JOINED)로 넣고, 코드(8자 · 7일)는 서버가 정함. 만든 사람 기록은 권한 없음
export async function createGroup(name: string): Promise<CreatedGroup> {
  const me = await requireUserId();
  const problem = groupNameProblem(name);
  if (problem) throw new UserError(problem);
  const { data, error } = await supabase
    .from('groups')
    .insert({ group_name: name.trim(), owner_id: me })
    .select('group_id, invite_code, invite_code_expires_at')
    .single();
  invalidateSnapshot();
  if (error) {
    if (error.code === '54000') throw new UserError(GROUP_TOO_MANY); // 한 사람 10개 상한 (5-33)
    throw error;
  }
  return { id: data.group_id, inviteCode: data.invite_code, expiresAt: data.invite_code_expires_at ? parseDbTime(data.invite_code_expires_at) : null };
}

// 코드 입력 → 미리보기 (참여는 안 함) — 없는 · 만료 · 잠시 뒤 다시는 status로, 문구는 groupTexts.previewProblem
//   틀린 코드는 서버가 계정별로 1시간 10번까지 세고, 막힌 동안은 맞는 코드도 LIMIT (5-14 · 5-15)
export async function previewGroupByCode(code: string): Promise<GroupPreview> {
  const cleaned = cleanCode(code);
  if (!cleaned) throw new UserError('초대 코드를 입력해 주세요');
  const { data: raw, error } = await supabase.rpc('preview_group_by_code', { p_code: cleaned });
  const data = (raw ?? {}) as GroupFnResult;
  if (error) throw error;
  switch (data.status) {
    case 'FOUND':
      return {
        status: 'FOUND',
        name: data.group_name ?? '',
        memberCount: data.member_count ?? 0,
        full: data.full ?? false,
        alreadyJoined: data.already_joined ?? false,
        expiresAt: data.expires_at ? parseDbTime(data.expires_at) : null,
      };
    case 'NOT_FOUND':
    case 'EXPIRED':
      return { status: data.status };
    case 'LIMIT':
      return { status: 'LIMIT', retryAfterSeconds: data.retry_after_seconds ?? 0 };
    default:
      return unexpected('preview_group_by_code', data.status);
  }
}

// 새로 들어온 직후 — 기존 멤버들에게 '새 멤버가 들어왔어요' (받는 사람은 서버가 고름: 알림 끈 멤버 · 차단 쌍 · 나 제외, 들어온 지 10분 안일 때만). 실패해도 참여는 그대로
function joined(groupId: string | undefined): JoinedGroup {
  const id = groupId ?? '';
  if (id) void sendPush({ kind: 'GROUP_MEMBER_JOINED', groupId: id });
  return { id, already: false };
}

// 코드로 참여 = 직접 초대를 받았으면 초대 수락. wakeShare = 동의 시트 [공유] (5-09 · 5-10)
export async function joinGroup(code: string, wakeShare: boolean): Promise<JoinedGroup> {
  const cleaned = cleanCode(code);
  if (!cleaned) throw new UserError('초대 코드를 입력해 주세요');
  const { data: raw, error } = await supabase.rpc('join_group', { p_code: cleaned, p_wake_share: wakeShare });
  const data = (raw ?? {}) as GroupFnResult;
  invalidateSnapshot();
  if (error) throw error;
  switch (data.status) {
    case 'JOINED':
      return joined(data.group_id);
    case 'ALREADY_JOINED':
      return { id: data.group_id ?? '', already: true };
    case 'NOT_FOUND':
      throw new UserError(CODE_NOT_FOUND);
    case 'EXPIRED':
      throw new UserError(CODE_EXPIRED);
    case 'LIMIT':
      throw new UserError(messageLimit(data.retry_after_seconds ?? 0));
    case 'FULL':
      throw new UserError(GROUP_FULL);
    case 'TOO_MANY_GROUPS':
      throw new UserError(GROUP_TOO_MANY);
    default:
      return unexpected('join_group', data.status);
  }
}

// G01 위 받은 초대 카드 — 그룹 이름 · 인원 · 초대한 사람까지만 (코드 · 멤버 목록은 수락 뒤)
export async function listGroupInvites(): Promise<GroupInvite[]> {
  const { data, error } = await supabase.rpc('my_group_invites');
  if (error) throw error;
  return ((data ?? []) as InviteRow[]).map((r) => ({
    groupId: r.group_id,
    name: r.group_name,
    initial: initialOf(r.group_name),
    memberCount: r.member_count,
    invitedByName: r.invited_by_nickname ?? '',
    invitedAt: parseDbTime(r.invited_at),
  }));
}

// 받은 초대 [참여] — 코드 참여와 같은 결과
export async function acceptGroupInvite(groupId: string, wakeShare: boolean): Promise<JoinedGroup> {
  const { data: raw, error } = await supabase.rpc('accept_group_invite', { p_group_id: groupId, p_wake_share: wakeShare });
  const data = (raw ?? {}) as GroupFnResult;
  invalidateSnapshot();
  if (error) throw error;
  switch (data.status) {
    case 'JOINED':
      return joined(data.group_id);
    case 'ALREADY_JOINED':
      return { id: data.group_id ?? '', already: true };
    case 'GONE':
      throw new UserError(MESSAGE_GONE);
    case 'FULL':
      throw new UserError(GROUP_FULL);
    case 'TOO_MANY_GROUPS':
      throw new UserError(GROUP_TOO_MANY);
    default:
      return unexpected('accept_group_invite', data.status);
  }
}

// 받은 초대 [거절] — 내 초대 행만 조용히 지움(알림 없음, 다시 초대받을 수 있음)
export async function declineGroupInvite(groupId: string): Promise<void> {
  const me = await requireUserId();
  const { data, error } = await supabase
    .from('group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_id', me)
    .eq('invite_status', 'INVITED')
    .select('group_member_id');
  invalidateSnapshot();
  if (error) throw error;
  if (!data?.length) throw new UserError(MESSAGE_GONE);
}

// G02 [+ 초대] — 내 친구를 직접 초대 (멤버 누구나, 친구 사이 · 차단 아님만 서버가 통과)
export async function inviteToGroup(groupId: string, userId: string): Promise<'INVITED' | 'ALREADY_INVITED'> {
  const { data: raw, error } = await supabase.rpc('invite_to_group', { p_group_id: groupId, p_user_id: userId });
  const data = (raw ?? {}) as GroupFnResult;
  invalidateSnapshot();
  if (error) throw error;
  switch (data.status) {
    case 'INVITED':
    case 'ALREADY_INVITED':
      return data.status;
    case 'ALREADY_MEMBER':
      throw new UserError('이미 그룹에 있어요');
    case 'SELF':
      throw new UserError('나는 초대할 수 없어요');
    case 'NOT_FOUND':
      throw new UserError('초대할 수 없는 사람이에요');
    default:
      return unexpected('invite_to_group', data.status);
  }
}

// + 초대 시트의 친구 줄 — 내 친구 이름순, 이미 멤버 · 초대 중은 표시만
export async function listInvitableFriends(groupId: string): Promise<InvitableFriend[]> {
  const s = await loadSnapshot();
  const status = (id: string) => s.members.find((m) => m.group_id === groupId && m.user_id === id)?.invite_status;
  return friendIds(s).map((id) => {
    const st = status(id);
    return { person: personOf(s, id), state: st === 'JOINED' ? ('MEMBER' as const) : st === 'INVITED' ? ('INVITED' as const) : ('NONE' as const) };
  });
}

// 코드 시트 — 열 때 서버가 만료됐으면 새 코드 + 7일로 바꿔 줌 (멤버 누구나, 5-49)
export async function getGroupCode(groupId: string): Promise<GroupCode> {
  const { data: raw, error } = await supabase.rpc('my_group_code', { p_group_id: groupId });
  const data = (raw ?? {}) as GroupFnResult;
  if (error) throw error;
  if (data.status === 'NOT_FOUND') throw new UserError(GROUP_NOT_MEMBER);
  if (data.status !== 'OK' || !data.code || !data.expires_at) return unexpected('my_group_code', data.status);
  return { code: data.code, expiresAt: parseDbTime(data.expires_at) };
}

// [새 코드] — 멤버 누구나. 옛 코드는 바로 못 씀, 만료 다시 7일. 시트에 새 코드 + 만료일을 같이 보이려고 다시 읽음 (5-17)
export async function regenerateInviteCode(groupId: string): Promise<GroupCode> {
  const { error } = await supabase.rpc('regenerate_invite_code', { p_group_id: groupId });
  invalidateSnapshot();
  if (error) {
    if (error.code === '42501') throw new UserError(GROUP_NOT_MEMBER); // insufficient_privilege — 참여 중 멤버가 아님
    throw error;
  }
  return getGroupCode(groupId);
}

// 이름 바꾸기 — 참여 중 멤버 누구나 (그룹장 없음). 바뀐 행이 없으면 참여 중이 아님
export async function renameGroup(groupId: string, name: string): Promise<void> {
  const problem = groupNameProblem(name);
  if (problem) throw new UserError(problem);
  const { data, error } = await supabase.from('groups').update({ group_name: name.trim() }).eq('group_id', groupId).select('group_id');
  invalidateSnapshot();
  if (error) throw error;
  if (!data?.length) throw new UserError(GROUP_NOT_MEMBER);
}

// 나가기 — 내 JOINED 행을 LEFT로만 (공동 약속 정리 · 마지막 사람이면 그룹 삭제는 서버 트리거, 5-21 · 5-44)
export async function leaveGroup(groupId: string): Promise<void> {
  const me = await requireUserId();
  const { data, error } = await supabase
    .from('group_members')
    .update({ invite_status: 'LEFT' })
    .eq('group_id', groupId)
    .eq('user_id', me)
    .eq('invite_status', 'JOINED')
    .select('group_member_id');
  invalidateSnapshot();
  if (error) throw error;
  if (!data?.length) throw new UserError(MESSAGE_GONE);
}

// 내보내기 — 참여 중 멤버 누구나 다른 사람의 행을 지움 (서버가 코드 교체 · 권한 삭제, 알림 없음, 5-19)
export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  const me = await requireUserId();
  if (userId === me) throw new UserError('나는 내보낼 수 없어요. 나가기를 눌러 주세요');
  const { data, error } = await supabase.from('group_members').delete().eq('group_id', groupId).eq('user_id', userId).select('group_member_id');
  invalidateSnapshot();
  if (error) throw error;
  if (!data?.length) throw new UserError(MESSAGE_GONE);
}

// 이 그룹 알림 끄기 · 켜기 — 그 그룹에서 오는 알림 전부 (깨우기는 사람 단위라 따로, 5-42 · 5-43)
export async function setGroupNotificationsOff(groupId: string, off: boolean): Promise<void> {
  const me = await requireUserId();
  const { data, error } = await supabase
    .from('group_members')
    .update({ notifications_off: off })
    .eq('group_id', groupId)
    .eq('user_id', me)
    .eq('invite_status', 'JOINED')
    .select('group_member_id');
  invalidateSnapshot();
  if (error) throw error;
  if (!data?.length) throw new UserError(GROUP_NOT_MEMBER);
}

// 이 그룹에 내 기상 상태를 공유하는 것에 동의 (group_members.wake_share_opt_in) — 본인 행만 고칠 수 있음 (RLS group_members_update_self)
//   F03 그룹 관계의 '기상 상태 조회' 스위치도 이 값을 바꿈(real/sharing.ts saveShareSettings), G02 · 그룹 만들기에서도 씀
//   끄면 출발 · 도착 공유도 같이 끔 (서버도 같은 규칙으로 막음)
export async function setWakeShareOptIn(groupId: string, on: boolean) {
  await updateMyMember(groupId, on ? { wake_share_opt_in: true } : { wake_share_opt_in: false, trip_share_opt_in: false });
}

// 이 그룹에 내 출발 · 도착 공유에 동의 (group_members.trip_share_opt_in, 기본 끔) — 기상 공유를 켠 사람만 켤 수 있음(서버가 막음)
export async function setTripShareOptIn(groupId: string, on: boolean) {
  await updateMyMember(groupId, { trip_share_opt_in: on });
}

async function updateMyMember(groupId: string, patch: { wake_share_opt_in?: boolean; trip_share_opt_in?: boolean }) {
  const me = await requireUserId();
  const { data, error } = await supabase
    .from('group_members')
    .update(patch)
    .eq('group_id', groupId)
    .eq('user_id', me)
    .eq('invite_status', 'JOINED')
    .select('group_member_id');
  invalidateSnapshot();
  if (error) throw error;
  if (!data?.length) throw new UserError('참여 중인 그룹이 아니에요');
}
