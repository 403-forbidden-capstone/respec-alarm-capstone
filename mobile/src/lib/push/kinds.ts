// 푸시 알림 데이터 모양 (친구 논리설계 11장) — 서버가 알림마다 data에 kind · recipientUserId · path(+ 종류별 값)를 실음
//   순수 함수만 — expo-notifications를 읽지 않아 웹 · 시험에서도 안전. 알림을 누르면 어디로 갈지는 features/push/link.ts
//   감지 안내(detect_v1)처럼 앱이 로컬로 만든 알림에는 kind가 없어 여기서 걸러짐
export const PUSH_KINDS = [
  'WAKE_PING',
  'ALARM_CHANGED',
  'FRIEND_REQUEST',
  'FRIEND_ACCEPTED',
  'GROUP_MEMBER_JOINED',
  'GROUP_APPT_CHANGED',
  'WAKE_MISSED',
  'WAKE_NUDGE', // 미확인 본인에게 10분 뒤 그룹원이 받는 '깨워 볼까요?' (wake-check 배치)
  'WAKE_NUDGE_UP', // 그 뒤 본인이 늦게 확인하면 가는 후속 '일어났어요'
] as const;

export type PushKind = (typeof PUSH_KINDS)[number];

export type PushData = { kind: PushKind } & Record<string, unknown>;

// 서버 푸시의 data인지 — 모르는 종류 · 모양이 다르면 false (앞으로 서버가 종류를 늘려도 옛 앱이 오동작하지 않게)
export function isPushData(data: unknown): data is PushData {
  if (typeof data !== 'object' || data === null) return false;
  const kind = (data as { kind?: unknown }).kind;
  return typeof kind === 'string' && (PUSH_KINDS as readonly string[]).includes(kind);
}

// 문구 없이 데이터만 오는 조용한 푸시(알림을 껐거나 차단 쌍이어도 알람은 다시 맞춰야 하는 공동 약속 변경) — 화면에는 안 띄움
export function isSilentPush(data: unknown): boolean {
  const silent = typeof data === 'object' && data !== null ? (data as { silent?: unknown }).silent : undefined;
  return silent === true || silent === 'true';
}

// 앞에 떠 있는 동안 알림을 띄울지 — 서버 푸시 중 문구가 있는 것만
export const showsInForeground = (data: unknown): boolean => isPushData(data) && !isSilentPush(data);
