// 그룹 5장 문구 · 상태 → 문구 (친구_논리설계.md 5장, 시험: __tests__/groups.test.ts)
import { dateParts, formatTime } from '@/lib/format';

import { messageLimit } from './relationMessages';
import type { GroupPreview } from './types';

export const GROUP_NAME_MAX = 50;

// 코드 입력 오류 3가지 + 가득 · 이미 참여 — 미리보기에 그대로 보임 (5-12 · 5-13 · 5-14 · 5-34)
export const CODE_NOT_FOUND = '없는 코드예요';
export const CODE_EXPIRED = '만료된 코드예요';
export const GROUP_FULL = '가득 찼어요';
export const GROUP_TOO_MANY = '그룹은 10개까지 참여할 수 있어요';
export const GROUP_ALREADY = '이미 참여 중이에요';
export const GROUP_NOT_MEMBER = '참여 중인 그룹이 아니에요';

// 코드 입력은 공백 · 소문자를 맞춤. O/0 보정은 없음 (서버와 같게, 5-13)
export const cleanCode = (code: string) => code.replace(/\s+/g, '').toUpperCase();

// 앞뒤 공백을 자른 이름이 1~50자인지 — 문제가 있으면 이유
export function groupNameProblem(name: string): string | null {
  const t = name.trim();
  if (!t) return '그룹 이름을 입력해 주세요';
  if ([...t].length > GROUP_NAME_MAX) return `그룹 이름은 ${GROUP_NAME_MAX}자까지 쓸 수 있어요`;
  return null;
}

// 미리보기가 못 찾은 이유 (FOUND가 아닐 때)
export function previewProblem(p: GroupPreview): string | null {
  if (p.status === 'NOT_FOUND') return CODE_NOT_FOUND;
  if (p.status === 'EXPIRED') return CODE_EXPIRED;
  if (p.status === 'LIMIT') return messageLimit(p.retryAfterSeconds);
  return null;
}

// 참여 · 수락 동의 시트 — 참여할 때 한 번 묻고, 그룹 상세에서 바꿀 수 있음 (5-09 · 5-10)
export const CONSENT_TEXT = {
  title: '그룹에 내 기상을 공개할까요?', // 그룹 이름을 알면 consentTitle로 '{그룹 이름}에 …'
  body: '그룹 사람들이 내가 일어났는지 볼 수 있어요. 알람 내용은 공유되지 않아요.',
  share: '공개',
  later: '나중에',
};

export const consentTitle = (groupName?: string | null) => (groupName ? `${groupName}에 내 기상을 공개할까요?` : CONSENT_TEXT.title);

export const LEFT_TOAST = '그룹에서 나왔어요';
export const MEMBER_REMOVED_TOAST = '그룹에서 내보냈어요';
export const RENAMED_TOAST = '이름을 바꿨어요';

// 나가기 확인창 — 공동 약속 알람 n개도 지워져요 (논리설계 5장 화면), 마지막 사람이면 그룹이 사라진다고 알림 (5-44)
// H05 '함께할 그룹'을 고르면 그 줄 아래 — 메모 칸이 아직 없어 그룹원에게 보이는 것을 이 줄로 알림 (9-거, 빈 곳: 메모 칸)
export const SHARED_APPOINTMENT_NOTE = '일정 이름 · 시각 · 장소는 그룹원 모두에게 보여요. 알람은 각자 [내 알람 만들기]로 만들어요.';

// G02 연결 일정 줄 상태 — 내 알람 켜짐 / 내 알람 없음 두 가지(안 누름 · 빠짐 · 끔은 모두 없음), 지난 약속은 그 한 줄 (9-42 · 9-32)
//   '4명 참여 · 참여'처럼 같은 말이 겹쳐 보이던 것을 '4명 참여 · 내 알람 켜짐'으로 (11/19)
export const appointmentStateText = (a: { iJoined: boolean; past: boolean }) => (a.past ? PAST_APPOINTMENT : a.iJoined ? '내 알람 켜짐' : '내 알람 없음');
export const PAST_APPOINTMENT = '지난 약속이에요';
// 0명은 정말 없는 것일 수도, 차단한 사이라 내게 안 보이는 것일 수도 있어 '없다'고 단정하지 않음 (탐색 시험 ①-17)
export const joinedCountText = (n: number) => (n > 0 ? `${n}명 참여` : '보이는 참여자가 없어요');
// [내 알람 만들기] — 집 위치가 없어 이동시간을 못 구할 때 (보내기 전에 막음)
export const HOME_MISSING_JOIN_TOAST = '집 위치를 먼저 정해 주세요';
export const HOME_MISSING_JOIN_ACTION = '설정 열기';
// G01 받은 초대는 이만큼만 펼치고 나머지는 접음 (탐색 시험 X-BOUND-15)
export const INVITES_SHOWN = 3;
export const moreInvitesText = (n: number) => `초대 ${n}개 더 보기`;
export const CREATOR_UNKNOWN = '만든 사람 알 수 없음'; // 9-27 — 참여한 사람 누구나 고칠 수 있음
export const JOINED_TOAST = '내 알람을 만들었어요';
// [내 알람 만들기] 뒤 토스트 — 만든 기상 · 출발 시각이 있으면 같이 (D-16: '내 알람을 맞췄어요 · 기상 7:20 · 출발 8:30')
export function joinedToastText(result: { wakeAt?: Date | null; departAt?: Date | null }): string {
  const parts = [result.wakeAt ? `기상 ${formatTime(result.wakeAt)}` : null, result.departAt ? `출발 ${formatTime(result.departAt)}` : null].filter(Boolean);
  return parts.length ? `내 알람을 맞췄어요 · ${parts.join(' · ')}` : JOINED_TOAST;
}
// 공동 약속을 저장한 뒤 토스트 끝에 붙임 (D-13) — 그룹에 보인다는 것 · 그룹원은 각자 알람을 만든다는 것
export const sharedSavedToast = (base: string) => `${base} · 그룹에도 보여요. 그룹원은 각자 [내 알람 만들기]를 해요`;
export const LEFT_APPOINTMENT_TOAST = '이 약속에서 빠졌어요';
export const leaveAppointmentText = (title: string) => ({
  title: `${title}에서 빠질까요?`,
  body: '내 알람만 지워져요. 다른 사람에게 알림은 가지 않아요. 다시 [내 알람 만들기]로 참여할 수 있어요.',
  ok: '빠지기',
});

export function leaveText(groupName: string, alarmCount: number, last: boolean) {
  const lines: string[] = [];
  if (alarmCount > 0) lines.push(`공동 약속 알람 ${alarmCount}개도 지워져요.`);
  if (last) lines.push('내가 마지막 멤버라 그룹이 사라져요.');
  lines.push('다시 들어오려면 새 초대가 필요해요.');
  return { title: `${groupName}에서 나갈까요?`, body: lines.join('\n'), ok: '나가기' };
}

// 내보내기 확인창 — 코드가 바뀌고 상대에게는 알리지 않음 (5-19)
export function removeMemberText(name: string) {
  return { title: `${name}님을 내보낼까요?`, body: '그룹 코드가 새로 바뀌어요. 상대에게는 알리지 않아요.', ok: '내보내기' };
}

// 코드 시트 · 미리보기의 만료일 — '11/15까지' (한국 시간)
export function expiresLabel(date: Date): string {
  const { month, day } = dateParts(date);
  return `${month}/${day}까지`;
}

// 공유창에 뜨는 초대 글 — 만료일(예: '11/15까지')이 있으면 같이 (5-07 · 5-49)
export const inviteShareMessage = (groupName: string, code: string, expires: string | null) =>
  `Re:Spec 알람 '${groupName}' 그룹에 초대해요. 초대 코드: ${code}${expires ? ` (${expires})` : ''}`;

// F03 혼자인 그룹 저장 (6-18) — 줄 사람이 없어 저장이 안 됨. 가짜 성공을 보이지 않음
export const NO_MEMBERS = '이 그룹에는 나 말고 멤버가 없어요. 멤버가 들어오면 권한을 줄 수 있어요';
// F03 그룹 저장 중 알람 권한은 저장됐지만 기상 공유 동의만 바꾸지 못함 — 다시 저장하면 됨
export const CONSENT_FAILED = '알람 권한은 저장했지만 기상 공유 동의는 바꾸지 못했어요. 다시 저장해 주세요';
