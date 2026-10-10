import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

type Props = {
  icon: ReactNode; // Avatar · GroupIcon
  title: string;
  sub?: string;
  right?: ReactNode; // 권한 수 · 작은 버튼 · 선택됨 칩
  onPress?: () => void; // 있으면 줄 전체를 누름
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

// 사람 · 관계 한 줄 (.person) — 친구 목록 · 그룹 멤버 · 받은 권한 · 관계 고르기
export function PersonRow({ icon, title, sub, right, onPress, first }: Props) {
  const body = (
    <>
      {icon}
      <View style={styles.text}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text variant="small" tone="sub">
            {sub}
          </Text>
        ) : null}
      </View>
      {right}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={[styles.row, !first && styles.divider]}>{body}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  text: { flex: 1, minWidth: 0 },
});
