// notify — 다른 사람 폰에 푸시 (screen-data-map: G03 깨우기 · G04 알람 바뀜 · 미확인 알림)
//   입력: { kind, targetUserId, alarmId?, title, body, data? }
//   처리: ① 부른 사람 확인 ② can_send_push(부른 사람, 받는 사람, kind) — 서버 권한 판정(DB 함수, service_role 전용)
//        ③ push_tokens 조회 ④ Expo Push로 보냄 (EXPO_ACCESS_TOKEN은 선택) ⑤ 만료된 토큰 지움
//   응답: { sent, failed, reason? } — 토큰이 없거나 푸시 설정(FCM 키)이 아직 없으면 오류가 아니라 { sent: 0, reason }
//   종류별 권한 (can_send_push, supabase/README.md):
//     ALARM_CHANGED — G04. 부른 사람이 받는 사람의 알람에 설정 권한(EDIT_ALARM)이 있을 때만 (D9: 변경 기록은 저장하지 않고 푸시만)
//     WAKE_PING     — G03 깨우기. D19(기상 공유 동의 조건) · D51(간격 제한)이 정해질 때까지 DB 함수가 늘 거절 → 403
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { dbFail, must } from '../_shared/db.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { sendExpoPush } from '../_shared/push.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

const KINDS = ['ALARM_CHANGED', 'WAKE_PING'] as const;

const DENIED: Record<(typeof KINDS)[number], string> = {
  ALARM_CHANGED: '이 사람의 알람을 바꿀 권한이 없어서 알림을 보낼 수 없어요',
  WAKE_PING: '깨우기 알림은 아직 보낼 수 없어요',
};

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const kind = root.oneOf('kind', KINDS, { required: true });
    const targetUserId = root.uuid('targetUserId', { required: true });
    const alarmId = root.uuid('alarmId');
    const title = root.string('title', { required: true, min: 1, max: 100 });
    const body = root.string('body', { required: true, min: 1, max: 200 });
    const data = root.object('data');
    const dataValue = data ? data.value : undefined;
    if (dataValue && JSON.stringify(dataValue).length > 2_000) root.problemAt('data', '2000자 이하여야 해요');
    root.finish();
    if (!kind || !targetUserId || !title || !body) throw new HttpError('VALIDATION_FAILED', '입력값을 확인해 주세요');

    const service = createServiceClient();

    // 권한 판정은 DB 함수 한 군데 (종류별 조건이 늘어도 여기는 안 바뀜)
    const allowed = await service.rpc('can_send_push', { p_sender_id: user.userId, p_target_id: targetUserId, p_kind: kind });
    if (allowed.error) dbFail('can_send_push', allowed.error);
    if (allowed.data !== true) throw new HttpError('FORBIDDEN', DENIED[kind]);

    // 알람 id를 같이 받은 경우, 받는 사람의 알람이 맞는지 (남의 알람 id로 알림 내용을 꾸미지 못하게)
    if (alarmId) {
      const alarm = must<{ alarm_id: string } | null>(
        'alarm lookup',
        await service.from('alarms').select('alarm_id').eq('alarm_id', alarmId).eq('user_id', targetUserId).maybeSingle(),
      );
      if (!alarm) throw new HttpError('NOT_FOUND', '받는 사람의 알람을 찾을 수 없어요');
    }

    const rows = must<{ token: string }[]>('push_tokens', await service.from('push_tokens').select('token').eq('user_id', targetUserId));
    if (!rows.length) return jsonResponse({ sent: 0, failed: 0, reason: 'NO_TOKENS' });

    const result = await sendExpoPush(
      rows.map((r) => r.token),
      { title, body, data: { ...(dataValue ?? {}), kind, ...(alarmId ? { alarmId } : {}) } },
      { accessToken: getEnv('EXPO_ACCESS_TOKEN') },
    );

    // 앱을 지웠거나 토큰이 바뀌어 못 받는 토큰은 지움 (8장 8.2.3)
    if (result.invalidTokens.length) {
      const del = await service.from('push_tokens').delete().in('token', result.invalidTokens);
      if (del.error) console.error('[notify] 만료 토큰 삭제 실패', del.error.message);
    }

    return jsonResponse({ sent: result.sent, failed: result.failed, ...(result.reason ? { reason: result.reason } : {}) });
  }),
);
