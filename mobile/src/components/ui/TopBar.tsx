import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, size } from '@/theme';

import { Text } from './Text';

type Props = {
  screenId?: string; // 목업 화면 번호(H01 등). 화면을 구분하는 내부 식별자 — 화면에는 그리지 않음
  onBack?: () => void; // 있으면 왼쪽에 "← 이전"
  left?: ReactNode; // 이전 대신 왼쪽에 둘 것 (홈의 날짜)
  right?: ReactNode;
};

// 화면 맨 위 줄 — 왼쪽은 이전 버튼(있으면), 오른쪽은 버튼
export function TopBar({ onBack, left, right }: Props) {
  return (
    <View style={styles.row}>
      {onBack ? (
        <View style={styles.left}>
          <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="이전 화면" style={styles.back}>
            <Text variant="body" tone="sub">
              ← 이전
            </Text>
          </Pressable>
        </View>
      ) : left ? (
        left
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
  accessibilityLabel?: string; // 글자만으로 뜻이 모자랄 때(···) 화면 읽기 도구가 부를 이름
  glass?: boolean; // 색이 깔린 바탕(홈의 하늘 배경) 위에 놓일 때 — 바탕이 비치는 반투명
};

// 위 줄 오른쪽의 작은 테두리 버튼 (.tbtn) — 모양은 32 높이, 누르는 칸은 44
export function TopBarButton({ label, onPress, onLongPress, onPressOut, disabled, accessibilityLabel, glass }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressOut={onPressOut}
      delayLongPress={400}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.tbtnHit, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <View style={[styles.tbtn, glass && styles.glass]}>
        <Text variant="small" tone="ink">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

type IconButtonProps = {
  icon: SymbolViewProps['name']; // expo-symbols 이름 — iOS는 SF Symbols, Android · 웹은 Material Symbols
  accessibilityLabel: string; // 그림뿐이라 화면 읽기 도구가 부를 이름이 꼭 필요
  onPress?: () => void;
  glass?: boolean; // 하늘 배경 위 — 바탕이 비치는 유리 버튼
};

const ICON_BUTTON = 38;

// 위 줄 오른쪽의 둥근 그림 버튼 (홈의 설정 · 알람 탭의 "+" · 친구 탭의 권한 관리) — 오른쪽 위에는 이 버튼 하나만 — 모양은 38 원, 누르는 칸은 44
export function TopBarIconButton({ icon, accessibilityLabel, onPress, glass }: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.tbtnHit, pressed && styles.pressed]}
    >
      <View style={[styles.ibtn, glass && styles.glass]}>
        <SymbolView name={icon} size={20} tintColor={colors.ink} />
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
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    justifyContent: 'center',
  },
  glass: { borderColor: colors.glassLine, backgroundColor: colors.glass, boxShadow: colors.glassShadow },
  ibtn: { width: ICON_BUTTON, height: ICON_BUTTON, borderRadius: ICON_BUTTON / 2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
});
