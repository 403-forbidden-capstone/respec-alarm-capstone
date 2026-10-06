import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, size } from '@/theme';

import { Text } from './Text';

type Props = {
  screenId?: string; // 목업 화면 번호(H01 등). 개발 중 확인용, 없으면 숨김
  onBack?: () => void; // 있으면 왼쪽에 "← 이전"
  right?: ReactNode;
};

// 화면 맨 위 줄 — 이전 버튼 · 화면 번호 · 오른쪽 버튼
export function TopBar({ screenId, onBack, right }: Props) {
  return (
    <View style={styles.row}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="이전 화면">
          <Text variant="body" tone="sub">
            ← 이전
          </Text>
        </Pressable>
      ) : screenId ? (
        <Text variant="screenId">{screenId}</Text>
      ) : (
        <View />
      )}
      {right ?? <View />}
    </View>
  );
}

// 위 줄 오른쪽의 작은 테두리 버튼 (.tbtn)
export function TopBarButton({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.tbtn} accessibilityRole="button">
      <Text variant="small" tone="ink">
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: size.topBar, marginTop: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
