// 온보딩 권한 안내 단계의 줄 — 폰 권한 상태(PermissionSnapshot)를 PermissionsStep 줄로 바꿈. 화면 없이 시험할 수 있게 순수 함수로 둠
// 안건 2 기본안 A: 상태 표 + 사용자가 누르는 [켜기]만 (자동 시스템 창 없음)
import type { PermissionSnapshot } from '@/features/permissions';

import type { PermissionRow, PermissionState } from './components/PermissionsStep';

// 폰 상태 → 줄 상태
const STATE: Record<'on' | 'off' | 'unknown', PermissionState> = { on: 'ok', off: 'off', unknown: 'unknown' };

// 줄 순서: 알림 → 전체화면 알림 → (정확한 알람) → 사용 정보 → 배터리 → 삼성 절전
// snapshot이 null(처음 읽는 중)이거나 지원 안 함(웹 · 가짜 · 옛 APK)이면 모든 줄을 '확인 전'으로, 버튼 없이 보여 줌
export function permissionRows(snapshot: PermissionSnapshot | null): PermissionRow[] {
  const read = snapshot?.supported ? snapshot : null;
  const rows: PermissionRow[] = [
    { key: 'notifications', label: '알림', why: '알람 화면과 준비 · 출발 알림이 떠요', state: read ? STATE[read.notifications] : 'unknown' },
    { key: 'fullScreen', label: '전체화면 알림', why: '잠금화면 위에 알람 화면을 띄워요', state: read ? STATE[read.fullScreen] : 'unknown' },
  ];
  // 정확한 알람은 보통 켜져 있어서(소음) 꺼졌을 때만 줄을 넣음
  if (read?.exactAlarm === 'off') {
    rows.push({ key: 'exactAlarm', label: '정확한 알람', why: '정해진 시각에 정확히 울려요', state: 'off' });
  }
  rows.push(
    {
      key: 'usageAccess',
      label: '사용 정보 접근',
      why: '알람을 끈 뒤 폰을 쓰는지로 기상을 자동 확인해요 · 안 켜면 직접 눌러요',
      state: read ? STATE[read.usageAccess] : 'unknown',
    },
    // 배터리 · 삼성 절전은 앱이 상태를 못 읽음(PR 6 네이티브 전) → 늘 '확인 전'. 배터리만 설정 열기 버튼, 삼성은 글 안내만
    // TODO(L2 permissions.ts 머지 뒤): 위치 줄(전경 · 항상)을 ONBOARDING_LOCATION_ROWS로 켜서 여기에 더함 (안건 2 A)
    {
      key: 'battery',
      label: '배터리',
      why: "배터리 절약이 알람 앱을 멈추지 않게 해요 · 목록에서 이 앱을 '제한 없음'으로",
      state: 'unknown',
      actionLabel: read ? '설정 열기' : undefined,
    },
    {
      key: 'samsung',
      label: '삼성 절전',
      why: "삼성 폰은 설정 › 배터리 › 백그라운드 사용 제한에서 '사용하지 않는 앱 절전'을 끄고 이 앱을 '절전 예외 앱'에 넣어 주세요",
      state: 'unknown',
    },
  );
  return rows;
}
