import { StyleSheet } from 'react-native';

import { Text } from '@/components/ui';

// 카드 밖 작은 안내 글 (.note) — 친구 · 기상 기록 · 공유 알람 설명
export function Note({ children }: { children: string }) {
  return (
    <Text variant="label" tone="sub" style={styles.note}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  note: { lineHeight: 19, marginTop: 4, marginHorizontal: 4, marginBottom: 14 },
});
