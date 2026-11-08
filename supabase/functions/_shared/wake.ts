// wake-check의 본문 — Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (wake.test.ts). 연결은 wake-check/index.ts
//   처리: find_missed_wake_alarms(DB 함수)가 "마지막으로 울리기 시작한 때(알람 시각 또는 마지막 미루기가 끝나 다시 울린 때) + 30분"이 지났는데 기상 확인이 없는 알람을 찾음
//        → alarm_events에 MISSED로 기록. client_event_id = event_key라서 겹쳐 돌거나 다시 돌아도 한 번만 들어감
//   푸시: 그룹에 알리는 미확인 푸시는 D19(기상 공유 동의 조건)가 정해질 때까지 안 보냄 — 기록만 남김
import { dbFail } from './db.ts';
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

// D19가 정해지기 전에는 false. 이유: 그 전에는 DB 함수 can_send_push가 'WAKE_MISSED'를 늘 거절하고 보내는 코드도 아직 없어서,
// 켜 봐야 받는 사람마다 DB를 왕복할 뿐이라서. D19 뒤: ① DB 함수에 'WAKE_MISSED' 조건을 더함 ② 이 값을 true로 ③ pushMissedToGroup의 TODO를 채움
export const PUSH_MISSED_TO_GROUP = false;

// 미확인 푸시를 받을 사람. 후보는 사실만 읽음 — 이 그룹에 참여 중(JOINED)인 다른 구성원.
// 보내도 되는지(기상 공유 동의 · 조회 권한 · 간격 같은 판정)는 DB 함수 can_send_push 하나가 정함. TS에서 sharing_permissions를 다시 해석하지 않음
// (판정이 두 군데로 나뉘면 D19 뒤에 어긋남 — #160 리뷰 방향성 2). 보내는 사람 = MISSED가 된 사람(권한을 준 쪽)
export async function missedPushTargets(service: Db, row: MissedRow): Promise<string[]> {
  if (!row.group_id) return [];
  const members = await service.from('group_members').select('user_id').eq('group_id', row.group_id).eq('invite_status', 'JOINED').neq('user_id', row.user_id);
  if (members.error) {
    console.error('[wake-check] 그룹 구성원 조회 실패', members.error.message);
    return [];
  }
  const candidates = ((members.data ?? []) as { user_id: string }[]).map((m) => m.user_id);
  const answers = await Promise.all(candidates.map((target) => service.rpc('can_send_push', { p_sender_id: row.user_id, p_target_id: target, p_kind: 'WAKE_MISSED' })));
  return candidates.filter((_, i) => !answers[i].error && answers[i].data === true);
}

// 그룹원에게 "미확인" 푸시. 보낸 수를 돌려줌 (D19 전에는 0)
export async function pushMissedToGroup(service: Db, row: MissedRow, enabled = PUSH_MISSED_TO_GROUP): Promise<number> {
  if (!enabled) return 0;
  const targets = await missedPushTargets(service, row);
  if (!targets.length) return 0;
  // TODO(D19): targets의 push_tokens 조회 + sendExpoPush (notify.ts runNotify와 같은 흐름), 보낸 수를 돌려줌. 문구는 D19 · D52 뒤
  return 0;
}

export type WakeCheckResult = { checked: number; recorded: number; pushed: number };

export async function runWakeCheck(service: Db, now: Date, options: { pushMissed?: boolean } = {}): Promise<WakeCheckResult> {
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
  for (const row of rows) if (fresh.has(row.event_key)) pushed += await pushMissedToGroup(service, row, options.pushMissed);

  return { checked: rows.length, recorded: fresh.size, pushed };
}
