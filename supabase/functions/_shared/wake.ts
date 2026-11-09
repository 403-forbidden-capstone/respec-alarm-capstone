// wake-check의 본문 — Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (wake.test.ts). 연결은 wake-check/index.ts
//   ① MISSED 기록: find_missed_wake_alarms(DB 함수)가 "마지막으로 울리기 시작한 때(알람 시각 또는 마지막 미루기가 끝나 다시 울린 때) + 30분"이 지났는데 기상 확인이 없는 알람을 찾음
//        → alarm_events에 MISSED로 기록. client_event_id = event_key라서 겹쳐 돌거나 다시 돌아도 한 번만 들어감
//   ② 본인 알림 (친구 8장 8-너): 이번에 새로 기록된 MISSED의 주인에게 '기상 확인 / 기상 확인이 안 됐어요' — 친구가 아니라 본인에게 먼저
//   ③ 친구 알림 (8-d5): claim_wake_nudges(DB 함수)가 받을 사람을 정함 — 미확인 10분 뒤 '깨워 볼까요?', 늦게 확인했으면 후속 '일어났어요' 1회.
//        받는 사람은 DB가 정하고 push_sends에 남기면서 돌려주므로 5분 배치가 겹쳐 돌아도 한 번만 나감. 남기는 것이 먼저라 보내기가 실패해도 다시 보내지 않음
//   푸시가 실패해도 MISSED 기록은 그대로 (푸시는 일이 끝난 뒤의 알림이라 오류로 만들지 않고 서버 로그에만)
import { dbFail, must } from './db.ts';
import { deliver, type NotifyOptions } from './notify.ts';
import { CHANNEL_IDS, composeCopy, PATHS, type PushKind } from './push-copy.ts';
import type { OutgoingMessage } from './push.ts';
import type { Db } from './supabase.ts';

// find_missed_wake_alarms 반환 행. appointment_id · group_id · appointment_at · participant_id는 약속 없는 알람이면 null (일정 없는 알람, D46)
export type MissedRow = {
  alarm_id: string;
  user_id: string;
  participant_id: string | null;
  appointment_id: string | null;
  group_id: string | null;
  appointment_at: string | null;
  scheduled_at: string;
  missed_at: string;
  event_key: string;
};

export const LOOKBACK_HOURS = 24; // 오래된 알람이 한꺼번에 MISSED로 쏟아지지 않게 (DB 함수 기본값과 같음)

// claim_wake_nudges 반환 행. kind NUDGE = '깨워 볼까요?', UP = 후속 '일어났어요'. group_id = 누르면 열 그룹
export type NudgeRow = { event_key: string; kind: 'NUDGE' | 'UP'; recipient_id: string; sleeper_id: string; group_id: string };

// claimed = 이번에 친구 알림 대상으로 정한 (받는 사람, 안 일어난 사람) 쌍 수, nudged = 실제로 나간 기기 수 (토큰이 없거나 전송이 실패하면 claimed보다 적음)
export type WakeCheckResult = { checked: number; recorded: number; pushed: number; claimed: number; nudged: number };

// .in()에 한꺼번에 넣는 id 수 (요청 주소가 너무 길어지지 않게)
const IN_CHUNK = 100;
async function selectIn<T>(service: Db, table: string, columns: string, column: string, ids: readonly string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...must<T[]>(table, await service.from(table).select(columns).in(column, ids.slice(i, i + IN_CHUNK))));
  return out;
}

// 본인 알림: 이번에 새로 기록된 MISSED의 주인마다 한 번 (한 사람의 알람이 둘 이상 같이 미확인이어도 한 번). 보낸 기기 수를 돌려줌
async function pushMissedToSelf(service: Db, rows: MissedRow[], push: NotifyOptions): Promise<number> {
  const users = [...new Set(rows.map((r) => r.user_id))];
  if (!users.length) return 0;
  const tokens = await selectIn<{ user_id: string; token: string }>(service, 'push_tokens', 'user_id, token', 'user_id', users);
  if (!tokens.length) return 0;
  const copy = composeCopy('WAKE_MISSED', {});
  const messages: OutgoingMessage[] = tokens.map((t) => ({
    to: t.token,
    ...copy,
    channelId: CHANNEL_IDS.WAKE_MISSED,
    data: { kind: 'WAKE_MISSED', recipientUserId: t.user_id, path: PATHS.WAKE_MISSED },
  }));
  return (await deliver(service, 'WAKE_MISSED', messages, new Map(tokens.map((t) => [t.token, t.user_id])), push)).sent;
}

async function recordMissed(service: Db, now: Date, push: NotifyOptions): Promise<{ checked: number; recorded: number; pushed: number }> {
  // 이름 인자(p_now · p_lookback_hours)는 DB 함수 매개변수 이름과 같아야 함 — 매개변수 이름을 바꾸면 여기도 같이
  const found = await service.rpc('find_missed_wake_alarms', { p_now: now.toISOString(), p_lookback_hours: LOOKBACK_HOURS });
  if (found.error) dbFail('find_missed_wake_alarms', found.error);
  const rows = (found.data ?? []) as MissedRow[];
  if (!rows.length) return { checked: 0, recorded: 0, pushed: 0 };

  // input_source는 비움 (폰 입력이 아니라 서버 판정). 이미 기록된 event_key는 건너뜀 (ON CONFLICT DO NOTHING)
  const events = rows.map((r) => ({
    alarm_id: r.alarm_id,
    user_id: r.user_id,
    event_type: 'MISSED',
    event_at: r.missed_at,
    sequence_no: 1,
    client_event_id: r.event_key,
    input_source: null,
  }));
  const inserted = await service
    .from('alarm_events')
    .upsert(events, { onConflict: 'client_event_id', ignoreDuplicates: true })
    .select('client_event_id');
  if (inserted.error) dbFail('alarm_events MISSED', inserted.error);

  // 이번에 새로 기록된 것만 푸시 대상 (다시 돌았을 때 같은 푸시가 두 번 가지 않게)
  const fresh = new Set(((inserted.data ?? []) as { client_event_id: string }[]).map((r) => r.client_event_id));
  let pushed = 0;
  try {
    pushed = await pushMissedToSelf(service, rows.filter((r) => fresh.has(r.event_key)), push);
  } catch (e) {
    console.error('[wake-check] 본인 미확인 푸시 실패', e instanceof Error ? e.message : String(e));
  }
  return { checked: rows.length, recorded: fresh.size, pushed };
}

// 친구 알림: 받을 사람을 DB가 정해 돌려주면 종류별로 묶어 보냄. 이름은 안 일어난(일어난) 사람 것만 문구에
async function pushNudges(service: Db, now: Date, push: NotifyOptions): Promise<{ claimed: number; sent: number }> {
  const claimed = await service.rpc('claim_wake_nudges', { p_now: now.toISOString() });
  if (claimed.error) dbFail('claim_wake_nudges', claimed.error);
  const rows = (claimed.data ?? []) as NudgeRow[];
  if (!rows.length) return { claimed: 0, sent: 0 };

  let sent = 0;
  try {
    const names = new Map(
      (await selectIn<{ user_id: string; nickname: string | null }>(service, 'profiles', 'user_id, nickname', 'user_id', [...new Set(rows.map((r) => r.sleeper_id))])).map((p) => [p.user_id, p.nickname]),
    );
    const tokens = await selectIn<{ user_id: string; token: string }>(service, 'push_tokens', 'user_id, token', 'user_id', [...new Set(rows.map((r) => r.recipient_id))]);
    for (const [kind, rowKind] of [['WAKE_NUDGE', 'NUDGE'], ['WAKE_NUDGE_UP', 'UP']] as [PushKind & ('WAKE_NUDGE' | 'WAKE_NUDGE_UP'), NudgeRow['kind']][]) {
      const messages: OutgoingMessage[] = rows
        .filter((r) => r.kind === rowKind)
        .flatMap((r) =>
          tokens
            .filter((t) => t.user_id === r.recipient_id)
            .map((t) => ({
              to: t.token,
              ...composeCopy(kind, { subjectName: names.get(r.sleeper_id) }),
              channelId: CHANNEL_IDS[kind],
              data: { kind, recipientUserId: r.recipient_id, path: PATHS[kind], groupId: r.group_id, subjectUserId: r.sleeper_id },
            })),
        );
      if (messages.length) sent += (await deliver(service, kind, messages, new Map(tokens.map((t) => [t.token, t.user_id])), push)).sent;
    }
  } catch (e) {
    console.error('[wake-check] 친구 미확인 푸시 실패', e instanceof Error ? e.message : String(e));
  }
  if (sent < rows.length) console.error('[wake-check] 친구 알림 대상보다 적게 나감', `claimed=${rows.length} sent=${sent}`);   // 토큰이 없거나 전송이 실패한 몫 — 기록이 먼저라 다시 보내지 않음
  return { claimed: rows.length, sent };
}

// ①②와 ③은 서로 안 막음: 한쪽이 실패해도 다른 쪽은 돌리고, 실패는 그 뒤에 그대로 던짐
export async function runWakeCheck(service: Db, now: Date, options: { push?: NotifyOptions } = {}): Promise<WakeCheckResult> {
  const push = options.push ?? {};
  let failure: unknown;
  let recorded = { checked: 0, recorded: 0, pushed: 0 };
  let nudges = { claimed: 0, sent: 0 };
  try {
    recorded = await recordMissed(service, now, push);
  } catch (e) {
    failure = e;
  }
  try {
    nudges = await pushNudges(service, now, push);
  } catch (e) {
    failure ??= e;
  }
  if (failure) throw failure;
  return { ...recorded, claimed: nudges.claimed, nudged: nudges.sent };
}
