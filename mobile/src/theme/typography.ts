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
  display: { ...font(700), fontSize: 25, lineHeight: 33, letterSpacing: -0.7 }, // 탭 화면 맨 위 큰 제목 (홈 인사말 등) — 줄 높이는 한글 기준 크기의 약 1.3배
  title: { ...font(700), fontSize: 23, lineHeight: 30, letterSpacing: -0.6 }, // .ttl
  lead: { ...font(400), fontSize: 13.5, lineHeight: 20 }, // .lead
  section: { ...font(700), fontSize: 15.5, lineHeight: 22 }, // .h2
  big: { ...font(700), fontSize: 17, lineHeight: 24, letterSpacing: -0.2 }, // .big2
  bodyLarge: { ...font(400), fontSize: 15, lineHeight: 21 }, // 카드 제목 · 목록 시각 · 울림 머리말 (굵기는 weight로)
  body: { ...font(400), fontSize: 14, lineHeight: 20 },
  listTitle: { ...font(700), fontSize: 14.5, lineHeight: 20 }, // 일정 목록 제목
  rowLabel: { ...font(400), fontSize: 13.5, lineHeight: 19 }, // .row 왼쪽 이름 · 선택 줄
  note: { ...font(400), fontSize: 13, lineHeight: 19 }, // .note · 계산식 · 빈 목록 안내
  bodyStrong: { ...font(600), fontSize: 14, lineHeight: 20 },
  label: { ...font(400), fontSize: 12, lineHeight: 17 }, // .lbl
  small: { ...font(400), fontSize: 12.5, lineHeight: 18 }, // .small
  caption: { ...font(400), fontSize: 11.5, lineHeight: 16 }, // .meta · .note.sm
  tiny: { ...font(400), fontSize: 11, lineHeight: 15 }, // 오전/오후 작은 글자 · 직접 고름 표시
  button: { ...font(600), fontSize: 15 },
  reading: { ...font(400), fontSize: 14.5, lineHeight: 23 }, // .voice p · .jtext
  sheetTitle: { ...font(700), fontSize: 18, lineHeight: 25, letterSpacing: -0.2 }, // .sheet h3 · .done-big b
  ampm: { ...font(400), fontSize: 16, lineHeight: 20 }, // .ampm
  compare: { ...font(600), fontSize: 26, lineHeight: 32, fontVariant: ['tabular-nums'] }, // .cmp b · .stepper b
  stat: { ...font(600), fontSize: 30, lineHeight: 36, letterSpacing: -0.6, fontVariant: ['tabular-nums'] }, // .stat .big
  number: { ...font(300), fontSize: 46, lineHeight: 50, letterSpacing: -1.6, fontVariant: ['tabular-nums'] }, // .num
  ringTime: { ...font(600), fontSize: 78, lineHeight: 82, letterSpacing: -3.5, fontVariant: ['tabular-nums'] }, // .ring-time
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof typeScale;
