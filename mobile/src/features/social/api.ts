// ② 알람 공유 · 기상 확인 — 데이터 접근은 이 파일에서만 합니다.
// 가짜 모드(웹 미리보기 · ?mode=mock)는 src/mocks의 가짜 데이터를 돌려주고, 실데이터 모드는 함수 맨 앞에서 ./real로 넘깁니다 (P6).
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (G01 · F02 · F03 · G02 · G03 · G04, 권한 합집합은 앱에서 합침 — grants.ts)
//   date = 그룹 기상 신호(lib/realtime)가 알려 준 날 (YYYY-MM-DD). 실데이터만 씀 — get_group_wake_status의 p_date, 없으면 내 시간대의 오늘
import { cleanHandle } from '@/features/onboarding/validate';
import { HANDLE_PATTERN } from '@/features/profile/types';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { dateParts } from '@/lib/format';
import { isMock } from '@/lib/mode';
import { memberState } from '@/mocks/calc';
import { db, kst, memberAlarms, people, timelines, TODAY, type MockGroup, type MockMemberAlarm, type MockPerson } from '@/mocks/data';

import { mergeGrants } from './grants';
import * as real from './real';
import { MESSAGE_GONE } from './relationMessages';
import { mergeHits } from './searchView';
import {
  type CreatedGroup,
  type FinalGrant,
  type FriendItem,
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
  type Relation,
  type RelationId,
  type ShareLogItem,
  type SharedAlarms,
  type SharedChangeResult,
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
  return mergeGrants(rows);
}

// 이 사람이 나에게 준 최종 권한
function receivedFrom(personId: string): FinalGrant {
  return mergeGrants((db.received[personId] ?? []).map((r) => ({ ...r })));
}

function wokeCount(groupId: string) {
  const t = now();
  return (db.groups[groupId]?.members ?? []).filter((p) => (p === 'me' || timelines[p]) && memberState(p, t).woke).length;
}

// 새 UI용 가짜 상태 — 앱을 다시 열 때까지만 (mocks/data.ts는 안 고침)
const sentRequests = new Set<string>(); // 내가 친구 요청을 보낸 사람
const newInviteCodes: Record<string, string> = {}; // 다시 만든 초대 코드
const wakeOptIns: Record<string, boolean> = {}; // 기상 공유 동의 — 목업 그룹은 이미 공유 중이라 기본 켬
const ownedGroups = new Set(['fam']); // 내가 만든 그룹 — 목업은 가족 그룹만 내가 만든 것으로

// 초대 코드 — 목업은 그룹 id에서 정해진 글자 (실데이터는 그룹의 초대 코드 칼럼)
function inviteCodeOf(g: MockGroup) {
  if (newInviteCodes[g.id]) return newInviteCodes[g.id];
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

// 참여 중인 그룹 (G01 그룹)
export async function listGroups(date?: string | null): Promise<GroupItem[]> {
  if (!isMock()) return real.listGroups(date);
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
export async function getGroupSummary(groupId: string, date?: string | null): Promise<GroupSummary | null> {
  if (!isMock()) return real.getGroupSummary(groupId, date);
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
export async function getGroup(groupId: string, date?: string | null): Promise<GroupDetail | null> {
  if (!isMock()) return real.getGroup(groupId, date);
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
    isOwner: ownedGroups.has(g.id),
    wakeShareOptIn: wakeOptIns[g.id] ?? true,
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
export async function getMemberWake(groupId: string, personId: string, date?: string | null): Promise<MemberWake | null> {
  if (!isMock()) return real.getMemberWake(groupId, personId, date);
  const g = db.groups[groupId];
  const tl = timelines[personId];
  const alarms = memberAlarms[personId];
  if (!g?.members.includes(personId) || !receivedFrom(personId).viewWake) return null;
  if (!tl || !alarms?.length) return { person: person(personId), groupName: g.name, alarm: null, timeline: [], firstAlarmAt: null, noGroupAppointment: false };
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
    noGroupAppointment: false,
  };
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

// 깨우기 알림 보내기 (G03) — 실데이터는 D19가 열려 있어 서버가 거절하므로 아직 보내지 않고 "준비 중" 안내만 (UserError)
export async function sendWakePing(personId: string) {
  if (!isMock()) return real.sendWakePing(personId);
  db.shareLog.push({ at: now(), text: `${person(personId).short}님에게 깨우기 알림` });
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
  if (!found) return { status: 'NOT_FOUND' };
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
    .filter((id) => id !== 'me' && people[id] && [people[id].name, people[id].short].some((n) => n.toLowerCase().includes(lower)))
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

// 그룹 만들기 — 만든 사람(나)이 바로 참여, 초대 코드가 생김
export async function createGroup(name: string): Promise<CreatedGroup> {
  if (!isMock()) return real.createGroup(name);
  const trimmed = name.trim();
  if (!trimmed) throw new UserError('그룹 이름을 입력해 주세요');
  if ([...trimmed].length > 50) throw new UserError('그룹 이름은 50자까지 쓸 수 있어요');
  let n = Object.keys(db.groups).length + 1;
  while (db.groups[`g${n}`]) n++;
  const id = `g${n}`;
  const { year, month } = dateParts(now());
  db.groups[id] = { id, name: trimmed, initial: [...trimmed][0], members: ['me'], since: `${year}년 ${month}월부터 함께하는 중` };
  db.grants.group[id] = none();
  ownedGroups.add(id);
  wakeOptIns[id] = false; // 만든 사람도 기상 공유 동의는 꺼진 채로 시작
  return { id, inviteCode: inviteCodeOf(db.groups[id]) };
}

// 초대 코드로 참여 — 참여한 그룹 id. 가짜 모드의 그룹은 모두 내가 이미 참여 중이라 그 그룹 id를 돌려줌
export async function joinGroupByCode(code: string): Promise<string> {
  if (!isMock()) return real.joinGroupByCode(code);
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) throw new UserError('초대 코드를 입력해 주세요');
  const g = Object.values(db.groups).find((x) => inviteCodeOf(x) === trimmed);
  if (!g) throw new UserError('초대 코드가 맞지 않아요');
  if (!g.members.includes('me')) g.members.push('me');
  return g.id;
}

// 초대 코드 새로 받기 — 만든 사람만
export async function regenerateInviteCode(groupId: string): Promise<string> {
  if (!isMock()) return real.regenerateInviteCode(groupId);
  const g = db.groups[groupId];
  if (!g || !ownedGroups.has(groupId)) throw new UserError('그룹을 만든 사람만 초대 코드를 바꿀 수 있어요');
  const old = inviteCodeOf(g);
  let code = old;
  while (code === old) code = `${g.id.toUpperCase().slice(0, 3)}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0')}`;
  newInviteCodes[groupId] = code;
  return code;
}

// 이 그룹에 내 기상 상태 공유를 동의 / 취소 (D19 열림 — F03 저장은 이 값을 건드리지 않음)
export async function setWakeShareOptIn(groupId: string, on: boolean) {
  if (!isMock()) return real.setWakeShareOptIn(groupId, on);
  if (!db.groups[groupId]?.members.includes('me')) throw new UserError('참여 중인 그룹이 아니에요');
  wakeOptIns[groupId] = on;
}
