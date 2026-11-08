// ② 알람 공유 · 기상 확인 — 이 기능에서 쓰는 타입
import type { WakeDot } from '@/components/ui';
import type { Importance } from '@/features/alarm/types';

export type Person = {
  id: string;
  name: string; // 이수연
  short: string; // 수연
  initial: string; // 수
  handle: string | null; // @etion
};

// 기상 상태 한 줄 (G02 멤버 · H01 그룹 요약)
export type WakeState = {
  text: string; // 기상 완료 · 오전 7:30
  dot: WakeDot;
  woke: boolean;
};

// DB sharing_permissions의 can_view_alarm · can_edit_alarm · can_view_wake
export type Permission = 'viewAlarm' | 'editAlarm' | 'viewWake';
export type PermissionSet = Record<Permission, boolean>;

export const PERMISSIONS: readonly { key: Permission; name: string; description: string }[] = [
  { key: 'viewAlarm', name: '알람 조회', description: '내 알람 시간과 반복 일정을 볼 수 있어요.' },
  { key: 'editAlarm', name: '알람 설정', description: '내 알람을 추가하거나 시간을 바꿀 수 있어요.' },
  { key: 'viewWake', name: '기상 상태 조회', description: '기상 확인 여부와 확인 시각을 볼 수 있어요.' },
];

// 관계 하나에서 준(받은) 권한 — DB sharing_permissions의 source_type · source_id
// sourceId: 그룹이면 group_id, 친구면 상대 사람 id (실데이터는 friends.friend_id로 찾아 사람으로 바꿈)
export type GrantRow = PermissionSet & { source: string; sourceType: 'FRIEND' | 'GROUP'; sourceId: string }; // source = 친구 · 캡스톤팀

// 여러 관계의 권한을 항목별로 합친 결과 (하나라도 허용하면 허용)
export type FinalGrant = PermissionSet & { rows: GrantRow[]; count: number };

// 권한을 주는 관계 — 친구 한 명 또는 그룹 하나
export type RelationId = `friend:${string}` | `group:${string}`;

export type Relation = {
  id: RelationId;
  kind: 'friend' | 'group';
  label: string; // 이수연 · 캡스톤팀
  sub: string; // 친구 · 그룹 · 멤버 4명
  initial: string;
};

export type FriendItem = { person: Person; grantCount: number }; // 내가 준 권한 수

export type GroupItem = {
  id: string;
  name: string;
  initial: string; // 그룹 아이콘 글자
  memberCount: number;
  wokeCount: number;
  grants: PermissionSet; // 이 그룹에 내가 준 권한
  canSeeWake: boolean; // 멤버 기상 상태를 볼 수 있는지 (받은 권한)
};

// 홈(H01)의 그룹 기상 요약
export type GroupSummary = {
  id: string;
  name: string;
  members: { person: Person; state: WakeState }[];
  wokeCount: number;
};

export type GroupMember = {
  person: Person;
  isMe: boolean;
  state: WakeState;
  received: FinalGrant; // 이 사람에게서 받은 권한 (기상 상태 · 알람 보기 버튼)
};

export type GroupDetail = {
  id: string;
  name: string;
  since: string; // 2025년 3월부터 함께하는 중
  grants: PermissionSet; // 그룹 공유 범위 (내가 준 권한)
  appointments: { id: string; title: string; at: Date; place: string; importance: Importance }[]; // 연결 일정 (여러 개일 수 있음)
  inviteCode: string; // 초대 코드 (G02 "+ 초대")
  members: GroupMember[];
  isOwner: boolean; // 내가 만든 그룹인지 — 초대 코드 다시 만들기는 만든 사람만 (새 UI용, 화면은 아직 안 씀)
  wakeShareOptIn: boolean; // 이 그룹에 내 기상 상태 공유를 동의했는지 (group_members.wake_share_opt_in, D19 열림 — 새 UI용)
};

// 친구 · 그룹원이 공유한 알람 한 건 (G03 · G04)
export type MemberAlarm = {
  id: string;
  date: Date;
  chain: { at: Date; label: string }[]; // 기상 · 준비 · 출발
  appointmentLabel: string; // 팀 주간회의 · 세종대학교 · 오전 10:00
  levelName: string; // 약 · 중 · 강
  note: string; // 준비 70분 · 이동 70분 · 여유 10분
  enabled: boolean;
};

export type TimelineEntry = { at: Date; label: string; source: string };

export type MemberWake = {
  person: Person;
  groupName: string; // 공유 범위 안내 (캡스톤팀에 허용한 범위만)
  alarm: MemberAlarm | null; // 오늘 알람이 없으면 null (권한이 없는 것과 다름)
  timeline: TimelineEntry[]; // 지금까지 일어난 일
  firstAlarmAt: Date | null;
  noGroupAppointment: boolean; // 그날 이 그룹의 약속이 없어 기상 상태를 주지 않는 날 (D57 — 알람이 없는 것과 다름). 가짜 데이터는 늘 false
};

export type SharedAlarms = {
  person: Person;
  canView: boolean; // 알람 조회 권한 — 없으면 alarms는 빈 목록 (RLS와 같게)
  canEdit: boolean;
  tags: string[]; // 조회 · 친구, 설정 · 친구 …
  alarms: MemberAlarm[];
};

export type ShareLogItem = { at: Date; text: string };

// G04에서 알람을 바꾼 결과 — 저장은 됐고 주인에게 알림이 갔는지만 알려 줌 (알림이 실패해도 저장은 그대로, 화면은 조용히 "바꿨어요"만)
export type SharedChangeResult = { notified: boolean };

// 아이디로 찾은 사람과 나와의 관계 — 서버 값 NONE · REQUEST_SENT · REQUEST_RECEIVED · FRIEND를 앱 값으로 (real/friends.ts)
export type FriendRelation = 'FRIEND' | 'SENT' | 'RECEIVED' | 'NONE';

// 아이디 정확 일치 한 번의 결과 (search_by_handle) — 없음 · 탈퇴 · 차단 · 온보딩 전은 모두 NOT_FOUND
export type HandleSearch =
  | { status: 'FOUND'; person: Person; relation: FriendRelation }
  | { status: 'SELF'; person: Person }
  | { status: 'NOT_FOUND' }
  | { status: 'LIMIT'; retryAfterSeconds: number };

// 검색 결과 한 줄 — via = 어떻게 찾았나 (HANDLE 아이디 정확 일치 · FRIEND 친구 이름 · GROUP 같은 그룹 이름)
export type PersonHit = { person: Person; relation: FriendRelation; via: 'HANDLE' | 'FRIEND' | 'GROUP' };

// F01 검색칸 한 번의 결과 — 아이디 정확 일치가 rows 맨 앞
export type PeopleSearch = {
  rows: PersonHit[];
  self: Person | null; // 내 아이디로 찾음
  limitSeconds: number | null; // 아이디 검색 제한에 걸림 — n초 뒤 다시
  notFound: boolean; // 아무도 못 찾음 (내 아이디 · 제한은 아님)
};

// 내 친구 링크 (my_friend_link) — 7일, 다시 만들면 옛 링크는 바로 무효
export type FriendLink = { token: string; expiresAt: Date };

// 친구 링크 착지 (open_friend_link) — 요청은 안 보낸 상태. 없는 · 옛 · 만료 · 탈퇴 · 차단 · 온보딩 전은 모두 EXPIRED
export type OpenedLink =
  | { status: 'OK'; person: Person; relation: FriendRelation }
  | { status: 'SELF'; person: Person }
  | { status: 'EXPIRED' };

// 그룹을 만든 결과 (새 UI용) — 만들고 바로 초대 코드를 보여 줄 수 있게
export type CreatedGroup = { id: string; inviteCode: string };
