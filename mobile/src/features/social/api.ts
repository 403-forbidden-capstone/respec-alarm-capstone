// ② 알람 공유 · 기상 확인 — 데이터 접근은 이 파일에서만 합니다.
// 가짜 모드(웹 미리보기 · ?mode=mock)는 src/mocks의 가짜 데이터를 돌려주고, 실데이터 모드는 함수 맨 앞에서 ./real로 넘깁니다 (P6).
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (G01 · F02 · F03 · G02 · G03 · G04, 권한 합집합은 앱에서 합침 — grants.ts)
//   date = 그룹 기상 신호(lib/realtime)가 알려 준 날 (YYYY-MM-DD). 실데이터만 씀 — get_group_wake의 p_date, 없으면 내 시간대의 오늘
import { cleanHandle } from '@/features/onboarding/validate';
import { HANDLE_PATTERN } from '@/features/profile/types';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { dateParts } from '@/lib/format';
import { isMock } from '@/lib/mode';
import { mockWakeRow } from '@/mocks/calc';
import { db, kst, memberAlarms, people, timelines, type MockMemberAlarm, type MockPerson } from '@/mocks/data';

import { mergeGrants } from './grants';
import { NO_APPOINTMENT_STATE, wakeStateOf, wokeCountOf, type WakeRow } from './map';
import { CODE_EXPIRED, CODE_NOT_FOUND, GROUP_FULL, GROUP_NOT_MEMBER, GROUP_TOO_MANY, cleanCode, groupNameProblem } from './groupTexts';
import * as real from './real';
import { MESSAGE_GONE } from './relationMessages';
import { mergeHits } from './searchView';
import { WAKE_PING_MOCK } from './wakeTexts';
import {
  type AppointmentJoiner,
  type GroupAppointment,
  type CreatedGroup,
  type GroupCode,
  type GroupInvite,
  type GroupPreview,
  type InvitableFriend,
  type JoinedGroup,
  type FinalGrant,
  type FriendItem,
  type BlockedPerson,
  type FriendLink,
  type FriendRelation,
  type GrantRow,
  type GroupDetail,
  type GroupItem,
  type GroupSummary,
  type HandleSearch,
  type MemberAlarm,
  type MemberWake,
  type OpenedLink,
  type PeopleSearch,
  type PermissionSet,
  type Person,
  type PersonHit,
  type ReceivedWakePing,
  type ReportReason,
  type ReportResult,
  type ReportTarget,
  type Relation,
  type RelationId,
  type ShareLogItem,
  type SharedAlarms,
  type SharedChangeResult,
  type WakePingResult,
} from './types';

const toPerson = (p: MockPerson): Person => ({ ...p });
const person = (id: string): Person => toPerson(people[id] ?? { id, name: '알 수 없음', short: '?', initial: '?', handle: null });
const copy = (s: PermissionSet): PermissionSet => ({ viewAlarm: s.viewAlarm, editAlarm: s.editAlarm, viewWake: s.viewWake });
const none = (): PermissionSet => ({ viewAlarm: false, editAlarm: false, viewWake: false });

// 내가 이 사람에게 준 최종 권한 — 친구 관계 + 같이 있는 모든 그룹을 항목별로 합침
function givenTo(personId: string): FinalGrant {
  const rows: GrantRow[] = [];
  if (db.friends.includes(personId) && db.grants.friend[personId]) {
    rows.push({ source: '친구', sourceType: 'FRIEND', sourceId: personId, ...copy(db.grants.friend[personId]) });
  }
  for (const g of Object.values(db.groups)) {
    if (g.members.includes(personId)) {
      rows.push({ source: g.name, sourceType: 'GROUP', sourceId: g.id, ...copy(db.grants.group[g.id] ?? none()) });
    }
  }
  return mergeGrants(rows);
}

// 이 사람이 나에게 준 최종 권한
function receivedFrom(personId: string): FinalGrant {
  return mergeGrants((db.received[personId] ?? []).map((r) => ({ ...r })));
}

// 가짜 모드의 get_group_wake — 그 그룹 약속이 있을 때만(목업은 날짜 없이 연결 일정이 있으면), 나 + 시나리오가 있고 그 그룹에서 기상을 준 사람 − 차단
//   (목업에는 동의 칸이 없어 받은 그룹 권한의 기상을 동의로 봄)
function mockWakeRows(groupId: string): WakeRow[] {
  const g = db.groups[groupId];
  if (!g || !db.appointments.some((a) => a.groupId === groupId)) return [];
  const t = now();
  return g.members.flatMap((p) => {
    const consent = p === 'me' || (db.received[p] ?? []).some((r) => r.sourceType === 'GROUP' && r.sourceId === groupId && r.viewWake);
    const row = consent && !blocked.includes(p) ? mockWakeRow(p, t) : null;
    return row ? [row] : [];
  });
}
const mockStateOf = (rows: WakeRow[], personId: string) => wakeStateOf(rows.find((r) => r.user_id === personId), rows.length > 0);

// 새 UI용 가짜 상태 — 앱을 다시 열 때까지만 (mocks/data.ts는 안 고침)
const sentRequests = new Set<string>(); // 내가 친구 요청을 보낸 사람
const blocked: string[] = []; // 내가 차단한 사람 — 새로 차단한 순 (가짜 모드는 앱을 다시 열 때까지만)
const reported = new Set<string>(); // 오늘 신고한 대상 `종류:id` — 같은 대상은 하루 한 번
const wakeOptIns: Record<string, boolean> = {}; // 기상 공유 동의 — 목업 그룹은 이미 공유 중이라 기본 켬
const notifOff: Record<string, boolean> = {}; // 이 그룹 알림 끄기 — 기본 꺼짐(= 알림 받음)
const wakeHides = new Set<string>(); // 내가 기상을 숨긴 사람 (G02 멤버 메뉴)
const invitedFriends: Record<string, Set<string>> = {}; // 그룹별로 내가 초대한 친구 (G02 + 초대에서 '초대 중' 표시)
const groupCodes: Record<string, GroupCode> = {}; // 그룹 코드 + 만료일 (처음 열 때 정함, 새 코드를 누르면 바뀜)

// 초대 코드 — 헷갈리는 글자(0 O 1 I)를 뺀 글자표 8자 · 7일 (5장). 목업은 그룹 id에서 정해진 글자
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mockCode(seed: string, salt = 0) {
  let h = [...seed].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7 + salt);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CODE_CHARS[h >>> 27]; // 위쪽 5비트 — 아래쪽 비트는 시작값이 비슷하면 같아짐
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
  }
  return out;
}
const sevenDays = () => new Date(now().getTime() + 7 * 24 * 3600 * 1000);
function codeOf(groupId: string): GroupCode {
  return (groupCodes[groupId] ??= { code: mockCode(groupId), expiresAt: sevenDays() });
}

// 아직 안 들어간 그룹 — 코드 입력 · 받은 초대 시험용. 'READ' · 'RUN'은 받은 초대 카드도 있음, 'FULLFULL'은 가득 찬 그룹, 'OLDCODE2'는 만료된 코드
type OutsideGroup = { id: string; name: string; initial: string; memberIds: string[]; count?: number; code: string; expired?: boolean; invitedBy?: string };
const outsideGroups: OutsideGroup[] = [
  { id: 'read', name: '독서 모임', initial: '독', memberIds: ['sy', 'jh', 'js'], code: 'READ2345', invitedBy: 'sy' },
  { id: 'run', name: '아침 러닝', initial: '러', memberIds: ['jh'], code: 'RUNNING2', invitedBy: 'jh' },
  { id: 'full', name: '가득 찬 모임', initial: '가', memberIds: ['sy'], count: 20, code: 'FULLFULL' },
  { id: 'old', name: '옛 모임', initial: '옛', memberIds: ['jh'], code: 'OLDCODE2', expired: true },
];
const declinedInvites = new Set<string>();
const joinedOutside = new Set<string>();
const hasInvite = (o: OutsideGroup) => !!o.invitedBy && !declinedInvites.has(o.id) && !joinedOutside.has(o.id);
const outsideByCode = (code: string) => outsideGroups.find((o) => o.code === code && !joinedOutside.has(o.id));

// 밖에 있던 그룹에 내가 들어옴 — 가짜 데이터 그룹으로 옮김
function enterOutside(o: OutsideGroup, wakeShare: boolean): JoinedGroup {
  const { year, month } = dateParts(now());
  db.groups[o.id] = { id: o.id, name: o.name, initial: o.initial, members: ['me', ...o.memberIds], since: `${year}년 ${month}월부터 함께하는 중` };
  db.grants.group[o.id] = none();
  wakeOptIns[o.id] = wakeShare;
  groupCodes[o.id] = { code: o.code, expiresAt: sevenDays() }; // 입력한 코드 그대로 이 그룹의 코드가 됨
  joinedOutside.add(o.id);
  return { id: o.id, already: false };
}

function toMemberAlarm(a: MockMemberAlarm): MemberAlarm {
  const shared = db.sharedAlarms[a.id] ?? { on: true, shift: 0 };
  return {
    id: a.id,
    date: kst(a.day, 0),
    chain: a.chain.map(([m, label]) => ({ at: kst(a.day, m + shared.shift), label })),
    appointmentLabel: a.appointmentLabel,
    levelName: a.levelName,
    note: a.note,
    enabled: shared.on,
  };
}

// 친구 목록 (G01 친구)
export async function listFriends(): Promise<FriendItem[]> {
  if (!isMock()) return real.listFriends();
  return db.friends.map((id) => ({ person: person(id), grantCount: givenTo(id).count }));
}

// 받은 친구 요청
export async function listFriendRequests(): Promise<Person[]> {
  if (!isMock()) return real.listFriendRequests();
  return db.requests.map(person);
}

// 요청 수락 — 친구가 돼도 공유는 아직 없음
export async function acceptFriend(id: string) {
  if (!isMock()) return real.acceptFriend(id);
  db.requests = db.requests.filter((x) => x !== id);
  if (!db.friends.includes(id)) db.friends.push(id);
  db.grants.friend[id] = none();
}

// 내가 보낸 대기 요청 — F01 보낸 요청 · [취소]
export async function listSentRequests(): Promise<Person[]> {
  if (!isMock()) return real.listSentRequests();
  return [...sentRequests].map(person);
}

// 받은 요청 거절 — 행이 지워지고 알림은 없음
export async function declineFriend(id: string) {
  if (!isMock()) return real.declineFriend(id);
  if (!db.requests.includes(id)) throw new UserError(MESSAGE_GONE);
  db.requests = db.requests.filter((x) => x !== id);
}

// 보낸 요청 취소
export async function cancelFriendRequest(id: string) {
  if (!isMock()) return real.cancelFriendRequest(id);
  if (!sentRequests.delete(id)) throw new UserError(MESSAGE_GONE);
}

// 친구 끊기 — 친구 권한도 같이 지워짐 (그룹 출처는 그대로)
export async function removeFriend(id: string) {
  if (!isMock()) return real.removeFriend(id);
  if (!db.friends.includes(id)) throw new UserError(MESSAGE_GONE);
  db.friends = db.friends.filter((x) => x !== id);
  delete db.grants.friend[id];
}

// 차단 — 친구 끊김 · 대기 요청 삭제 · 권한 삭제 (가짜 모드는 목록에서만 빠짐)
export async function blockUser(userId: string) {
  if (!isMock()) return real.blockUser(userId);
  if (userId === 'me') throw new UserError('나는 차단할 수 없어요');
  if (!people[userId]) throw new UserError('사용자를 찾을 수 없어요');
  db.friends = db.friends.filter((x) => x !== userId);
  db.requests = db.requests.filter((x) => x !== userId);
  sentRequests.delete(userId);
  delete db.grants.friend[userId];
  if (!blocked.includes(userId)) blocked.unshift(userId);
}

// 차단 풀기 — 친구는 복구 안 됨
export async function unblockUser(userId: string) {
  if (!isMock()) return real.unblockUser(userId);
  const i = blocked.indexOf(userId);
  if (i < 0) throw new UserError(MESSAGE_GONE);
  blocked.splice(i, 1);
}

// 설정 > 차단 목록
export async function listBlocks(): Promise<BlockedPerson[]> {
  if (!isMock()) return real.listBlocks();
  return blocked.map((id) => ({ person: person(id), blockedAt: now() }));
}

// 신고 — 같은 대상은 하루 한 번
export async function submitReport(target: ReportTarget, reason: ReportReason, note?: string): Promise<ReportResult> {
  if (!isMock()) return real.submitReport(target, reason, note);
  if (target.type === 'USER' && target.id === 'me') throw new UserError('나는 신고할 수 없어요');
  if (target.type === 'USER' ? !people[target.id] : !db.groups[target.id]) throw new UserError('신고할 대상을 찾을 수 없어요');
  const key = `${target.type}:${target.id}`;
  if (reported.has(key)) return 'ALREADY_REPORTED';
  reported.add(key);
  return 'REPORTED';
}

// 참여 중인 그룹 (G01 그룹)
export async function listGroups(date?: string | null): Promise<GroupItem[]> {
  if (!isMock()) return real.listGroups(date);
  return Object.values(db.groups).map((g) => ({
    id: g.id,
    name: g.name,
    initial: g.initial,
    memberCount: g.members.length,
    wokeCount: wokeCountOf(mockWakeRows(g.id)),
    grants: copy(db.grants.group[g.id] ?? none()),
  }));
}

// 홈(H01)의 그룹 기상 요약
export async function getGroupSummary(groupId: string, date?: string | null): Promise<GroupSummary | null> {
  if (!isMock()) return real.getGroupSummary(groupId, date);
  const g = db.groups[groupId];
  if (!g) return null;
  const rows = mockWakeRows(g.id);
  return {
    id: g.id,
    name: g.name,
    members: g.members.map((id) => ({ person: person(id), state: mockStateOf(rows, id) })),
    wokeCount: wokeCountOf(rows),
  };
}

// 가짜 모드 연결 일정 (친구 9장) — 내 목록에 있으면 참여, [나는 빠지기]로 빠진 것(db.left)은 알람 없음. 다른 사람은 시나리오가 있는 그룹원을 참여로 셈
function mockGroupAppointments(groupId: string): GroupAppointment[] {
  const g = db.groups[groupId];
  const others = (g?.members ?? []).filter((p) => p !== 'me' && timelines[p]).length;
  const current = now().getTime();
  const rows = [...db.appointments.map((a) => ({ a, joined: true })), ...db.left.map((a) => ({ a, joined: false }))].filter(({ a }) => a.groupId === groupId);
  return rows
    .sort((x, y) => x.a.at.getTime() - y.a.at.getTime())
    .map(({ a, joined }) => ({
      id: a.id,
      title: a.title,
      at: a.at,
      place: a.place,
      importance: a.importance,
      joinedCount: others + (joined ? 1 : 0),
      iJoined: joined,
      past: a.at.getTime() <= current,
      mine: !a.creatorId || a.creatorId === 'me',
      creatorUnknown: false,
    }));
}

// 연결 일정 참여자 줄 (G02) — 나 먼저, 시나리오가 있는 그룹원은 참여, 차단한 사람은 이름만
export async function getAppointmentJoiners(appointmentId: string): Promise<AppointmentJoiner[]> {
  if (!isMock()) return real.getAppointmentJoiners(appointmentId);
  const a = [...db.appointments, ...db.left].find((x) => x.id === appointmentId);
  const g = a?.groupId ? db.groups[a.groupId] : undefined;
  if (!a || !g) return [];
  const iJoined = db.appointments.includes(a);
  return [...g.members]
    .sort((x, y) => (x === 'me' ? -1 : y === 'me' ? 1 : 0))
    .map((id) => ({
      person: person(id),
      isMe: id === 'me',
      state: blocked.includes(id) ? ('HIDDEN' as const) : (id === 'me' ? iJoined : !!timelines[id]) ? ('JOINED' as const) : ('NO_ALARM' as const),
    }));
}

// 그룹 상세 (G02)
export async function getGroup(groupId: string, date?: string | null): Promise<GroupDetail | null> {
  if (!isMock()) return real.getGroup(groupId, date);
  const g = db.groups[groupId];
  if (!g) return null;
  const rows = mockWakeRows(g.id);
  return {
    id: g.id,
    name: g.name,
    since: g.since,
    grants: copy(db.grants.group[g.id] ?? none()),
    appointments: mockGroupAppointments(g.id),
    members: g.members.map((id) => ({
      person: person(id),
      isMe: id === 'me',
      state: mockStateOf(rows, id),
      received: receivedFrom(id),
      wakeHidden: wakeHides.has(id),
    })),
    wakeShareOptIn: wakeOptIns[g.id] ?? true,
    notificationsOff: notifOff[g.id] ?? false,
  };
}

// 친구 권한 (F02) — 이 친구가 내 정보에 대해 가진 최종 권한과 출처. 친구가 아니면 null (그룹원 · 나를 주소로 열어도)
export async function getFriendGrant(
  personId: string,
): Promise<{ person: Person; final: FinalGrant; groupCount: number } | null> {
  if (!isMock()) return real.getFriendGrant(personId);
  if (!db.friends.includes(personId)) return null;
  return {
    person: person(personId),
    final: givenTo(personId),
    groupCount: Object.values(db.groups).filter((g) => g.members.includes(personId)).length,
  };
}

// 권한을 줄 관계 고르기 (F03) — 그룹 먼저, 그다음 친구
export async function listRelations(): Promise<Relation[]> {
  if (!isMock()) return real.listRelations();
  const ids: RelationId[] = [
    ...Object.keys(db.groups).map((id) => `group:${id}` as const),
    ...db.friends.map((id) => `friend:${id}` as const),
  ];
  return ids.map(relationOf).filter((r): r is Relation => r != null);
}

function relationOf(id: RelationId): Relation | null {
  const [kind, key] = id.split(':') as ['friend' | 'group', string];
  if (kind === 'friend') {
    const p = people[key];
    return p ? { id, kind, label: p.name, sub: '친구', initial: p.initial } : null;
  }
  const g = db.groups[key];
  return g ? { id, kind, label: g.name, sub: `그룹 · 멤버 ${g.members.length}명`, initial: g.name.slice(0, 1) } : null;
}

export async function getRelation(id: RelationId): Promise<Relation | null> {
  if (!isMock()) return real.getRelation(id);
  return relationOf(id);
}

// 이 관계에서 내가 주는 권한 (F03 내가 공유)
export async function getShareSettings(id: RelationId): Promise<PermissionSet> {
  if (!isMock()) return real.getShareSettings(id);
  const [kind, key] = id.split(':');
  const set = kind === 'friend' ? db.grants.friend[key] : db.grants.group[key];
  return copy(set ?? none());
}

export async function saveShareSettings(id: RelationId, next: PermissionSet) {
  if (!isMock()) return real.saveShareSettings(id, next);
  if (!relationOf(id)) return;
  const [kind, key] = id.split(':');
  if (kind === 'friend') db.grants.friend[key] = copy(next);
  else db.grants.group[key] = copy(next);
  db.shareLog.push({ at: now(), text: `${relationOf(id)?.label ?? ''} 공유 권한 변경` });
}

// 이 관계에서 받은 권한 (F03 받은 권한)
export async function getReceived(id: RelationId): Promise<{ person: Person; permissions: PermissionSet }[]> {
  if (!isMock()) return real.getReceived(id);
  const [kind, key] = id.split(':');
  if (kind === 'friend') {
    return (db.received[key] ?? [])
      .filter((r) => r.sourceType === 'FRIEND')
      .map((r) => ({ person: person(key), permissions: copy(r) }));
  }
  const g = db.groups[key];
  if (!g) return [];
  return g.members.flatMap((pid) => {
    const row = (db.received[pid] ?? []).find((r) => r.sourceType === 'GROUP' && r.sourceId === g.id);
    return row ? [{ person: person(pid), permissions: copy(row) }] : [];
  });
}

// G03 — 그 그룹의 다른 멤버일 때만. 약속 있는 날 줄이 없으면 null(공유 안 함), 약속 없는 날은 noGroupAppointment (실데이터와 같게)
export async function getMemberWake(groupId: string, personId: string, date?: string | null): Promise<MemberWake | null> {
  if (!isMock()) return real.getMemberWake(groupId, personId, date);
  const g = db.groups[groupId];
  if (!g?.members.includes(personId) || personId === 'me') return null;
  const rows = mockWakeRows(groupId);
  const base = { person: person(personId), groupName: g.name, canViewAlarm: receivedFrom(personId).viewAlarm };
  if (!rows.length) return { ...base, state: NO_APPOINTMENT_STATE, alarmAt: null, confirmedAt: null, noGroupAppointment: true };
  const row = rows.find((r) => r.user_id === personId);
  if (!row) return null;
  return {
    ...base,
    state: wakeStateOf(row, true),
    alarmAt: row.wake_alarm_at ? new Date(row.wake_alarm_at) : null,
    confirmedAt: row.wake_confirmed_at ? new Date(row.wake_confirmed_at) : null,
    noGroupAppointment: false,
  };
}

// G02 멤버 메뉴 [이 사람에게 기상 숨기기 / 보이기] — 상대에게 알리지 않음 (7-43)
export async function setWakeHidden(personId: string, hidden: boolean): Promise<void> {
  if (!isMock()) return real.setWakeHidden(personId, hidden);
  if (hidden) wakeHides.add(personId);
  else wakeHides.delete(personId);
}

// 공유받은 알람 (G04) — 조회 권한이 없으면 알람은 비워서 줌 (alarms RLS와 같게)
export async function getSharedAlarms(personId: string): Promise<SharedAlarms | null> {
  if (!isMock()) return real.getSharedAlarms(personId);
  const alarms = memberAlarms[personId];
  if (!alarms) return null;
  const received = receivedFrom(personId);
  // 조회가 없으면 설정도 못 쓰므로 설정 꼬리표도 뺌 ("조회 권한이 없어요"와 엇갈리지 않게)
  const tags = received.rows.flatMap((r) => [
    ...(r.viewAlarm ? [`조회 · ${r.source}`] : []),
    ...(r.editAlarm && received.viewAlarm ? [`설정 · ${r.source}`] : []),
  ]);
  return {
    person: person(personId),
    canView: received.viewAlarm,
    canEdit: received.viewAlarm && received.editAlarm, // 조회가 안 되면 고칠 알람도 안 보임 (docs/screen-data-map.md F03)
    tags,
    alarms: received.viewAlarm ? alarms.map(toMemberAlarm) : [],
  };
}

// 켜기 · 끄기 — 저장되고 주인에게 알림이 갔는지를 돌려줌 (알림이 실패해도 저장은 그대로)
export async function setSharedAlarmEnabled(personId: string, alarmId: string, enabled: boolean): Promise<SharedChangeResult> {
  if (!isMock()) return real.setSharedAlarmEnabled(personId, alarmId, enabled);
  const s = (db.sharedAlarms[alarmId] ??= { on: true, shift: 0 });
  s.on = enabled;
  db.shareLog.push({ at: now(), text: `${person(personId).short}님 알람 ${enabled ? '켬' : '끔'}` });
  return { notified: true };
}

// 공유받은 알람 시각 옮기기 — minutes가 음수면 앞당김
export async function shiftSharedAlarm(personId: string, alarmId: string, minutes: number): Promise<SharedChangeResult> {
  if (!isMock()) return real.shiftSharedAlarm(personId, alarmId, minutes);
  const s = (db.sharedAlarms[alarmId] ??= { on: true, shift: 0 });
  s.shift += minutes;
  db.shareLog.push({ at: now(), text: `${person(personId).short}님 알람 ${Math.abs(minutes)}분 ${minutes < 0 ? '앞당김' : '늦춤'}` });
  return { notified: true };
}

// 공유 알람 변경 기록 — DB에는 저장 자리가 없음 (D9: 저장 없이 주인에게 푸시만, 스키마 보완 3). 실데이터도 이번 실행 동안 바꾼 것만 보임 (D20 열림)
export async function getShareLog(): Promise<ShareLogItem[]> {
  if (!isMock()) return real.getShareLog();
  return db.shareLog.map((l) => ({ ...l }));
}

// 깨우기 알림 보내기 (G03) — 실데이터는 서버가 판정 · 횟수를 세고 결과 상태를 줌. 가짜 모드는 막힘 (8-16)
export async function sendWakePing(groupId: string, personId: string): Promise<WakePingResult> {
  if (!isMock()) return real.sendWakePing(groupId, personId);
  throw new UserError(WAKE_PING_MOCK);
}

// 오늘 내가 받은 깨우기 — 홈 · H08 '수연님이 7:12에 깨웠어요'. 가짜 모드는 받은 것이 없음
export async function getReceivedWakePings(): Promise<ReceivedWakePing[]> {
  if (!isMock()) return real.getReceivedWakePings();
  return [];
}

// ---------------------------------------------------------------------------
// 새 UI용 — 화면은 나중에 붙음. 가짜 모드는 목업 사람 · 그룹에 맞춰 최소한만 흉내
// ---------------------------------------------------------------------------

// 가짜 모드의 관계 — 친구 · 내가 보낸 요청 · 나에게 온 요청 · 없음
function mockRelation(id: string): FriendRelation {
  if (db.friends.includes(id)) return 'FRIEND';
  if (sentRequests.has(id)) return 'SENT';
  if (db.requests.includes(id)) return 'RECEIVED';
  return 'NONE';
}

// 아이디 정확 일치로 사람 찾기 — @ 있어도 없어도, 대소문자 무관. 아이디 모양이 아니면 못 찾은 것 (가짜 모드는 횟수 제한 없음)
export async function searchByHandle(query: string): Promise<HandleSearch> {
  if (!isMock()) return real.searchByHandle(query);
  const clean = cleanHandle(query);
  if (!HANDLE_PATTERN.test(clean)) return { status: 'NOT_FOUND' };
  const found = Object.values(people).find((p) => p.id !== 'me' && p.handle?.slice(1).toLowerCase() === clean);
  if (!found || blocked.includes(found.id)) return { status: 'NOT_FOUND' }; // 차단한 사람도 없는 아이디와 같은 응답
  return { status: 'FOUND', person: toPerson(found), relation: mockRelation(found.id) };
}

// F01 검색칸 — 아이디 정확 일치가 먼저, 이름은 친구 · 같은 그룹 안에서만 부분 일치 (실데이터는 real/friends.ts)
export async function searchPeople(query: string): Promise<PeopleSearch> {
  if (!isMock()) return real.searchPeople(query);
  const q = query.trim().replace(/^@/, '').trim();
  if (!q) return { rows: [], self: null, limitSeconds: null, notFound: false };
  const byHandle = await searchByHandle(q);
  const exact: PersonHit | null = byHandle.status === 'FOUND' ? { person: byHandle.person, relation: byHandle.relation, via: 'HANDLE' } : null;
  const related = new Set([...db.friends, ...Object.values(db.groups).flatMap((g) => g.members)]);
  const lower = q.toLowerCase();
  const byName: PersonHit[] = [...related]
    .filter((id) => id !== 'me' && people[id] && !blocked.includes(id) && [people[id].name, people[id].short].some((n) => n.toLowerCase().includes(lower)))
    .map((id) => ({ person: person(id), relation: mockRelation(id), via: db.friends.includes(id) ? ('FRIEND' as const) : ('GROUP' as const) }));
  const rows = mergeHits(exact, byName);
  return { rows, self: null, limitSeconds: null, notFound: !rows.length };
}

// 내 친구 링크 — 가짜 모드는 앱을 다시 열 때까지만 (실데이터는 my_friend_link)
let linkSerial = 0;
let currentLink = '';
const oldLinks = new Set<string>();
const mockLinkToken = (n: number) => `MOCKLINK${String.fromCharCode(65 + (n % 26)).repeat(4)}`;
const MOCK_LINK_OWNERS: Record<string, string> = { FRIENDSY00001: 'sy', FRIENDJH00001: 'jh', FRIENDDAD0001: 'dad', FRIENDBJ00001: 'bj' }; // 시험 · 미리보기용 남의 링크

export async function myFriendLink(renew = false): Promise<FriendLink> {
  if (!isMock()) return real.myFriendLink(renew);
  if (!currentLink || renew) {
    if (currentLink) oldLinks.add(currentLink);
    currentLink = mockLinkToken(linkSerial++);
  }
  return { token: currentLink, expiresAt: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000) };
}

// 친구 링크 착지 — 요청은 안 보냄. 가짜 모드는 내 링크 → SELF, 다시 만들기 전 링크 · 모르는 글자 → EXPIRED
export async function openFriendLink(token: string): Promise<OpenedLink> {
  if (!isMock()) return real.openFriendLink(token);
  const t = token.trim().toUpperCase();
  if (t && t === currentLink) return { status: 'SELF', person: person('me') };
  const owner = MOCK_LINK_OWNERS[t];
  if (!owner) return { status: 'EXPIRED' };
  return { status: 'OK', person: person(owner), relation: mockRelation(owner) };
}

// 친구 요청 보내기 — 가짜 모드는 보낸 요청으로만 기억함 (상대가 수락하는 흐름은 목업 범위 밖)
export async function sendFriendRequest(userId: string): Promise<'SENT' | 'FRIEND'> {
  if (!isMock()) return real.sendFriendRequest(userId);
  if (userId === 'me') throw new UserError('나에게는 친구 요청을 보낼 수 없어요');
  if (!people[userId]) throw new UserError('사용자를 찾을 수 없어요');
  if (db.friends.includes(userId) || sentRequests.has(userId) || db.requests.includes(userId)) {
    throw new UserError('이미 친구이거나 요청이 진행 중이에요');
  }
  sentRequests.add(userId);
  return 'SENT';
}

// 그룹 만들기 — 만든 사람(나)이 바로 참여, 초대 코드가 생김 (그룹장 없음 — 만든 사람은 권한 없는 기록)
export async function createGroup(name: string): Promise<CreatedGroup> {
  if (!isMock()) return real.createGroup(name);
  const problem = groupNameProblem(name);
  if (problem) throw new UserError(problem);
  const trimmed = name.trim();
  if (Object.keys(db.groups).length >= 10) throw new UserError(GROUP_TOO_MANY);
  let n = Object.keys(db.groups).length + 1;
  while (db.groups[`g${n}`]) n++;
  const id = `g${n}`;
  const { year, month } = dateParts(now());
  db.groups[id] = { id, name: trimmed, initial: [...trimmed][0], members: ['me'], since: `${year}년 ${month}월부터 함께하는 중` };
  db.grants.group[id] = none();
  wakeOptIns[id] = false; // 만든 사람도 기상 공유 동의는 꺼진 채로 시작 — 만든 직후 같은 동의 시트가 뜸
  const { code, expiresAt } = codeOf(id);
  return { id, inviteCode: code, expiresAt };
}

// 코드 입력 → 미리보기 (참여는 안 함)
export async function previewGroupByCode(code: string): Promise<GroupPreview> {
  if (!isMock()) return real.previewGroupByCode(code);
  const cleaned = cleanCode(code);
  if (!cleaned) throw new UserError('초대 코드를 입력해 주세요');
  const mine = Object.values(db.groups).find((g) => codeOf(g.id).code === cleaned);
  if (mine) return { status: 'FOUND', name: mine.name, memberCount: mine.members.length, full: false, alreadyJoined: true, expiresAt: codeOf(mine.id).expiresAt };
  const o = outsideByCode(cleaned);
  if (!o) return { status: 'NOT_FOUND' };
  if (o.expired) return { status: 'EXPIRED' };
  const memberCount = o.count ?? o.memberIds.length;
  return { status: 'FOUND', name: o.name, memberCount, full: memberCount >= 20, alreadyJoined: false, expiresAt: sevenDays() };
}

// 코드로 참여 — wakeShare = 동의 시트 [공유]
export async function joinGroup(code: string, wakeShare: boolean): Promise<JoinedGroup> {
  if (!isMock()) return real.joinGroup(code, wakeShare);
  const cleaned = cleanCode(code);
  if (!cleaned) throw new UserError('초대 코드를 입력해 주세요');
  const mine = Object.values(db.groups).find((g) => codeOf(g.id).code === cleaned);
  if (mine) return { id: mine.id, already: true };
  const o = outsideByCode(cleaned);
  if (!o) throw new UserError(CODE_NOT_FOUND);
  if (o.expired) throw new UserError(CODE_EXPIRED);
  if ((o.count ?? o.memberIds.length) >= 20) throw new UserError(GROUP_FULL);
  if (Object.keys(db.groups).length >= 10) throw new UserError(GROUP_TOO_MANY);
  return enterOutside(o, wakeShare);
}

// G01 위 받은 초대 카드
export async function listGroupInvites(): Promise<GroupInvite[]> {
  if (!isMock()) return real.listGroupInvites();
  return outsideGroups.filter(hasInvite).map((o) => ({
    groupId: o.id,
    name: o.name,
    initial: o.initial,
    memberCount: o.count ?? o.memberIds.length,
    invitedByName: person(o.invitedBy as string).name,
    invitedAt: now(),
  }));
}

// 받은 초대 [참여]
export async function acceptGroupInvite(groupId: string, wakeShare: boolean): Promise<JoinedGroup> {
  if (!isMock()) return real.acceptGroupInvite(groupId, wakeShare);
  const o = outsideGroups.find((x) => x.id === groupId);
  if (!o || !hasInvite(o)) throw new UserError(MESSAGE_GONE);
  if ((o.count ?? o.memberIds.length) >= 20) throw new UserError(GROUP_FULL);
  if (Object.keys(db.groups).length >= 10) throw new UserError(GROUP_TOO_MANY);
  return enterOutside(o, wakeShare);
}

// 받은 초대 [거절] — 조용히 지움
export async function declineGroupInvite(groupId: string): Promise<void> {
  if (!isMock()) return real.declineGroupInvite(groupId);
  const o = outsideGroups.find((x) => x.id === groupId);
  if (!o || !hasInvite(o)) throw new UserError(MESSAGE_GONE);
  declinedInvites.add(groupId);
}

// G02 [+ 초대] — 내 친구 이름순, 이미 멤버 · 초대 중은 표시
export async function listInvitableFriends(groupId: string): Promise<InvitableFriend[]> {
  if (!isMock()) return real.listInvitableFriends(groupId);
  const g = db.groups[groupId];
  if (!g) throw new UserError(GROUP_NOT_MEMBER);
  return [...db.friends]
    .map(person)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => ({ person: p, state: g.members.includes(p.id) ? ('MEMBER' as const) : invitedFriends[groupId]?.has(p.id) ? ('INVITED' as const) : ('NONE' as const) }));
}

export async function inviteToGroup(groupId: string, userId: string): Promise<'INVITED' | 'ALREADY_INVITED'> {
  if (!isMock()) return real.inviteToGroup(groupId, userId);
  const g = db.groups[groupId];
  if (!g) throw new UserError(GROUP_NOT_MEMBER);
  if (!db.friends.includes(userId)) throw new UserError('초대할 수 없는 사람이에요');
  if (g.members.includes(userId)) throw new UserError('이미 그룹에 있어요');
  const set = (invitedFriends[groupId] ??= new Set());
  if (set.has(userId)) return 'ALREADY_INVITED';
  set.add(userId);
  return 'INVITED';
}

// 코드 시트 — 코드 + 만료일
export async function getGroupCode(groupId: string): Promise<GroupCode> {
  if (!isMock()) return real.getGroupCode(groupId);
  if (!db.groups[groupId]) throw new UserError(GROUP_NOT_MEMBER);
  return { ...codeOf(groupId) };
}

// [새 코드] — 멤버 누구나, 옛 코드는 바로 못 씀
export async function regenerateInviteCode(groupId: string): Promise<GroupCode> {
  if (!isMock()) return real.regenerateInviteCode(groupId);
  if (!db.groups[groupId]) throw new UserError(GROUP_NOT_MEMBER);
  const old = codeOf(groupId).code;
  let salt = 1;
  let code = mockCode(groupId, salt);
  while (code === old) code = mockCode(groupId, ++salt);
  groupCodes[groupId] = { code, expiresAt: sevenDays() };
  return { ...groupCodes[groupId] };
}

// 이름 바꾸기 — 멤버 누구나
export async function renameGroup(groupId: string, name: string): Promise<void> {
  if (!isMock()) return real.renameGroup(groupId, name);
  const problem = groupNameProblem(name);
  if (problem) throw new UserError(problem);
  const g = db.groups[groupId];
  if (!g) throw new UserError(GROUP_NOT_MEMBER);
  g.name = name.trim();
  g.initial = [...g.name][0];
}

// 나가기 — 가짜 데이터에서는 내 그룹 목록에서 빠짐
export async function leaveGroup(groupId: string): Promise<void> {
  if (!isMock()) return real.leaveGroup(groupId);
  if (!db.groups[groupId]) throw new UserError(MESSAGE_GONE);
  delete db.groups[groupId];
  delete db.grants.group[groupId];
}

// 내보내기 — 코드가 바뀜 (5-19)
export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  if (!isMock()) return real.removeGroupMember(groupId, userId);
  if (userId === 'me') throw new UserError('나는 내보낼 수 없어요. 나가기를 눌러 주세요');
  const g = db.groups[groupId];
  if (!g || !g.members.includes(userId)) throw new UserError(MESSAGE_GONE);
  g.members = g.members.filter((p) => p !== userId);
  await regenerateInviteCode(groupId);
}

// 이 그룹 알림 끄기 · 켜기
export async function setGroupNotificationsOff(groupId: string, off: boolean): Promise<void> {
  if (!isMock()) return real.setGroupNotificationsOff(groupId, off);
  if (!db.groups[groupId]) throw new UserError(GROUP_NOT_MEMBER);
  notifOff[groupId] = off;
}

// 이 그룹에 내 기상 상태 공유를 동의 / 취소 (D19 열림 — F03 저장은 이 값을 건드리지 않음)
export async function setWakeShareOptIn(groupId: string, on: boolean) {
  if (!isMock()) return real.setWakeShareOptIn(groupId, on);
  if (!db.groups[groupId]?.members.includes('me')) throw new UserError('참여 중인 그룹이 아니에요');
  wakeOptIns[groupId] = on;
}
