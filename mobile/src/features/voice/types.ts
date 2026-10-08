// ③ 수면 전후 음성 AI — 이 기능에서 쓰는 타입
// 이름은 DB(conversation_sessions)를 따르고, 화면에 바로 쓰기 좋게 모양만 바꿈
import type { Importance } from '@/features/alarm/types';
import type { ApplyStatus } from '@/features/routine/types';

export type { ApplyStatus } from '@/features/routine/types'; // PENDING · APPLIED · REJECTED

// 대화 한 줄 — card = AI가 대화에서 찾은 일정 카드 (내용은 Conversation.found)
export type ChatMessage = {
  id: string;
  who: 'ai' | 'me' | 'card';
  text: string; // card면 빈 글자
  at: Date;
};

// 대화에서 찾은 일정 (conversation_sessions.extracted_data · apply_status)
export type FoundSchedule = {
  title: string;
  at: Date; // 약속 시각
  place: string;
  items: string[]; // 준비물 — 찾자마자 준비물 목록에 넣음
  importance: Importance; // 찾은 중요도 — 알람 강도로 이어짐 (#42 "중요도 높음 → 알람")
  question: string; // 내일 오후 2시 스터디로 저장할까요?
  status: ApplyStatus; // 저장 = APPLIED, 저장 안 함 = REJECTED
};

// 다음 차례 — 내 말(대본 문장) · AI 답 · 대본 끝(null)
export type NextTurn = { who: 'me'; text: string } | { who: 'ai' } | null;

export type Conversation = {
  messages: ChatMessage[];
  next: NextTurn;
  found: FoundSchedule | null;
};
