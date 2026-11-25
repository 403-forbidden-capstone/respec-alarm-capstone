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
    r = create(createElement(FoundScheduleCard, {
      card: c, at: new Date(2026, 9, 29, 22, 0), onSave: () => {}, onReject: () => {}, onPickGroup,
      onPickPlace: () => {}, onSaveWithoutPlace: () => {},
    }));
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

  it('장소를 못 찾은 일정에서는 장소 고르기만 보여 주고 장소 없이 저장은 숨긴다', () => {
    const v = render(card({ status: 'NEEDS_PLACE', place: '' }));
    expect(v.text).toContain('장소 고르기');
    expect(v.text).not.toContain('장소 없이 저장');
  });

  it('없는 그룹(가족)이면 찾을 수 없다는 안내와 개인 일정 칩만 — 다른 그룹 칩 없음', () => {
    const v = render(card({ group: { choice: 'ASK', id: null, candidates: [], missing: '가족' } }));
    expect(v.text).toContain('가족 그룹을 찾을 수 없어요. 그룹을 만들거나 개인 일정으로 등록해 주세요');
    expect(v.text).not.toContain('캡스톤 그룹');
    v.press('개인 일정');
    expect(v.onPickGroup.mock.calls).toEqual([[null]]);
  });
});

describe('FoundScheduleCard 일정 변경 카드 (APPT_OPEN)', () => {
  const change = (over: Partial<ConversationCard> = {}) =>
    card({ kind: 'APPT_OPEN', group: null, change: { before: { title: '캡스톤 회의', time: '10:30', place: '학교' }, after: { time: '11:00', place: '강남역' } }, ...over });

  it('지금 → 바뀔 값 줄과 [변경하기] · [변경 안 함] — [일정 열기]는 없음', () => {
    const v = render(change());
    expect(v.text).toContain('캡스톤 회의');
    expect(v.text).toContain('학교 → 강남역');
    expect(v.text).toContain('변경하기');
    expect(v.text).toContain('변경 안 함');
    expect(v.text).not.toContain('일정 열기');
  });

  it('끝난 뒤에는 결과만', () => {
    expect(render(change({ status: 'SAVED' })).text).toContain('일정을 바꿨어요');
    expect(render(change({ status: 'REJECTED' })).text).toContain('바꾸지 않았어요');
  });
});
