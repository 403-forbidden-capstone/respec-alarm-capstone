import { useEffect, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { formatTime } from '@/lib/format';
import { colors } from '@/theme';

// 말풍선 틀 (.msg) — AI는 왼쪽 흰 풍선, 나는 오른쪽 검은 풍선. wide = 찾은 일정 카드처럼 넓게
export function Bubble({ who, wide, children }: { who: 'ai' | 'me'; wide?: boolean; children: ReactNode }) {
  return <View style={[styles.base, who === 'me' ? styles.me : styles.ai, wide && styles.wide]}>{children}</View>;
}

// 보낸 시각 (AI · 오후 9:20)
export function BubbleTime({ who, at }: { who: 'ai' | 'me'; at: Date }) {
  const me = who === 'me';
  return (
    <Text variant="tiny" tone={me ? 'inverse' : 'faint'} style={[styles.time, me && styles.meTime]}>
      {me ? formatTime(at) : `AI · ${formatTime(at)}`}
    </Text>
  );
}

// 대화 한 줄
export function ChatBubble({ who, text, at }: { who: 'ai' | 'me'; text: string; at: Date }) {
  return (
    <Bubble who={who}>
      <Text variant="body" tone={who === 'me' ? 'inverse' : 'ink'} style={styles.text}>
        {text}
      </Text>
      <BubbleTime who={who} at={at} />
    </Bubble>
  );
}

const DOT_SHIFTS = [0, 0.15, 0.3]; // CSS의 animation-delay (1초 중)

// AI가 답을 정리하는 중 (.typing) — 점 세 개가 차례로 깜빡임
export function TypingBubble() {
  const [phase] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(Animated.timing(phase, { toValue: 1, duration: 1000, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [phase]);

  return (
    <View style={[styles.base, styles.ai, styles.typing]} accessible accessibilityLabel="AI가 답하는 중">
      {DOT_SHIFTS.map((s) => {
        // 0.3 → 1 → 0.3을 s만큼 늦게 — 시작 · 끝 값은 그 시점의 밝기
        const edge = 0.3 + 1.4 * s;
        const opacity = s
          ? phase.interpolate({ inputRange: [0, s, s + 0.5, 1], outputRange: [edge, 0.3, 1, edge] })
          : phase.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 1, 0.3] });
        return <Animated.View key={s} style={[styles.dot, { opacity }]} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { maxWidth: '84%', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 18 },
  ai: {
    alignSelf: 'flex-start',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderBottomLeftRadius: 6,
  },
  me: { alignSelf: 'flex-end', backgroundColor: colors.ink, borderBottomRightRadius: 6 },
  wide: { maxWidth: '92%' },
  text: { lineHeight: 21.5 },
  time: { marginTop: 4 },
  meTime: { opacity: 0.55 },
  typing: { flexDirection: 'row', gap: 4, padding: 16 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.faint },
});
