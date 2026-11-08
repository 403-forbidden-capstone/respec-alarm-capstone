// 차단 · 신고 안내 글 — 지형님이 확인한 초안(11/8)의 문구 그대로 (시험: __tests__/blocks.test.ts, 시험케이스 4장)
import type { ReportReason, ReportResult } from './types';

export const BLOCK_TEXT = {
  title: (name: string) => `${name}님을 차단할까요?`,
  lines: [
    '친구가 끊기고 공유한 권한이 모두 사라져요.',
    '서로 검색 · 요청 · 초대 · 깨우기를 할 수 없어요.',
    '같은 그룹에서는 이름만 보이고 기상 상태는 가려져요.',
    '상대에게는 알리지 않아요.',
  ],
  ok: '차단',
  toast: '차단했어요',
} as const;

export const UNBLOCK_TEXT = {
  title: (name: string) => `${name}님 차단을 풀까요?`,
  body: '풀어도 다시 친구가 되지는 않아요. 친구는 새 요청부터 시작해요. 상대가 나를 차단했다면 서로 안 보이는 상태는 그대로예요.',
  ok: '풀기',
  toast: '차단을 풀었어요',
} as const;

// 신고 사유 — 서버 값(submit_report) 그대로. 사람은 4가지, 그룹은 3가지 (사유를 고르기 전에는 [신고하기]가 흐림)
export const REPORT_REASONS: Record<'USER' | 'GROUP', readonly { value: ReportReason; label: string }[]> = {
  USER: [
    { value: 'HARASSMENT', label: '괴롭힘이나 불쾌한 행동' },
    { value: 'NICKNAME', label: '부적절한 닉네임' },
    { value: 'PHOTO', label: '부적절한 사진' },
    { value: 'OTHER', label: '기타' },
  ],
  GROUP: [
    { value: 'GROUP_NAME', label: '부적절한 그룹 이름' },
    { value: 'HARASSMENT', label: '괴롭힘이나 불쾌한 행동' },
    { value: 'OTHER', label: '기타' },
  ],
};

export const REPORT_NOTE_MAX = 200;

export function reportToast(result: ReportResult): string {
  return result === 'REPORTED' ? '신고했어요' : '오늘은 이미 신고한 대상이에요';
}
