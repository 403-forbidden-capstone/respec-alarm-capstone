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
  rightIsButtons?: boolean; // right에 누르는 버튼이 있으면 — 줄 누름은 아이콘 · 글자까지만, 버튼은 따로 눌림
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

// 사람 · 관계 한 줄 (.person) — 친구 목록 · 그룹 멤버 · 받은 권한 · 관계 고르기
export function PersonRow({ icon, title, sub, right, onPress, rightIsButtons, first }: Props) {
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
    </>
  );

  // 버튼이 든 줄 — 누르는 칸이 버튼을 감싸지 않게 나눔 (버튼 안의 버튼 방지)
  if (onPress && rightIsButtons) {
    return (
      <View style={[styles.split, !first && styles.divider]}>
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        >
          {body}
        </Pressable>
        {right}
      </View>
    );
  }
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
      >
        {body}
        {right}
      </Pressable>
    );
  }
  return (
    <View style={[styles.row, !first && styles.divider]}>
      {body}
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  split: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  text: { flex: 1, minWidth: 0 },
});
