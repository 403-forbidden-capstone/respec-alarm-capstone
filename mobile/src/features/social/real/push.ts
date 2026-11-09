// 다른 사람 폰에 푸시 — notify 서버 함수 호출 한 곳 (친구 논리설계 11장, supabase/functions/_shared/notify.ts)
//   요청에는 종류별 인자만: 한 사람 종류는 targetUserId, 그룹 종류는 groupId(+ appointmentId) — 제목 · 본문 · data는 서버가 종류별로 고정해서 보내도 무시됨
//   알림은 덤이라 실패해도 던지지 않음 (본 동작은 이미 끝났으므로 되돌리지 않음). 보냈으면(받은 기기가 있으면) true
import { callEdge } from '@/lib/edge';

const NOTIFY_TIMEOUT_MS = 8_000; // 오래 기다리지 않음 — 저장은 이미 끝남

export type PushRequest =
  | { kind: 'FRIEND_REQUEST' | 'FRIEND_ACCEPTED'; targetUserId: string }
  | { kind: 'ALARM_CHANGED'; targetUserId: string; alarmId?: string; previousAt?: Date; newAt?: Date }
  | { kind: 'GROUP_MEMBER_JOINED'; groupId: string };

// 요청 본문 — Date는 ISO 글자로, 알람 바뀜의 이전 → 새 시각은 둘 다 있을 때만 (서버가 문구에 '이전 → 새 시각'을 넣음)
export function pushBody(request: PushRequest): Record<string, unknown> {
  if (request.kind !== 'ALARM_CHANGED') return { ...request };
  const { previousAt, newAt, alarmId, ...rest } = request;
  return {
    ...rest,
    ...(alarmId ? { alarmId } : {}),
    ...(previousAt && newAt ? { previousAt: previousAt.toISOString(), newAt: newAt.toISOString() } : {}),
  };
}

export async function sendPush(request: PushRequest): Promise<boolean> {
  try {
    const result = await callEdge<{ sent?: number }>('notify', pushBody(request), { timeoutMs: NOTIFY_TIMEOUT_MS });
    return (result?.sent ?? 0) > 0;
  } catch {
    return false;
  }
}
