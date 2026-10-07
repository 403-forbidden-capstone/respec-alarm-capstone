import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { colors, font } from '@/theme';

import { Text } from './Text';

type Props = Omit<TextInputProps, 'style'> & {
  label: string;
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

// 이름 — 입력 한 줄 (.field) — 카드 안에서 여러 줄을 이어 씀
export function Field({ label, first, ...input }: Props) {
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <Text variant="body" tone="sub" style={styles.label}>
        {label}
      </Text>
      <TextInput placeholderTextColor={colors.faint} style={styles.input} accessibilityLabel={label} {...input} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  label: { fontSize: 13.5, flexShrink: 0 },
  input: { ...font(600), flex: 1, fontSize: 14, color: colors.ink, textAlign: 'right', paddingVertical: 4 },
});
