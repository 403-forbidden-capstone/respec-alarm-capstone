// notify의 본문 — Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (notify.test.ts). 연결은 notify/index.ts
//   요청: { kind, targetUserId, alarmId?, title, body, data? }
//   처리: ① can_send_push(부른 사람, 받는 사람, kind) — 서버 권한 판정(DB 함수, service_role 전용) ② alarmId는 받는 사람의 알람인지
//        ③ push_tokens 조회 ④ Expo Push로 보냄 ⑤ 만료된 토큰 지움
//   응답: { sent, failed, reason? } — 토큰이 없거나 푸시 설정(FCM 키 · Expo 액세스 토큰)이 아직 없으면 오류가 아니라 { sent: 0, reason }
import { dbFail, must } from './db.ts';
import { HttpError } from './errors.ts';
import { sendExpoPush, type FetchLike, type PushResult } from './push.ts';
import type { Reader } from './read.ts';
import type { Db } from './supabase.ts';

// 종류별 권한은 DB 함수 can_send_push가 정함 (supabase/README.md). 종류가 늘어도 여기는 이름만 더함
//   ALARM_CHANGED — G04. 부른 사람이 받는 사람의 알람에 설정 권한(EDIT_ALARM)이 있을 때만 (D9: 변경 기록은 저장하지 않고 푸시만)
//   WAKE_PING     — G03 깨우기. D19(기상 공유 동의 조건) · D51(간격 제한)이 정해질 때까지 DB 함수가 늘 거절 → 403
export const PUSH_KINDS = ['ALARM_CHANGED', 'WAKE_PING'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

const DENIED: Record<PushKind, string> = {
  ALARM_CHANGED: '이 사람의 알람을 바꿀 권한이 없어서 알림을 보낼 수 없어요',
  WAKE_PING: '깨우기 알림은 아직 보낼 수 없어요',
};

export type NotifyRequest = {
  kind: PushKind;
  targetUserId: string;
  alarmId?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type NotifyResult = { sent: number; failed: number; reason?: 'NO_TOKENS' | NonNullable<PushResult['reason']> };

// 요청을 읽고 문제가 있으면 한 번에 던짐 (root.finish() 포함)
export function readNotifyRequest(root: Reader): NotifyRequest {
  const kind = root.oneOf('kind', PUSH_KINDS, { required: true });
  const targetUserId = root.uuid('targetUserId', { required: true });
  const alarmId = root.uuid('alarmId');
  const title = root.string('title', { required: true, min: 1, max: 100 });
  const body = root.string('body', { required: true, min: 1, max: 200 });
  const data = root.object('data');
  if (data && JSON.stringify(data.value).length > 2_000) root.problemAt('data', '2000자 이하여야 해요');
  root.finish();
  if (!kind || !targetUserId || !title || !body) throw new HttpError('VALIDATION_FAILED', '입력값을 확인해 주세요');
  return { kind, targetUserId, ...(alarmId ? { alarmId } : {}), title, body, ...(data ? { data: data.value } : {}) };
}

export async function runNotify(
  service: Db,
  senderId: string,
  req: NotifyRequest,
  options: { accessToken?: string; fetchImpl?: FetchLike } = {},
): Promise<NotifyResult> {
  // 권한 판정은 DB 함수 한 군데 (종류별 조건이 늘어도 여기는 안 바뀜)
  const allowed = await service.rpc('can_send_push', { p_sender_id: senderId, p_target_id: req.targetUserId, p_kind: req.kind });
  if (allowed.error) dbFail('can_send_push', allowed.error);
  if (allowed.data !== true) throw new HttpError('FORBIDDEN', DENIED[req.kind]);

  // 알람 id를 같이 받은 경우, 받는 사람의 알람이 맞는지 (남의 알람 id로 알림 내용을 꾸미지 못하게)
  if (req.alarmId) {
    const alarm = must<{ alarm_id: string } | null>(
      'alarm lookup',
      await service.from('alarms').select('alarm_id').eq('alarm_id', req.alarmId).eq('user_id', req.targetUserId).maybeSingle(),
    );
    if (!alarm) throw new HttpError('NOT_FOUND', '받는 사람의 알람을 찾을 수 없어요');
  }

  const rows = must<{ token: string }[]>('push_tokens', await service.from('push_tokens').select('token').eq('user_id', req.targetUserId));
  if (!rows.length) return { sent: 0, failed: 0, reason: 'NO_TOKENS' };

  const result = await sendExpoPush(
    rows.map((r) => r.token),
    { title: req.title, body: req.body, data: { ...(req.data ?? {}), kind: req.kind, ...(req.alarmId ? { alarmId: req.alarmId } : {}) } },
    { accessToken: options.accessToken, fetchImpl: options.fetchImpl },
  );

  // 앱을 지웠거나 토큰이 바뀌어 못 받는 토큰은 지움 (8장 8.2.3)
  if (result.invalidTokens.length) {
    const del = await service.from('push_tokens').delete().in('token', result.invalidTokens);
    if (del.error) console.error('[notify] 만료 토큰 삭제 실패', del.error.message);
  }

  return { sent: result.sent, failed: result.failed, ...(result.reason ? { reason: result.reason } : {}) };
}
