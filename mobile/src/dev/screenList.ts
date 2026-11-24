// 개발용 화면 목록 데이터 — /dev/screens 화면과 웹 미리보기 기종 프레임 패널(components/dev)이 같이 씀
// 목업의 데모 패널 대신 화면 번호로 바로 열 때 쓰는 목록. 절은 기능별(알람 · 친구 · 그룹 · 기록 · AI · 처음), 친구 · 그룹은 쓰는 흐름 순서
// 목업 번호가 없는 화면은 번호 칸 '—'. 온보딩은 단계마다 바로 열기(?step=, 가짜 데이터 모드만) — 패널은 `group`이 같은 줄을 한 줄로 접어 보임
// 실데이터 모드: 가짜 id(sy · cap · a1)를 쓰는 줄은 `real`로 내 첫 친구 · 첫 그룹 · 다음 알람에 맞춰 열고, 없으면 흐리게 보임 (resolveRow, 패널 · 시험은 screenNav)
import type { Href } from 'expo-router';

import { activeSteps, type OnboardingStepId } from '@/features/onboarding/steps';
import { ONBOARDING_IN_FLOW, TIMETABLE_PATHS } from '@/lib/flags';
import { canUseRealData, type DataMode } from '@/lib/mode';

// 실데이터에서 가짜 id 자리에 넣을 내 데이터 (패널이 서버에서 읽어 옴, 없으면 null)
export type ScreenTargets = { friendId: string | null; groupId: string | null; appointmentId: string | null; alarmId: string | null };
export type TargetNeed = 'friend' | 'group' | 'appointment' | 'alarm';

export type ScreenRow = {
  id: string; // 목업 화면 번호, 없으면 '—'
  name: string;
  href: Href; // 가짜 데이터 모드에서 여는 곳 (가짜 id)
  mockOnly?: boolean; // 가짜 데이터 모드에서만 줄이 있음 (실데이터면 로그인 · 온보딩 판정대로만 가거나, 가짜 id뿐이라 열 곳이 없음)
  group?: string; // 같은 값이 이어진 줄은 패널에서 한 줄로 접힘 (온보딩 단계)
  real?: { needs: readonly TargetNeed[]; href: (t: ScreenTargets) => Href; name?: string }; // 실데이터에서 여는 곳 — needs가 모두 있어야 열림
};

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
export const ONBOARDING_GROUP = '온보딩';
const FIRST_ROWS: ScreenRow[] = canUseRealData
  ? [
      { id: 'L01', name: '로그인', href: '/login', mockOnly: true },
      ...STEPS.map((step, i) => ({
        id: 'L02',
        name: `${i + 1}/${STEPS.length} · ${STEP_TITLE[step]}`,
        href: { pathname: '/onboarding', params: { step } } as const,
        mockOnly: true,
        group: ONBOARDING_GROUP,
      })),
      { id: 'L03', name: '설정', href: '/settings' },
      { id: '—', name: '다시 동의 (개인정보 안내가 바뀐 뒤)', href: '/reconsent' },
      { id: 'L03', name: '학교 시간표 (반복 일정 · 가져오기)', href: '/timetable' },
      ...(TIMETABLE_PATHS.photo || TIMETABLE_PATHS.calendar
        ? [{ id: 'L03', name: '시간표 가져오기 확인', href: '/timetable-import' as const }]
        : []),
    ]
  : [];

const needs = (...list: TargetNeed[]) => list;

const ALL_SECTIONS: ScreenSection[] = [
  {
    title: '알람',
    issue: '#30',
    rows: [
      { id: 'H01', name: '홈', href: '/' },
      { id: 'H02', name: '알람 목록 (2번 탭)', href: '/alarms' },
      {
        id: 'H03',
        name: '알람 설정 · 팀 주간회의 (매주 · 캡스톤팀 공유)',
        href: { pathname: '/alarm/[id]', params: { id: 'a1' } },
        real: { needs: needs('appointment'), href: (t) => ({ pathname: '/alarm/[id]', params: { id: t.appointmentId as string } }), name: '알람 설정 · 내 다음 일정' },
      },
      { id: 'H03', name: '알람 설정 · 저녁약속 (기상 없이 준비 · 출발)', href: { pathname: '/alarm/[id]', params: { id: 'a2' } }, mockOnly: true },
      { id: 'H03', name: '알람 설정 · 수업 (내일 · 준비 전 활동)', href: { pathname: '/alarm/[id]', params: { id: 'a3' } }, mockOnly: true },
      { id: 'H03', name: '알람 설정 · 영어 스터디 (반복 · 앞으로 회차)', href: { pathname: '/alarm/[id]', params: { id: 'st1' } }, mockOnly: true },
      { id: 'H05', name: '새 일정 만들기', href: '/schedule/new' },
      {
        id: 'H07',
        name: '알람 울림 · 기상',
        href: { pathname: '/ring', params: { alarm: 'a1:WAKE' } },
        real: { needs: needs('alarm'), href: (t) => ({ pathname: '/ring', params: { alarm: t.alarmId as string } }), name: '알람 울림 · 내 다음 알람' },
      },
      { id: 'H07', name: '알람 울림 · 준비', href: { pathname: '/ring', params: { alarm: 'a1:PREPARE' } }, mockOnly: true },
      { id: 'H07', name: '알람 울림 · 출발', href: { pathname: '/ring', params: { alarm: 'a1:DEPARTURE' } }, mockOnly: true },
      {
        id: 'H08',
        name: '기상 확인 (해제 전 빈 화면)',
        href: { pathname: '/wake', params: { alarm: 'a1:WAKE' } },
        real: { needs: needs('alarm'), href: (t) => ({ pathname: '/wake', params: { alarm: t.alarmId as string } }) },
      },
      { id: 'H09', name: '아침 루틴 음성 진행', href: '/routine-run' },
      { id: 'L04', name: '알람 점검표 (웹은 샘플 권한 상태를 골라야 보임)', href: '/ring-check' },
    ],
  },
  {
    title: '친구 · 그룹',
    issue: '#43',
    rows: [
      { id: 'G01', name: '친구와 그룹 · 친구 찾기 · 받은 요청', href: '/group' },
      {
        id: 'F02',
        name: '친구 권한 · 이수연',
        href: { pathname: '/friends/[id]', params: { id: 'sy' } },
        real: { needs: needs('friend'), href: (t) => ({ pathname: '/friends/[id]', params: { id: t.friendId as string } }), name: '친구 권한 · 내 첫 친구' },
      },
      { id: '—', name: '새 그룹 만들기', href: '/groups/new' },
      { id: '—', name: '초대 코드로 참여', href: '/groups/join' },
      { id: '—', name: '초대 받기 (링크로 열림)', href: '/invite' },
      {
        id: 'G02',
        name: '그룹 상세 · 연결 일정 · 내 알람 만들기 · 캡스톤팀',
        href: { pathname: '/groups/[id]', params: { id: 'cap' } },
        real: { needs: needs('group'), href: (t) => ({ pathname: '/groups/[id]', params: { id: t.groupId as string } }), name: '그룹 상세 · 연결 일정 · 내 알람 만들기 · 내 첫 그룹' },
      },
      { id: 'H05', name: '새 공동 약속 (함께할 그룹 고르기)', href: '/schedule/new' },
      {
        id: 'G03',
        name: '그룹원 기상 · 깨우기 · 수연',
        href: { pathname: '/groups/[id]/members/[userId]', params: { id: 'cap', userId: 'sy' } },
        real: {
          needs: needs('group', 'friend'),
          href: (t) => ({ pathname: '/groups/[id]/members/[userId]', params: { id: t.groupId as string, userId: t.friendId as string } }),
          name: '그룹원 기상 · 깨우기 · 내 첫 친구',
        },
      },
      {
        id: 'G04',
        name: '공유받은 알람 · 시각 제안 · 수연',
        href: { pathname: '/friends/[id]/alarms', params: { id: 'sy' } },
        real: { needs: needs('friend'), href: (t) => ({ pathname: '/friends/[id]/alarms', params: { id: t.friendId as string } }), name: '공유받은 알람 · 시각 제안 · 내 첫 친구' },
      },
      {
        id: '—',
        name: '약속 변경 확인 (공동 약속이 바뀐 뒤)',
        href: { pathname: '/alarm/changed', params: { id: 'a1' } },
        real: { needs: needs('appointment'), href: (t) => ({ pathname: '/alarm/changed', params: { id: t.appointmentId as string } }) },
      },
      {
        id: 'F03',
        name: '공유 권한 설정 · 캡스톤팀',
        href: { pathname: '/permissions', params: { relation: 'group:cap' } },
        real: { needs: needs('group'), href: (t) => ({ pathname: '/permissions', params: { relation: `group:${t.groupId as string}` } }), name: '공유 권한 설정 · 내 첫 그룹' },
      },
      { id: '—', name: '차단 목록', href: '/blocks' },
    ],
  },
  {
    title: '기록 · 제안',
    issue: '#38',
    rows: [
      { id: 'R02', name: '나의 기록 (홈 맨 아래, D110)', href: '/' },
      { id: 'S01', name: '알람 조정 제안', href: { pathname: '/suggestion/[id]', params: { id: 's1' } }, mockOnly: true },
    ],
  },
  {
    title: 'AI · 루틴',
    issue: '#39',
    rows: [
      { id: 'A02', name: 'AI 대화', href: '/ai' },
      { id: 'A03', name: '하루 기록 · 일기', href: { pathname: '/journal/[date]', params: { date: '2025-05-22' } }, mockOnly: true },
      { id: 'A03', name: '하루 기록 · 일기 · 지난 날 (5월 21일)', href: { pathname: '/journal/[date]', params: { date: '2025-05-21' } }, mockOnly: true },
      {
        id: 'A04',
        name: '루틴 편집 · 회의 전날 준비',
        href: { pathname: '/routine/[id]', params: { id: 'new', journal: '2025-05-22' } },
        mockOnly: true,
      },
    ],
  },
  {
    title: '처음 · 설정',
    issue: '#25',
    rows: [...FIRST_ROWS, { id: '—', name: '계정 삭제 안내 (웹 페이지)', href: '/account-deletion' }],
  },
];

// 지금 데이터 모드에서 열리는 줄만. 줄이 없는 절(실데이터를 못 쓰는 빌드의 "처음 · 설정")은 뺌
export function sectionsFor(mode: DataMode): ScreenSection[] {
  return ALL_SECTIONS.map((section) => ({ ...section, rows: section.rows.filter((row) => mode === 'mock' || !row.mockOnly) })).filter(
    (section) => section.rows.length > 0,
  );
}
