// notify의 본문 — Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (notify.test.ts). 연결은 notify/index.ts
//   요청: { kind, targetUserId?, groupId?, appointmentId?, alarmId?, previousAt?, newAt? }
//        한 사람에게 가는 종류(깨우기 · 알람 바뀜 · 친구 요청 · 수락)는 targetUserId, 그룹 종류(새 멤버 · 약속 변경)는 groupId(+ appointmentId)만 — 받는 사람은 서버가 고름
//        옛 앱이 보내던 title · body · data는 읽지 않음: 문구는 종류별로 서버가 고정하고(push-copy.ts) 알림 데이터도 서버가 채움
//   처리(한 사람): ① 받는 사람 프로필 확인(탈퇴했으면 조용히 끝) ② can_send_push(부른 사람, 받는 사람, kind) — 서버 권한 판정(DB 함수, service_role 전용)
//        ③ alarmId는 받는 사람의 알람인지 ④ push_tokens 조회 ⑤ Expo Push로 보냄(실패하면 한 번 더) ⑥ 접수 번호를 push_tickets에 기록(영수증은 15분 뒤 배치가 확인)
//        ⑦ 접수 단계에서 만료로 돌아온 토큰은 바로 지움
//   처리(그룹): plan_group_push(DB 함수)가 보낸 사람이 그 그룹에 참여 중인지 보고 받는 사람 = 참여 중 멤버 − 보낸 사람 − 알림 끈 멤버 − 차단 쌍을 돌려줌 → 받는 사람마다 토큰 조회 · 발송
//   응답: { sent, failed, reason? } — 토큰이 없거나 푸시 설정(FCM 키 · Expo 액세스 토큰)이 아직 없으면 오류가 아니라 { sent: 0, reason }
import { dbFail, must } from './db.ts';
import { HttpError } from './errors.ts';
import { CHANNEL_IDS, CLIENT_KINDS, composeCopy, type ClientKind, type GroupKind, isGroupKind, PATHS } from './push-copy.ts';
import { type FetchLike, type OutgoingMessage, type PushResult, sendExpoMessages, type SendResult } from './push.ts';
import type { Reader } from './read.ts';
import type { Db } from './supabase.ts';

// 종류별 권한은 DB 함수 can_send_push(한 사람)와 plan_group_push(그룹)가 정함 (supabase/README.md). 종류가 늘어도 여기는 이름만 더함
//   WAKE_PING          — G03 깨우기. 8장이 조건(기상 공유 동의 · 간격)을 정할 때까지 DB 함수가 늘 거절 → 403
//   ALARM_CHANGED      — G04. 부른 사람이 받는 사람의 알람에 설정 권한(조회도 함께)이 있을 때만 (D9: 변경 기록은 저장하지 않고 푸시만)
//   FRIEND_REQUEST     — 받는 사람에게 보낸 대기 요청이 있을 때 / FRIEND_ACCEPTED — 방금 수락한 사람이 요청한 사람에게
//   GROUP_MEMBER_JOINED · GROUP_APPT_CHANGED — 그룹 단위
export { CLIENT_KINDS as PUSH_KINDS };
export type PushKind = ClientKind;

const DENIED: Record<ClientKind, string> = {
  ALARM_CHANGED: '이 사람의 알람을 바꿀 권한이 없어서 알림을 보낼 수 없어요',
  WAKE_PING: '깨우기 알림은 아직 보낼 수 없어요',
  FRIEND_REQUEST: '이 사람에게는 친구 요청 알림을 보낼 수 없어요',
  FRIEND_ACCEPTED: '이 사람에게는 수락 알림을 보낼 수 없어요',
  GROUP_MEMBER_JOINED: '이 그룹에는 알림을 보낼 수 없어요',
  GROUP_APPT_CHANGED: '이 그룹에는 알림을 보낼 수 없어요',
};

export type NotifyRequest = {
  kind: ClientKind;
  targetUserId?: string; // 한 사람 종류
  groupId?: string; // 그룹 종류
  appointmentId?: string; // GROUP_APPT_CHANGED
  alarmId?: string;
  previousAt?: string; // ALARM_CHANGED: 바뀌기 전 → 후 시각 (ISO, 문구에 HH:mm으로)
  newAt?: string;
};

export type NotifyResult = { sent: number; failed: number; reason?: 'NO_TOKENS' | NonNullable<PushResult['reason']> };

// 요청을 읽고 문제가 있으면 한 번에 던짐 (root.finish() 포함)
export function readNotifyRequest(root: Reader): NotifyRequest {
  const kind = root.oneOf('kind', CLIENT_KINDS, { required: true });
  const targetUserId = root.uuid('targetUserId');
  const groupId = root.uuid('groupId');
  const appointmentId = root.uuid('appointmentId');
  const alarmId = root.uuid('alarmId');
  const previousAt = root.date('previousAt');
  const newAt = root.date('newAt');
  const absent = (key: string) => !root.has(key) || root.isNull(key); // 값이 틀려서 없는 것(이미 문제로 기록됨)과 아예 안 보낸 것을 가름
  if (kind) {
    if (isGroupKind(kind)) {
      if (absent('groupId')) root.problemAt('groupId', '필수 값이에요');
      if (kind === 'GROUP_APPT_CHANGED' && absent('appointmentId')) root.problemAt('appointmentId', '필수 값이에요');
    } else if (absent('targetUserId')) {
      root.problemAt('targetUserId', '필수 값이에요');
    }
  }
  root.finish();
  if (!kind) throw new HttpError('VALIDATION_FAILED', '입력값을 확인해 주세요');
  if (isGroupKind(kind)) {
    if (!groupId || (kind === 'GROUP_APPT_CHANGED' && !appointmentId)) throw new HttpError('VALIDATION_FAILED', '입력값을 확인해 주세요');
    return { kind, groupId, ...(kind === 'GROUP_APPT_CHANGED' && appointmentId ? { appointmentId } : {}) }; // 앱이 넘긴 받는 사람은 버림 (11-15)
  }
  if (!targetUserId) throw new HttpError('VALIDATION_FAILED', '입력값을 확인해 주세요');
  return {
    kind,
    targetUserId,
    ...(alarmId ? { alarmId } : {}),
    ...(kind === 'ALARM_CHANGED' && previousAt && newAt ? { previousAt: previousAt.toISOString(), newAt: newAt.toISOString() } : {}),
  };
}

export type NotifyOptions = { accessToken?: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> };

type Profile = { user_id: string; nickname: string | null; timezone: string | null };

export async function runNotify(service: Db, senderId: string, req: NotifyRequest, options: NotifyOptions = {}): Promise<NotifyResult> {
  return isGroupKind(req.kind) ? await notifyGroup(service, senderId, req as NotifyRequest & { kind: GroupKind }, options) : await notifyOne(service, senderId, req, options);
}

const noTokens = (): NotifyResult => ({ sent: 0, failed: 0, reason: 'NO_TOKENS' });

async function notifyOne(service: Db, senderId: string, req: NotifyRequest, options: NotifyOptions): Promise<NotifyResult> {
  const target = req.targetUserId as string;
  // 받는 사람이 탈퇴했으면 조용히 끝 — 권한 판정도 토큰 조회도 하지 않음 (11-17)
  const profiles = must<Profile[]>('profiles', await service.from('profiles').select('user_id, nickname, timezone').in('user_id', [target, senderId]));
  const targetProfile = profiles.find((p) => p.user_id === target);
  if (!targetProfile) return noTokens();

  // 권한 판정은 DB 함수 한 군데 (종류별 조건이 늘어도 여기는 안 바뀜)
  const allowed = await service.rpc('can_send_push', { p_sender_id: senderId, p_target_id: target, p_kind: req.kind });
  if (allowed.error) dbFail('can_send_push', allowed.error);
  if (allowed.data !== true) throw new HttpError('FORBIDDEN', DENIED[req.kind]);

  // 알람 id를 같이 받은 경우, 받는 사람의 알람이 맞는지 (남의 알람 id로 알림 내용을 꾸미지 못하게)
  if (req.alarmId) {
    const alarm = must<{ alarm_id: string } | null>(
      'alarm lookup',
      await service.from('alarms').select('alarm_id').eq('alarm_id', req.alarmId).eq('user_id', target).maybeSingle(),
    );
    if (!alarm) throw new HttpError('NOT_FOUND', '받는 사람의 알람을 찾을 수 없어요');
  }

  const rows = must<{ token: string }[]>('push_tokens', await service.from('push_tokens').select('token').eq('user_id', target));
  if (!rows.length) return noTokens();

  const copy = composeCopy(req.kind, {
    senderName: profiles.find((p) => p.user_id === senderId)?.nickname,
    previousAt: req.previousAt,
    newAt: req.newAt,
    timeZone: targetProfile.timezone,
  });
  const data = { kind: req.kind, recipientUserId: target, path: PATHS[req.kind], ...(req.alarmId ? { alarmId: req.alarmId } : {}) };
  const messages: OutgoingMessage[] = rows.map((r) => ({ to: r.token, ...copy, channelId: CHANNEL_IDS[req.kind], data }));
  return await deliver(service, req.kind, messages, new Map(rows.map((r) => [r.token, target])), options);
}

async function notifyGroup(service: Db, senderId: string, req: NotifyRequest & { kind: GroupKind }, options: NotifyOptions): Promise<NotifyResult> {
  const planned = await service.rpc('plan_group_push', { p_sender_id: senderId, p_group_id: req.groupId, p_kind: req.kind, p_appointment_id: req.appointmentId ?? null });
  if (planned.error) dbFail('plan_group_push', planned.error);
  const plan = planned.data as { status?: unknown; group_name?: unknown; appointment_title?: unknown; recipients?: unknown } | null;
  if (plan?.status === 'FORBIDDEN') throw new HttpError('FORBIDDEN', DENIED[req.kind]);
  if (plan?.status !== 'OK' || !Array.isArray(plan.recipients) || !plan.recipients.every((r) => typeof r === 'string')) {
    console.error('[notify] plan_group_push 응답이 약속과 다름', JSON.stringify(plan));
    throw new HttpError('INTERNAL', '데이터를 처리하지 못했어요. 잠시 후 다시 시도해 주세요');
  }
  const recipients = plan.recipients as string[];
  if (!recipients.length) return noTokens();

  const rows = must<{ user_id: string; token: string }[]>('push_tokens', await service.from('push_tokens').select('user_id, token').in('user_id', recipients));
  if (!rows.length) return noTokens();

  // 문구에는 그룹 이름 · 약속 제목만 (사람 이름 없음). 받는 사람마다 알림 데이터의 받는 사람 id가 다름
  const copy = composeCopy(req.kind, {
    groupName: typeof plan.group_name === 'string' ? plan.group_name : null,
    appointmentTitle: typeof plan.appointment_title === 'string' ? plan.appointment_title : null,
  });
  const base = { kind: req.kind, path: PATHS[req.kind], groupId: req.groupId, ...(req.appointmentId ? { appointmentId: req.appointmentId } : {}) };
  const messages: OutgoingMessage[] = rows.map((r) => ({ to: r.token, ...copy, channelId: CHANNEL_IDS[req.kind], data: { ...base, recipientUserId: r.user_id } }));
  return await deliver(service, req.kind, messages, new Map(rows.map((r) => [r.token, r.user_id])), options);
}

// 보내고, 접수 번호를 영수증 표에 남기고, 접수 단계에서 만료로 돌아온 토큰은 지움
async function deliver(service: Db, kind: ClientKind, messages: OutgoingMessage[], owners: Map<string, string>, options: NotifyOptions): Promise<NotifyResult> {
  const result: SendResult = await sendExpoMessages(messages, { accessToken: options.accessToken, fetchImpl: options.fetchImpl, sleep: options.sleep });

  // 영수증 기록이 안 돼도 푸시는 이미 나갔으므로 오류로 만들지 않음 (다음 배치에서 확인할 대상이 빠질 뿐)
  if (result.tickets.length) {
    const ins = await service
      .from('push_tickets')
      .insert(result.tickets.map((t) => ({ ticket_id: t.ticketId, user_id: owners.get(t.token), token: t.token, kind })));
    if (ins.error) console.error('[notify] 푸시 영수증 기록 실패', ins.error.message);
  }

  // 앱을 지웠거나 토큰이 바뀌어 못 받는 토큰은 지움 (8장 8.2.3)
  if (result.invalidTokens.length) {
    const del = await service.from('push_tokens').delete().in('token', result.invalidTokens);
    if (del.error) console.error('[notify] 만료 토큰 삭제 실패', del.error.message);
  }

  return { sent: result.sent, failed: result.failed, ...(result.reason ? { reason: result.reason } : {}) };
}
