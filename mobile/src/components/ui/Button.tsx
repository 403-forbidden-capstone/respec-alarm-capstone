import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { colors, radius, size } from '@/theme';

import { Text } from './Text';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'ghost' | 'plain' | 'danger'; // 검은 버튼 · 흰 테두리 버튼 · 글자만 · 붉은 버튼(되돌릴 수 없는 행동)
  small?: boolean;
  disabled?: boolean;
  loading?: boolean; // 저장 중 — 글자 대신 돌아가는 표시, 누를 수 없음
};

// 작은 버튼은 모양(38)은 그대로 두고 누르는 칸만 44로
const SMALL_SLOP = { top: (size.touch - size.buttonSm) / 2, bottom: (size.touch - size.buttonSm) / 2, left: 4, right: 4 } as const;

// 버튼 (.btn) — 한 화면의 주된 행동은 primary 하나
export function Button({ label, onPress, variant = 'primary', small, disabled, loading }: Props) {
  const blocked = disabled || loading;
  const filled = variant === 'primary' || variant === 'danger';
  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      hitSlop={small ? SMALL_SLOP : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        small && styles.small,
        pressed && !blocked && styles.pressed,
        loading && !disabled && styles.loading,
        disabled && styles.disabled,
      ]}
    >
      {/* 돌아가는 동안에도 글자를 투명하게 남겨 두어 버튼 폭이 변하지 않게 함 */}
      <Text
        variant={small ? 'body' : 'button'}
        weight={variant === 'plain' ? 400 : 600}
        tone={filled ? 'inverse' : variant === 'plain' ? 'sub' : 'ink'}
        style={loading ? styles.hidden : undefined}
      >
        {label}
      </Text>
      {loading ? <ActivityIndicator size="small" color={filled ? colors.inverse : colors.ink} style={StyleSheet.absoluteFill} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { height: size.button, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  primary: { backgroundColor: colors.ink },
  ghost: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  plain: { height: size.buttonPlain, backgroundColor: 'transparent' },
  danger: { backgroundColor: colors.danger },
  small: { height: size.buttonSm, borderRadius: radius.buttonSm, paddingHorizontal: 16, alignSelf: 'flex-start' },
  pressed: { opacity: 0.75 },
  loading: { opacity: 0.8 },
  disabled: { opacity: 0.35 },
  hidden: { opacity: 0 },
});
