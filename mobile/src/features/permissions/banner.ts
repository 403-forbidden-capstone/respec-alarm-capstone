// 홈 빨간 줄에 보일 문장 계산 — 순수 함수만 (read.ts가 읽은 상태 + alarmSync의 못 건 알람 수를 받음)
import type { BannerLine, PermissionSnapshot } from './types';

type Context = {
  failedCount: number; // 폰에 못 건 알람 수 (alarmSync failedAlarmCount)
  hasAlarm: boolean; // 예정된 알람이 있는지 (홈의 다음 알람)
};

// 'unknown'은 줄이 없음 (모르는 것을 꺼진 것처럼 보이지 않게)
// 알람 음량 · 방해 금지 · 배터리 줄은 없음 — 음량 · 방해 금지는 PR 6 네이티브 뒤, 안건 7 기본안 B
// failed는 supported와 상관없이 셈: 옛 APK는 모듈이 없어 예약이 전부 실패하므로 오히려 이때 가장 필요한 줄
export function bannerLines(snapshot: PermissionSnapshot | null, { failedCount, hasAlarm }: Context): BannerLine[] {
  const lines: BannerLine[] = [];
  if (snapshot?.supported) {
    // 처음 켠 새 사용자에게 묻기도 전에 빨간 줄을 띄우지 않으려고, 이미 물어봤거나 알람이 있을 때만
    if (snapshot.notifications === 'off' && (snapshot.notificationsAsked || hasAlarm)) {
      lines.push({ key: 'notifications', text: '알림이 꺼져 있어 알람이 잠금화면에 안 떠요' });
    }
    if (snapshot.fullScreen === 'off') {
      lines.push({ key: 'fullScreen', text: '전체화면 알림이 꺼져 있어 알람 화면이 안 떠요' });
    }
  }
  if (failedCount > 0) lines.push({ key: 'failed', text: `알람 ${failedCount}개를 폰에 걸지 못했어요` });
  return lines;
}

// 줄이 없으면 null (빨간 줄을 안 그림), 하나면 그 글, 여럿이면 개수만
export function bannerSummary(lines: readonly BannerLine[]): string | null {
  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0].text;
  return `알람이 안 울릴 수 있어요 · ${lines.length}개`;
}
