import { Pressable, StyleSheet } from 'react-native';

import { colors, radius, size } from '@/theme';

import { Text } from './Text';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'ghost' | 'plain'; // 검은 버튼 · 흰 테두리 버튼 · 글자만
  small?: boolean;
  disabled?: boolean;
};

// 버튼 (.btn) — 한 화면의 주된 행동은 primary 하나
export function Button({ label, onPress, variant = 'primary', small, disabled }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        small && styles.small,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text
        variant={small ? 'body' : 'button'}
        weight={variant === 'plain' ? 400 : 600}
        tone={variant === 'primary' ? 'inverse' : variant === 'plain' ? 'sub' : 'ink'}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { height: size.button, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  primary: { backgroundColor: colors.ink },
  ghost: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  plain: { height: size.buttonPlain, backgroundColor: 'transparent' },
  small: { height: size.buttonSm, borderRadius: radius.buttonSm, paddingHorizontal: 16, alignSelf: 'flex-start' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.35 },
});
