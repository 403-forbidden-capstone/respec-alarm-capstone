// ② 친구 · 그룹 · 권한 — 한 번 읽어 온 행 묶음(Snapshot)에서 화면이 쓰는 값을 뽑는 순수 함수 (쿼리는 real/load.ts, 시험: __tests__/snapshot.test.ts)
// RLS가 보여 주는 만큼만 들어 있음: 내가 당사자인 친구 · 권한 행, 내가 참여 중인 그룹의 구성원, get_public_profiles가 준 공개 프로필(닉네임 · 아이디)
import type { Tables } from '@/types/database';

import { effectiveOf, mergeGrants, noPermission, permissionOf, unionPermissions, type FriendRow, type MemberRow, type PermRow } from './grants';
import { personFromProfile, unknownPerson, type ProfileRow } from './map';
import type { FinalGrant, GrantRow, PermissionSet, Person } from './types';

export type GroupRow = Pick<Tables<'groups'>, 'group_id' | 'group_name' | 'owner_id' | 'invite_code' | 'created_at'>;

export type Snapshot = {
  me: string;
  friends: FriendRow[];
  groups: GroupRow[]; // 만든 · 초대받은 · 참여 중인 그룹 (groups RLS) — 오래된 순
  members: MemberRow[];
  perms: PermRow[];
  profiles: ProfileRow[];
};

// 한글은 코드 순서가 가나다 순이라 Intl 없이 비교해도 됨
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function profileOf(s: Snapshot, id: string): ProfileRow | undefined {
  return s.profiles.find((p) => p.user_id === id);
}

export function personOf(s: Snapshot, id: string): Person {
  const p = profileOf(s, id);
  return p ? personFromProfile(p) : unknownPerson(id);
}

const nameOf = (s: Snapshot, id: string) => profileOf(s, id)?.nickname ?? '';
const otherSide = (f: FriendRow, me: string) => (f.requester_id === me ? f.addressee_id : f.requester_id);

// 나와 친구가 된(ACCEPTED) 사람들 — 이름순
export function friendIds(s: Snapshot): string[] {
  return s.friends
    .filter((f) => f.status === 'ACCEPTED')
    .map((f) => otherSide(f, s.me))
    .sort((a, b) => byName(nameOf(s, a), nameOf(s, b)));
}

// 나에게 온 친구 요청(PENDING, 받는 사람 = 나) — 최근 요청이 위
export function requestIds(s: Snapshot): string[] {
  return s.friends
    .filter((f) => f.status === 'PENDING' && f.addressee_id === s.me)
    .sort((a, b) => (a.requested_at < b.requested_at ? 1 : a.requested_at > b.requested_at ? -1 : 0))
    .map((f) => f.requester_id);
}

// 나와 이 사람 사이의 수락된 친구 관계
export function friendBetween(s: Snapshot, otherId: string): FriendRow | undefined {
  return s.friends.find(
    (f) =>
      f.status === 'ACCEPTED' &&
      ((f.requester_id === s.me && f.addressee_id === otherId) || (f.requester_id === otherId && f.addressee_id === s.me)),
  );
}

// 내가 참여 중(JOINED)인 그룹 — 만든 순
export function myGroups(s: Snapshot): GroupRow[] {
  const joined = new Set(s.members.filter((m) => m.user_id === s.me && m.invite_status === 'JOINED').map((m) => m.group_id));
  return s.groups.filter((g) => joined.has(g.group_id));
}

export function myGroup(s: Snapshot, groupId: string): GroupRow | undefined {
  return myGroups(s).find((g) => g.group_id === groupId);
}

// 그 그룹에 참여 중인 사람 — 나 먼저, 나머지는 이름순
export function joinedIds(s: Snapshot, groupId: string): string[] {
  const ids = s.members.filter((m) => m.group_id === groupId && m.invite_status === 'JOINED').map((m) => m.user_id);
  return [...ids.filter((id) => id === s.me), ...ids.filter((id) => id !== s.me).sort((a, b) => byName(nameOf(s, a), nameOf(s, b)))];
}

// 나와 이 사람이 같이 참여 중인 그룹
export function sharedGroups(s: Snapshot, otherId: string): GroupRow[] {
  return myGroups(s).filter((g) => joinedIds(s, g.group_id).includes(otherId));
}

const groupNameOf = (s: Snapshot, groupId: string) => s.groups.find((g) => g.group_id === groupId)?.group_name;

// 화면 줄 하나로 — 출처 이름은 친구면 '친구', 그룹이면 그룹 이름. 그룹 이름을 모르는 행(내가 못 보는 그룹)은 버림
function toGrantRow(s: Snapshot, row: PermRow, set: PermissionSet, otherId: string): GrantRow | null {
  if (row.source_type === 'FRIEND') return { source: '친구', sourceType: 'FRIEND', sourceId: otherId, ...set };
  const name = groupNameOf(s, row.source_id);
  return name == null ? null : { source: name, sourceType: 'GROUP', sourceId: row.source_id, ...set };
}

// 친구 관계 먼저, 그다음 그룹(그룹 순서대로)
function ordered(s: Snapshot, rows: GrantRow[]): GrantRow[] {
  const groupOrder = (r: GrantRow) => (r.sourceType === 'FRIEND' ? -1 : s.groups.findIndex((g) => g.group_id === r.sourceId));
  return [...rows].sort((a, b) => groupOrder(a) - groupOrder(b));
}

// 이 사람이 나에게 준 권한 — 효력 있는 값 (출처가 끝난 행은 빠지고, 동의 안 한 그룹의 기상 조회는 꺼짐)
export function receivedRows(s: Snapshot, fromId: string): GrantRow[] {
  const rows = s.perms
    .filter((p) => p.owner_id === fromId && p.grantee_id === s.me)
    .flatMap((p) => {
      const set = effectiveOf(p, s.friends, s.members);
      const row = set && toGrantRow(s, p, set, fromId);
      return row ? [row] : [];
    });
  return ordered(s, rows);
}

// 내가 이 사람에게 준 권한 — 같은 규칙으로 효력 있는 값 (F02 "이 친구가 내 정보에 가진 최종 권한")
export function givenRows(s: Snapshot, toId: string): GrantRow[] {
  const rows = s.perms
    .filter((p) => p.owner_id === s.me && p.grantee_id === toId)
    .flatMap((p) => {
      const set = effectiveOf(p, s.friends, s.members);
      const row = set && toGrantRow(s, p, set, toId);
      return row ? [row] : [];
    });
  return ordered(s, rows);
}

export const receivedFrom = (s: Snapshot, fromId: string): FinalGrant => mergeGrants(receivedRows(s, fromId));
export const givenTo = (s: Snapshot, toId: string): FinalGrant => mergeGrants(givenRows(s, toId));

// F03 "내가 공유" — 친구에게 준 값 (효력과 상관없이 내가 적어 둔 값 그대로, 출처가 살아 있을 때만)
export function friendShareSet(s: Snapshot, otherId: string): PermissionSet {
  const row = s.perms.find(
    (p) => p.owner_id === s.me && p.grantee_id === otherId && p.source_type === 'FRIEND' && effectiveOf(p, s.friends, s.members) != null,
  );
  return row ? permissionOf(row) : noPermission();
}

// F03 · G01 · G02 — 그룹에 준 값. 권한 행은 멤버마다 있어서(D18 열림) 모두 합쳐 한 벌로 보임
export function groupShareSet(s: Snapshot, groupId: string): PermissionSet {
  const sets = s.perms
    .filter((p) => p.owner_id === s.me && p.source_type === 'GROUP' && p.source_id === groupId && effectiveOf(p, s.friends, s.members) != null)
    .map(permissionOf);
  return unionPermissions(sets);
}

// 그 그룹의 다른 구성원 중 누구라도 나에게 기상 상태 조회를 허용했는지 (G01 카드가 상세로 들어가는지)
export function canSeeWakeIn(s: Snapshot, groupId: string): boolean {
  return joinedIds(s, groupId)
    .filter((id) => id !== s.me)
    .some((id) => receivedFrom(s, id).viewWake);
}

// 내 기상 공유 동의 (group_members.wake_share_opt_in)
export function myOptIn(s: Snapshot, groupId: string): boolean {
  return s.members.some((m) => m.group_id === groupId && m.user_id === s.me && m.wake_share_opt_in);
}
