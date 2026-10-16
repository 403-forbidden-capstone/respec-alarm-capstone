// wake-check — 기상 미확인(MISSED) 기록 배치 (상세설계서 5장 5.7 · 7장 7.9.2). 서버 전용
//   pg_cron이 5분마다 pg_net으로 부름 (private.invoke_edge_function — 주소 · 키는 Vault, supabase/README.md "배치")
//   처리: find_missed_wake_alarms(DB 함수)가 "알람 시각 + 다시 울림 총 소요 + 미루기 누적 + 30분"이 지났는데 기상 확인이 없는 알람을 찾음
//        → alarm_events에 MISSED로 기록. client_event_id = event_key라서 겹쳐 돌거나 다시 돌아도 한 번만 들어감
//   푸시: 그룹에 알리는 미확인 푸시는 D19(기상 공유 동의 조건)가 정해질 때까지 안 보냄 — 기록만 남기고,
//        보내는 자리(아래 pushMissedToGroup)는 can_send_push를 거치게 만들어 둠 (지금은 DB 함수가 늘 거절)
//   verify_jwt = false (config.toml): 키 형식이 legacy JWT · sb_secret_ 둘 다일 수 있어 게이트웨이 대신 여기서 서비스 키를 직접 비교
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireServiceCall } from '../_shared/auth.ts';
import { dbFail } from '../_shared/db.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { createServiceClient, type Db } from '../_shared/supabase.ts';

// find_missed_wake_alarms 반환 행. appointment_id · group_id · appointment_at · participant_id는 약속 없는 알람이면 null (일정 없는 알람, D46)
type MissedRow = {
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

const LOOKBACK_HOURS = 24; // 오래된 알람이 한꺼번에 MISSED로 쏟아지지 않게 (DB 함수 기본값과 같음)

// 그룹원에게 "미확인" 푸시. D19 전에는 can_send_push가 거절하므로 0을 돌려줌
//   받을 사람 = 이 그룹에서 MISSED가 된 사람의 기상 조회 권한을 가진 그룹원. 보내는 사람은 MISSED가 된 사람(권한을 준 쪽)
//   D19 결정 뒤: DB 함수 can_send_push에 'WAKE_MISSED' 조건을 더하고, 여기서 notify와 같은 sendExpoPush를 부르면 됨
async function pushMissedToGroup(service: Db, row: MissedRow): Promise<number> {
  if (!row.group_id) return 0;
  const grantees = await service
    .from('sharing_permissions')
    .select('grantee_id')
    .eq('owner_id', row.user_id)
    .eq('source_type', 'GROUP')
    .eq('source_id', row.group_id)
    .eq('can_view_wake', true);
  if (grantees.error) {
    console.error('[wake-check] 그룹 권한 조회 실패', grantees.error.message);
    return 0;
  }
  const pushed = 0; // D19 뒤에 보낸 수를 더함
  for (const g of (grantees.data ?? []) as { grantee_id: string }[]) {
    const allowed = await service.rpc('can_send_push', { p_sender_id: row.user_id, p_target_id: g.grantee_id, p_kind: 'WAKE_MISSED' });
    if (allowed.error || allowed.data !== true) continue; // 지금은 항상 여기서 건너뜀 (D19)
    // TODO(D19): push_tokens 조회 + sendExpoPush 결과를 pushed에 더함 — notify/index.ts와 같은 흐름
  }
  return pushed;
}

Deno.serve(
  serve(async (req) => {
    requireServiceCall(req);
    const service = createServiceClient();
    const now = new Date();

    const found = await service.rpc('find_missed_wake_alarms', { p_now: now.toISOString(), p_lookback_hours: LOOKBACK_HOURS });
    if (found.error) dbFail('find_missed_wake_alarms', found.error);
    const rows = (found.data ?? []) as MissedRow[];
    if (!rows.length) return jsonResponse({ checked: 0, recorded: 0, pushed: 0 });

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
    for (const row of rows) if (fresh.has(row.event_key)) pushed += await pushMissedToGroup(service, row);

    return jsonResponse({ checked: rows.length, recorded: fresh.size, pushed });
  }),
);
