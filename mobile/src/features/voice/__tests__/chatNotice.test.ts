import { describe, expect, it } from '@jest/globals';

import { noticeActions, noticeCopy, primaryAction, type NoticeKind } from '../chatNotice';

const all = { hasRetry: true, hasManual: true, hasDone: true };
const KINDS: NoticeKind[] = ['failed', 'busy', 'limit', 'turn'];

describe('noticeCopy', () => {
  it('종류마다 정해진 제목 — 분당 · 하루 · 대화 길이 제한이 서로 다른 글', () => {
    expect(noticeCopy('failed').title).toBe('AI가 지금 답하지 못해요');
    expect(noticeCopy('busy').title).toBe('지금 AI 요청이 몰렸어요');
    expect(noticeCopy('limit').title).toBe('오늘 AI 대화는 여기까지예요');
    expect(noticeCopy('turn').title).toBe('오늘 대화가 길어져서 여기까지예요');
    expect(new Set(KINDS.map((k) => noticeCopy(k).title)).size).toBe(KINDS.length);
  });

  it('분당은 잠시 뒤 다시, 하루는 사용량 · 내일, 대화 길이는 내일 새 대화', () => {
    expect(noticeCopy('busy').body).toContain('1분쯤 뒤에');
    expect(noticeCopy('limit').body).toContain('사용량을 다 썼어요');
    expect(noticeCopy('turn').body).toContain('내일 새 대화에서 이어가요');
  });

  it('한도(limit · turn) 본문에 하루 기록을 만든다는 줄이 있음', () => {
    expect(noticeCopy('limit').body).toContain('하루 기록을 만들어요');
    expect(noticeCopy('turn').body).toContain('하루 기록을 만들어요');
  });

  it('기술 단어를 쓰지 않음', () => {
    for (const kind of KINDS) {
      const { title, body } = noticeCopy(kind);
      expect(`${title}${body}`).not.toMatch(/오류|실패|에러|RPM|429/);
    }
  });
});

describe('noticeActions', () => {
  it('failed · busy — 다시 시도가 1차, 그다음 직접 만들기 · 마치기', () => {
    for (const kind of ['failed', 'busy'] as const) {
      expect(noticeActions(kind, all)).toEqual(['retry', 'manual', 'done']);
      expect(primaryAction(kind)).toBe('retry');
    }
  });

  it('limit · turn — 대화 마치기가 1차, 다시 시도는 콜백이 있어도 없음', () => {
    for (const kind of ['limit', 'turn'] as const) {
      expect(noticeActions(kind, all)).toEqual(['done', 'manual']);
      expect(primaryAction(kind)).toBe('done');
    }
  });

  it('콜백이 없는 버튼은 뺌', () => {
    expect(noticeActions('failed', { hasRetry: true })).toEqual(['retry']);
    expect(noticeActions('failed', { hasManual: true, hasDone: true })).toEqual(['manual', 'done']);
    expect(noticeActions('limit', { hasManual: true })).toEqual(['manual']);
  });

  it('아무 콜백도 없으면 빈 목록', () => {
    expect(noticeActions('failed', {})).toEqual([]);
    expect(noticeActions('limit', {})).toEqual([]);
    expect(noticeActions('limit', { hasRetry: true })).toEqual([]);
  });
});
