// ① 약속 기반 알람 — 실데이터 오늘 첫 일정 (기상 후 아침 흐름, 이슈 #230)
//   H08 한 줄과 홈 아침 카드가 읽음. 하루 약속은 홈 하루 일정(getDaySchedule)과 같은 읽기(realRows loadDayRows)를 같이 써서 동시에 불러도 쿼리는 한 번
//   · 오늘 첫 일정 고르기 · 칸 만들기는 morning.ts(순수 함수), 행 → 약속 한 줄은 map.ts toMorningSource
//   · 기상 확인 여부 = 그 기상 알람의 alarm_events WAKE_CONFIRMED (확정의 표지 — realWake.ts), 출발 기록 = appointment_participants.departed_at
import { now } from '@/lib/clock';
import { parseDbTime } from '@/lib/dbTime';
import { addDays } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { toMorningSource } from './map';
import { morningDay, pickMorningSource, toMorningPlan, wakeAlarmOf } from './morning';
import { loadDayRows } from './realRows';
import type { MorningPlan } from './types';

// 그 기상 알람의 기상 확정 시각 — 없으면 아직 확인 전. 확정 기록은 알람마다 한 줄이지만 가장 이른 것을 씀
async function loadWakeConfirmedAt(userId: string, wakeAlarmId: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from('alarm_events')
    .select('event_at')
    .eq('user_id', userId)
    .eq('alarm_id', wakeAlarmId)
    .eq('event_type', 'WAKE_CONFIRMED')
    .order('event_at')
    .limit(1);
  if (error) throw error;
  return data?.[0] ? parseDbTime(data[0].event_at) : null;
}

// 오늘(저녁이면 내일) 첫 일정 — 켜진 기상 알람이 붙은 가장 이른 약속. 없으면 null
export async function getMorningPlan(): Promise<MorningPlan | null> {
  const userId = await requireUserId();
  const from = morningDay(now());
  const rows = await loadDayRows(userId, from.toISOString(), addDays(from, 1).toISOString());
  const source = pickMorningSource(rows.map(toMorningSource));
  const wake = source ? wakeAlarmOf(source) : undefined;
  if (!source || !wake) return null;
  return toMorningPlan(source, await loadWakeConfirmedAt(userId, wake.id));
}
