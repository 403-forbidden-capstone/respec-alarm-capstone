// notify의 본문 — Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (notify.test.ts). 연결은 notify/index.ts
//   요청: { kind, targetUserId?, groupId?, appointmentId?, alarmId? } (옛 앱이 보내던 previousAt · newAt은 읽기만 하고 안 씀 — ALARM_CHANGED의 시각은 제안 기록에서)
//        한 사람에게 가는 종류(깨우기 · 알람 바뀜 · 친구 요청 · 수락)는 targetUserId, 그룹 종류(새 멤버 · 약속 변경)는 groupId(+ appointmentId)만 — 받는 사람은 서버가 고름
//        깨우기는 groupId도 받음(어느 그룹의 G03에서 눌렀는지): 그 그룹에서 보이는 사람일 때만 되고, 푸시를 누르면 그 그룹의 G03로 감
//        옛 앱이 보내던 title · body · data는 읽지 않음: 문구는 종류별로 서버가 고정하고(push-copy.ts) 알림 데이터도 서버가 채움
//   처리(한 사람): ① can_send_push(부른 사람, 받는 사람, kind) — 서버 권한 판정(DB 함수, service_role 전용). 없는 · 탈퇴한 · 권한 없는 · 차단된 대상은 모두 같은 403이라
//        사용자 존재 여부가 응답으로 드러나지 않음(15-나). 깨우기만 can_send_push를 안 부르고 plan_wake_ping이 권한까지 한 곳에서 판정함 ② 받는 사람 프로필(문구에 쓸 이름 · 시간대)
//        ③ 알람 바뀜(제안)은 받는 사람에게 방금(1시간 안) 보낸 대기 중 제안을 조회해 문구의 시각 · 알람 종류를 채움(alarmId가 있으면 그 알람의 제안으로 좁힘) ④ push_tokens 조회 ⑤ Expo Push로 보냄(실패하면 한 번 더) ⑥ 접수 번호를 push_tickets에 기록(영수증은 15분 뒤 배치가 확인)
//        ⑦ 접수 단계에서 만료로 돌아온 토큰은 바로 지움
//   처리(그룹): plan_group_push(DB 함수)가 보낸 사람이 그 그룹에 참여 중인지 보고 받는 사람 = 참여 중 멤버 − 보낸 사람 − 알림 끈 멤버 − 차단 쌍을 돌려줌 → 받는 사람마다 토큰 조회 · 발송
//   깨우기(WAKE_PING)는 ①이 아니라 plan_wake_ping(판정만) → 토큰 확인 → plan_wake_ping(횟수 세기, 같은 쌍 잠금 아래 다시 판정) → 발송. 기상이 안 보이는 사람이면 403.
//        못 보내는 이유(아직 안 울림 · 이미 일어남 · 5분 · 하루 3번 · 받기 꺼짐)는 오류가 아니라 응답의 ping.status로 — 보낸 쪽 G03이 글자를 바꿈.
//        토큰이 없거나, 센 뒤에 푸시가 한 건도 못 나가면(전송 실패) 센 횟수를 되돌리고 ping.status = NO_TOKENS (받는 사람이 못 받은 깨우기가 한도를 쓰지 않게)
//   응답: { sent, failed, reason?, ping? } — 토큰이 없거나 푸시 설정(FCM 키 · Expo 액세스 토큰)이 아직 없으면 오류가 아니라 { sent: 0, reason }
import { dbFail, must } from './db.ts';
import { HttpError } from './errors.ts';
import { CHANNEL_IDS, CLIENT_KINDS, composeCopy, type ClientKind, type GroupChange, type GroupKind, isGroupKind, PATHS, type PushKind as AnyPushKind, wakePingPath } from './push-copy.ts';
import { type FetchLike, type OutgoingMessage, type PushResult, sendExpoMessages, type SendResult } from './push.ts';
import type { Reader } from './read.ts';
import type { Db } from './supabase.ts';

// 종류별 권한은 DB 함수 can_send_push(한 사람)와 plan_group_push(그룹)가 정함 (supabase/README.md). 종류가 늘어도 여기는 이름만 더함
//   WAKE_PING          — G03 깨우기. can_send_push는 늘 거절(옛 서버 함수가 한도 없이 보내지 못하게)이고 plan_wake_ping이 판정: 기상이 보이는 사람에게만(그룹 · 동의 · 오늘 약속 · 숨김 / 차단 아님), 아니면 403. 간격 · 횟수 · 이미 일어남은 상태로 돌려줌
//   ALARM_CHANGED      — G04 알람 시각 제안. 부른 사람이 받는 사람의 알람에 설정 권한(조회도 함께)이 있고 받는 사람에게 방금(1시간 안) 보낸 대기 중 제안이 있을 때만
//   FRIEND_REQUEST     — 받는 사람에게 보낸 대기 요청이 있을 때 / FRIEND_ACCEPTED — 방금 수락한 사람이 요청한 사람에게
//   GROUP_MEMBER_JOINED · GROUP_APPT_CHANGED — 그룹 단위
export { CLIENT_KINDS as PUSH_KINDS };
export type PushKind = ClientKind;

const DENIED: Record<ClientKind, string> = {
  ALARM_CHANGED: '이 사람에게 알람 제안 알림을 보낼 수 없어요 (권한이 없거나 방금 보낸 제안이 없어요)',
  WAKE_PING: '이 사람에게는 깨우기 알림을 보낼 수 없어요',
  FRIEND_REQUEST: '이 사람에게는 친구 요청 알림을 보낼 수 없어요',
  FRIEND_ACCEPTED: '이 사람에게는 수락 알림을 보낼 수 없어요',
  GROUP_MEMBER_JOINED: '이 그룹에는 알림을 보낼 수 없어요',
  GROUP_APPT_CHANGED: '이 그룹에는 알림을 보낼 수 없어요',
};

export type NotifyRequest = {
  kind: ClientKind;
  targetUserId?: string; // 한 사람 종류
  groupId?: string; // 그룹 종류 + 깨우기(누른 그룹 화면)
  appointmentId?: string; // GROUP_APPT_CHANGED
  alarmId?: string; // ALARM_CHANGED: 어느 알람의 제안인지 (없으면 방금 보낸 가장 최근 제안)
};

// 깨우기 판정 결과 (DB 함수 plan_wake_ping의 jsonb + 토큰이 없을 때 NO_TOKENS). OK일 때만 푸시가 나갔음
//   count · limit = 오늘 몇 번째/하루 몇 번, next_at = 다음에 보낼 수 있는 시각, resets_at = 하루 한도가 풀리는 시각(받는 사람 시간대 0시)
export type WakePing = { status: 'OK' | 'NOT_RINGING' | 'ALREADY_UP' | 'WAIT' | 'DAILY_LIMIT' | 'OFF' | 'NO_TOKENS'; count?: number; limit?: number; next_at?: string; resets_at?: string };
const PING_KEYS = ['count', 'limit', 'next_at', 'resets_at'] as const;
const PING_STATUSES = new Set(['OK', 'NOT_RINGING', 'ALREADY_UP', 'WAIT', 'DAILY_LIMIT', 'OFF']);

export type NotifyResult = { sent: number; failed: number; reason?: 'NO_TOKENS' | NonNullable<PushResult['reason']>; ping?: WakePing };

// 요청을 읽고 문제가 있으면 한 번에 던짐 (root.finish() 포함)
export function readNotifyRequest(root: Reader): NotifyRequest {
  const kind = root.oneOf('kind', CLIENT_KINDS, { required: true });
  const targetUserId = root.uuid('targetUserId');
  const groupId = root.uuid('groupId');
  const appointmentId = root.uuid('appointmentId');
  const alarmId = root.uuid('alarmId');
  root.date('previousAt'); // 옛 앱이 보내던 값 — 모양만 확인하고 안 씀 (문구의 시각은 서버가 제안 기록에서 가져옴, 친구 10-25)
  root.date('newAt');
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
    ...(kind === 'WAKE_PING' && groupId ? { groupId } : {}),                    // 깨우기만 그룹 id를 가짐 (다른 한 사람 종류에서는 버림)
    ...(kind === 'ALARM_CHANGED' && alarmId ? { alarmId } : {}),   // 알람 id는 알람 바뀜에만 (다른 종류에 실어 남의 알람 id를 시험하지 못하게)
  };
}

export type NotifyOptions = { accessToken?: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; now?: Date }; // now = 문구의 '내일' 같은 말을 가를 기준 시각(시험용, 기본 지금)

type Profile = { user_id: string; nickname: string | null; timezone: string | null };

export async function runNotify(service: Db, senderId: string, req: NotifyRequest, options: NotifyOptions = {}): Promise<NotifyResult> {
  return isGroupKind(req.kind) ? await notifyGroup(service, senderId, req as NotifyRequest & { kind: GroupKind }, options) : await notifyOne(service, senderId, req, options);
}

const noTokens = (withPing = false): NotifyResult => ({ sent: 0, failed: 0, reason: 'NO_TOKENS', ...(withPing ? { ping: { status: 'NO_TOKENS' as const } } : {}) });

// 깨우기 판정 (DB 함수 한 군데). 기상이 안 보이는 사람이면 403(이유 구분 없음), 모르는 응답이면 500. 앱에 돌려줄 값은 약속한 칸만(send_id 같은 서버 안쪽 값은 뺌)
async function planPing(service: Db, senderId: string, target: string, reserve: boolean, groupId?: string): Promise<{ ping: WakePing; sendId?: number; groupId?: string }> {
  const r = await service.rpc('plan_wake_ping', { p_sender: senderId, p_target: target, p_reserve: reserve, ...(groupId ? { p_group_id: groupId } : {}) });
  if (r.error) dbFail('plan_wake_ping', r.error);
  const data = r.data as (Record<string, unknown> & { status?: unknown }) | null;
  if (data?.status === 'FORBIDDEN') throw new HttpError('FORBIDDEN', DENIED.WAKE_PING);
  if (typeof data?.status !== 'string' || !PING_STATUSES.has(data.status)) {
    console.error('[notify] plan_wake_ping 응답이 약속과 다름', JSON.stringify(data));
    throw new HttpError('INTERNAL', '데이터를 처리하지 못했어요. 잠시 후 다시 시도해 주세요');
  }
  const ping: WakePing = { status: data.status as WakePing['status'] };
  for (const k of PING_KEYS) if (data[k] !== undefined && data[k] !== null) (ping as Record<string, unknown>)[k] = data[k];
  return { ping, ...(typeof data.send_id === 'number' ? { sendId: data.send_id } : {}), ...(typeof data.group_id === 'string' ? { groupId: data.group_id } : {}) };
}

async function notifyOne(service: Db, senderId: string, req: NotifyRequest, options: NotifyOptions): Promise<NotifyResult> {
  const target = req.targetUserId as string;
  const wake = req.kind === 'WAKE_PING';
  if (wake) {
    // 깨우기: 권한(기상이 보이는 사람)과 보낼 수 있는 때를 plan_wake_ping 한 곳에서 먼저 (토큰 조회 전에 — 못 보내는 이유를 보낸 쪽에 알려 주려고)
    const verdict = await planPing(service, senderId, target, false, req.groupId);
    if (verdict.ping.status !== 'OK') return { sent: 0, failed: 0, ping: verdict.ping };
  } else {
    // 권한 판정이 먼저, DB 함수 한 군데 (종류별 조건이 늘어도 여기는 안 바뀜). 없는 · 탈퇴한 사람은 권한 행이 없어 권한 없음 · 차단과 같은 거절이 됨 (11-17 · 15-나)
    const allowed = await service.rpc('can_send_push', { p_sender_id: senderId, p_target_id: target, p_kind: req.kind });
    if (allowed.error) dbFail('can_send_push', allowed.error);
    if (allowed.data !== true) throw new HttpError('FORBIDDEN', DENIED[req.kind]);
  }

  const profiles = must<Profile[]>('profiles', await service.from('profiles').select('user_id, nickname, timezone').in('user_id', [target, senderId]));
  const targetProfile = profiles.find((p) => p.user_id === target);
  if (!targetProfile) return noTokens(wake); // 판정과 조회 사이에 탈퇴한 경우뿐

  // 알람 바뀜(제안): 문구의 알람 종류 · 이전 → 새 시각은 요청이 아니라 방금 보낸 대기 중 제안 기록에서 — 시각을 꾸밀 수 없음 (친구 10-25). 알람 id를 같이 받았으면 그 알람의 제안이어야 함
  let proposal: { proposal_id: string; alarm_id: string; from_at: string; to_at: string; alarm_type: string | null } | undefined;
  if (req.kind === 'ALARM_CHANGED') {
    let query = service
      .from('alarm_proposals')
      .select('proposal_id, alarm_id, from_at, to_at')
      .eq('proposer_id', senderId)
      .eq('owner_id', target)
      .eq('status', 'PENDING')
      .gte('created_at', new Date(Date.now() - 3_600_000).toISOString()); // DB의 can_send_push와 같은 1시간 (options.now는 문구용이라 안 씀)
    if (req.alarmId) query = query.eq('alarm_id', req.alarmId);
    const found = must<{ proposal_id: string; alarm_id: string; from_at: string; to_at: string }[]>('alarm_proposals', await query.order('created_at', { ascending: false }).limit(1));
    if (!found.length) throw new HttpError('NOT_FOUND', '보낸 제안을 찾을 수 없어요');
    const alarm = must<{ alarm_type: string } | null>('alarm lookup', await service.from('alarms').select('alarm_type').eq('alarm_id', found[0].alarm_id).eq('user_id', target).maybeSingle());
    proposal = { ...found[0], alarm_type: alarm?.alarm_type ?? null };
  }

  const rows = must<{ token: string }[]>('push_tokens', await service.from('push_tokens').select('token').eq('user_id', target));
  if (!rows.length) return noTokens(wake); // 토큰이 없으면 횟수를 안 셈 (8-14)

  // 보내기 직전에 횟수를 셈 — 같은 쌍 잠금 아래에서 다시 판정하므로 동시에 두 번 눌러도 한 번만 나감 (8-차)
  let reserved: { ping: WakePing; sendId?: number; groupId?: string } | undefined;
  if (wake) {
    reserved = await planPing(service, senderId, target, true, req.groupId);
    if (reserved.ping.status !== 'OK') return { sent: 0, failed: 0, ping: reserved.ping };
  }

  const copy = composeCopy(req.kind, {
    senderName: profiles.find((p) => p.user_id === senderId)?.nickname,
    ...(proposal ? { previousAt: proposal.from_at, newAt: proposal.to_at, alarmType: proposal.alarm_type, now: options.now } : {}),
    timeZone: targetProfile.timezone,
  });
  const path = reserved?.groupId ? wakePingPath(reserved.groupId, target) : PATHS[req.kind]; // 깨우기는 그 그룹에서 본 그 사람의 G03
  const data = { kind: req.kind, recipientUserId: target, path, ...(proposal ? { alarmId: proposal.alarm_id, proposalId: proposal.proposal_id } : {}) };
  const messages: OutgoingMessage[] = rows.map((r) => ({ to: r.token, ...copy, channelId: CHANNEL_IDS[req.kind], data }));
  const delivered = await deliver(service, req.kind, messages, new Map(rows.map((r) => [r.token, target])), options);
  if (!reserved) return delivered;
  if (delivered.sent === 0) {
    // 센 뒤인데 한 건도 못 나감(전송 실패 · 푸시 설정 없음) — 받는 사람이 못 받은 깨우기가 하루 3번을 쓰지 않게 센 줄을 지움
    if (reserved.sendId !== undefined) {
      const undo = await service.from('push_sends').delete().eq('send_id', reserved.sendId);
      if (undo.error) console.error('[notify] 깨우기 횟수 되돌리기 실패', undo.error.message);
    }
    return { ...delivered, ping: { status: 'NO_TOKENS' } };
  }
  return { ...delivered, ping: reserved.ping };
}

async function notifyGroup(service: Db, senderId: string, req: NotifyRequest & { kind: GroupKind }, options: NotifyOptions): Promise<NotifyResult> {
  return await sendGroupPush(service, req, await planGroupPush(service, senderId, req), options);
}

// 그룹 알림의 받는 사람 · 문구 재료를 DB 함수로 정함 — 권한이 없으면 403. 보내기와 나눈 이유: 약속을 지우기 전에 받는 사람을 정해 두고(지운 뒤엔 약속이 없음) 지운 다음에 보내려고 (9장)
//   silentRecipients = 보이는 알림이 빠진 참여자(알림 끈 멤버 · 차단 쌍) — 알람만 다시 맞추게 조용한 데이터 푸시를 보냄 (약속 변경만)
export type GroupPlan = { recipients: string[]; silentRecipients: string[]; groupName: string | null; appointmentTitle: string | null };
export async function planGroupPush(service: Db, senderId: string, req: NotifyRequest & { kind: GroupKind }): Promise<GroupPlan> {
  const planned = await service.rpc('plan_group_push', { p_sender_id: senderId, p_group_id: req.groupId, p_kind: req.kind, p_appointment_id: req.appointmentId ?? null });
  if (planned.error) dbFail('plan_group_push', planned.error);
  const plan = planned.data as { status?: unknown; group_name?: unknown; appointment_title?: unknown; recipients?: unknown; silent_recipients?: unknown } | null;
  if (plan?.status === 'FORBIDDEN') throw new HttpError('FORBIDDEN', DENIED[req.kind]);
  if (plan?.status !== 'OK' || !Array.isArray(plan.recipients) || !plan.recipients.every((r) => typeof r === 'string')) {
    console.error('[notify] plan_group_push 응답이 약속과 다름', JSON.stringify(plan));
    throw new HttpError('INTERNAL', '데이터를 처리하지 못했어요. 잠시 후 다시 시도해 주세요');
  }
  const silent = Array.isArray(plan.silent_recipients) ? plan.silent_recipients.filter((r): r is string => typeof r === 'string') : [];
  return {
    recipients: plan.recipients as string[],
    silentRecipients: silent,
    groupName: typeof plan.group_name === 'string' ? plan.group_name : null,
    appointmentTitle: typeof plan.appointment_title === 'string' ? plan.appointment_title : null,
  };
}

// 정해 둔 받는 사람의 토큰으로 보냄. extra.change = 바뀜 / 취소됨(문구 · 알림 데이터 `change`), extra.perRecipient = 받는 사람마다 알림 데이터에 더할 값(예: 확인이 필요한 사람)
export type GroupSendExtra = { change?: GroupChange; perRecipient?: ReadonlyMap<string, Record<string, unknown>> };
export async function sendGroupPush(service: Db, req: NotifyRequest & { kind: GroupKind }, plan: GroupPlan, options: NotifyOptions, extra: GroupSendExtra = {}): Promise<NotifyResult> {
  const quietIds = plan.silentRecipients.filter((id) => !plan.recipients.includes(id));
  if (!plan.recipients.length && !quietIds.length) return noTokens();

  const rows = must<{ user_id: string; token: string }[]>('push_tokens', await service.from('push_tokens').select('user_id, token').in('user_id', [...plan.recipients, ...quietIds]));
  if (!rows.length) return noTokens();

  // 문구에는 그룹 이름 · 약속 제목만 (사람 이름 없음). 받는 사람마다 알림 데이터의 받는 사람 id가 다름
  const copy = composeCopy(req.kind, { groupName: plan.groupName, appointmentTitle: plan.appointmentTitle, ...(extra.change ? { change: extra.change } : {}) });
  const base = { kind: req.kind, path: PATHS[req.kind], groupId: req.groupId, ...(req.appointmentId ? { appointmentId: req.appointmentId } : {}), ...(extra.change ? { change: extra.change } : {}) };
  const owners = new Map(rows.map((r) => [r.token, r.user_id]));
  const messages: OutgoingMessage[] = rows
    .filter((r) => plan.recipients.includes(r.user_id))
    .map((r) => ({ to: r.token, ...copy, channelId: CHANNEL_IDS[req.kind], data: { ...base, ...(extra.perRecipient?.get(r.user_id) ?? {}), recipientUserId: r.user_id } }));
  // 알림을 끈 멤버 · 차단 쌍: 보이는 알림은 없어도 알람은 다시 맞춰야 하므로 문구 없는 데이터 푸시만 (받은 폰이 알림 없이 알람을 맞춤)
  const quiet: OutgoingMessage[] = rows
    .filter((r) => quietIds.includes(r.user_id))
    .map((r) => ({ to: r.token, title: '', body: '', silent: true, data: { ...base, ...(extra.perRecipient?.get(r.user_id) ?? {}), silent: true, recipientUserId: r.user_id } }));

  const shown = messages.length ? await deliver(service, req.kind, messages, owners, options) : noTokens();
  if (!quiet.length) return shown;
  const hidden = await deliver(service, req.kind, quiet, owners, options); // 보낸 수(sent)에는 안 더함 — '알림이 간 참여자 수'는 보이는 알림만. 실패는 합침
  return { ...shown, failed: shown.failed + hidden.failed };
}

// 보내고, 접수 번호를 영수증 표에 남기고, 접수 단계에서 만료로 돌아온 토큰은 지움
export async function deliver(service: Db, kind: AnyPushKind, messages: OutgoingMessage[], owners: Map<string, string>, options: NotifyOptions): Promise<NotifyResult> {
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

  // 보내지 못한 이유를 서버 로그에 남김 — 앱은 푸시 실패를 무시하므로 FCM 키 없음 · Expo 장애를 운영자가 알 길이 이것뿐 (11-20)
  if (result.reason) console.error('[notify] 푸시 전송 실패', kind, result.reason, `sent=${result.sent} failed=${result.failed}`);
  return { sent: result.sent, failed: result.failed, ...(result.reason ? { reason: result.reason } : {}) };
}
