// 디자인 기본값 — 클릭 목업(mobile/public/mockup.html)의 :root 값과 같은 숫자를 씀
// 화면에서는 이 파일의 값만 쓰고, 색 · 간격을 직접 적지 않음

export const colors = {
  bg: '#F6F6F4', // 화면 바탕
  card: '#FFFFFF', // 카드 · 입력칸
  line: '#E6E6E2', // 테두리 · 구분선
  ink: '#151515', // 본문 · 강조 버튼
  sub: '#666662', // 보조 글자 — 하늘 톤이 섞인 화면 바탕(features/sky skyBase)에서도 4.5 : 1 이상
  skySub: '#52524C', // 하늘 배경(탭 화면 위쪽) 위의 보조 글자 — sub는 색이 진한 하늘에서 대비가 모자람 (features/sky SKY_LEAD_FROM)
  faint: '#71716C', // 흐린 글자 · 비활성 — 흰 바탕 4.9 : 1 · 화면 바탕(bg) 4.5 : 1 (글자 대비 4.5 : 1 이상). sub보다는 연함. 하늘 톤이 섞인 탭 화면 바탕 위에는 직접 쓰지 않음(최저 4.2 : 1) — 카드 안에서만
  faintDecor: '#A5A5A0', // 글자가 아닌 장식(점 · 테두리 · 막대)용 연한 색 — 대비 기준이 없어 예전 faint 값
  chip: '#EFEFEC', // 칩 · 세그먼트 바탕
  dash: '#CFCFCA', // 점선 카드 테두리
  switchOff: '#D8D8D4',
  shadow: '#000000', // 그림자 색 (투명도는 쓰는 곳에서)
  scrim: 'rgba(20, 20, 20, 0.38)', // 시트 뒤를 어둡게
  inverse: '#FFFFFF', // 어두운 바탕 위 글자

  // 상태 점 · 경고
  ok: '#55B477', // 기상 확인
  mid: '#7B99E8', // 준비 중
  zz: '#D3A630', // 아직 자는 중
  warn: '#C8553D', // 기준선 · 경고
  danger: '#B8452E', // 되돌릴 수 없는 버튼(삭제 · 나가기) 바탕 — 흰 글자 5.3 : 1

  // 웹 데모 휴대폰 틀 (PC 브라우저에서만)
  stage: '#E6E9E4',
  device: '#1A1B1A',
  camera: '#000000', // 카메라 구멍 · 노치

  // 로그인 버튼 (카카오 디자인 가이드 색)
  kakao: '#FEE500',
  kakaoText: 'rgba(0, 0, 0, 0.85)',

  // 알람 울림 화면 바탕 (종류별)
  ringWake: '#141414',
  ringPrepare: '#262A28',
  ringDepart: '#4A4A54',
  ringPanel: 'rgba(255, 255, 255, 0.08)', // 울림 화면의 음성 안내 칸
  ringOption: 'rgba(255, 255, 255, 0.1)', // 미루기 시간 버튼
  ringButton: 'rgba(255, 255, 255, 0.12)', // 미루기 버튼
  ringLine: 'rgba(255, 255, 255, 0.35)', // 어두운 바탕 위 칩 테두리
  ringWave: 'rgba(255, 255, 255, 0.8)', // 음성 파형

  // 하늘 배경 위에 얹는 것 (홈 위쪽) — 바탕 색은 아래 skyTint, 해 · 구름 등 그림 색은 scripts/make-sky-assets.py
  glass: 'rgba(255, 255, 255, 0.3)', // 하늘 배경 위 유리 버튼 바탕 — 하늘이 비치게 옅게
  glassLine: 'rgba(255, 255, 255, 0.7)', // 유리 버튼 테두리 (밝은 가장자리)
  // 유리 버튼 입체감 — 위쪽 안쪽에 밝은 빛 한 줄 + 아래로 옅은 그림자
  glassCard: 'rgba(255, 255, 255, 0.55)', // 하늘 위 큰 카드(홈 다음 알람) — 버튼보다 덜 비침
  glassShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 4px 12px -6px rgba(0, 0, 0, 0.22)',
} as const;

// 하늘 배경 맨 위 색 — 날씨 × 시간대. 아래로 갈수록 화면 바탕(bg)으로 풀림 (features/sky/sky.ts의 skyColorAt)
// 글자 대비를 지키려고 전부 옅은 색. 값을 바꾸면 features/sky/__tests__/sky.test.ts가 대비를 다시 잼
export const skyTint = {
  clear: { dawn: '#F9D58A', morning: '#B5D6F3', day: '#9CC8F2', dusk: '#E6C6CF', night: '#ACA7DC' },
  cloudy: { dawn: '#CFC4BF', morning: '#CDCBC2', day: '#BFC6CB', dusk: '#C9BBBB', night: '#B4B4CC' },
  rain: { dawn: '#A9BACA', morning: '#A6BCCD', day: '#9FB7C9', dusk: '#A9B1C9', night: '#9FA6C6' },
  snow: { dawn: '#C5CFE6', morning: '#BCD5EC', day: '#B8D4EE', dusk: '#C0C6E2', night: '#B0B9DC' },
} as const;

export const radius = {
  card: 22,
  tile: 20,
  button: 16,
  buttonSm: 12,
  field: 16,
  segment: 14,
  segmentItem: 11,
  option: 14,
  chip: 13,
  icon: 12,
  pill: 999,
} as const;

// 간격은 목업 CSS의 px 값을 그대로 씀
export const space = {
  screenX: 20, // 화면 좌우 여백
  cardX: 18,
  cardY: 16,
  gap: 10, // 버튼 · 카드 묶음 사이
  section: 22, // 섹션 제목 위
  sectionBelow: 10, // 섹션 제목 아래
  cardBelow: 12,
} as const;

export const size = {
  button: 52,
  buttonSm: 38,
  buttonPlain: 44,
  touch: 44, // 누르는 칸 최소 크기 (가로 · 세로)
  chip: 26,
  switchW: 46,
  switchH: 28,
  segment: 38,
  avatar: 40,
  avatarSm: 32,
  topBar: 44,
  tabBar: 64,
} as const;
