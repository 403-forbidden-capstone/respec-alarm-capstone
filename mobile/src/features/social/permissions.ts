// ② 공유 권한 화면에서 쓰는 계산 — 데이터를 읽지 않는 순수 함수만 (api.ts와 나눠서 단위 테스트)
import { PERMISSIONS, type Permission, type PermissionSet, type RelationId } from './types';

// 켜진 권한 이름 (알람 조회 · 기상 상태 조회) — 그룹 카드 · 받은 권한 칩
export function permissionNames(set: PermissionSet): string[] {
  return PERMISSIONS.filter((p) => set[p.key]).map((p) => p.name);
}

// F03 스위치 하나를 바꿈 — 설정 권한은 조회 권한이 있어야 실제로 고칠 수 있음 (docs/screen-data-map.md F03)
//   설정을 켜면 조회도 켬 (docs), 조회를 끄면 설정도 끔 (같은 규칙의 반대쪽 — 작성자 판단)
export function togglePermission(set: PermissionSet, key: Permission, next: boolean): PermissionSet {
  const out: PermissionSet = { ...set, [key]: next };
  if (key === 'editAlarm' && next) out.viewAlarm = true;
  if (key === 'viewAlarm' && !next) out.editAlarm = false;
  return out;
}

// friend:sy → { kind: 'friend', key: 'sy' } · group:cap → { kind: 'group', key: 'cap' }
export function parseRelation(id: RelationId): { kind: 'friend' | 'group'; key: string } {
  const at = id.indexOf(':');
  return { kind: id.slice(0, at) as 'friend' | 'group', key: id.slice(at + 1) };
}
