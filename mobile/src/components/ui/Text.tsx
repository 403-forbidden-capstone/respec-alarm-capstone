import { Children, type ReactNode } from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { keepWordsIfWrappable } from '@/lib/format';

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

// 글자(문자열) 자식에만 어절 단위 줄바꿈을 검 — 안쪽 Text나 숫자는 그대로
function wrapWords(children: ReactNode): ReactNode {
  if (typeof children === 'string') return keepWordsIfWrappable(children);
  if (Array.isArray(children)) return Children.map(children, (c) => (typeof c === 'string' ? keepWordsIfWrappable(c) : c));
  return children;
}

// 화면 글자는 모두 이 컴포넌트로 씀 — 글꼴 · 크기 · 색을 목업 값으로 맞춤
// 띄어쓰기가 있는 한글 글은 어절 단위로 줄이 바뀜 (keepWords 자동 적용)
// 시스템 글자 크기를 키워도 1.3배까지만 (레이아웃이 깨지지 않게) — 더 키우려면 maxFontSizeMultiplier를 따로 줌
export function Text({ variant = 'body', tone, weight, align, style, children, ...rest }: TextProps) {
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
      maxFontSizeMultiplier={1.3}
      {...rest}
    >
      {wrapWords(children)}
    </RNText>
  );
}
