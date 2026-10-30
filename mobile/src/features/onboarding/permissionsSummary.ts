// 권한 안내 단계(PermissionsStep)의 순수 함수 — 위 요약 글자 · 상태 글자. 화면 없이 시험할 수 있게 부품에서 뺌
export type PermissionState = 'ok' | 'off' | 'unknown';

// 꺼진 것이 있으면 그 수, 꺼진 건 없고 확인 전만 남았으면 확인 안내, 모두 허용이면 '모두 켜져 있어요'. 줄이 없으면 '' (요약을 그리지 않음)
// 확인 전(unknown)은 폰이 아직 못 읽은 것(배터리 · 삼성 절전 등)이라 "켜라"고 세지 않음
export function permissionsSummary(rows: readonly { state: PermissionState }[]): string {
  if (rows.length === 0) return '';
  const off = rows.filter((row) => row.state === 'off').length;
  if (off > 0) return `${off}개를 켜면 알람이 더 확실해요`;
  return rows.some((row) => row.state === 'unknown') ? '확인이 안 된 항목이 있어요' : '모두 켜져 있어요';
}

// 상태 글자 — 색에 기대지 않고 글자로도 알 수 있게
export function permissionStateLabel(state: PermissionState): string {
  return state === 'ok' ? '허용' : state === 'off' ? '꺼짐' : '확인 전';
}
