// 개발용 화면 목록 데이터 — /dev/screens 화면과 웹 미리보기 기종 프레임 패널(components/dev)이 같이 씀
// 목업의 데모 패널 대신 화면 번호로 바로 열 때 쓰는 목록. 알람 설정(H03)은 가짜 데이터 알람(mocks/data)마다 한 줄
// 목업에 없는 로그인 · 온보딩 · 설정은 맨 아래 "처음 · 설정". 온보딩은 단계마다 바로 열기(?step=, 가짜 데이터 모드만)
import type { Href } from 'expo-router';

import { activeSteps, type OnboardingStepId } from '@/features/onboarding/steps';
import { ONBOARDING_IN_FLOW, TIMETABLE_PATHS } from '@/lib/flags';
import { canUseRealData, type DataMode } from '@/lib/mode';

export type ScreenRow = { id: string; name: string; href: Href; mockOnly?: boolean }; // mockOnly = 가짜 데이터 모드에서만 열림 (실데이터면 로그인 · 온보딩 판정대로만 감)

export type ScreenSection = { title: string; issue: string; rows: ScreenRow[] };

// 온보딩 단계 제목 — app/onboarding.tsx 단계 화면의 제목과 같게
const STEP_TITLE: Record<OnboardingStepId, string> = {
  handle: '내 아이디',
  nickname: '닉네임',
  sleep: '잠귀',
  home: '집 위치',
  prepare: '아침 준비',
  timetable: '수업 시간표',
  consent: '개인정보 안내',
  permissions: '권한 안내',
  share: '기상 공유 안내',
  first: '첫 일정',
  mic: '마이크',
};

// 로그인 · 온보딩 · 설정은 실데이터를 쓸 수 있는 빌드에서만 열림 — app/_layout.tsx 막는 조건과 같게
//   로그인 · 온보딩은 가짜 모드의 미리 보기로만 열림(preview). 실데이터면 로그인 · 온보딩 판정이 정하므로 줄을 숨김(mockOnly)
//   온보딩은 흐름에서 빼면(ONBOARDING_IN_FLOW) 주소로도 안 열리고, 시간표 가져오기는 사진 · 캘린더 길이 둘 다 꺼지면 안 열림
const STEPS = ONBOARDING_IN_FLOW ? activeSteps() : []; // 켜진 단계만 (lib/flags ONBOARDING_STEPS)
const FIRST_ROWS: ScreenRow[] = canUseRealData
  ? [
      { id: 'L01', name: '로그인', href: '/login', mockOnly: true },
      ...STEPS.map((step, i) => ({
        id: 'L02',
        name: `온보딩 ${i + 1}/${STEPS.length} · ${STEP_TITLE[step]}`,
        href: { pathname: '/onboarding', params: { step } } as const,
        mockOnly: true,
      })),
      { id: 'L03', name: '설정', href: '/settings' },
      ...(TIMETABLE_PATHS.photo || TIMETABLE_PATHS.calendar
        ? [{ id: 'L03', name: '시간표 가져오기 확인 (설정 · 온보딩 시간표에서 들어옴)', href: '/timetable-import' as const }]
        : []),
    ]
  : [];

const ALL_SECTIONS: ScreenSection[] = [
  {
    title: '홈 · 알람',
    issue: '#30',
    rows: [
      { id: 'H01', name: '홈', href: '/' },
      { id: 'H02', name: '알람 목록', href: '/alarms' },
      { id: 'H03', name: '알람 설정 · 팀 주간회의 (매주 · 캡스톤팀 공유)', href: { pathname: '/alarm/[id]', params: { id: 'a1' } } },
      { id: 'H03', name: '알람 설정 · 저녁약속 (기상 없이 준비 · 출발)', href: { pathname: '/alarm/[id]', params: { id: 'a2' } } },
      { id: 'H03', name: '알람 설정 · 수업 (내일 · 준비 전 활동)', href: { pathname: '/alarm/[id]', params: { id: 'a3' } } },
      { id: 'H03', name: '알람 설정 · 영어 스터디 (반복 · 앞으로 회차)', href: { pathname: '/alarm/[id]', params: { id: 'st1' } } },
      { id: 'H05', name: '새 일정 만들기', href: '/schedule/new' },
      { id: 'H07', name: '알람 울림 · 기상', href: { pathname: '/ring', params: { alarm: 'a1:WAKE' } } },
      { id: 'H07', name: '알람 울림 · 준비', href: { pathname: '/ring', params: { alarm: 'a1:PREPARE' } } },
      { id: 'H07', name: '알람 울림 · 출발', href: { pathname: '/ring', params: { alarm: 'a1:DEPARTURE' } } },
      { id: 'H08', name: '기상 확인 · 해제 전 빈 화면 (판정은 H07 기상 → 알람 해제)', href: { pathname: '/wake', params: { alarm: 'a1:WAKE' } } },
      { id: 'L04', name: '알람이 안 울릴 때 점검표 (웹은 위 샘플 권한 상태를 골라야 상태가 보임)', href: '/ring-check' },
    ],
  },
  {
    title: '그룹 · 친구',
    issue: '#43',
    rows: [
      { id: 'G01', name: '친구와 그룹', href: '/group' },
      { id: 'F02', name: '친구 권한 · 이수연', href: { pathname: '/friends/[id]', params: { id: 'sy' } } },
      { id: 'F03', name: '공유 권한 설정 · 캡스톤팀', href: { pathname: '/permissions', params: { relation: 'group:cap' } } },
      { id: 'G02', name: '그룹 상세 · 캡스톤팀', href: { pathname: '/groups/[id]', params: { id: 'cap' } } },
      {
        id: 'G03',
        name: '그룹원 기상 상태 · 수연',
        href: { pathname: '/groups/[id]/members/[userId]', params: { id: 'cap', userId: 'sy' } },
      },
      { id: 'G04', name: '공유받은 알람 · 수연', href: { pathname: '/friends/[id]/alarms', params: { id: 'sy' } } },
    ],
  },
  {
    title: '기록 · 제안',
    issue: '#38',
    rows: [
      { id: 'R02', name: '나의 기록', href: '/records' },
      { id: 'S01', name: '알람 조정 제안', href: { pathname: '/suggestion/[id]', params: { id: 's1' } } },
    ],
  },
  {
    title: 'AI · 루틴',
    issue: '#39',
    rows: [
      { id: 'A02', name: 'AI 대화', href: '/ai' },
      { id: 'A03', name: '하루 기록 · 일기', href: { pathname: '/journal/[date]', params: { date: '2025-05-22' } } },
      { id: 'A03', name: '하루 기록 · 일기 · 지난 날 (5월 21일)', href: { pathname: '/journal/[date]', params: { date: '2025-05-21' } } },
      {
        id: 'A04',
        name: '루틴 편집 · 회의 전날 준비',
        href: { pathname: '/routine/[id]', params: { id: 'new', journal: '2025-05-22' } },
      },
    ],
  },
  {
    title: '처음 · 설정',
    issue: '#25',
    rows: FIRST_ROWS,
  },
];

// 지금 데이터 모드에서 열리는 줄만. 줄이 없는 절(실데이터를 못 쓰는 빌드의 "처음 · 설정")은 뺌
export function sectionsFor(mode: DataMode): ScreenSection[] {
  return ALL_SECTIONS.map((section) => ({ ...section, rows: section.rows.filter((row) => mode === 'mock' || !row.mockOnly) })).filter(
    (section) => section.rows.length > 0,
  );
}
