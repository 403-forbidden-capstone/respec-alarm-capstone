import type { TextStyle } from 'react-native';

// 글꼴 — Pretendard (KS X 1001 한글 2,350자 + 영문 · 기호로 줄인 파일, assets/fonts)
// Android는 굵기마다 다른 파일을 써야 해서 fontWeight 대신 fontFamily로 굵기를 고름
export const fontFiles = {
  'Pretendard-Light': require('../../assets/fonts/Pretendard-Light.ttf'),
  'Pretendard-Regular': require('../../assets/fonts/Pretendard-Regular.ttf'),
  'Pretendard-SemiBold': require('../../assets/fonts/Pretendard-SemiBold.ttf'),
  'Pretendard-Bold': require('../../assets/fonts/Pretendard-Bold.ttf'),
};

export type Weight = 300 | 400 | 500 | 600 | 700;

const family: Record<Weight, keyof typeof fontFiles> = {
  300: 'Pretendard-Light',
  400: 'Pretendard-Regular',
  500: 'Pretendard-Regular', // 500 파일은 넣지 않음
  600: 'Pretendard-SemiBold',
  700: 'Pretendard-Bold',
};

export function font(weight: Weight = 400): Pick<TextStyle, 'fontFamily'> {
  return { fontFamily: family[weight] };
}

// 목업 CSS의 글자 크기 · 굵기 · 줄 간격 · 자간(em → px)
export const typeScale = {
  screenId: { ...font(400), fontSize: 11.5, letterSpacing: 0.7 }, // .sid
  title: { ...font(700), fontSize: 23, lineHeight: 30, letterSpacing: -0.6 }, // .ttl
  lead: { ...font(400), fontSize: 13.5, lineHeight: 20 }, // .lead
  section: { ...font(700), fontSize: 15.5, lineHeight: 22 }, // .h2
  big: { ...font(700), fontSize: 17, lineHeight: 24, letterSpacing: -0.2 }, // .big2
  body: { ...font(400), fontSize: 14, lineHeight: 20 },
  bodyStrong: { ...font(600), fontSize: 14, lineHeight: 20 },
  label: { ...font(400), fontSize: 12, lineHeight: 17 }, // .lbl
  small: { ...font(400), fontSize: 12.5, lineHeight: 18 }, // .small
  caption: { ...font(400), fontSize: 11.5, lineHeight: 16 }, // .meta · .note.sm
  button: { ...font(600), fontSize: 15 },
  number: { ...font(300), fontSize: 46, lineHeight: 50, letterSpacing: -1.6, fontVariant: ['tabular-nums'] }, // .num
  ringTime: { ...font(600), fontSize: 78, lineHeight: 82, letterSpacing: -3.5, fontVariant: ['tabular-nums'] }, // .ring-time
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof typeScale;
