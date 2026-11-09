// ② 그룹원 기상 상태 실데이터 — G03 · G02 멤버 메뉴 기상 숨기기 (친구 7장, docs/screen-data-map.md G03)
//   get_group_wake — 그 그룹 약속이 있는 날만 줄을 주고(D57), 단계 · 알람 시각 · 확인 시각만 줌(7-37). 줄이 없는 멤버는 '공유 안 함'(동의 안 함 · 숨김 · 차단 구분 없음)
//   set_wake_hidden — 내 기상을 그 사람에게만 가림(내가 속한 모든 그룹), 상대는 모름 (7-더)
//   date = 기상 신호가 알려 준 날 (없으면 내 시간대의 오늘)
import { parseDbTime } from '@/lib/dbTime';
import { callEdge, EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

import { NO_APPOINTMENT_STATE, wakeStateOf } from '../map';
import { joinedIds, myGroup, personOf, receivedFrom } from '../snapshot';
import type { MemberWake, ReceivedWakePing, WakePingResult } from '../types';
import { WAKE_HIDE_FAILED } from '../wakeTexts';
import { loadSnapshot, loadWakeRows } from './load';

// 그 그룹의 다른 참여 멤버일 때만. 약속 있는 날 줄이 없으면 null(공유 안 함), 약속 없는 날은 noGroupAppointment
export async function getMemberWake(groupId: string, personId: string, date?: string | null): Promise<MemberWake | null> {
  const s = await loadSnapshot();
  const group = myGroup(s, groupId);
  if (!group || personId === s.me || !joinedIds(s, groupId).includes(personId)) return null;

  const rows = await loadWakeRows(groupId, date);
  const base = { person: personOf(s, personId), groupName: group.group_name, canViewAlarm: receivedFrom(s, personId).viewAlarm };
  if (!rows.length) return { ...base, state: NO_APPOINTMENT_STATE, alarmAt: null, confirmedAt: null, noGroupAppointment: true };
  const row = rows.find((r) => r.user_id === personId);
  if (!row) return null;
  return {
    ...base,
    state: wakeStateOf(row, true),
    alarmAt: row.wake_alarm_at ? parseDbTime(row.wake_alarm_at) : null,
    confirmedAt: row.wake_confirmed_at ? parseDbTime(row.wake_confirmed_at) : null,
    noGroupAppointment: false,
  };
}

// G02 멤버 메뉴 [이 사람에게 기상 숨기기 / 보이기]
export async function setWakeHidden(personId: string, hidden: boolean): Promise<void> {
  const { data, error } = await supabase.rpc('set_wake_hidden', { p_user_id: personId, p_hidden: hidden });
  if (error) throw error;
  const status = (data as { status?: unknown } | null)?.status;
  if (status === 'OK') return;
  if (status === 'NOT_FOUND') throw new UserError(WAKE_HIDE_FAILED); // 나 자신 · 관계가 끊긴 사람
  throw new Error(`set_wake_hidden: 모르는 상태 ${String(status)}`);
}

// 깨우기 알림 (G03) — notify(WAKE_PING). 판정 · 횟수(5분 1번 · 하루 3번) · 직전 재확인은 서버가 하고, 앱은 결과 상태만 받아 보여 줌
//   groupId = 어느 그룹 화면(G03)에서 눌렀는지 — 주면 그 그룹에서 보이는 사람일 때만 됨
//   기상이 안 보이는 사람(같은 그룹 아님 · 동의 안 함 · 오늘 약속 없음 · 숨김 · 차단)은 서버가 구분 없이 403 → 꺼짐과 같은 말(8-11 · 8-12 · 8-35)
export async function sendWakePing(groupId: string, personId: string): Promise<WakePingResult> {
  let res: NotifyPingResponse;
  try {
    res = await callEdge<NotifyPingResponse>('notify', { kind: 'WAKE_PING', targetUserId: personId, groupId }, { timeoutMs: PING_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof EdgeError && e.code === 'FORBIDDEN') return { status: 'OFF' };
    throw e;
  }
  return pingResultOf(res);
}

type NotifyPingResponse = { sent?: number; failed?: number; reason?: string; ping?: { status?: string; count?: number; limit?: number; next_at?: string | null } };
const PING_TIMEOUT_MS = 10_000;

export function pingResultOf(res: NotifyPingResponse | null | undefined): WakePingResult {
  const ping = res?.ping;
  const at = (value: string | null | undefined) => (value ? parseDbTime(value) : null);
  switch (ping?.status) {
    case 'OK':
      return { status: 'OK', count: ping.count ?? 1, limit: ping.limit ?? 3, nextAt: at(ping.next_at) };
    case 'WAIT':
      return { status: 'WAIT', nextAt: at(ping.next_at) };
    case 'DAILY_LIMIT':
    case 'NOT_RINGING':
    case 'ALREADY_UP':
    case 'OFF':
    case 'NO_TOKENS':
      return { status: ping.status };
    default:
      throw new Error(`notify WAKE_PING: 모르는 상태 ${String(ping?.status)}`);
  }
}

// 오늘 내가 받은 깨우기 — 홈 · H08 한 줄. 차단한 사람 것은 서버가 뺌
export async function getReceivedWakePings(): Promise<ReceivedWakePing[]> {
  const { data, error } = await supabase.rpc('my_wake_pings');
  if (error) throw error;
  return (data ?? []).map((r) => ({ senderId: r.sender_id, senderName: r.sender_nickname, at: parseDbTime(r.sent_at) }));
}
