// ② 그룹원 기상 상태 실데이터 — G03 (docs/screen-data-map.md G03)
//   get_group_wake_status — 그 그룹 약속이 있는 날만 행을 주고(D57), 기상 관련 값만 줌(D59: 준비 · 출발 · 도착은 실데이터에서 뺌)
//   date = 기상 신호가 알려 준 날 (없으면 내 시간대의 오늘)
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

import { appointmentLabel, wakeAlarmCard, wakeTimeline } from '../map';
import { joinedIds, myGroup, personOf, receivedFrom } from '../snapshot';
import type { MemberWake } from '../types';
import { loadSnapshot, loadWakeRows } from './load';

const DAY_MS = 24 * 60 * 60 * 1000;

// 그 그룹의 구성원이고 나에게 기상 상태 조회를 허용했을 때만 (함수와 같게), 아니면 null
// 허용은 했는데 오늘 알람이 없으면 alarm: null — 권한이 없다는 말과 구분. 그 그룹 약속이 없는 날이면 noGroupAppointment
export async function getMemberWake(groupId: string, personId: string, date?: string | null): Promise<MemberWake | null> {
  const s = await loadSnapshot();
  const group = myGroup(s, groupId);
  if (!group || personId === s.me || !joinedIds(s, groupId).includes(personId) || !receivedFrom(s, personId).viewWake) return null;

  const rows = await loadWakeRows(groupId, date);
  const row = rows.find((r) => r.user_id === personId);
  const base = { person: personOf(s, personId), groupName: group.group_name, noGroupAppointment: rows.length === 0 };
  if (!row) return { ...base, alarm: null, timeline: [], firstAlarmAt: null };

  const wakeAt = row.wake_alarm_at ? new Date(row.wake_alarm_at) : null;
  const label = wakeAt ? await groupAppointmentLabel(groupId, wakeAt) : '';
  return {
    ...base,
    alarm: wakeAlarmCard(row, label),
    timeline: wakeTimeline(row),
    firstAlarmAt: wakeAt,
  };
}

// 기상 알람 뒤 하루 안에 있는 이 그룹의 첫 약속 — 알람 카드 아래 줄 (없으면 빈 글자)
async function groupAppointmentLabel(groupId: string, wakeAt: Date): Promise<string> {
  const { data, error } = await supabase
    .from('appointments')
    .select('title, dest_name, appointment_at')
    .eq('group_id', groupId)
    .gte('appointment_at', wakeAt.toISOString())
    .lt('appointment_at', new Date(wakeAt.getTime() + DAY_MS).toISOString())
    .order('appointment_at')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? appointmentLabel(data.title, data.dest_name, new Date(data.appointment_at)) : '';
}

// 깨우기 알림 (G03) — D19 열림: 서버 can_send_push가 WAKE_PING을 늘 거절하므로 실데이터에서는 보내지 않음 (D51 간격 제한도 그 뒤)
export async function sendWakePing(_personId: string): Promise<void> {
  throw new UserError('깨우기는 준비 중이에요');
}
