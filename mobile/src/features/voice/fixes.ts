// 대화로 고친 기록(정정)을 앱 함수로 반영 — voice-turn이 준 fixes 한 건씩 (설계 메모 2.2 · 5.1, L2 답 L2-2)
//   · 새 시각 "도착은 10시 20분이었어" = recordParticipantTimes(출처 MANUAL) — 위치 값만 덮고, 원탭 · 직접 값은 먼저 쓴 값이 유지돼 그대로 ("keep" = 못 바꿈)
//   · 부정 "그건 출발 아니야" = rejectDetection({participantId, kind, screen: 'A02'}) — L2 PR 6이 RejectScreen에 'A02'를 넣은 뒤 연결 (지금은 "아직 안 됨", 아래 denyDetection 한 곳만 바꾸면 됨)
//   · 고친 값 기록(user_edit_logs, 화면 A02)은 부르는 쪽(여기)이 한 줄 남김 — DB CHECK의 A02는 20261029141531 마이그레이션
//   · 기상 정정은 L1 정정 함수가 없어(L1 답 L1-3) 서버가 안 보내지만, 오면 "아직 안 됨"
// 서버에 돌려주는 error는 짧은 이유(T1이 "거절: … (이유)"로 읽음) — 사용자 화면에는 안 보임
import { readLocationTime, recordParticipantTimes } from '@/features/alarm/participantTimes';
import { settleCorrectedDetection } from '@/features/location/fix';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';
import { stableUuid } from '@/lib/uuid';

import type { FixResult } from './types';

export type Fix = {
  id: string; // 정정 번호 (x1)
  kind: string; // DEPART · ARRIVE (그 밖은 아직 안 됨)
  participantId: string;
  action: 'CORRECT' | 'DENY';
  to: Date | null; // CORRECT일 때 새 시각
};

const NOT_YET = '아직 안 됨';
const FIELD = { DEPART: 'departed_at', ARRIVE: 'arrived_at' } as const;
const ALARM = { DEPART: 'DEPARTURE', ARRIVE: 'ARRIVE' } as const;

// 부정(위치 값 지우기) — L2 PR 6(rejectDetection의 screen 'A02')이 main에 들어오면 이 함수만 rejectDetection 호출로 바꿈
async function denyDetection(): Promise<FixResult['ok']> {
  return false;
}

export async function applyFix(fix: Fix): Promise<FixResult> {
  const result = (ok: boolean, error: string | null = null): FixResult => ({ id: fix.id, ok, error });
  if (fix.kind !== 'DEPART' && fix.kind !== 'ARRIVE') return result(false, NOT_YET);
  const kind = fix.kind;

  if (fix.action === 'DENY') {
    return (await denyDetection()) ? result(true) : result(false, NOT_YET);
  }
  if (!fix.to || Number.isNaN(fix.to.getTime())) return result(false, '시각 모름');

  // 고치기 전의 위치 값 — 고친 값 기록의 자동 값. 위치 값이 아니면 null (원탭 · 직접 값은 어차피 안 바뀜)
  const before = await readLocationTime(fix.participantId, kind);
  const written = await recordParticipantTimes({ participantId: fix.participantId, ...(kind === 'DEPART' ? { departedAt: fix.to } : { arrivedAt: fix.to }), source: 'MANUAL' });
  const decision = kind === 'DEPART' ? written.departed : written.arrived;
  if (decision == null) return result(false, '대상 없음'); // 지워진 참여 조건
  if (decision === 'keep') return result(false, '이미 확인한 기록');
  // 알림창의 감지 안내 · 폰 판정 기억 · 폰 예약을 [아니에요]와 같은 정리로 맞춤 (G10) — 못 해도 정정은 그대로
  await settleCorrectedDetection({ participantId: fix.participantId, kind, serverAt: before?.at ?? null });

  if (before) {
    // 기록 실패가 정정을 되돌리지는 않음 — 시각은 이미 고쳐졌으니 성공으로 돌려줌
    try {
      const userId = await requireUserId();
      const { error } = await supabase.from('user_edit_logs').insert({
        edit_id: stableUuid('a02-fix', fix.participantId, kind, fix.to.getTime()),
        user_id: userId,
        appointment_id: before.appointmentId,
        alarm_id: before.alarmId,
        screen: 'A02',
        field: FIELD[kind],
        alarm_type: ALARM[kind],
        auto_value: new Date(before.at).toISOString(),
        edited_value: fix.to.toISOString(),
      });
      if (error && error.code !== '23505') throw error; // 23505 = 같은 정정을 다시 보낸 것
    } catch {
      // 조용히 넘어감
    }
  }
  return result(true);
}
