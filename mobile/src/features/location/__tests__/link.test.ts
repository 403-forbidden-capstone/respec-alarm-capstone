import { describe, expect, it } from '@jest/globals';

import { buildDetectionLink, detectionNoticeId, parseDetectionLink, parseDetectionParams } from '../link';

// 감지 안내 알림 ↔ 정정 화면 주소 — 만든 주소는 다시 읽히고, 낯선 주소는 거름
const LINK = { kind: 'DEPART', participantId: 'p-1', at: 1_748_000_000_000 } as const;

describe('감지 안내 주소 (link)', () => {
  it('buildDetectionLink: respecalarm://detection?kind&participantId&at', () => {
    expect(buildDetectionLink(LINK)).toBe('respecalarm://detection?kind=DEPART&participantId=p-1&at=1748000000000');
  });

  it('만든 주소를 다시 읽으면 같은 값 (특수문자 id도)', () => {
    for (const link of [LINK, { kind: 'ARRIVE', participantId: 'a b&c=d/é', at: 5 } as const]) {
      expect(parseDetectionLink(buildDetectionLink(link))).toEqual(link);
    }
  });

  it('앱 안 경로(/detection?…)도 읽음', () => {
    expect(parseDetectionLink('/detection?kind=ARRIVE&participantId=x&at=10')).toEqual({ kind: 'ARRIVE', participantId: 'x', at: 10 });
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'respecalarm://other?kind=DEPART&participantId=x&at=1',
    'https://detection?kind=DEPART&participantId=x&at=1',
    'respecalarm://detection',
    'respecalarm://detection?kind=LEAVE&participantId=x&at=1',
    'respecalarm://detection?kind=DEPART&at=1',
    'respecalarm://detection?kind=DEPART&participantId=x&at=abc',
    'respecalarm://detection?kind=DEPART&participantId=x&at=-5',
    'respecalarm://detection?kind=DEPART&participantId=%E0%A4%A&at=1',
  ])('모양이 틀리면 null: %s', (url) => {
    expect(parseDetectionLink(url)).toBeNull();
  });

  it('parseDetectionParams: 배열 쿼리는 첫 값, 빠지면 null', () => {
    expect(parseDetectionParams({ kind: ['DEPART', 'ARRIVE'], participantId: 'x', at: '7' })).toEqual({ kind: 'DEPART', participantId: 'x', at: 7 });
    expect(parseDetectionParams({ kind: 'DEPART', participantId: 'x' })).toBeNull();
    expect(parseDetectionParams({})).toBeNull();
  });

  it('detectionNoticeId: 같은 판정은 같은 번호, 종류 · 시각이 다르면 다른 번호', () => {
    expect(detectionNoticeId(LINK)).toBe('detect-DEPART-p-1-1748000000000');
    expect(detectionNoticeId({ ...LINK })).toBe(detectionNoticeId(LINK));
    expect(detectionNoticeId({ ...LINK, kind: 'ARRIVE' })).not.toBe(detectionNoticeId(LINK));
    expect(detectionNoticeId({ ...LINK, at: LINK.at + 1 })).not.toBe(detectionNoticeId(LINK));
  });
});
