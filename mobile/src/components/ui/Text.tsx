import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { colors, font, typeScale, type TypeVariant, type Weight } from '@/theme';

type Tone = 'ink' | 'sub' | 'faint' | 'inverse' | 'warn';

export type TextProps = RNTextProps & {
  variant?: TypeVariant;
  tone?: Tone;
  weight?: Weight; // 같은 크기에서 굵기만 바꿀 때
  align?: 'left' | 'center' | 'right';
};

const toneColor: Record<Tone, string> = {
  ink: colors.ink,
  sub: colors.sub,
  faint: colors.faint,
  inverse: colors.inverse,
  warn: colors.warn,
};

// 화면 글자는 모두 이 컴포넌트로 씀 — 글꼴 · 크기 · 색을 목업 값으로 맞춤
export function Text({ variant = 'body', tone, weight, align, style, ...rest }: TextProps) {
  const defaultTone: Tone =
    variant === 'lead' || variant === 'small' || variant === 'label' ? 'sub' : variant === 'caption' || variant === 'screenId' ? 'faint' : 'ink';
  return (
    <RNText
      style={[
        typeScale[variant],
        { color: toneColor[tone ?? defaultTone] },
        weight ? font(weight) : null,
        align ? { textAlign: align } : null,
        style,
      ]}
      {...rest}
    />
  );
}
