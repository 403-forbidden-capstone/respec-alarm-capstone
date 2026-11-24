import { describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { Text as RNText } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { FoundScheduleCard } from '../components/FoundScheduleCard';
import type { ConversationCard } from '../types';

// 새 일정 카드의 그룹 · 개인 일정 칩 — 고르기 전(ASK)이면 안내, 칩을 누르면 그 그룹 id(개인은 null)
const card = (over: Partial<ConversationCard> = {}): ConversationCard => ({
  id: 'c1', kind: 'APPT_NEW', status: 'READY', firstOfDay: true, highlight: false, summary: '', title: '캡스톤 회의',
  at: new Date(2026, 9, 30, 10, 30), place: '학교', importance: null, items: [], alarms: [], question: null, error: null, appointmentId: null,
  group: { choice: 'ASK', id: null, candidates: [{ id: 'g-cap', name: '캡스톤' }] },
  ...over,
});

function render(c: ConversationCard, onPickGroup = jest.fn<(id: string | null) => void>()) {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(createElement(FoundScheduleCard, { card: c, at: new Date(2026, 9, 29, 22, 0), onSave: () => {}, onReject: () => {}, onPickGroup }));
  });
  // Text가 한국어 줄바꿈용으로 끼우는 U+2060을 빼고 화면 글 전체를 한 줄로
  const textOf = (n: ReactTestInstance): string => n.findAllByType(RNText).flatMap((t) => [t.props.children].flat()).filter((x) => typeof x === 'string').join('').replace(/⁠/g, '');
  const text = textOf(r.root);
  const press = (label: string) => act(() => r.root.findAll((n) => n.props.accessibilityRole === 'tab' && textOf(n) === label)[0].props.onPress());
  return { text, press, onPickGroup };
}

describe('FoundScheduleCard 그룹 칩', () => {
  it('고르기 전이면 안내와 개인 · 그룹 칩, 누르면 그룹 id · 개인은 null', () => {
    const v = render(card());
    expect(v.text).toContain('그룹 일정인지 개인 일정인지 골라 주세요');
    v.press('캡스톤 그룹');
    v.press('개인 일정');
    expect(v.onPickGroup.mock.calls).toEqual([['g-cap'], [null]]);
  });

  it('저장된 그룹 일정은 칩 대신 그룹 줄 · 그룹 말이 없는 카드는 칩 없음', () => {
    const saved = render(card({ status: 'SAVED', group: { choice: 'GROUP', id: 'g-cap', candidates: [{ id: 'g-cap', name: '캡스톤' }] } }));
    expect(saved.text).toContain('그룹캡스톤 내 알람만');
    expect(saved.text).not.toContain('캡스톤 그룹');
    expect(render(card({ group: null })).text).not.toContain('개인 일정');
  });
});
