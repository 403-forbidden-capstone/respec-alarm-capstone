// 개발용 화면 목록 데이터 — /dev/screens 화면과 웹 미리보기 기종 프레임 패널(components/dev)이 같이 씀
// 목업의 데모 패널 대신 화면 번호로 바로 열 때 쓰는 목록. 알람 설정(H03)은 가짜 데이터 알람(mocks/data)마다 한 줄
// 목업에 없는 로그인 · 온보딩 · 설정은 맨 아래 "처음 · 설정". 온보딩은 단계마다 바로 열기(?step=, 가짜 데이터 모드만)
import type { Href } from 'expo-router';

import { activeSteps, type OnboardingStepId } from '@/features/onboarding/steps';
import { ONBOARDING_IN_FLOW, TIMETABLE_PATHS } from '@/lib/flags';
import { canUseRealData, type DataMode } from '@/lib/mode';

// id = 목업 화면 번호, 목업에 없는 화면은 '—'. name = 짧은 이름 (자세한 설명은 화면을 열어 봄)
//   mockOnly = 가짜 데이터 모드에서만 열림 (실데이터면 로그인 · 온보딩 판정대로만 감)
//   fake = href가 가짜 데이터의 id(sy · cap · a1 …)를 씀 — 실데이터 모드에서는 줄을 숨김 (가짜 id는 서버에 없어 빈 화면이 됨)
export type ScreenRow = { id: string; name: string; href: Href; mockOnly?: boolean; fake?: boolean };

// 줄 하나 또는 접히는 줄 묶음 (온보딩 단계처럼 한 줄로 접어 두고 펼치면 단계가 나옴)
export type ScreenFold = { fold: string; rows: ScreenRow[] };
export type ScreenItem = ScreenRow | ScreenFold;
export const isFold = (item: ScreenItem): item is ScreenFold => 'fold' in item;

export type ScreenSection = { title: string; issue: string; rows: ScreenRow[]; items: ScreenItem[] };

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
const ONBOARDING_ROWS: ScreenRow[] = STEPS.map((step, i) => ({
  id: 'L02',
  name: `${i + 1}/${STEPS.length} ${STEP_TITLE[step]}`,
  href: { pathname: '/onboarding', params: { step } } as const,
  mockOnly: true,
}));
const FIRST_ITEMS: ScreenItem[] = canUseRealData
  ? [
      { id: 'L01', name: '로그인', href: '/login', mockOnly: true },
      ...(ONBOARDING_ROWS.length ? [{ fold: `온보딩 ${ONBOARDING_ROWS.length}단계`, rows: ONBOARDING_ROWS }] : []),
      { id: '—', name: '다시 동의', href: '/reconsent' },
      { id: '—', name: '계정 삭제 안내', href: '/account-deletion' },
      { id: 'L03', name: '설정', href: '/settings' },
      { id: 'L03', name: '학교 시간표', href: '/timetable' },
      ...(TIMETABLE_PATHS.photo || TIMETABLE_PATHS.calendar
        ? [{ id: 'L03', name: '시간표 가져오기 확인', href: '/timetable-import' as const }]
        : []),
    ]
  : [];

// 기능별 절 — 위에서부터 쓰는 순서. 친구 · 그룹은 처음 만나서 약속 · 기상 · 깨우기 · 제안까지 이어지는 흐름 순서
const SECTION_DEFS: { title: string; issue: string; items: ScreenItem[] }[] = [
  {
    title: '알람',
    issue: '#30',
    items: [
      { id: 'H01', name: '홈', href: '/' },
      { id: 'H02', name: '알람 목록', href: '/alarms' },
      { id: 'H03', name: '알람 설정 · 팀 주간회의', href: { pathname: '/alarm/[id]', params: { id: 'a1' } }, fake: true },
      { id: 'H03', name: '알람 설정 · 저녁약속', href: { pathname: '/alarm/[id]', params: { id: 'a2' } }, fake: true },
      { id: 'H03', name: '알람 설정 · 수업', href: { pathname: '/alarm/[id]', params: { id: 'a3' } }, fake: true },
      { id: 'H03', name: '알람 설정 · 영어 스터디', href: { pathname: '/alarm/[id]', params: { id: 'st1' } }, fake: true },
      { id: 'H05', name: '새 일정 만들기', href: '/schedule/new' },
      { id: 'H07', name: '알람 울림 · 기상', href: { pathname: '/ring', params: { alarm: 'a1:WAKE' } }, fake: true },
      { id: 'H07', name: '알람 울림 · 준비', href: { pathname: '/ring', params: { alarm: 'a1:PREPARE' } }, fake: true },
      { id: 'H07', name: '알람 울림 · 출발', href: { pathname: '/ring', params: { alarm: 'a1:DEPARTURE' } }, fake: true },
      { id: 'H08', name: '기상 확인', href: { pathname: '/wake', params: { alarm: 'a1:WAKE' } }, fake: true },
      { id: 'L04', name: '알람 안 울릴 때 점검표', href: '/ring-check' },
    ],
  },
  {
    title: '친구 · 그룹',
    issue: '#43',
    items: [
      { id: 'G01', name: '친구와 그룹 (친구 찾기 · 받은 요청)', href: '/group' },
      { id: 'F02', name: '친구 권한 · 이수연', href: { pathname: '/friends/[id]', params: { id: 'sy' } }, fake: true },
      { id: '—', name: '새 그룹 만들기', href: '/groups/new' },
      { id: '—', name: '초대 코드로 참여', href: '/groups/join' },
      { id: '—', name: '초대 받기 (초대 링크)', href: { pathname: '/invite', params: { t: 'sample' } }, fake: true },
      { id: 'G02', name: '그룹 상세 · 캡스톤팀 (연결 일정 · 내 알람 만들기)', href: { pathname: '/groups/[id]', params: { id: 'cap' } }, fake: true },
      { id: 'H05', name: '새 공동 약속 (함께할 그룹)', href: '/schedule/new' },
      {
        id: 'G03',
        name: '그룹원 기상 · 깨우기 · 수연',
        href: { pathname: '/groups/[id]/members/[userId]', params: { id: 'cap', userId: 'sy' } },
        fake: true,
      },
      { id: 'G04', name: '공유받은 알람 · 시각 제안 · 수연', href: { pathname: '/friends/[id]/alarms', params: { id: 'sy' } }, fake: true },
      { id: '—', name: '약속 변경 확인', href: { pathname: '/alarm/changed', params: { id: 'a1' } }, fake: true },
      { id: 'F03', name: '공유 권한 · 캡스톤팀', href: { pathname: '/permissions', params: { relation: 'group:cap' } }, fake: true },
      { id: '—', name: '차단 목록', href: '/blocks' },
    ],
  },
  {
    title: '기록 · 제안',
    issue: '#38',
    items: [
      { id: 'R02', name: '나의 기록', href: '/records' },
      { id: 'S01', name: '알람 조정 제안', href: { pathname: '/suggestion/[id]', params: { id: 's1' } }, fake: true },
    ],
  },
  {
    title: 'AI · 루틴',
    issue: '#39',
    items: [
      { id: 'A02', name: 'AI 대화', href: '/ai' },
      { id: 'A03', name: '하루 기록 · 5월 22일', href: { pathname: '/journal/[date]', params: { date: '2025-05-22' } }, fake: true },
      { id: 'A03', name: '하루 기록 · 5월 21일 (지난 날)', href: { pathname: '/journal/[date]', params: { date: '2025-05-21' } }, fake: true },
      { id: 'A04', name: '루틴 편집 · 회의 전날 준비', href: { pathname: '/routine/[id]', params: { id: 'new', journal: '2025-05-22' } }, fake: true },
    ],
  },
  {
    title: '처음 · 설정',
    issue: '#25',
    items: FIRST_ITEMS,
  },
];

const flat = (items: ScreenItem[]): ScreenRow[] => items.flatMap((item) => (isFold(item) ? item.rows : [item]));
const ALL_SECTIONS: ScreenSection[] = SECTION_DEFS.map((def) => ({ ...def, rows: flat(def.items) }));

// 지금 데이터 모드에서 열리는 줄인지 — 가짜 모드는 전부, 실데이터는 mockOnly(로그인 · 온보딩 미리 보기)와 가짜 id를 쓰는 줄(fake)을 뺌
const visible = (row: ScreenRow, mode: DataMode) => mode === 'mock' || (!row.mockOnly && !row.fake);

// 지금 데이터 모드에서 열리는 줄만. 줄이 없는 절(실데이터를 못 쓰는 빌드의 "처음 · 설정")은 뺌.
//   rows = 접힘 없이 평평한 줄 (/dev/screens), items = 접히는 묶음 그대로 (웹 미리보기 패널)
export function sectionsFor(mode: DataMode): ScreenSection[] {
  return ALL_SECTIONS.map((section) => {
    const items = section.items
      .map((item): ScreenItem | null => {
        if (!isFold(item)) return visible(item, mode) ? item : null;
        const rows = item.rows.filter((row) => visible(row, mode));
        return rows.length ? { ...item, rows } : null;
      })
      .filter((item): item is ScreenItem => item != null);
    return { ...section, items, rows: flat(items) };
  }).filter((section) => section.rows.length > 0);
}
