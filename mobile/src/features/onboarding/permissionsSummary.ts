// 권한 안내 단계(PermissionsStep)의 순수 함수 — 위 요약 글자 · 상태 글자. 화면 없이 시험할 수 있게 부품에서 뺌
export type PermissionState = 'ok' | 'off' | 'unknown';

// 모두 허용이면 '모두 켜져 있어요', 아니면 허용이 아닌 것(꺼짐 · 확인 전)의 수. 줄이 없으면 '' (요약을 그리지 않음)
export function permissionsSummary(rows: readonly { state: PermissionState }[]): string {
  if (rows.length === 0) return '';
  const left = rows.filter((row) => row.state !== 'ok').length;
  return left === 0 ? '모두 켜져 있어요' : `${left}개를 켜면 알람이 더 확실해요`;
}

// 상태 글자 — 색에 기대지 않고 글자로도 알 수 있게
export function permissionStateLabel(state: PermissionState): string {
  return state === 'ok' ? '허용' : state === 'off' ? '꺼짐' : '확인 전';
}
