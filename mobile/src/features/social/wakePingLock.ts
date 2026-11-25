// [깨우기] 버튼 잠금 계산 — 그룹 상세(G02)와 그룹원 기상 상태(G03)가 같이 씀
//   마지막 결과가 OK · WAIT면 다음 가능 시각(nextAt)까지, 한도 · 꺼짐 · 이미 일어남은 계속 잠금. 마지막 보냄(count >= limit)은 시간이 지나도 오늘은 더 못 보냄
//   NOT_RINGING · NO_TOKENS는 잠그지 않음 (다시 눌러 볼 수 있음)
import type { WakePingResult } from './types';
import { wakePingLocks } from './wakeTexts';

// 타이머로 풀리는 결과(OK · WAIT) — 다음 가능 시각이 지나면 풀림
export const wakePingTimed = (ping: WakePingResult | null | undefined): ping is Extract<WakePingResult, { status: 'OK' | 'WAIT' }> =>
  ping != null && (ping.status === 'OK' || ping.status === 'WAIT');

export function wakePingLocked(ping: WakePingResult | null | undefined, current: Date): boolean {
  if (ping == null || !wakePingLocks(ping)) return false;
  const spent = ping.status === 'OK' && ping.count >= ping.limit;
  return spent || !(wakePingTimed(ping) && ping.nextAt != null && current >= ping.nextAt);
}
