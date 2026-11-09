// ② 공유 권한 실데이터 — F02 친구 권한 · F03 공유 권한 설정 (docs/screen-data-map.md F02 · F03)
//   sharing_permissions(주는 사람 owner, 받는 사람 grantee, 출처 FRIEND=friend_id · GROUP=group_id)를 읽고 씀. 화면의 "최종 권한"은 앱에서 항목별 OR로 합침
//   효력 규칙(출처가 살아 있어야 함 · 그룹 기상 조회는 준 사람이 동의해야 함)은 grants.ts — DB 판정 함수와 같게
//   그룹 권한은 그룹마다 한 벌 — 저장은 save_group_permissions(멤버 전원 한 번에), 나중에 들어온 멤버는 조회만 자동으로 받고 설정은 다시 저장해야 함 (6장)
//   기상 조회는 권한 행이 아니라 그룹 기상 공유 동의(wake_share_opt_in) 하나 — F03 그룹 관계의 기상 스위치가 이 동의를 켜고 끔. 친구 관계에는 기상 스위치 없음
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

import { CONSENT_FAILED, NO_MEMBERS } from '../groupTexts';
import { parseRelation } from '../permissions';
import {
  friendBetween,
  friendIds,
  friendShareSet,
  givenTo,
  groupShareSet,
  joinedIds,
  myGroup,
  myGroups,
  myOptIn,
  personOf,
  receivedRows,
  sharedGroups,
} from '../snapshot';
import type { FinalGrant, PermissionSet, Person, Relation, RelationId } from '../types';
import { setWakeShareOptIn } from './groups';
import { invalidateSnapshot, loadSnapshot } from './load';

// 친구 권한 (F02) — 이 친구가 내 정보에 대해 가진 최종 권한과 출처. 친구가 아니면 null (그룹원 · 나를 주소로 열어도)
//   방향은 D17 열림이라 가짜 데이터와 같게 "내가 준 권한"
export async function getFriendGrant(personId: string): Promise<{ person: Person; final: FinalGrant; groupCount: number; firstGroupId: string | null } | null> {
  const s = await loadSnapshot();
  if (!friendBetween(s, personId)) return null;
  const groups = sharedGroups(s, personId);
  return { person: personOf(s, personId), final: givenTo(s, personId), groupCount: groups.length, firstGroupId: groups[0]?.group_id ?? null };
}

// 권한을 줄 관계 고르기 (F03) — 그룹 먼저, 그다음 친구
export async function listRelations(): Promise<Relation[]> {
  const s = await loadSnapshot();
  return [
    ...myGroups(s).map(
      (g): Relation => ({
        id: `group:${g.group_id}`,
        kind: 'group',
        label: g.group_name,
        sub: `그룹 · 멤버 ${joinedIds(s, g.group_id).length}명`,
        initial: g.group_name.slice(0, 1),
      }),
    ),
    ...friendIds(s).map((id): Relation => {
      const p = personOf(s, id);
      return { id: `friend:${id}`, kind: 'friend', label: p.name, sub: '친구', initial: p.initial };
    }),
  ];
}

export async function getRelation(id: RelationId): Promise<Relation | null> {
  return (await listRelations()).find((r) => r.id === id) ?? null;
}

// 이 관계에서 내가 주는 권한 (F03 내가 공유) — 내가 적어 둔 값 그대로
export async function getShareSettings(id: RelationId): Promise<PermissionSet> {
  const s = await loadSnapshot();
  const { kind, key } = parseRelation(id);
  return kind === 'friend' ? friendShareSet(s, key) : groupShareSet(s, key);
}

// F03 [변경사항 저장]
//   친구 관계: 내 행 하나를 upsert — 알람 조회 · 설정만 (기상 조회는 친구 출처에 없음, 서버가 켜도 꺼진 채 저장). 설정을 켜면 조회도 켜서 보냄(설정만 켠 행은 DB 제약이 거절)
//   그룹 관계: save_group_permissions 한 번 — 참여 중 멤버 전원에게 같은 값이 전부 되거나 전부 안 됨, 값이 그대로여도 저장(나중에 들어온 사람 몫의 설정 행도 이때 생김, 6-15).
//     기상 조회 스위치 = 이 그룹 기상 공유 동의(wake_share_opt_in) — 권한 행과 따로 저장 (6-23). 혼자인 그룹은 줄 사람이 없어 오류 (6-18)
export async function saveShareSettings(id: RelationId, next: PermissionSet) {
  const s = await loadSnapshot();
  const { kind, key } = parseRelation(id);
  const editAlarm = next.editAlarm;
  const viewAlarm = next.viewAlarm || editAlarm;

  if (kind === 'friend') {
    const friend = friendBetween(s, key);
    if (!friend) throw new UserError('친구 관계를 찾을 수 없어요');
    const { error } = await supabase
      .from('sharing_permissions')
      .upsert(
        { owner_id: s.me, grantee_id: key, source_type: 'FRIEND', source_id: friend.friend_id, can_view_alarm: viewAlarm, can_edit_alarm: editAlarm, can_view_wake: false },
        { onConflict: 'owner_id,grantee_id,source_type,source_id' },
      );
    invalidateSnapshot();
    if (error) throw error;
    return;
  }

  if (!myGroup(s, key)) throw new UserError('참여 중인 그룹을 찾을 수 없어요');
  const { data, error } = await supabase.rpc('save_group_permissions', { p_group_id: key, p_can_view_alarm: viewAlarm, p_can_edit_alarm: editAlarm });
  invalidateSnapshot();
  if (error) throw error;
  const status = (data as { status?: unknown } | null)?.status;
  if (status === 'NO_MEMBERS') throw new UserError(NO_MEMBERS);
  if (status === 'NOT_FOUND') throw new UserError('참여 중인 그룹을 찾을 수 없어요');
  if (status !== 'OK') throw new Error(`save_group_permissions: 모르는 상태 ${String(status)}`);
  if (next.viewWake !== myOptIn(s, key)) {
    // 알람 권한은 이미 저장된 뒤 — 동의만 못 바꿨으면 그 사실을 알리고(다시 저장하면 같은 요청이라 안전), 화면은 저장된 값을 다시 읽게 함
    try {
      await setWakeShareOptIn(key, next.viewWake);
    } catch (e) {
      throw new UserError(CONSENT_FAILED);
    }
  }
}

// 이 관계에서 받은 권한 (F03 받은 권한) — 효력 있는 값 (동의 안 한 그룹의 기상 조회는 꺼진 것으로)
export async function getReceived(id: RelationId): Promise<{ person: Person; permissions: PermissionSet }[]> {
  const s = await loadSnapshot();
  const { kind, key } = parseRelation(id);
  if (kind === 'friend') {
    if (!friendBetween(s, key)) return [];
    const row = receivedRows(s, key).find((r) => r.sourceType === 'FRIEND');
    return row ? [{ person: personOf(s, key), permissions: pick(row) }] : [];
  }
  if (!myGroup(s, key)) return [];
  // 멤버 모두 — 알람 권한 행이 없어도 기상 공유 동의를 켰으면 기상은 보임(권한 행 따로 필요 없음, 6-23). 읽기만, 권한을 요청하는 길 없음 (6-42)
  return joinedIds(s, key)
    .filter((uid) => uid !== s.me)
    .flatMap((uid) => {
      const row = receivedRows(s, uid).find((r) => r.sourceType === 'GROUP' && r.sourceId === key);
      return row ? [{ person: personOf(s, uid), permissions: pick(row) }] : [];
    });
}

const pick = (r: PermissionSet): PermissionSet => ({ viewAlarm: r.viewAlarm, editAlarm: r.editAlarm, viewWake: r.viewWake });

