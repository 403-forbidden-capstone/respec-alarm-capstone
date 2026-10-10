import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Text } from './Text';

type Message = { text: string; id: number };

let push: ((text: string) => void) | null = null;

// 아래쪽에 잠깐 뜨는 안내 (#toast) — 어디서든 toast('이 일정의 알람을 껐어요')
export function toast(text: string) {
  push?.(text);
}

// 루트 레이아웃에 하나만 둠
export function ToastHost() {
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    push = (text) => setMessage((prev) => ({ text, id: (prev?.id ?? 0) + 1 }));
    return () => {
      push = null;
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <View style={styles.box}>
        <Text variant="small" tone="inverse" align="center">
          {message.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 96, alignItems: 'center', paddingHorizontal: 30, pointerEvents: 'none' },
  box: { maxWidth: 330, backgroundColor: colors.ink, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 16 },
});
