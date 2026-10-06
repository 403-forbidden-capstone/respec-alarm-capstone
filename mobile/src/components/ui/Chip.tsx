import { StyleSheet, View } from 'react-native';

import { colors, radius, size } from '@/theme';

import { Text } from './Text';

type Props = {
  label: string;
  variant?: 'outline' | 'fill' | 'ink'; // 테두리 · 회색 바탕 · 검은 바탕
};

// 작은 꼬리표 (.chip) — 강도 · 반복 · 출처 같은 짧은 정보
export function Chip({ label, variant = 'outline' }: Props) {
  return (
    <View style={[styles.base, styles[variant]]}>
      <Text variant="label" tone={variant === 'ink' ? 'inverse' : 'ink'} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    height: size.chip,
    paddingHorizontal: 10,
    borderRadius: radius.chip,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  outline: { backgroundColor: colors.card, borderColor: colors.line },
  fill: { backgroundColor: colors.chip, borderColor: 'transparent' },
  ink: { backgroundColor: colors.ink, borderColor: colors.ink },
});
