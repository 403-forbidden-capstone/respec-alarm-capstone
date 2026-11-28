import { describe, expect, it } from '@jest/globals';
import { BottomTabBarHeightContext } from 'expo-router/js-tabs';
import { createElement } from 'react';
import { Platform, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { act, create } from 'react-test-renderer';

import { Screen } from '../Screen';

// 아래 안전 영역은 탭 화면에서는 탭 막대가, 탭 밖 화면에서는 Screen이 한 번만 잡음
function edgesOf(inTabs: boolean, os: 'android' | 'web', footer?: boolean) {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  try {
    const screen = createElement(Screen, { footer: footer ? createElement(Text, null, 'f') : undefined, children: createElement(Text, null, 'x') });
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(inTabs ? createElement(BottomTabBarHeightContext.Provider, { value: 82 }, screen) : screen);
    });
    const edges = r.root.findByType(SafeAreaView).props.edges as string[];
    act(() => r.unmount());
    return edges;
  } finally {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  }
}

describe('Screen 아래 안전 영역', () => {
  it('탭 안: 폰에서도 위만', () => {
    expect(edgesOf(true, 'android')).toEqual(['top']);
  });
  it('탭 안: footer가 있어도 위만', () => {
    expect(edgesOf(true, 'android', true)).toEqual(['top']);
  });
  it('탭 밖 + 안드로이드: 위 · 아래', () => {
    expect(edgesOf(false, 'android')).toEqual(['top', 'bottom']);
  });
  it('탭 밖 + 웹: footer 없으면 위만, 있으면 위 · 아래', () => {
    expect(edgesOf(false, 'web')).toEqual(['top']);
    expect(edgesOf(false, 'web', true)).toEqual(['top', 'bottom']);
  });
});
