// 그룹 기상 상태 문구 (친구 7장) — G01 카드 · G02 멤버 메뉴 · G03 · 옛 값 안내
//   단계 글자('8:50 알람' · '울렸어요' · '일어났어요 8:08' · '알람 없음' · '공유 안 함')는 map.ts wakeStateOf
import { formatTime } from '@/lib/format';

import type { TripCounts, WakePingResult } from './types';

// G01 그룹 카드 '오늘 n명 일어남' — 분모 없음, 약속 없는 날(null)은 줄을 숨김 (7-사 · 7-34)
export const wokeLine = (n: number | null) => (n == null ? null : `오늘 ${n}명 일어남`);

// 누군가 출발 · 도착이 보이면 0이 아닌 것만 '도착 1 · 이동 중 2 · 일어남 1', 아니면 '오늘 n명 일어남'. 약속 없는 날(wokeCount null)은 줄 숨김
export function groupWakeLine(wokeCount: number | null, trip: TripCounts | null): string | null {
  if (wokeCount == null) return null;
  if (!trip) return wokeLine(wokeCount);
  const parts = [
    trip.arrived ? `도착 ${trip.arrived}` : null,
    trip.moving ? `이동 중 ${trip.moving}` : null,
    trip.woke ? `일어남 ${trip.woke}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

// G03 '오늘의 흐름' 시각 줄 (목업 G03 타임라인) — 아는 것만 시간순: 알람 · 일어났어요 · 출발 · 도착. 출발 · 도착은 상대가 출발 · 도착 공유를 켰을 때만 들어옴
export type DayLine = { label: string; at: Date };
export function dayLinesOf(w: { alarmAt: Date | null; confirmedAt: Date | null; departedAt: Date | null; arrivedAt: Date | null }): DayLine[] {
  const lines: DayLine[] = [
    ...(w.alarmAt ? [{ label: '알람', at: w.alarmAt }] : []),
    ...(w.confirmedAt ? [{ label: '일어났어요', at: w.confirmedAt }] : []),
    ...(w.departedAt ? [{ label: '출발했어요', at: w.departedAt }] : []),
    ...(w.arrivedAt ? [{ label: '도착했어요', at: w.arrivedAt }] : []),
  ];
  return lines.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// G02 멤버 메뉴 — 숨김은 사람 단위(내가 속한 모든 그룹), 상대는 모름 (7-더 · 7-43)
export const wakeHideLabel = (hidden: boolean) => (hidden ? '이 사람에게 기상 보이기' : '이 사람에게 기상 숨기기');
export const wakeHideToast = (name: string, hidden: boolean) =>
  hidden ? `${name}님에게 내 기상을 숨겼어요. 상대에게는 알리지 않아요` : `${name}님에게 내 기상이 다시 보여요`;
export const WAKE_HIDE_FAILED = '이 사람에게는 기상 숨기기를 바꿀 수 없어요'; // set_wake_hidden NOT_FOUND (관계가 끊김 등)

// 다시 읽기가 실패했거나 실시간이 끊겼을 때 — 옛 값을 최신처럼 보이지 않게 (7-36)
export const WAKE_STALE_TEXT = '연결이 끊겨 최신 상태가 아닐 수 있어요';

// G03 — 줄이 안 나온 사람(동의 안 함 · 숨김 · 차단)은 구분 없이 같은 말 (7-06)
export const WAKE_NOT_SHARED_TITLE = '기상 상태를 볼 수 없어요';
export const WAKE_NOT_SHARED_BODY = '이 그룹에서 기상 공유를 켠 멤버만 볼 수 있어요.';

// G03 [깨우기] 보낸 결과 한 줄 (친구 8장 · 8-17) — 꺼 둔 사실은 글자로 안 드러냄(8-10): 받기를 껐든 보낼 수 없든 같은 말
export const WAKE_PING_OFF = '지금은 깨울 수 없어요';
export const WAKE_PING_NO_TOKENS = '지금은 알림이 닿지 않아요';
export const WAKE_PING_ALREADY_UP = '이미 일어났어요';
export const WAKE_PING_NOT_RINGING = '아직 알람이 울리기 전이에요';
export const WAKE_PING_DAILY_LIMIT = '오늘은 3번 모두 깨웠어요. 내일 다시 할 수 있어요';
export const wakePingSent = (name: string) => `${name}님에게 깨우기 알림을 보냈어요`;
export const WAKE_PING_FAILED = '깨우기를 보내지 못했어요. 다시 해 주세요';
export const WAKE_PING_MOCK = '가짜 데이터에서는 깨우기를 보낼 수 없어요';

// 버튼 아래 한 줄 — OK는 '1/3 · 8:15부터 다시', WAIT은 '8:15부터 다시'
export function wakePingNote(result: WakePingResult): string {
  switch (result.status) {
    case 'OK':
      // 마지막(3/3) 보냄은 5분 뒤에도 못 보냄 — '다시' 안내 대신 한도 문구
      if (result.count >= result.limit) return `${result.count}/${result.limit} · ${WAKE_PING_DAILY_LIMIT}`;
      return result.nextAt ? `${result.count}/${result.limit} · ${formatTime(result.nextAt)}부터 다시` : `${result.count}/${result.limit}`;
    case 'WAIT':
      return result.nextAt ? `${formatTime(result.nextAt)}부터 다시` : '잠시 뒤 다시 할 수 있어요';
    case 'DAILY_LIMIT':
      return WAKE_PING_DAILY_LIMIT;
    case 'OFF':
      return WAKE_PING_OFF;
    case 'NO_TOKENS':
      return WAKE_PING_NO_TOKENS;
    case 'ALREADY_UP':
      return WAKE_PING_ALREADY_UP;
    case 'NOT_RINGING':
      return WAKE_PING_NOT_RINGING;
  }
}

// 버튼을 잠그는 결과 — 같은 요청을 또 보내도 서버가 거절할 뿐이라 막아 둠 (WAIT · OK는 다음 가능 시각까지, 한도 · 꺼짐 · 이미 일어남은 계속)
export const wakePingLocks = (result: WakePingResult): boolean => result.status === 'OK' || result.status === 'WAIT' || result.status === 'DAILY_LIMIT' || result.status === 'OFF' || result.status === 'ALREADY_UP';

// 홈 · H08 받은 깨우기 한 줄 — 가장 최근 것, 같은 사람이 여러 번 깨웠으면 '· 오늘 n번' (다른 사람이 깨운 것까지 세지 않음)
export function receivedPingLine(pings: readonly { senderId?: string; senderName: string; at: Date }[]): string | null {
  const last = pings[0];
  if (!last) return null;
  const line = `${last.senderName}님이 ${formatTime(last.at)}에 깨웠어요`;
  const same = pings.filter((p) => (last.senderId ? p.senderId === last.senderId : p.senderName === last.senderName)).length;
  return same > 1 ? `${line} · 오늘 ${same}번` : line;
}
