// 디자인 기본값 — 클릭 목업(mobile/public/mockup.html)의 :root 값과 같은 숫자를 씀
// 화면에서는 이 파일의 값만 쓰고, 색 · 간격을 직접 적지 않음

export const colors = {
  bg: '#F6F6F4', // 화면 바탕
  card: '#FFFFFF', // 카드 · 입력칸
  line: '#E6E6E2', // 테두리 · 구분선
  ink: '#151515', // 본문 · 강조 버튼
  sub: '#6B6B67', // 보조 글자
  faint: '#A5A5A0', // 흐린 글자 · 비활성
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

  // 웹 데모 휴대폰 틀 (PC 브라우저에서만)
  stage: '#E6E9E4',
  device: '#1A1B1A',

  // 로그인 버튼 (카카오 디자인 가이드 색)
  kakao: '#FEE500',
  kakaoText: 'rgba(0, 0, 0, 0.85)',

  // 알람 울림 화면 바탕 (종류별)
  ringWake: '#141414',
  ringPrepare: '#262A28',
  ringDepart: '#4A4A54',
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
  chip: 26,
  switchW: 46,
  switchH: 28,
  segment: 38,
  avatar: 40,
  avatarSm: 32,
  topBar: 44,
  tabBar: 64,
} as const;
