// 받은 알람 제안 (친구 10장) — 홈 제안 카드 '수연 제안 기상 알람 7:30 → 7:00 [적용] [무시]'
//   my_alarm_proposals = 내가 받은 대기 중 제안(알람 시각 전만, 차단한 사람 것은 서버가 뺌, 늦게 보낸 순)
//   respond_alarm_proposal = [적용] 알람 카드(기상 · 준비 · 출발)가 같은 만큼 움직임 · [무시] 보낸 친구에게는 알리지 않음 · 알람 시각이 지났거나 내가 그사이 직접 고쳤으면 EXPIRED
//   적용하면 서버 DB만 바뀐 것 — 폰 예약은 앱이 서버 알람으로 다시 맞춰야 함(lib/alarmSync syncNow)
import { parseDbTime } from '@/lib/dbTime';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

import { KIND_LABEL, type AlarmKind } from '@/features/alarm/types';

import { PROPOSAL_GONE, PROPOSAL_LIMIT } from '../proposalTexts';
import type { AlarmProposal, ProposalResponse } from '../types';

export async function listAlarmProposals(): Promise<AlarmProposal[]> {
  const { data, error } = await supabase.rpc('my_alarm_proposals');
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.proposal_id,
    proposerName: r.proposer_nickname,
    kindLabel: KIND_LABEL[r.alarm_type as AlarmKind] ?? '알람',
    fromAt: parseDbTime(r.from_at),
    toAt: parseDbTime(r.to_at),
  }));
}

export async function respondAlarmProposal(proposalId: string, apply: boolean): Promise<ProposalResponse> {
  const { data, error } = await supabase.rpc('respond_alarm_proposal', { p_proposal_id: proposalId, p_apply: apply });
  if (error) throw error;
  const status = (data as { status?: unknown } | null)?.status;
  if (status === 'APPLIED') {
    // 서버가 바꾼 알람을 폰에 다시 검 — 못 걸어도 적용은 그대로(다음에 앱이 켜질 때 맞춤). 알람 동기화 모듈은 이때만 읽음(다른 시험이 시계를 가짜로 둘 때 딸려 오지 않게)
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 적용할 때만 읽음
    const { syncNow } = require('@/lib/alarmSync') as typeof import('@/lib/alarmSync');
    await syncNow().catch(() => {});
    return 'APPLIED';
  }
  if (status === 'DISMISSED') return 'DISMISSED';
  if (status === 'EXPIRED') return 'EXPIRED';
  if (status === 'LIMIT') throw new UserError(PROPOSAL_LIMIT);
  if (status === 'NOT_FOUND') throw new UserError(PROPOSAL_GONE);
  throw new Error(`respond_alarm_proposal: 모르는 상태 ${String(status)}`);
}
