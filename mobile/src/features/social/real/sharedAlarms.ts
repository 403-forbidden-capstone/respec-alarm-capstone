// ② 공유받은 알람 실데이터 — G04 (docs/screen-data-map.md G04)
//   읽기: get_shared_alarm_appointments(p_owner_id) — 조회 권한을 받은 사람 알람의 약속 제목 · 장소 · 시각 (appointments RLS는 본인 · 그룹원만이라 함수가 대신 줌)
//         + alarms(RLS가 조회 권한을 확인). 함수는 지난 알람 · 꺼진 알람도 주므로 앱에서 거름: 약속 시각이 지난 카드는 빼고 꺼진 알람은 다시 켤 수 있게 남김 (작성자 판단)
//         함수 결과는 날짜 조건이 없어 쌓일수록 길어지므로, 알람을 읽기 전에 오늘 0시 이후 약속만 남겨 .in() 목록(주소 길이)이 이력만큼 커지지 않게 함
//   쓰기(친구 10장): 바꿀 수 있는 것은 시각뿐 — 켜기 · 끄기 · 삭제는 없음(내 알람은 늘 울림). 친구가 시각을 골라 [보내기]하면 propose_alarm_time으로 제안 한 줄이 생기고
//         상대 알람은 그대로, 상대에게 제안 알림(notify ALARM_CHANGED). 상대가 [적용]해야 바뀜 — 곧 울릴 알람 · 원래 시각 기준 ±60분 · 같은 시각은 서버가 상태로 거절
//         '제안함' · '반영됨'은 sent_alarm_proposals, [원래대로]는 alarms.original_scheduled_at 시각을 제안(친구가 바꾼 적이 있을 때만)
//         주인 폰의 예약은 주인이 [적용]할 때 주인 앱이 다시 걸음 (lib/alarmSync) — 내 폰에서 걸지 않음
//   변경 기록은 없음 — DB에 저장 자리가 없고 시트도 뺌 (친구 논리설계 10장 · D9 · D20)
import { now } from '@/lib/clock';
import { dbTimeMs, parseDbTime } from '@/lib/dbTime';
import { UserError } from '@/lib/errors';
import { startOfDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';

import { groupSharedCards, shareTags, toMemberAlarm, upcomingCards, type SharedAlarmRow, type SharedApptRow, type SharedCard } from '../map';
import { personOf, profileOf, receivedFrom, receivedRows, type Snapshot } from '../snapshot';
import {
  PROPOSE_FORBIDDEN,
  PROPOSE_INVALID,
  PROPOSE_LIMIT,
  PROPOSE_SAME,
  PROPOSE_TOO_LATE,
  PROPOSE_TOO_SOON,
} from '../proposalTexts';
import type { SentProposal, SharedAlarms, SharedChangeResult } from '../types';
import { loadSnapshot } from './load';
import { sendPush } from './push';

const ALARM_COLUMNS = 'alarm_id, alarm_type, scheduled_at, intensity, sound_key, is_enabled, time_source, original_scheduled_at';

// 그 사람의 공유받은 알람 전부 (카드 묶음 전, 지난 것 포함). 권한이 없으면 함수가 빈 목록
async function loadCards(ownerId: string): Promise<SharedCard[]> {
  const { data, error } = await supabase.rpc('get_shared_alarm_appointments', { p_owner_id: ownerId });
  if (error) throw error;
  // 오늘 0시(한국) 이후 약속만 — 화면은 약속 시각이 안 지난 카드만 보이므로(upcomingCards) 그 앞의 이력은 읽을 필요가 없음
  const todayStart = startOfDay(now()).getTime();
  const appointments: SharedApptRow[] = (data ?? []).filter((a) => dbTimeMs(a.appointment_at) >= todayStart);
  if (!appointments.length) return [];
  const alarms = await supabase
    .from('alarms')
    .select(ALARM_COLUMNS)
    .eq('user_id', ownerId)
    .in('alarm_id', appointments.map((a) => a.alarm_id));
  if (alarms.error) throw alarms.error;
  return groupSharedCards(appointments, alarms.data ?? []);
}

// 나와 아무 관계도 없는 사람이면 null (주소를 직접 연 경우) — 공개 프로필이 보이는 사람 = 친구 · 친구 요청 · 같은 그룹. 관계는 있는데 권한이 없으면 canView: false + 빈 알람
const isRelated = (s: Snapshot, personId: string) => personId !== s.me && profileOf(s, personId) != null;

export async function getSharedAlarms(personId: string): Promise<SharedAlarms | null> {
  const s = await loadSnapshot();
  if (!isRelated(s, personId)) return null;
  const received = receivedFrom(s, personId);
  const canView = received.viewAlarm;
  const cards = canView ? upcomingCards(await loadCards(personId), now().getTime()) : [];
  const sent = cards.length ? await loadSentProposals(personId) : new Map<string, SentProposal>();
  return {
    person: personOf(s, personId),
    canView,
    canEdit: canView && received.editAlarm, // 조회가 안 되면 고칠 알람도 안 보임 (docs/screen-data-map.md G04)
    tags: shareTags(receivedRows(s, personId)),
    alarms: cards.map((card) => {
      const alarm = toMemberAlarm(card, now().getTime());
      // 보낸 제안은 카드의 알람마다 따로 기록되므로 가장 이른 알람(제안을 보낸 알람) 것을 붙임
      return { ...alarm, proposal: (alarm.firstAlarmId && sent.get(alarm.firstAlarmId)) || null };
    }),
  };
}

// 내가 이 사람에게 보낸 제안 중 알람마다 가장 최근 것 — 못 읽어도 화면은 열림(제안 상태만 안 보임)
async function loadSentProposals(ownerId: string): Promise<Map<string, SentProposal>> {
  const { data, error } = await supabase.rpc('sent_alarm_proposals', { p_owner_id: ownerId });
  if (error) return new Map();
  const map = new Map<string, SentProposal>();
  for (const r of data ?? []) {
    if (r.status === 'PENDING' || r.status === 'APPLIED') map.set(r.alarm_id, { status: r.status, toAt: parseDbTime(r.to_at) });
  }
  return map;
}

// 카드(= 약속) 하나의 알람 — 지금 읽은 값. 이미 지워졌거나 권한이 없어졌으면 UserError
async function loadCard(ownerId: string, cardId: string): Promise<SharedCard> {
  const card = (await loadCards(ownerId)).find((c) => c.appointmentId === cardId);
  if (!card) throw new UserError('알람을 찾을 수 없어요. 이미 바뀌었거나 공유가 끝났을 수 있어요');
  return card;
}

// 주인에게 제안 알림 — 실패해도 던지지 않음. 보냈으면 true. 문구 · 시각 · 알람 종류는 서버가 제안 기록에서 가져옴(요청에는 받는 사람 · 알람 id만)
async function notifyOwner(ownerId: string, alarmId: string): Promise<boolean> {
  return sendPush({ kind: 'ALARM_CHANGED', targetUserId: ownerId, alarmId });
}

// 시각 제안 보내기 (G04 [보내기] · [원래대로]) — 화면이 본 알람(카드에서 켜져 있고 아직 안 울린 가장 이른 것)의 새 시각. 서버가 권한 · 곧 울릴 알람 · ±60분을 다시 확인
//   성공하면 상대에게 알림을 부르고(실패해도 제안은 그대로), 거절은 UserError로 이유를 알림
export async function proposeSharedAlarm(personId: string, alarmId: string, newAt: Date): Promise<SharedChangeResult> {
  const { data, error } = await supabase.rpc('propose_alarm_time', { p_alarm_id: alarmId, p_new_at: newAt.toISOString() });
  if (error) throw error;
  const status = (data as { status?: unknown } | null)?.status;
  if (status === 'TOO_SOON') throw new UserError(PROPOSE_TOO_SOON);
  if (status === 'TOO_LATE') throw new UserError(PROPOSE_TOO_LATE);
  if (status === 'LIMIT') throw new UserError(PROPOSE_LIMIT);
  if (status === 'SAME') throw new UserError(PROPOSE_SAME);
  if (status === 'FORBIDDEN') throw new UserError(PROPOSE_FORBIDDEN);
  if (status === 'INVALID') throw new UserError(PROPOSE_INVALID);
  if (status !== 'OK') throw new Error(`propose_alarm_time: 모르는 상태 ${String(status)}`);
  return { notified: await notifyOwner(personId, alarmId) };
}
