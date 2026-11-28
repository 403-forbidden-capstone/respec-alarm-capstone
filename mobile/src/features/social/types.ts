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

// 기상 상태 한 줄 (G01 · G02 멤버 · G03 · H01 그룹 요약) — 서버 기상 6단계를 화면 3단계로 묶고, 출발 · 도착 공유가 보이면 뒤에 3단계를 더함 (친구 7장, map.ts wakeStateOf)
//   SCHEDULED 취침 중('취침 중 · 오전 8:50 알람') · RANG 알람 울리는 중 · 알람 울림 · 기상 확인 전(울림 · 해제 · 미확인) · WOKE 기상 완료 · NO_ALARM 알람 없음
//   PREPARING 준비 중(준비 알람 해제 = 준비 시작 체크 뒤 출발 전, 출발 · 도착 공유를 켠 사람만) · PREP_SCHEDULED 준비 알람 예정(기상 알람이 없는 날) · DEPARTED 이동 중 · 출발 · ARRIVED 도착
//   NOT_SHARED 공유 안 함(동의 안 함 · 숨김 · 차단 구분 없음) · NO_APPOINTMENT 그 그룹 약속이 없는 날
export type WakeStage = 'SCHEDULED' | 'RANG' | 'WOKE' | 'PREPARING' | 'PREP_SCHEDULED' | 'DEPARTED' | 'ARRIVED' | 'NO_ALARM' | 'NOT_SHARED' | 'NO_APPOINTMENT';
export type WakeState = {
  stage: WakeStage;
  text: string; // 기상 완료 · 오전 8:08
  dot: WakeDot | null; // 색 점 — 공유 안 함 · 약속 없는 날은 없음
  woke: boolean;
};

// DB sharing_permissions의 can_view_alarm · can_edit_alarm · can_view_wake
//   viewTrip = 그룹 출발 · 도착 공유 (group_members.trip_share_opt_in) — 그룹 관계에만 있음. 친구 관계 · 권한 행에는 없어 비어 있으면 꺼짐
export type Permission = 'viewAlarm' | 'editAlarm' | 'viewWake' | 'viewTrip';
export type PermissionSet = Record<'viewAlarm' | 'editAlarm' | 'viewWake', boolean> & { viewTrip?: boolean; ruleVersion?: string; accepted?: boolean; acceptedCount?: number; memberCount?: number };

// 알람 조회를 켤 때 보이는 것 · 안 보이는 것 안내 한 줄 (친구 13-다 · 13-사 — 켤 때 따로 동의를 받지 않으므로 F03에서 미리 알림)
export const VIEW_ALARM_NOTE = '일정 장소도 보여요 · 집 · 출발지는 안 보여요';

export const PERMISSIONS: readonly { key: 'viewAlarm' | 'editAlarm' | 'viewWake'; name: string; description: string }[] = [
  { key: 'viewAlarm', name: '알람 조회', description: '알람 시각 · 일정 · 장소를 볼 수 있어요.' },
  { key: 'editAlarm', name: '알람 설정', description: '내 알람을 추가하거나 시간을 바꿀 수 있어요.' },
  { key: 'viewWake', name: '내 기상 공개', description: '기상 확인 여부와 시각이 보여요.' },
];

// 그룹 출발 · 도착 공유 — 기상 공유와 따로 한 동의(기본 끔). 기상 공유를 켠 사람만 켤 수 있고 기상 공유를 끄면 같이 꺼짐 (11/19 지형님 결정)
//   chip = G02 '내가 공유 중' 칩 글자
export const TRIP_PERMISSION: { key: 'viewTrip'; name: string; chip: string; description: string } = {
  key: 'viewTrip',
  name: '출발 · 도착 공유',
  chip: '출발 · 도착',
  description: '준비 시작 · 출발 · 도착 시각이 보여요.',
};
export const TRIP_NEEDS_WAKE = '내 기상 공개를 켜야 켤 수 있어요';

// F03 스위치 목록 — 친구 관계에는 기상 조회가 없음(그룹 기상 공유 동의 하나로만, 친구 6장 6-가). 그룹 관계의 기상 조회는 그 그룹에 내 기상 공유를 켜는 동의
//   출발 · 도착 공유는 그룹 관계에만 (맨 끝)
export const permissionsFor = (kind: 'friend' | 'group'): readonly { key: Permission; name: string; description: string }[] =>
  kind === 'friend' ? PERMISSIONS.filter((p) => p.key === 'viewWake') : [...PERMISSIONS, TRIP_PERMISSION];

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
  wokeCount: number | null; // 오늘 기상 완료 수(준비 중 · 출발 · 도착 포함) — 그 그룹 약속이 없는 날은 null (G01 '오늘 n명 기상 완료' 줄을 숨김)
  trip: TripCounts | null; // 출발 · 도착이 보이는 사람이 있을 때만 — G01 요약 줄이 '도착 1 · 이동 중 2 · 준비 중 1 · 기상 완료 1'로 바뀜
  grants: PermissionSet; // 이 그룹에 내가 준 권한
};

// 그룹 요약 줄 숫자 — 도착 · 이동 중(출발했고 아직 도착 전) · 준비 중(준비 시작 체크 뒤 출발 전) · 기상 완료(준비 시작 전)
export type TripCounts = { arrived: number; moving: number; preparing: number; woke: number };

// 홈(H01)의 그룹 기상 요약
export type GroupSummary = {
  id: string;
  name: string;
  members: { person: Person; state: WakeState }[];
  wokeCount: number | null; // 약속 없는 날은 null
  trip: TripCounts | null;
};

export type GroupMember = {
  person: Person;
  isMe: boolean;
  state: WakeState; // 기상 상태는 받은 권한이 아니라 그 사람의 그룹 기상 공유 동의로만 (6장 · 7장)
  received: FinalGrant; // 이 사람에게서 받은 권한 (알람 보기 버튼)
  wakeHidden: boolean; // 내가 이 사람에게 내 기상을 숨김 (wake_hides, G02 멤버 메뉴)
};

// G02 연결 일정 한 줄 (친구 9장) — 인원수 · 내 참여는 서버가 셈(group_appointment_counts)
export type GroupAppointment = {
  id: string;
  title: string;
  at: Date;
  place: string;
  importance: Importance;
  joinedCount: number; // 알람이 하나라도 켜진 참여 수
  iJoined: boolean; // 내가 참여(알람 켜짐) — 아니면 '알람 없음'
  past: boolean; // 이미 지난 약속 — [내 알람 만들기] · 고치기 막힘('지난 약속이에요')
  mine: boolean; // 내가 만든 약속 — 기록일 뿐 권한 판단에 안 씀 (#619, 고치기 · 지우기 · 빠지기는 그룹원 누구나)
  creatorUnknown: boolean; // 만든 사람이 탈퇴함 (9-아 · 9-27)
};

// G02 연결 일정 참여자 줄 — 참여 / 알람 없음 두 가지, 차단 쌍은 이름만(HIDDEN) (9-42 · 9-33)
export type AppointmentJoiner = { person: Person; isMe: boolean; state: 'JOINED' | 'NO_ALARM' | 'HIDDEN' };

export type GroupDetail = {
  id: string;
  name: string;
  since: string; // 2025년 3월부터 함께하는 중
  grants: PermissionSet; // 그룹 공유 범위 (내가 준 권한)
  appointments: GroupAppointment[]; // 연결 일정 (여러 개일 수 있음, 오늘부터)
  members: GroupMember[]; // 참여 중인 사람만 (초대 중은 + 초대 시트에서) — 그룹장 표시 없음 (5장)
  wakeShareOptIn: boolean; // 이 그룹에 내 기상 상태 공유를 동의했는지 (group_members.wake_share_opt_in — F03 그룹 관계의 기상 스위치와 같은 값)
  tripShareOptIn: boolean; // 이 그룹에 내 출발 · 도착 공유를 동의했는지 (group_members.trip_share_opt_in, 기본 끔 — 기상 공유가 꺼지면 같이 꺼짐)
  notificationsOff: boolean; // 이 그룹에서 오는 알림 끄기 (group_members.notifications_off)
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
  firstAlarmId?: string; // 제안을 보낼 때 가리키는 알람(켜져 있고 아직 안 울린 가장 이른 것) — 없으면 시각 제안 불가
  proposeAt?: Date; // 그 알람의 지금 시각 (고른 시각 초안의 기준)
  originalAt?: Date | null; // 친구가 바꾸기 전 원래 시각(합계 ±60분 기준, [원래대로]) — 비어 있으면 아직 바뀐 적 없음
  proposal?: SentProposal | null; // 내가 보낸 제안의 지금 상태 ('제안함' · '반영됨')
};

// 내가 이 알람에 보낸 가장 최근 제안 — PENDING은 '제안함'(주인이 무시해도 서버가 PENDING으로 돌려줘 보낸 쪽에는 안 알림), APPLIED는 '반영됨' (친구 10장 10-파)
export type SentProposal = { status: 'PENDING' | 'APPLIED'; toAt: Date };

// 홈에 뜨는 받은 제안 카드 '수연 제안 기상 알람 7:30 → 7:00 [적용] [무시]'
export type AlarmProposal = { id: string; proposerName: string; kindLabel: string; fromAt: Date; toAt: Date };

export type ProposalResponse = 'APPLIED' | 'DISMISSED' | 'EXPIRED';

// G03 그룹원 기상 상태 — 알람 시각 · 확인 시각 · (공유했으면) 출발 · 도착 시각. 알람 카드(강도 · 장소 · 준비)는 알람 조회 권한이 있을 때 G04에서 (7-다 · 7-41)
export type MemberWake = {
  person: Person;
  groupName: string; // 공유 범위 안내
  state: WakeState;
  alarmAt: Date | null; // 그날 첫 기상 알람 시각
  confirmedAt: Date | null;
  prepareAlarmAt: Date | null; // 준비 알람 시각 · 준비 시작(준비 알람 해제) 시각 — 출발 · 도착 공유를 켰을 때만 (기상 알람이 없는 날은 준비 알람부터)
  prepareStartedAt: Date | null;
  departedAt: Date | null; // 출발 · 도착은 상대가 출발 · 도착 공유를 켰을 때만 옴 (장소 · 감지 출처는 안 옴)
  arrivedAt: Date | null;
  tripVisible: boolean; // 상대가 이 그룹에 출발 · 도착 공유를 켰음 — G03 공유 범위 글자
  canViewAlarm: boolean; // 알람 조회 권한 → [알람 보기] (G04)
  noGroupAppointment: boolean; // 그날 이 그룹 약속이 없어 기상 상태를 주지 않는 날 (D57 — 공유 안 함과 다름)
};

// G03 [깨우기] 보낸 결과 (친구 8장) — 서버 notify 응답의 ping.status. 버튼 상태는 보내 봐야 알 수 있음(읽기 전용 조회가 없음)
//   OK = 보냄(count/limit = 오늘 몇 번째, nextAt = 다음 가능 시각) · WAIT = 5분 안에 또 누름 · DAILY_LIMIT = 하루 3번 다 씀 · OFF = 받기를 꺼 뒀거나 보낼 수 없음(구분 안 함)
//   NOT_RINGING = 아직 안 울림 · ALREADY_UP = 이미 일어남 · NO_TOKENS = 알림이 닿지 않음(횟수 안 셈)
export type WakePingResult =
  | { status: 'OK'; count: number; limit: number; nextAt: Date | null }
  | { status: 'WAIT'; nextAt: Date | null }
  | { status: 'DAILY_LIMIT' }
  | { status: 'NOT_RINGING' | 'ALREADY_UP' | 'OFF' | 'NO_TOKENS' };

// 홈 · H08 '수연님이 7:12에 깨웠어요' — 오늘 내가 받은 깨우기, 최신 순 (my_wake_pings)
export type ReceivedWakePing = { senderId: string; senderName: string; at: Date };

export type SharedAlarms = {
  person: Person;
  canView: boolean; // 알람 조회 권한 — 없으면 alarms는 빈 목록 (RLS와 같게)
  canEdit: boolean;
  tags: string[]; // 조회 · 친구, 설정 · 친구 …
  alarms: MemberAlarm[];
};


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

// 그룹을 만든 결과 — 만들고 바로 초대 글을 보낼 수 있게 (코드는 8자, 7일)
export type CreatedGroup = { id: string; inviteCode: string; expiresAt: Date | null };

// 코드 입력 미리보기 (preview_group_by_code) — 참여는 아직 안 함. 오류 3가지(없는 · 만료 · 잠시 뒤)는 status로
export type GroupPreview =
  | { status: 'FOUND'; name: string; memberCount: number; full: boolean; alreadyJoined: boolean; expiresAt: Date | null }
  | { status: 'NOT_FOUND' | 'EXPIRED' }
  | { status: 'LIMIT'; retryAfterSeconds: number };

// 참여한 그룹 — already = 이미 참여 중이던 그룹 (같은 코드를 또 넣음)
export type JoinedGroup = { id: string; already: boolean };

// G01 위 받은 초대 카드 (my_group_invites) — 그룹 이름 · 인원 · 초대한 사람까지만
export type GroupInvite = { groupId: string; name: string; initial: string; memberCount: number; invitedByName: string; invitedAt: Date };

// 코드 시트 (my_group_code) — 만료됐으면 서버가 새 코드 + 7일로 바꿔서 줌
export type GroupCode = { code: string; expiresAt: Date };

// G02 [+ 초대] 친구 목록의 한 줄 — 초대 중 · 이미 멤버는 표시만
export type InvitableFriend = { person: Person; state: 'NONE' | 'INVITED' | 'MEMBER' };

// 차단 목록 한 줄 (my_blocks) — 새로 차단한 순
export type BlockedPerson = { person: Person; blockedAt: Date };

// 신고 (submit_report) — 대상은 사람(닉네임 · 사진 · 괴롭힘) 또는 그룹(그룹 이름)
export type ReportTarget = { type: 'USER' | 'GROUP'; id: string };
export type ReportReason = 'HARASSMENT' | 'NICKNAME' | 'PHOTO' | 'GROUP_NAME' | 'OTHER';
export type ReportResult = 'REPORTED' | 'ALREADY_REPORTED'; // 같은 대상은 하루 1번
