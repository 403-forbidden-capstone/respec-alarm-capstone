import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { Platform, Text as RNText, StyleSheet, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatComposer } from '../components/ChatComposer';

// AI 대화 글 입력칸 — 숨은 글로 잰 높이(한 줄 38 ~ 5줄 118), 웹 Enter는 보내기(Shift+Enter · 한글 조합 중은 아님)
const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
});

function render(text = '안녕하세요') {
  const onSend = jest.fn();
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      createElement(ChatComposer, {
        status: '',
        mode: 'text',
        inputVisible: true,
        canSay: true,
        listening: false,
        text,
        onChangeText: () => {},
        onSend,
        onToggleMode: () => {},
        onSpeak: () => {},
        onDone: () => {},
      }),
    );
  });
  const input = () => r.root.findByType(TextInput);
  const measured = (height: number) =>
    act(() => r.root.findAll((n) => n.type === RNText && n.props['aria-hidden'])[0].props.onLayout({ nativeEvent: { layout: { height } } }));
  const height = () => StyleSheet.flatten(input().props.style).height;
  const key = (k: { key: string; shiftKey?: boolean; isComposing?: boolean }) => {
    const preventDefault = jest.fn();
    act(() => input().props.onKeyPress?.({ nativeEvent: { shiftKey: false, isComposing: false, ...k }, preventDefault }));
    return preventDefault;
  };
  return { input, measured, height, key, onSend };
}

describe('ChatComposer 입력칸 높이', () => {
  it('한 줄은 38, 줄이 늘면 커지고 5줄(118)에서 멈춤, 줄면 다시 줄어듦', () => {
    const v = render();
    v.measured(20);
    expect(v.height()).toBe(38);
    v.measured(60);
    expect(v.height()).toBe(78);
    v.measured(400);
    expect(v.height()).toBe(118);
    v.measured(20);
    expect(v.height()).toBe(38);
  });
});

describe('ChatComposer 웹 Enter', () => {
  it('Enter는 보내고 줄바꿈을 막음, Shift+Enter · 한글 조합 중 Enter는 그대로 둠', () => {
    Platform.OS = 'web';
    const v = render();
    expect(v.key({ key: 'Enter', shiftKey: true })).not.toHaveBeenCalled();
    expect(v.key({ key: 'Enter', isComposing: true })).not.toHaveBeenCalled();
    expect(v.key({ key: 'a' })).not.toHaveBeenCalled();
    expect(v.onSend).not.toHaveBeenCalled();
    expect(v.key({ key: 'Enter' })).toHaveBeenCalled();
    expect(v.onSend).toHaveBeenCalledTimes(1);
  });

  it('앱(Android)은 키 처리를 붙이지 않음 — 보내기는 submitBehavior가 맡음', () => {
    Platform.OS = 'android';
    expect(render().input().props.onKeyPress).toBeUndefined();
  });
});
