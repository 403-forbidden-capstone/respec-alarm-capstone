// ② 공유 권한 실데이터 — F02 친구 권한 · F03 공유 권한 설정 (docs/screen-data-map.md F02 · F03)
//   sharing_permissions(주는 사람 owner, 받는 사람 grantee, 출처 FRIEND=friend_id · GROUP=group_id)를 읽고 씀. 화면의 "최종 권한"은 앱에서 항목별 OR로 합침
//   효력 규칙(출처가 살아 있어야 함 · 그룹 기상 조회는 준 사람이 동의해야 함)은 grants.ts — DB 판정 함수와 같게
//   D18 열림(그룹 권한을 어떤 단위로 저장할지): 가짜 데이터와 같은 뜻으로 "그룹마다 한 벌"을 보여 주고, 저장은 지금 참여 중인 다른 구성원마다 행을 씀.
//     나중에 들어온 구성원은 다시 저장하기 전까지 이 그룹에서 아무 권한도 못 받음 (행 추가 규칙은 D18 결정 뒤)
//   D19 열림(기상 조회를 켤 때 기상 공유 동의도 켤지): 저장은 권한 행만 씀. 동의는 setWakeShareOptIn(새 UI용)으로만 바뀜
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

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
  personOf,
  receivedRows,
  sharedGroups,
} from '../snapshot';
import type { FinalGrant, PermissionSet, Person, Relation, RelationId } from '../types';
import { invalidateSnapshot, loadSnapshot } from './load';

// 친구 권한 (F02) — 이 친구가 내 정보에 대해 가진 최종 권한과 출처. 친구가 아니면 null (그룹원 · 나를 주소로 열어도)
//   방향은 D17 열림이라 가짜 데이터와 같게 "내가 준 권한"
export async function getFriendGrant(personId: string): Promise<{ person: Person; final: FinalGrant; groupCount: number } | null> {
  const s = await loadSnapshot();
  if (!friendBetween(s, personId)) return null;
  return { person: personOf(s, personId), final: givenTo(s, personId), groupCount: sharedGroups(s, personId).length };
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

export async function saveShareSettings(id: RelationId, next: PermissionSet) {
  const s = await loadSnapshot();
  const { kind, key } = parseRelation(id);
  const flags = { can_view_alarm: next.viewAlarm, can_edit_alarm: next.editAlarm, can_view_wake: next.viewWake };

  if (kind === 'friend') {
    const friend = friendBetween(s, key);
    if (!friend) throw new UserError('친구 관계를 찾을 수 없어요');
    const { error } = await supabase
      .from('sharing_permissions')
      .upsert({ owner_id: s.me, grantee_id: key, source_type: 'FRIEND', source_id: friend.friend_id, ...flags }, { onConflict: 'owner_id,grantee_id,source_type,source_id' });
    invalidateSnapshot();
    if (error) throw error;
    return;
  }

  if (!myGroup(s, key)) throw new UserError('참여 중인 그룹을 찾을 수 없어요');
  const others = joinedIds(s, key).filter((uid) => uid !== s.me);
  if (!others.length) return; // 혼자인 그룹 — 줄 사람이 없음
  const { error } = await supabase
    .from('sharing_permissions')
    .upsert(
      others.map((uid) => ({ owner_id: s.me, grantee_id: uid, source_type: 'GROUP' as const, source_id: key, ...flags })),
      { onConflict: 'owner_id,grantee_id,source_type,source_id' },
    );
  invalidateSnapshot();
  if (error) throw error;
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
  return joinedIds(s, key)
    .filter((uid) => uid !== s.me)
    .flatMap((uid) => {
      const row = receivedRows(s, uid).find((r) => r.sourceType === 'GROUP' && r.sourceId === key);
      return row ? [{ person: personOf(s, uid), permissions: pick(row) }] : [];
    });
}

const pick = (r: PermissionSet): PermissionSet => ({ viewAlarm: r.viewAlarm, editAlarm: r.editAlarm, viewWake: r.viewWake });

