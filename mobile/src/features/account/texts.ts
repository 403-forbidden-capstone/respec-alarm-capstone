// 계정 삭제 문구 (친구 12장) — 설정 [계정 삭제] 확인 두 번 · 웹 삭제 요청 안내 페이지
//   유예 없이 바로 삭제 — 확인 문구에 영향 요약(나갈 그룹 · 마지막 멤버라 사라질 그룹 · 남을 공동 약속 · 친구)과 '되돌릴 수 없어요'
import type { DeleteSummary } from './types';

export const DELETE_ACCOUNT_LABEL = '계정 삭제';

// 첫 번째 확인 — 영향 요약. 0인 줄은 빼고, 아무 영향이 없어도 '되돌릴 수 없어요'는 항상
export function deleteSummaryLines(s: DeleteSummary): string[] {
  const lines: string[] = [];
  if (s.groupsLeaving > 0) lines.push(`그룹 ${s.groupsLeaving}개에서 나가요.`);
  if (s.groupsDisappearing > 0) lines.push(`그중 내가 마지막 멤버라 사라질 그룹이 ${s.groupsDisappearing}개예요.`);
  if (s.groupAppointmentsStaying > 0) lines.push(`내가 만든 공동 약속 ${s.groupAppointmentsStaying}개는 남고, 만든 사람은 '알 수 없음'으로 보여요.`);
  if (s.friends > 0) lines.push(`친구 ${s.friends}명과 연결이 끊겨요.`);
  lines.push('내 알람 · 기록 · 일정 · 공유 권한이 모두 지워지고 되돌릴 수 없어요.');
  return lines;
}

export const DELETE_FIRST = (s: DeleteSummary) => ({
  title: '계정을 삭제할까요?',
  message: deleteSummaryLines(s).join('\n'),
  okLabel: '계속',
});

// 두 번째 확인 — 한 번 더 (실수로 누른 한 번으로 지워지지 않게)
export const DELETE_SECOND = {
  title: '정말 삭제할까요?',
  message: '삭제하면 바로 지워져요. 이 계정으로 다시 돌아올 수 없어요.',
  okLabel: '삭제',
};

export const DELETE_SUMMARY_FAILED = '삭제 전에 확인할 내용을 불러오지 못했어요. 다시 해 주세요';
export const DELETE_FAILED = '계정을 삭제하지 못했어요. 다시 해 주세요 (중간에 멈췄어도 다시 누르면 이어서 지워요)';
export const DELETED_TOAST = '계정을 삭제했어요';

// 웹 삭제 요청 안내 페이지 — 로그인 없이 보는 안내, 폼 없음. 팀 메일 주소는 답을 받으면 DELETION_MAIL에 적음 (친구 12-사, 지금은 비워 둠)
export const DELETION_MAIL: string | null = null;
export const DELETION_PAGE = {
  title: '계정 삭제 요청',
  lead: '앱을 쓸 수 있다면 설정 > 계정 삭제에서 바로 지울 수 있어요. 앱을 쓸 수 없을 때는 메일로 요청해 주세요.',
  mailLabel: '요청 메일 주소',
  mailMissing: '메일 주소를 준비하고 있어요.',
  sendTitle: '메일에 적어 주세요',
  sendItems: ['가입한 이메일', '앱에서 쓰는 아이디(설정에서 볼 수 있어요)'],
  timing: '가입한 이메일에서 보낸 메일만 처리해요. 요청을 받으면 30일 안에 지워요.',
  scope: '지우면 내 알람 · 기록 · 일정 · 친구 · 공유 권한이 모두 사라지고 되돌릴 수 없어요.',
};
