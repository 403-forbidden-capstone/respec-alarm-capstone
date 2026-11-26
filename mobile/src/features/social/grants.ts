// ② 공유 권한 판정 — 데이터를 읽지 않는 순수 함수만 (시험: __tests__/grants.test.ts)
// DB의 판정 함수(supabase/migrations/20261007000200_rls.sql private.is_valid_permission_source · private.granted_owner_ids)와 같은 규칙을
// 앱에서 다시 적은 것: RLS는 행을 막아 줄 뿐 "이 사람이 나에게 실제로 허용한 권한"을 계산해 주지 않아서 화면(F02 · G01 · G02 · G04)이 쓸 합집합은 앱에서 합침
// (docs/screen-data-map.md F02 "항목별 OR (앱에서 합침)"). DB 규칙이 바뀌면 이 파일도 같이 바꿈
import type { Tables } from '@/types/database';

import type { FinalGrant, GrantRow, PermissionSet } from './types';

export type FriendRow = Pick<Tables<'friends'>, 'friend_id' | 'requester_id' | 'addressee_id' | 'status' | 'requested_at'>;
export type MemberRow = Pick<Tables<'group_members'>, 'group_id' | 'user_id' | 'invite_status' | 'wake_share_opt_in' | 'trip_share_opt_in' | 'joined_at' | 'notifications_off'>;
export type PermRow = Pick<
  Tables<'sharing_permissions'>,
  'owner_id' | 'grantee_id' | 'source_type' | 'source_id' | 'can_view_alarm' | 'can_edit_alarm' | 'can_view_wake'
>;

export const noPermission = (): PermissionSet => ({ viewAlarm: false, editAlarm: false, viewWake: false });

// 권한 행이 적어 둔 값 그대로 (효력과 상관없이 — 내가 준 권한을 F03에 보일 때)
export const permissionOf = (row: PermRow): PermissionSet => ({
  viewAlarm: row.can_view_alarm,
  editAlarm: row.can_edit_alarm,
  viewWake: row.can_view_wake,
});

// private.is_valid_permission_source — 권한 행의 출처가 아직 살아 있는지
//   FRIEND: 두 사람의 친구 관계(source_id = friend_id)가 ACCEPTED
//   GROUP : 두 사람 다 그 그룹(source_id = group_id)에 JOINED
export function isValidSource(row: PermRow, friends: readonly FriendRow[], members: readonly MemberRow[]): boolean {
  if (row.source_type === 'FRIEND') {
    return friends.some(
      (f) =>
        f.friend_id === row.source_id &&
        f.status === 'ACCEPTED' &&
        ((f.requester_id === row.owner_id && f.addressee_id === row.grantee_id) ||
          (f.requester_id === row.grantee_id && f.addressee_id === row.owner_id)),
    );
  }
  const joined = new Set(
    members
      .filter((m) => m.group_id === row.source_id && m.invite_status === 'JOINED' && (m.user_id === row.owner_id || m.user_id === row.grantee_id))
      .map((m) => m.user_id),
  );
  return joined.size === 2;
}

// private.granted_owner_ids — 권한 행이 실제로 효력을 가진 값. 출처가 끝난 행은 null
//   기상 조회(viewWake)는 권한 행의 값이 아니라 그룹 기상 공유 동의 하나로만 (친구 6장, Q13 · D19): 그룹 출처는 준 사람(owner)이 그 그룹에서
//   동의(wake_share_opt_in)했을 때, 친구 출처는 항상 없음 (친구 출처 기상 조회 행은 서버가 이제 못 넣음)
export function effectiveOf(row: PermRow, friends: readonly FriendRow[], members: readonly MemberRow[]): PermissionSet | null {
  if (!isValidSource(row, friends, members)) return null;
  if (row.source_type === 'FRIEND') return { viewAlarm: false, editAlarm: false, viewWake: row.can_view_wake };
  const owner = members.find((m) => m.group_id === row.source_id && m.user_id === row.owner_id && m.invite_status === 'JOINED');
  const viewer = members.find((m) => m.group_id === row.source_id && m.user_id === row.grantee_id && m.invite_status === 'JOINED');
  const viewWake = !!owner?.wake_share_opt_in && !!viewer?.wake_share_opt_in;
  return { viewAlarm: row.can_view_alarm, editAlarm: row.can_edit_alarm, viewWake, viewTrip: viewWake && !!owner?.trip_share_opt_in };
}

// 여러 관계의 권한을 항목별로 합침 — 하나라도 허용하면 허용 (4장 4.6 "최종 권한의 계산")
export function mergeGrants(rows: GrantRow[]): FinalGrant {
  const viewAlarm = rows.some((r) => r.viewAlarm);
  const editAlarm = rows.some((r) => r.editAlarm);
  const viewWake = rows.some((r) => r.viewWake);
  const viewTrip = rows.some((r) => r.sourceType === 'GROUP' && r.viewTrip);
  return { viewAlarm, editAlarm, viewWake, viewTrip, rows, count: [viewAlarm, editAlarm, viewWake, viewTrip].filter(Boolean).length };
}

// 권한 집합 여럿을 항목별로 합침 (그룹에 준 권한 = 멤버마다 쓴 행의 합집합, D18 열림)
export function unionPermissions(sets: readonly PermissionSet[]): PermissionSet {
  return {
    viewAlarm: sets.some((s) => s.viewAlarm),
    editAlarm: sets.some((s) => s.editAlarm),
    viewWake: sets.some((s) => s.viewWake),
  };
}
