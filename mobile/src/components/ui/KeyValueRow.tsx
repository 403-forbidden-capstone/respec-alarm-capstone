import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Text } from './Text';

type Props = {
  label: string;
  value: ReactNode; // 글자면 굵게, 요소면 그대로(스위치 등)
  sub?: string; // 값 아래 작은 설명
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

// 이름 — 값 한 줄 (.kv) — 카드 안에서 여러 줄을 이어 쓰면 사이에 구분선
export function KeyValueRow({ label, value, sub, first }: Props) {
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <Text variant="body" tone="sub" style={styles.label}>
        {label}
      </Text>
      <View style={styles.value}>
        {typeof value === 'string' || typeof value === 'number' ? (
          <Text variant="bodyStrong" align="right">
            {value}
          </Text>
        ) : (
          value
        )}
        {sub ? (
          <Text variant="caption" align="right">
            {sub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 11 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  label: { fontSize: 13.5 },
  value: { alignItems: 'flex-end', flexShrink: 1 },
});
