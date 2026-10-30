import { describe, expect, it } from '@jest/globals';

import { noticeActions, noticeCopy, primaryAction } from '../chatNotice';

const all = { hasRetry: true, hasManual: true, hasDone: true };

describe('noticeCopy', () => {
  it('failed · limit 제목이 정해진 문구', () => {
    expect(noticeCopy('failed').title).toBe('AI가 지금 답하지 못해요');
    expect(noticeCopy('limit').title).toBe('오늘 대화는 여기까지예요');
  });

  it('limit 본문에 하루 기록을 만든다는 줄이 있음', () => {
    expect(noticeCopy('limit').body).toContain('하루 기록을 만들어요');
  });

  it('기술 단어를 쓰지 않음', () => {
    for (const kind of ['failed', 'limit'] as const) {
      const { title, body } = noticeCopy(kind);
      expect(`${title}${body}`).not.toMatch(/오류|실패|에러/);
    }
  });
});

describe('noticeActions', () => {
  it('failed — 다시 시도가 1차, 그다음 직접 만들기 · 마치기', () => {
    expect(noticeActions('failed', all)).toEqual(['retry', 'manual', 'done']);
    expect(primaryAction('failed')).toBe('retry');
  });

  it('limit — 대화 마치기가 1차, 다시 시도는 콜백이 있어도 없음', () => {
    expect(noticeActions('limit', all)).toEqual(['done', 'manual']);
    expect(primaryAction('limit')).toBe('done');
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
