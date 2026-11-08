// ② 차단 · 신고 실데이터 — block_user · unblock_user · my_blocks · submit_report (친구 4장)
//   차단 효과(친구 끊김 · 대기 요청 삭제 · 권한 삭제 · 양쪽 검색 숨김)는 서버가 함. 앱은 호출하고 상태를 문구로
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { parseDbTime } from '@/lib/dbTime';

import { personFromProfile, type ProfileRow } from '../map';
import { MESSAGE_GONE } from '../relationMessages';
import { REPORT_NOTE_MAX } from '../blockTexts';
import type { BlockedPerson, ReportReason, ReportResult, ReportTarget } from '../types';
import { invalidateSnapshot } from './load';

async function statusOf(name: 'block_user' | 'unblock_user' | 'submit_report', args: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase.rpc(name, args as never);
  if (error) throw error;
  const status = (data as { status?: string } | null)?.status;
  if (typeof status !== 'string') throw new Error(`${name} 응답에 status가 없어요`);
  return status;
}

const unknownStatus = (name: string, status: string) => new Error(`알 수 없는 ${name} 상태: ${status}`);

// 차단 — 친구 · 검색 결과 · 요청 보낸 사람 · 같은 그룹원 누구나 (4-30). 이미 차단한 사람도 성공
export async function blockUser(userId: string): Promise<void> {
  const status = await statusOf('block_user', { p_user_id: userId });
  invalidateSnapshot(); // 친구 · 받은 요청 · 같은 그룹 사람이 바뀜
  if (status === 'BLOCKED' || status === 'ALREADY_BLOCKED') return;
  if (status === 'SELF') throw new UserError('나는 차단할 수 없어요');
  if (status === 'NOT_FOUND') throw new UserError('사용자를 찾을 수 없어요');
  throw unknownStatus('block_user', status);
}

// 차단 풀기 — 내 행만. 친구는 복구 안 됨 (새 요청부터)
export async function unblockUser(userId: string): Promise<void> {
  const status = await statusOf('unblock_user', { p_user_id: userId });
  invalidateSnapshot();
  if (status === 'UNBLOCKED') return;
  if (status === 'GONE') throw new UserError(MESSAGE_GONE);
  throw unknownStatus('unblock_user', status);
}

// 설정 > 차단 목록 — 내가 차단한 사람만, 새로 차단한 순(서버 순서 그대로). 탈퇴한 사람은 서버가 뺌, 아이디를 바꿨으면 새 아이디
export async function listBlocks(): Promise<BlockedPerson[]> {
  const { data, error } = await supabase.rpc('my_blocks');
  if (error) throw error;
  return ((data ?? []) as (ProfileRow & { blocked_at: string })[]).map((row) => ({ person: personFromProfile(row), blockedAt: parseDbTime(row.blocked_at) }));
}

// 신고 넣기 — 같은 대상은 하루 1번(ALREADY_REPORTED). 신고한 사실은 상대에게도 신고한 나에게도 알림 없음. 한 줄 메모는 앞뒤 공백을 떼고 200자까지, 비면 보내지 않음
export async function submitReport(target: ReportTarget, reason: ReportReason, note?: string): Promise<ReportResult> {
  const trimmed = (note ?? '').trim().slice(0, REPORT_NOTE_MAX);
  const status = await statusOf('submit_report', { p_target_type: target.type, p_target_id: target.id, p_reason: reason, p_note: trimmed || null });
  if (status === 'REPORTED' || status === 'ALREADY_REPORTED') return status;
  if (status === 'INVALID') throw new UserError('신고 내용을 확인해 주세요');
  if (status === 'SELF') throw new UserError('나는 신고할 수 없어요');
  if (status === 'NOT_FOUND') throw new UserError('신고할 대상을 찾을 수 없어요');
  throw unknownStatus('submit_report', status);
}
