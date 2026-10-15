import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, size } from '@/theme';

import { Text } from './Text';

type Props = {
  screenId?: string; // 목업 화면 번호(H01 등). 개발 중 확인용, 없으면 숨김
  onBack?: () => void; // 있으면 왼쪽에 "← 이전"
  left?: ReactNode; // 이전 · 화면 번호 대신 왼쪽에 둘 것 (홈의 날짜)
  right?: ReactNode;
};

// 화면 맨 위 줄 — 왼쪽은 이전 버튼(있으면, 옆에 화면 번호) 또는 화면 번호, 오른쪽은 버튼
export function TopBar({ screenId, onBack, left, right }: Props) {
  return (
    <View style={styles.row}>
      {onBack ? (
        <View style={styles.left}>
          <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="이전 화면" style={styles.back}>
            <Text variant="body" tone="sub">
              ← 이전
            </Text>
          </Pressable>
          {screenId ? <Text variant="screenId">{screenId}</Text> : null}
        </View>
      ) : left ? (
        left
      ) : screenId ? (
        <Text variant="screenId">{screenId}</Text>
      ) : (
        <View />
      )}
      {right ?? <View />}
    </View>
  );
}

// 위 줄 오른쪽의 작은 테두리 버튼 (.tbtn) — 모양은 32 높이, 누르는 칸은 44
export function TopBarButton({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.tbtnHit, pressed && styles.pressed]}>
      <View style={styles.tbtn}>
        <Text variant="small" tone="ink">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: size.topBar, marginTop: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  left: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  back: { minHeight: size.touch, minWidth: size.touch, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  tbtnHit: { minHeight: size.touch, minWidth: size.touch, justifyContent: 'center', alignItems: 'flex-end' },
  tbtn: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    justifyContent: 'center',
  },
});
