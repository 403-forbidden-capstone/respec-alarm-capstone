// DB 행 → 화면 타입(types.ts) 바꾸기 — 순수 함수만 (시험: __tests__/map.test.ts). 쿼리는 real/
// 그룹 기상 상태는 D59에 따라 기상까지만, 화면은 3단계(아직 · 울렸어요 · 일어남) — 준비 · 출발 · 도착은 실데이터에 없음 (친구 7장)
import { KIND_LABEL, LEVELS, type AlarmKind } from '@/features/alarm/types';
import { parseDbTime } from '@/lib/dbTime';
import { dateParts, formatTime, minutesBetween, startOfDay } from '@/lib/format';
import type { Enums } from '@/types/database';
import { levelOfIntensity, levelOfSoundKey } from '@shared/calc/intensity.ts';

import type { FriendLink, FriendRelation, HandleSearch, MemberAlarm, OpenedLink, Person, WakeState } from './types';

// ---------------------------------------------------------------------------
// 사람
// ---------------------------------------------------------------------------

// get_public_profiles · search_by_handle · search_related_by_name이 주는 공개 칸 (닉네임 · 사진 · 아이디)
export type ProfileRow = { user_id: string; nickname: string; handle: string | null; profile_image_url: string | null };

// 이름 첫 글자 (아바타)
export const initialOf = (text: string) => [...text.trim()][0] ?? '?';

// 실데이터엔 닉네임 하나뿐이라 name · short가 같음 (목업은 이름 이수연 / 짧은 이름 수연)
export function personFromProfile(p: ProfileRow): Person {
  return { id: p.user_id, name: p.nickname, short: p.nickname, initial: initialOf(p.nickname), handle: p.handle ? `@${p.handle}` : null };
}

// 공개 프로필을 못 읽는 사람 (관계가 끊긴 직후 등) — 가짜 api와 같은 글자
export const unknownPerson = (id: string): Person => ({ id, name: '알 수 없음', short: '?', initial: '?', handle: null });

// 2025년 3월부터 함께하는 중
export function sinceLabel(createdAt: string): string {
  const { year, month } = dateParts(parseDbTime(createdAt));
  return `${year}년 ${month}월부터 함께하는 중`;
}

// ---------------------------------------------------------------------------
// 그룹 기상 상태 (get_group_wake, 친구 7장)
// ---------------------------------------------------------------------------

// 함수가 주는 칸 — 단계 · 알람 시각 · 확인 시각만 (미루기 횟수 · 알람 끈 시각 · 울린 시각 · 미확인 시각은 서버가 안 줌, 7-37)
export type WakeRow = {
  user_id: string;
  is_me: boolean;
  wake_alarm_at: string | null; // 그날 첫 켜진 기상 알람 시각
  wake_confirmed_at: string | null;
  wake_status: string; // SCHEDULED · RINGING · DISMISSED · MISSED · CONFIRMED · NO_ALARM
};

// 서버 6단계 → 화면 3단계 + 알람 없음. 울림 · 해제 · 미확인은 '울렸어요'로 묶음 (7-아 · 7-바 · D61: 해제만 하면 '울렸어요')
//   모르는 값은 '울렸어요' — 일어남으로 잘못 보이지 않게
export function stageOf(status: string): 'SCHEDULED' | 'RANG' | 'WOKE' | 'NO_ALARM' {
  switch (status) {
    case 'SCHEDULED':
      return 'SCHEDULED';
    case 'CONFIRMED':
      return 'WOKE';
    case 'NO_ALARM':
      return 'NO_ALARM';
    default:
      return 'RANG';
  }
}

export const NO_APPOINTMENT_STATE: WakeState = { stage: 'NO_APPOINTMENT', text: '오늘은 그룹 약속이 없어요', dot: null, woke: false };
// 약속 있는 날 줄이 없는 멤버 — 동의 안 함 · 나를 숨김 · 차단을 구분하지 않음 (7-06 · 7-10)
export const NOT_SHARED_STATE: WakeState = { stage: 'NOT_SHARED', text: '공유 안 함', dot: null, woke: false };

const at = parseDbTime; // DB 시각 글자 (lib/dbTime)

// '오전 8:50 알람' — 알람 시각 한 줄 (앱 다른 화면처럼 오전 · 오후를 붙임, 11/9 결정표) (G02 아직 단계 · G03, 7-다)
export const alarmLine = (alarmAt: Date | null) => (alarmAt ? `${formatTime(alarmAt)} 알람` : null);

// 멤버 한 줄의 기상 상태 — 알람 기준 글자만, '취침 중' · 준비 · 출발 · 도착 없음 (7-라 · 7-42). 색 + 글자를 같이 (14-파)
//   dayHasRows = 함수가 그날 줄을 하나라도 줬는지 (나는 늘 나오니 비었으면 그 그룹 약속이 없는 날, D57)
export function wakeStateOf(row: WakeRow | undefined, dayHasRows: boolean): WakeState {
  if (!dayHasRows) return NO_APPOINTMENT_STATE;
  if (!row) return NOT_SHARED_STATE;
  const stage = stageOf(row.wake_status);
  switch (stage) {
    case 'WOKE':
      return { stage, text: row.wake_confirmed_at ? `일어났어요 ${formatTime(at(row.wake_confirmed_at))}` : '일어났어요', dot: 'ok', woke: true };
    case 'RANG':
      return { stage, text: '울렸어요', dot: 'mid', woke: false };
    case 'SCHEDULED':
      return { stage, text: alarmLine(row.wake_alarm_at ? at(row.wake_alarm_at) : null) ?? '알람 전', dot: 'zz', woke: false };
    default:
      return { stage, text: '알람 없음', dot: 'zz', woke: false };
  }
}

// 오늘 일어난 사람 수 — 약속 없는 날(줄 없음)은 null이라 G01이 그 줄을 숨김 (7-사 · 7-34)
export const wokeCountOf = (rows: readonly WakeRow[]): number | null =>
  rows.length ? rows.filter((r) => stageOf(r.wake_status) === 'WOKE').length : null;

// 팀 주간회의 · 세종대학교 · 오전 10:00
export const appointmentLabel = (title: string, place: string, when: Date) => `${title} · ${place} · ${formatTime(when)}`;

// ---------------------------------------------------------------------------
// G04 공유받은 알람 (get_shared_alarm_appointments + alarms)
// ---------------------------------------------------------------------------

// 약속 하나가 카드 하나 — 기상 · 준비 · 출발 알람을 묶음 (도착 목표는 울리는 알람이 아니라 카드에 안 넣음)
export const CHAIN_KINDS: readonly AlarmKind[] = ['WAKE', 'PREPARE', 'DEPARTURE'];

export type SharedApptRow = { alarm_id: string; appointment_id: string; title: string; dest_name: string; appointment_at: string };
export type SharedAlarmRow = {
  alarm_id: string;
  alarm_type: Enums<'alarm_type'>;
  scheduled_at: string;
  intensity: Enums<'alarm_intensity'>;
  sound_key: string | null;
  is_enabled: boolean;
  time_source: Enums<'alarm_value_source'>;
};

export type SharedCard = { appointmentId: string; title: string; place: string; appointmentAt: Date; alarms: SharedAlarmRow[] };

// 약속마다 기상 · 준비 · 출발 알람을 시각순으로 묶음. 순서는 약속 시각순(함수가 그렇게 줌), 알람이 하나도 안 읽히면 카드를 만들지 않음
export function groupSharedCards(appointments: readonly SharedApptRow[], alarms: readonly SharedAlarmRow[]): SharedCard[] {
  const byId = new Map(alarms.map((a) => [a.alarm_id, a]));
  const cards = new Map<string, SharedCard>();
  for (const row of appointments) {
    const alarm = byId.get(row.alarm_id);
    if (!alarm || !CHAIN_KINDS.includes(alarm.alarm_type as AlarmKind)) continue;
    const card = cards.get(row.appointment_id) ?? {
      appointmentId: row.appointment_id,
      title: row.title,
      place: row.dest_name,
      appointmentAt: at(row.appointment_at),
      alarms: [],
    };
    card.alarms.push(alarm);
    cards.set(row.appointment_id, card);
  }
  for (const card of cards.values()) card.alarms.sort((a, b) => at(a.scheduled_at).getTime() - at(b.scheduled_at).getTime());
  return [...cards.values()];
}

// 약속 시각이 지난 카드는 거름 (함수는 지난 알람도 줌 — 작성자 판단: 화면은 앞으로 올 알람만). 꺼진 알람은 다시 켤 수 있게 남김
export const upcomingCards = (cards: readonly SharedCard[], nowMs: number) => cards.filter((c) => c.appointmentAt.getTime() >= nowMs);

// 준비 · 출발부터 약속까지 — 이동 · 여유 값은 남의 참여 조건이라 못 읽고, 읽을 수 있는 알람 간격으로만 적음
function noteOf(card: SharedCard): string {
  const first = card.alarms[0];
  const departure = card.alarms.find((a) => a.alarm_type === 'DEPARTURE');
  if (!first || !departure || first === departure) return '';
  return `준비 ${minutesBetween(at(first.scheduled_at), at(departure.scheduled_at))}분 · 출발부터 약속까지 ${minutesBetween(at(departure.scheduled_at), card.appointmentAt)}분`;
}

export function toMemberAlarm(card: SharedCard): MemberAlarm {
  const first = card.alarms[0];
  // 강도 세 칸이 한 약속에서 같은 값이라 첫 알람의 배경음 칸으로 읽음 (features/alarm/map.ts와 같은 규칙)
  const level = levelOfSoundKey(first.sound_key) ?? levelOfIntensity(first.intensity) ?? 1;
  return {
    id: card.appointmentId,
    date: startOfDay(at(first.scheduled_at)),
    chain: card.alarms.map((a) => ({ at: at(a.scheduled_at), label: KIND_LABEL[a.alarm_type as AlarmKind] })),
    appointmentLabel: appointmentLabel(card.title, card.place, card.appointmentAt),
    levelName: LEVELS[level].name,
    note: noteOf(card),
    enabled: card.alarms.some((a) => a.is_enabled), // 카드 스위치 = 묶음 전체. 하나라도 켜져 있으면 켜짐
  };
}

// 권한 꼬리표 (조회 · 친구, 설정 · 캡스톤팀) — 설정은 조회가 있어야 실제로 고칠 수 있어 조회가 없으면 뺌
export function shareTags(rows: readonly { source: string; viewAlarm: boolean; editAlarm: boolean }[]): string[] {
  const canView = rows.some((r) => r.viewAlarm);
  const tags = rows.flatMap((r) => [...(r.viewAlarm ? [`조회 · ${r.source}`] : []), ...(r.editAlarm && canView ? [`설정 · ${r.source}`] : [])]);
  return [...new Set(tags)];
}

// ---------------------------------------------------------------------------
// 친구 2장 — 아이디 검색 · 이름 검색 · 친구 링크 응답 (search_by_handle · search_related_by_name · my_friend_link · open_friend_link)
// ---------------------------------------------------------------------------

// 서버의 관계 값 → 앱 값 (REQUEST_SENT · REQUEST_RECEIVED가 앱의 SENT · RECEIVED)
export function relationFromServer(value: unknown): FriendRelation {
  switch (value) {
    case 'NONE':
      return 'NONE';
    case 'REQUEST_SENT':
      return 'SENT';
    case 'REQUEST_RECEIVED':
      return 'RECEIVED';
    case 'FRIEND':
      return 'FRIEND';
    default:
      throw new Error(`알 수 없는 관계 값: ${String(value)}`);
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});

// search_by_handle 응답 → 화면 값. 모르는 상태는 던짐 — 못 찾은 것으로 잘못 보이지 않게
export function handleSearchFromRpc(data: unknown): HandleSearch {
  const r = obj(data);
  switch (r.status) {
    case 'FOUND':
      return { status: 'FOUND', person: personFromProfile(r.profile as ProfileRow), relation: relationFromServer(r.relation) };
    case 'SELF':
      return { status: 'SELF', person: personFromProfile(r.profile as ProfileRow) };
    case 'NOT_FOUND':
      return { status: 'NOT_FOUND' };
    case 'LIMIT':
      return { status: 'LIMIT', retryAfterSeconds: Math.max(1, Math.ceil(Number(r.retry_after_seconds) || 1)) };
    default:
      throw new Error(`알 수 없는 검색 상태: ${String(r.status)}`);
  }
}

// open_friend_link 응답 → 화면 값
export function openedLinkFromRpc(data: unknown): OpenedLink {
  const r = obj(data);
  switch (r.status) {
    case 'OK':
      return { status: 'OK', person: personFromProfile(r.profile as ProfileRow), relation: relationFromServer(r.relation) };
    case 'SELF':
      return { status: 'SELF', person: personFromProfile(r.profile as ProfileRow) };
    case 'EXPIRED':
      return { status: 'EXPIRED' };
    default:
      throw new Error(`알 수 없는 링크 상태: ${String(r.status)}`);
  }
}

// my_friend_link 응답 → 화면 값
export function friendLinkFromRpc(data: unknown): FriendLink {
  const r = obj(data);
  if (typeof r.token !== 'string' || typeof r.expires_at !== 'string') throw new Error('친구 링크 응답이 이상해요');
  return { token: r.token, expiresAt: parseDbTime(r.expires_at) };
}
