// 친구가 내 알람 바꾸기 = 제안 (친구 10장) — G04 보내기 · 홈 제안 카드 문구
//   서버 상태(propose_alarm_time · respond_alarm_proposal)를 문구로. 곧 울릴 알람 · ±60분 · 같은 시각은 이유를 알려 주고, 권한이 없거나 안 보이는 알람은 구분 없이 한 문구
import { formatTime } from '@/lib/format';

import type { SentProposal } from './types';

export const PROPOSE_SENT = '제안을 보냈어요';
export const PROPOSE_SENT_NO_PUSH = '제안을 보냈어요. 상대 폰에는 알림이 닿지 않았어요';
export const PROPOSE_TOO_SOON = '곧 울릴 알람이라 지금은 제안할 수 없어요';
export const PROPOSE_LIMIT = '원래 시각에서 1시간(±60분) 안에서만 제안할 수 있어요';
export const PROPOSE_SAME = '지금 시각과 같아요';
export const PROPOSE_FORBIDDEN = '이 알람은 바꿀 수 없어요';
export const PROPOSE_INVALID = '시각을 확인해 주세요';
export const PROPOSE_NOTE = (name: string) => `제안을 보내면 ${name}님에게 알림이 가요. ${name}님이 적용해야 바뀌어요.`;

export const PROPOSAL_APPLIED = '알람을 새 시각으로 바꿨어요';
export const PROPOSAL_DISMISSED = '무시했어요. 상대에게는 알리지 않아요';
export const PROPOSAL_EXPIRED = '이미 지나간 제안이에요';
export const PROPOSAL_GONE = '이미 처리된 제안이에요';
export const PROPOSAL_LIMIT = '원래 시각에서 1시간 넘게는 바꿀 수 없어요';
export const PROPOSAL_FAILED = '처리하지 못했어요. 다시 해 주세요';

// G04 카드 한 줄 — '제안함 · 7:00' / '반영됨 · 7:00'
export function proposalLine(p: SentProposal | null | undefined): string | null {
  if (!p) return null;
  return p.status === 'APPLIED' ? `반영됨 · ${formatTime(p.toAt)}` : `제안함 · ${formatTime(p.toAt)}`;
}

// 받은 제안 카드 본문 — '기상 알람 7:30 → 7:00'
export const proposalChange = (kindLabel: string, fromAt: Date, toAt: Date) => `${kindLabel} 알람 ${formatTime(fromAt)} → ${formatTime(toAt)}`;
