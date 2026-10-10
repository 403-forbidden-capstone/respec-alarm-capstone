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
  received: FinalGrant; // 이 사람에게서 받은 권한 (기상 확인 · 알람 보기 버튼)
};

export type GroupDetail = {
  id: string;
  name: string;
  since: string; // 2025년 3월부터 함께하는 중
  grants: PermissionSet; // 그룹 공유 범위 (내가 준 권한)
  appointment: { id: string; title: string; at: Date; place: string; importance: Importance } | null; // 연결 일정
  members: GroupMember[];
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
  alarm: MemberAlarm;
  timeline: TimelineEntry[]; // 지금까지 일어난 일
  firstAlarmAt: Date;
};

export type SharedAlarms = {
  person: Person;
  canView: boolean; // 알람 조회 권한 — 없으면 alarms는 빈 목록 (RLS와 같게)
  canEdit: boolean;
  tags: string[]; // 조회 · 친구, 설정 · 친구 …
  alarms: MemberAlarm[];
};

export type ShareLogItem = { at: Date; text: string };
