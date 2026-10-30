import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { colors, font } from '@/theme';

import { Text } from './Text';

type Props = Omit<TextInputProps, 'style'> & {
  label: string;
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

// 이름 — 입력 한 줄 (.field) — 카드 안에서 여러 줄을 이어 씀
// 값이 있을 때만 굵게 — 빈 칸의 자리 글자(placeholder)가 값처럼 보이지 않게
export function Field({ label, first, ...input }: Props) {
  const filled = !!input.value;
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <Text variant="body" tone="sub" style={styles.label}>
        {label}
      </Text>
      <TextInput
        placeholderTextColor={colors.faint}
        maxFontSizeMultiplier={1.3} // 입력칸도 일반 글자(Text)와 같이 1.3배까지만
        style={[styles.input, font(filled ? 600 : 400)]}
        accessibilityLabel={label}
        {...input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  label: { fontSize: 13.5, flexShrink: 0 },
  input: { flex: 1, fontSize: 14, color: colors.ink, textAlign: 'right', paddingVertical: 4 },
});
