// 시험용 행 묶음 — supabase/seed/data.mjs의 데모 상황을 줄여 옮김 (나 · 수연 · 지형 · 준성, 캡스톤팀)
//   · 나↔수연 친구(수락), 지형→나 친구(수락), 준성→나 요청(대기)
//   · 캡스톤팀(지형이 만듦): 기상 공유 동의 — 나 · 수연 · 지형 켬, 준성 끔
//   · 수연 → 나: 친구(조회 · 설정 · 기상) + 그룹(조회 · 기상), 지형 → 나: 친구(조회 · 기상) + 그룹(기상), 준성 → 나: 그룹(기상, 동의가 꺼져 있어 효력 없음)
//   · 나 → 수연: 친구(조회) + 그룹(기상), 나 → 지형: 그룹(기상)
import type { FriendRow, MemberRow, PermRow } from '../grants';
import type { ProfileRow } from '../map';
import type { GroupRow, Snapshot } from '../snapshot';

export const ME = '00000000-0000-4000-8000-000000000001';
export const SUYEON = '00000000-0000-4000-8000-000000000002';
export const JIHYEONG = '00000000-0000-4000-8000-000000000003';
export const JUNSEONG = '00000000-0000-4000-8000-000000000004';
export const GROUP = '10000000-0000-4000-8000-000000000001';
export const F_SUYEON = '20000000-0000-4000-8000-000000000001';
export const F_JIHYEONG = '20000000-0000-4000-8000-000000000002';
export const F_JUNSEONG = '20000000-0000-4000-8000-000000000003';

const profile = (user_id: string, nickname: string, handle: string): ProfileRow => ({ user_id, nickname, handle, profile_image_url: null });

export const profiles: ProfileRow[] = [
  profile(ME, '나(데모)', 'demo_me'),
  profile(SUYEON, '수연', 'demo_suyeon'),
  profile(JIHYEONG, '지형', 'demo_jihyeong'),
  profile(JUNSEONG, '준성', 'demo_junseong'),
];

export const friends: FriendRow[] = [
  { friend_id: F_SUYEON, requester_id: ME, addressee_id: SUYEON, status: 'ACCEPTED', requested_at: '2026-10-01T00:00:00.000Z' },
  { friend_id: F_JIHYEONG, requester_id: JIHYEONG, addressee_id: ME, status: 'ACCEPTED', requested_at: '2026-10-02T00:00:00.000Z' },
  { friend_id: F_JUNSEONG, requester_id: JUNSEONG, addressee_id: ME, status: 'PENDING', requested_at: '2026-10-03T00:00:00.000Z' },
];

export const groups: GroupRow[] = [
  { group_id: GROUP, group_name: '캡스톤팀', created_at: '2026-03-05T00:00:00.000Z' },
];

const member = (user_id: string, wake_share_opt_in: boolean, joined_at = '2026-03-05T00:00:00.000Z'): MemberRow => ({
  group_id: GROUP,
  user_id,
  invite_status: 'JOINED',
  wake_share_opt_in,
  joined_at,
  notifications_off: false,
});
// 나는 4월에 들어옴 — G02 '4월부터 함께'는 내 참여 일시 (5-41)
export const members: MemberRow[] = [member(ME, true, '2026-04-20T00:00:00.000Z'), member(SUYEON, true), member(JIHYEONG, true), member(JUNSEONG, false)];

type Flags = { alarm?: boolean; edit?: boolean; wake?: boolean };
const perm = (owner_id: string, grantee_id: string, source_type: 'FRIEND' | 'GROUP', source_id: string, v: Flags): PermRow => ({
  owner_id,
  grantee_id,
  source_type,
  source_id,
  can_view_alarm: !!v.alarm,
  can_edit_alarm: !!v.edit,
  can_view_wake: !!v.wake,
});

export const perms: PermRow[] = [
  perm(SUYEON, ME, 'FRIEND', F_SUYEON, { alarm: true, edit: true, wake: true }),
  perm(ME, SUYEON, 'FRIEND', F_SUYEON, { alarm: true }),
  perm(JIHYEONG, ME, 'FRIEND', F_JIHYEONG, { alarm: true, wake: true }),
  perm(SUYEON, ME, 'GROUP', GROUP, { alarm: true, wake: true }),
  perm(JIHYEONG, ME, 'GROUP', GROUP, { wake: true }),
  perm(JUNSEONG, ME, 'GROUP', GROUP, { wake: true }),
  perm(ME, SUYEON, 'GROUP', GROUP, { wake: true }),
  perm(ME, JIHYEONG, 'GROUP', GROUP, { wake: true }),
];

export const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ me: ME, friends, groups, members, perms, profiles, ...over });
