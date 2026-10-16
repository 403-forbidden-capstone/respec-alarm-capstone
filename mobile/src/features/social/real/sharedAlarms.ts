// ② 공유받은 알람 실데이터 — G04 (docs/screen-data-map.md G04)
//   읽기: get_shared_alarm_appointments(p_owner_id) — 조회 권한을 받은 사람 알람의 약속 제목 · 장소 · 시각 (appointments RLS는 본인 · 그룹원만이라 함수가 대신 줌)
//         + alarms(RLS가 조회 권한을 확인). 함수는 지난 알람 · 꺼진 알람도 주므로 앱에서 거름: 약속 시각이 지난 카드는 빼고 꺼진 알람은 다시 켤 수 있게 남김 (작성자 판단)
//   쓰기: 켜기 · 끄기 · ±5분은 상대 알람을 DB에 직접 (설정 권한 EDIT_ALARM이면 RLS가 허용). 카드 하나(약속의 기상 · 준비 · 출발)가 한 번에 움직임
//         ±5분은 시각을 사용자가 직접 정한 것이라 time_source = MANUAL로 같이 씀 — 안 그러면 주인이 그 약속을 다시 저장할 때 alarm-commit이 자동 시각으로 덮음
//   바꾼 뒤 주인에게 notify(ALARM_CHANGED). 푸시가 실패해도 저장은 되돌리지 않고 화면은 조용히 "바꿨어요"만 (푸시 토큰 등록은 Q12 — 붙이기 전엔 대부분 안 감)
//   주인 폰의 예약은 주인 앱이 푸시를 받거나 다시 켜질 때 맞춤(lib/alarmSync reconcile) — 내 폰에서 걸지 않음
//   변경 기록(getShareLog)은 DB에 저장 자리가 없음(D9 · 스키마 보완 3): 이번에 앱을 연 동안 내가 바꾼 것만 메모리에 둠 (D20 열림 — 가짜 데이터와 같은 뜻)
import { now } from '@/lib/clock';
import { callEdge } from '@/lib/edge';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { groupSharedCards, shareTags, toMemberAlarm, upcomingCards, type SharedAlarmRow, type SharedApptRow, type SharedCard } from '../map';
import { personOf, profileOf, receivedFrom, receivedRows, type Snapshot } from '../snapshot';
import type { ShareLogItem, SharedAlarms, SharedChangeResult } from '../types';
import { loadSnapshot } from './load';

const ALARM_COLUMNS = 'alarm_id, alarm_type, scheduled_at, intensity, sound_key, is_enabled, time_source';

// 그 사람의 공유받은 알람 전부 (카드 묶음 전, 지난 것 포함). 권한이 없으면 함수가 빈 목록
async function loadCards(ownerId: string): Promise<SharedCard[]> {
  const { data, error } = await supabase.rpc('get_shared_alarm_appointments', { p_owner_id: ownerId });
  if (error) throw error;
  const appointments: SharedApptRow[] = data ?? [];
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
  return {
    person: personOf(s, personId),
    canView,
    canEdit: canView && received.editAlarm, // 조회가 안 되면 고칠 알람도 안 보임 (docs/screen-data-map.md F03)
    tags: shareTags(receivedRows(s, personId)),
    alarms: cards.map(toMemberAlarm),
  };
}

// 변경 기록 — 이번 실행 동안만, 계정이 바뀌면 비움
let log: { me: string; items: ShareLogItem[] } = { me: '', items: [] };
function remember(me: string, text: string) {
  if (log.me !== me) log = { me, items: [] };
  log.items.push({ at: now(), text });
}

export async function getShareLog(): Promise<ShareLogItem[]> {
  const me = await requireUserId();
  return log.me === me ? log.items.map((l) => ({ ...l })) : [];
}

// 카드(= 약속) 하나의 알람 — 지금 읽은 값. 이미 지워졌거나 권한이 없어졌으면 UserError
async function loadCard(ownerId: string, cardId: string): Promise<SharedCard> {
  const card = (await loadCards(ownerId)).find((c) => c.appointmentId === cardId);
  if (!card) throw new UserError('알람을 찾을 수 없어요. 이미 바뀌었거나 공유가 끝났을 수 있어요');
  return card;
}

const NO_EDIT = '이 알람을 바꿀 권한이 없어요';
const NOTIFY_TIMEOUT_MS = 8_000; // 알림은 덤이라 오래 기다리지 않음 (저장은 이미 끝남)

// 주인에게 알림 — 실패해도 던지지 않음. 보냈으면 true
async function notifyOwner(s: Snapshot, ownerId: string, card: SharedCard, what: string): Promise<boolean> {
  try {
    const result = await callEdge<{ sent?: number }>(
      'notify',
      {
        kind: 'ALARM_CHANGED',
        targetUserId: ownerId,
        alarmId: card.alarms[0].alarm_id,
        title: '공유한 알람이 바뀌었어요',
        body: `${profileOf(s, s.me)?.nickname ?? '친구'}님이 '${card.title}' 알람을 ${what}`,
      },
      { timeoutMs: NOTIFY_TIMEOUT_MS },
    );
    return (result?.sent ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function setSharedAlarmEnabled(personId: string, cardId: string, enabled: boolean): Promise<SharedChangeResult> {
  const s = await loadSnapshot();
  const card = await loadCard(personId, cardId);
  const { data, error } = await supabase
    .from('alarms')
    .update({ is_enabled: enabled })
    .in('alarm_id', card.alarms.map((a) => a.alarm_id))
    .select('alarm_id');
  if (error) throw error;
  if ((data?.length ?? 0) !== card.alarms.length) throw new UserError(NO_EDIT); // RLS는 권한이 없으면 오류 없이 0행을 바꿈
  remember(s.me, `${personOf(s, personId).short}님 알람 ${enabled ? '켬' : '끔'}`);
  return { notified: await notifyOwner(s, personId, card, enabled ? '켰어요' : '껐어요') };
}

// 공유받은 알람 시각 옮기기 — minutes가 음수면 앞당김. 카드의 알람이 같이 움직임 (기상 · 준비 · 출발 간격 그대로)
//   D35(옮길 수 있는 범위) · D52(누를 때마다 알림) 열림: 가짜 데이터와 같게 범위 제한 없이 누를 때마다 저장하고 알림
export async function shiftSharedAlarm(personId: string, cardId: string, minutes: number): Promise<SharedChangeResult> {
  const s = await loadSnapshot();
  const card = await loadCard(personId, cardId);
  const done: SharedAlarmRow[] = [];
  try {
    for (const alarm of card.alarms) {
      const moved = new Date(new Date(alarm.scheduled_at).getTime() + minutes * 60_000).toISOString();
      const { data, error } = await supabase
        .from('alarms')
        .update({ scheduled_at: moved, time_source: 'MANUAL' })
        .eq('alarm_id', alarm.alarm_id)
        .select('alarm_id');
      if (error) throw error;
      if (!data?.length) throw new UserError(NO_EDIT);
      done.push(alarm);
    }
  } catch (e) {
    // 일부만 옮겨졌으면 되돌려서 기상 · 준비 · 출발 간격이 어긋나지 않게 (되돌리기도 실패하면 어쩔 수 없음)
    for (const alarm of done) {
      await supabase.from('alarms').update({ scheduled_at: alarm.scheduled_at, time_source: alarm.time_source }).eq('alarm_id', alarm.alarm_id);
    }
    throw e;
  }
  remember(s.me, `${personOf(s, personId).short}님 알람 ${Math.abs(minutes)}분 ${minutes < 0 ? '앞당김' : '늦춤'}`);
  return { notified: await notifyOwner(s, personId, card, `${Math.abs(minutes)}분 ${minutes < 0 ? '앞당겼어요' : '늦췄어요'}`) };
}
