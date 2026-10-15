// ② 알람 공유 · 기상 확인 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (G01 · F02 · F03 · G02 · G03 · G04, 권한 합집합은 DB 함수)
import { now } from '@/lib/clock';
import { memberState, orGrants } from '@/mocks/calc';
import { db, kst, memberAlarms, people, timelines, TODAY, type MockGroup, type MockMemberAlarm, type MockPerson } from '@/mocks/data';

import {
  type FinalGrant,
  type FriendItem,
  type GrantRow,
  type GroupDetail,
  type GroupItem,
  type GroupSummary,
  type MemberAlarm,
  type MemberWake,
  type PermissionSet,
  type Person,
  type Relation,
  type RelationId,
  type ShareLogItem,
  type SharedAlarms,
  type TimelineEntry,
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
  return orGrants(rows);
}

// 이 사람이 나에게 준 최종 권한
function receivedFrom(personId: string): FinalGrant {
  return orGrants((db.received[personId] ?? []).map((r) => ({ ...r })));
}

function wokeCount(groupId: string) {
  const t = now();
  return (db.groups[groupId]?.members ?? []).filter((p) => (p === 'me' || timelines[p]) && memberState(p, t).woke).length;
}

// 초대 코드 — 목업은 그룹 id에서 정해진 글자 (실데이터는 그룹의 초대 코드 칼럼)
function inviteCodeOf(g: MockGroup) {
  const hash = [...g.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `${g.id.toUpperCase().slice(0, 3)}-${hash.toString(36).toUpperCase().padStart(4, '0').slice(-4)}`;
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
  return db.friends.map((id) => ({ person: person(id), grantCount: givenTo(id).count }));
}

// 받은 친구 요청
export async function listFriendRequests(): Promise<Person[]> {
  return db.requests.map(person);
}

// 요청 수락 — 친구가 돼도 공유는 아직 없음
export async function acceptFriend(id: string) {
  db.requests = db.requests.filter((x) => x !== id);
  if (!db.friends.includes(id)) db.friends.push(id);
  db.grants.friend[id] = none();
}

// 참여 중인 그룹 (G01 그룹)
export async function listGroups(): Promise<GroupItem[]> {
  return Object.values(db.groups).map((g) => ({
    id: g.id,
    name: g.name,
    initial: g.initial,
    memberCount: g.members.length,
    wokeCount: wokeCount(g.id),
    grants: copy(db.grants.group[g.id] ?? none()),
    canSeeWake: g.members.some((p) => p !== 'me' && receivedFrom(p).viewWake),
  }));
}

// 홈(H01)의 그룹 기상 요약
export async function getGroupSummary(groupId: string): Promise<GroupSummary | null> {
  const g = db.groups[groupId];
  if (!g) return null;
  const t = now();
  return {
    id: g.id,
    name: g.name,
    members: g.members.map((id) => ({ person: person(id), state: memberState(id, t) })),
    wokeCount: wokeCount(g.id),
  };
}

// 그룹 상세 (G02)
export async function getGroup(groupId: string): Promise<GroupDetail | null> {
  const g = db.groups[groupId];
  if (!g) return null;
  const t = now();
  return {
    id: g.id,
    name: g.name,
    since: g.since,
    grants: copy(db.grants.group[g.id] ?? none()),
    appointments: db.appointments
      .filter((a) => a.groupId === g.id)
      .map((a) => ({ id: a.id, title: a.title, at: a.at, place: a.place, importance: a.importance })),
    inviteCode: inviteCodeOf(g),
    members: g.members.map((id) => ({
      person: person(id),
      isMe: id === 'me',
      state: memberState(id, t),
      received: receivedFrom(id),
    })),
  };
}

// 친구 권한 (F02) — 이 친구가 내 정보에 대해 가진 최종 권한과 출처. 친구가 아니면 null (그룹원 · 나를 주소로 열어도)
export async function getFriendGrant(
  personId: string,
): Promise<{ person: Person; final: FinalGrant; groupCount: number } | null> {
  if (!db.friends.includes(personId)) return null;
  return {
    person: person(personId),
    final: givenTo(personId),
    groupCount: Object.values(db.groups).filter((g) => g.members.includes(personId)).length,
  };
}

// 권한을 줄 관계 고르기 (F03) — 그룹 먼저, 그다음 친구
export async function listRelations(): Promise<Relation[]> {
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
  return relationOf(id);
}

// 이 관계에서 내가 주는 권한 (F03 내가 공유)
export async function getShareSettings(id: RelationId): Promise<PermissionSet> {
  const [kind, key] = id.split(':');
  const set = kind === 'friend' ? db.grants.friend[key] : db.grants.group[key];
  return copy(set ?? none());
}

export async function saveShareSettings(id: RelationId, next: PermissionSet) {
  if (!relationOf(id)) return;
  const [kind, key] = id.split(':');
  if (kind === 'friend') db.grants.friend[key] = copy(next);
  else db.grants.group[key] = copy(next);
  db.shareLog.push({ at: now(), text: `${relationOf(id)?.label ?? ''} 공유 권한 변경` });
}

// 이 관계에서 받은 권한 (F03 받은 권한)
export async function getReceived(id: RelationId): Promise<{ person: Person; permissions: PermissionSet }[]> {
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

// 그룹원 기상 상태 (G03) — 지금까지 일어난 일만
const SOURCE: Record<string, string> = {
  '알람 울림': '자동 기록',
  '알람 해제': '기상 미확정',
  '준비 시작': '진행 중',
  출발: '지오펜스',
  도착: '지오펜스',
};

// 그 그룹의 구성원이고 나에게 기상 상태 조회 권한을 줬을 때만 (get_group_wake_status와 같게), 아니면 null
// 권한은 있는데 오늘 알람이 없으면 alarm: null (권한이 없다는 말과 구분)
export async function getMemberWake(groupId: string, personId: string): Promise<MemberWake | null> {
  const g = db.groups[groupId];
  const tl = timelines[personId];
  const alarms = memberAlarms[personId];
  if (!g?.members.includes(personId) || !receivedFrom(personId).viewWake) return null;
  if (!tl || !alarms?.length) return { person: person(personId), groupName: g.name, alarm: null, timeline: [], firstAlarmAt: null };
  const t = now().getTime();
  const timeline: TimelineEntry[] = tl
    .map(([m, label, source]) => ({ at: kst(TODAY, m), label, source: source ?? SOURCE[label] ?? '' }))
    .filter((e) => e.at.getTime() <= t);
  return {
    person: person(personId),
    groupName: g.name,
    alarm: toMemberAlarm(alarms[0]),
    timeline,
    firstAlarmAt: kst(TODAY, tl[0][0]),
  };
}

// 공유받은 알람 (G04) — 조회 권한이 없으면 알람은 비워서 줌 (alarms RLS와 같게)
export async function getSharedAlarms(personId: string): Promise<SharedAlarms | null> {
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

export async function setSharedAlarmEnabled(personId: string, alarmId: string, enabled: boolean) {
  const s = (db.sharedAlarms[alarmId] ??= { on: true, shift: 0 });
  s.on = enabled;
  db.shareLog.push({ at: now(), text: `${person(personId).short}님 알람 ${enabled ? '켬' : '끔'}` });
}

// 공유받은 알람 시각 옮기기 — minutes가 음수면 앞당김
export async function shiftSharedAlarm(personId: string, alarmId: string, minutes: number) {
  const s = (db.sharedAlarms[alarmId] ??= { on: true, shift: 0 });
  s.shift += minutes;
  db.shareLog.push({ at: now(), text: `${person(personId).short}님 알람 ${Math.abs(minutes)}분 ${minutes < 0 ? '앞당김' : '늦춤'}` });
}

// 공유 알람 변경 기록 — DB에는 아직 자리가 없음 (screen-data-map의 스키마 보완 후보)
export async function getShareLog(): Promise<ShareLogItem[]> {
  return db.shareLog.map((l) => ({ ...l }));
}

// 깨우기 알림 보내기 (G03) — 실데이터는 notify Edge Function
export async function sendWakePing(personId: string) {
  db.shareLog.push({ at: now(), text: `${person(personId).short}님에게 깨우기 알림` });
}
