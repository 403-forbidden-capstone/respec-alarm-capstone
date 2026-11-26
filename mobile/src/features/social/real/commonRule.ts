import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { PermissionSet } from '../types';
import { invalidateSnapshot } from './load';

export type CommonRule = PermissionSet & { ruleVersion: string; accepted: boolean; acceptedCount: number; memberCount: number };
export async function readCommonRule(target: { p_group_id?: string; p_code?: string }): Promise<CommonRule> {
  const { data, error } = await supabase.rpc('get_common_group_rule', target);
  if (error) throw error;
  const r = data as { status?: string; version?: string; viewAlarm?: boolean; editAlarm?: boolean; viewWake?: boolean; viewTrip?: boolean; accepted?: boolean; acceptedCount?: number; memberCount?: number } | null;
  if (r?.status !== 'OK' || !r.version) throw new UserError('그룹 공유 규칙을 불러오지 못했어요. 다시 확인해 주세요.');
  return { ruleVersion: r.version, viewAlarm: !!r.viewAlarm, editAlarm: !!r.editAlarm, viewWake: !!r.viewWake, viewTrip: !!r.viewTrip, accepted: !!r.accepted, acceptedCount: r.acceptedCount ?? 0, memberCount: r.memberCount ?? 0 };
}
export async function writeCommonRule(groupId: string, next: PermissionSet) {
  if (!next.ruleVersion) throw new UserError('그룹 규칙을 다시 불러와 주세요.');
  const { data, error } = await supabase.rpc('save_common_group_rule', { p_group_id: groupId, p_version: next.ruleVersion, p_view_alarm: next.viewAlarm || next.editAlarm, p_edit_alarm: next.editAlarm, p_view_wake: next.viewWake, p_view_trip: next.viewWake && !!next.viewTrip });
  invalidateSnapshot();
  if (error) throw error;
  const status = (data as { status?: string } | null)?.status;
  if (status !== 'OK') throw new UserError(status === 'RULE_CHANGED' ? '다른 멤버가 규칙을 바꿨어요. 다시 확인해 주세요.' : '그룹 공유 규칙을 저장하지 못했어요.');
}
export async function withdrawCommonRule(groupId: string) {
  const { data, error } = await supabase.rpc('withdraw_common_group_rule', { p_group_id: groupId });
  invalidateSnapshot();
  if (error) throw error;
  if ((data as { status?: string } | null)?.status !== 'OK') throw new UserError('공유 동의를 철회하지 못했어요.');
}
export async function readFriendWake(userId: string): Promise<string> {
  const { data, error } = await supabase.rpc('get_friend_wake', { p_user_id: userId });
  if (error) throw error;
  const status = (data as { status?: string } | null)?.status;
  return status === 'CONFIRMED' ? '기상 완료' : status === 'UNCONFIRMED' ? '기상 미확인' : '기상 공유 안 함';
}
