import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, size } from '@/theme';

import { ScreenId } from './ScreenId';
import { Text } from './Text';

type Props = {
  screenId?: string; // 목업 화면 번호(H01 등). 개발 중 확인용 — 출시용 폰 빌드에선 숨김(ScreenId), 없으면 안 그림
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
          {screenId ? <ScreenId id={screenId} /> : null}
        </View>
      ) : left ? (
        left
      ) : screenId ? (
        <View>
          <ScreenId id={screenId} />
        </View>
      ) : (
        <View />
      )}
      {right ?? <View />}
    </View>
  );
}

type ButtonProps = {
  label: string;
  onPress?: () => void;
  onLongPress?: () => void; // 길게 누르면 (계속 바뀌는 값 — 누르고 있는 동안 반복은 부르는 쪽이 onPressOut으로 멈춤)
  onPressOut?: () => void;
  disabled?: boolean; // 흐리게 · 못 누름
};

// 위 줄 오른쪽의 작은 테두리 버튼 (.tbtn) — 모양은 32 높이, 누르는 칸은 44
export function TopBarButton({ label, onPress, onLongPress, onPressOut, disabled }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressOut={onPressOut}
      delayLongPress={400}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.tbtnHit, pressed && styles.pressed, disabled && styles.disabled]}
    >
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
  disabled: { opacity: 0.35 },
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
