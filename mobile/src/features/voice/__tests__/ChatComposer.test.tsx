import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { Platform, Text as RNText, StyleSheet, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatComposer, type VoiceState } from '../components/ChatComposer';

// AI 대화 입력 칸 — 음성 모드(마이크 · 상태 글) / 글 모드(숨은 글로 잰 높이 한 줄 44 ~ 5줄 124, 웹 Enter 보내기)
const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
});

function render(o: { text?: string; mode?: 'voice' | 'text'; voice?: VoiceState } = {}) {
  const onSend = jest.fn();
  const onToggleMode = jest.fn();
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      createElement(ChatComposer, {
        mode: o.mode ?? 'text',
        onToggleMode,
        voice: o.voice ?? 'idle',
        micDisabled: false,
        onSpeak: () => {},
        inputVisible: true,
        canSay: true,
        text: o.text ?? '안녕하세요',
        onChangeText: () => {},
        onSend,
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
  const button = (label: string) => r.root.find((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  const texts = () => r.root.findAll((n) => typeof n.props.children === 'string').map((n) => n.props.children);
  return { r, input, measured, height, key, button, texts, onSend, onToggleMode };
}

describe('ChatComposer 음성 모드', () => {
  it('입력칸 · 완료 없이 키보드 버튼 · 마이크, 상태에 따라 아래 글이 바뀜', () => {
    const v = render({ mode: 'voice' });
    expect(v.r.root.findAllByType(TextInput)).toHaveLength(0);
    expect(v.texts()).toContain('말하기');
    expect(v.texts()).not.toContain('완료');
    act(() => v.button('글로 쓰기').props.onPress());
    expect(v.onToggleMode).toHaveBeenCalled();
    expect(render({ mode: 'voice', voice: 'listening' }).texts()).toContain('듣고 있어요');
    expect(render({ mode: 'voice', voice: 'speaking' }).texts()).toContain('AI가 말하고 있어요');
  });
});

describe('ChatComposer 입력칸 높이', () => {
  it('한 줄은 44(버튼과 같음), 줄이 늘면 커지고 5줄(124)에서 멈춤, 줄면 다시 줄어듦', () => {
    const v = render();
    v.measured(20);
    expect(v.height()).toBe(44);
    v.measured(60);
    expect(v.height()).toBe(84);
    v.measured(400);
    expect(v.height()).toBe(124);
    v.measured(20);
    expect(v.height()).toBe(44);
  });

  it('빈 글 · 공백만은 보내기를 막음', () => {
    expect(render({ text: '   ' }).button('보내기').props.disabled).toBe(true);
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
