// 그룹 5장 문구 · 상태 → 문구 (친구_논리설계.md 5장, 시험: __tests__/groups.test.ts)
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
  title: '기상 상태를 그룹에 공유할까요?',
  body: '그룹 사람들이 내가 일어났는지 볼 수 있어요. 알람 내용은 공유되지 않아요.',
  share: '공유',
  later: '나중에',
};

export const LEFT_TOAST = '그룹에서 나왔어요';
export const MEMBER_REMOVED_TOAST = '그룹에서 내보냈어요';
export const RENAMED_TOAST = '이름을 바꿨어요';

// 나가기 확인창 — 공동 약속 알람 n개도 지워져요 (논리설계 5장 화면), 마지막 사람이면 그룹이 사라진다고 알림 (5-44)
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

export const inviteShareMessage = (groupName: string, code: string, expiresLabel: string | null) =>
  `Re:Spec 알람 '${groupName}' 그룹에 초대해요. 초대 코드: ${code}${expiresLabel ? ` (${expiresLabel}까지)` : ''}`;
