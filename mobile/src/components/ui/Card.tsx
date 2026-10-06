import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, space } from '@/theme';

type Props = {
  children: ReactNode;
  variant?: 'default' | 'dash' | 'flat'; // dash = 비어 있을 때 점선, flat = 테두리 · 여백 없음
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

// 흰 카드 (.card) — 누를 수 있으면 onPress를 줌
export function Card({ children, variant = 'default', onPress, style }: Props) {
  const cardStyle = [styles.base, styles[variant], style];
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [cardStyle, pressed && styles.pressed]} accessibilityRole="button">
        {children}
      </Pressable>
    );
  }
  return <View style={cardStyle}>{children}</View>;
}

const styles = StyleSheet.create({
  base: { marginBottom: space.cardBelow },
  default: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    paddingVertical: space.cardY,
    paddingHorizontal: space.cardX,
  },
  dash: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.dash,
    borderRadius: radius.card,
    paddingVertical: space.cardY,
    paddingHorizontal: space.cardX,
  },
  flat: {},
  pressed: { opacity: 0.7 },
});
