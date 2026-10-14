import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/theme';

import { Text } from './Text';

export type ToastOptions = {
  actionLabel?: string; // 있으면 토스트 안에 누를 수 있는 글자 (되돌리기 · 다시 시도)
  onAction?: () => void;
  duration?: number; // 보이는 시간(ms). 기본 2.6초, 버튼이 있으면 4.5초
};

type Message = { text: string; id: number; actionLabel?: string; onAction?: () => void; duration: number };

let push: ((text: string, opts?: ToastOptions) => void) | null = null;

const BASE_DURATION = 2600;
const ACTION_DURATION = 4500;
const ABOVE_BOTTOM = 110; // 아래 안전 영역 위로 띄우는 높이 — 아래 고정 버튼 · 탭 막대를 가리지 않게
const ABOVE_KEYBOARD = 12;

// 아래쪽에 잠깐 뜨는 안내 (#toast) — 어디서든 toast('이 일정의 알람을 껐어요')
// 되돌리기처럼 누를 글자가 필요하면 toast('삭제했어요', { actionLabel: '되돌리기', onAction: undo })
export function toast(text: string, opts?: ToastOptions) {
  push?.(text, opts);
}

// 루트 레이아웃에 하나만 둠
export function ToastHost() {
  const [message, setMessage] = useState<Message | null>(null);
  const [keyboard, setKeyboard] = useState(0);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    push = (text, opts) =>
      setMessage((prev) => ({
        text,
        id: (prev?.id ?? 0) + 1,
        actionLabel: opts?.actionLabel,
        onAction: opts?.onAction,
        duration: opts?.duration ?? (opts?.actionLabel ? ACTION_DURATION : BASE_DURATION),
      }));
    return () => {
      push = null;
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), message.duration);
    return () => clearTimeout(timer);
  }, [message]);

  // 키보드가 열려 있으면 그 위로 (웹은 키보드가 화면을 덮지 않으니 건너뜀)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  if (!message) return null;
  const bottom = keyboard > 0 ? keyboard + ABOVE_KEYBOARD : insets.bottom + ABOVE_BOTTOM;
  const { actionLabel, onAction } = message;

  return (
    // 바깥 줄은 터치를 뒤 화면으로 넘기고, 버튼이 있는 토스트 상자만 터치를 받음
    <View style={[styles.wrap, { bottom }]} accessibilityLiveRegion="polite">
      <View style={[styles.box, actionLabel ? styles.boxAction : styles.boxPlain]}>
        <Text variant="small" tone="inverse" align={actionLabel ? 'left' : 'center'} style={actionLabel ? styles.text : undefined}>
          {message.text}
        </Text>
        {actionLabel ? (
          <Pressable
            onPress={() => {
              setMessage(null);
              onAction?.();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text variant="small" tone="inverse" weight={700} style={styles.actionText}>
              {actionLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 30, pointerEvents: 'box-none' },
  box: { maxWidth: 330, backgroundColor: colors.ink, borderRadius: 14 },
  boxPlain: { paddingVertical: 11, paddingHorizontal: 16, pointerEvents: 'none' },
  boxAction: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 4, minHeight: 48, pointerEvents: 'auto' },
  text: { flexShrink: 1 },
  action: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  actionText: { textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
});
