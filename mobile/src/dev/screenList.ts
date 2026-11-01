// 개발용 화면 목록 데이터 — /dev/screens 화면과 웹 미리보기 기종 프레임 패널(components/dev)이 같이 씀
// 목업의 데모 패널 대신 화면 번호로 바로 열 때 쓰는 목록. 목업에 없는 로그인 · 온보딩 · 설정은 두지 않음 (#116)
import type { Href } from 'expo-router';

export type ScreenRow = { id: string; name: string; href: Href };

export type ScreenSection = { title: string; issue: string; rows: ScreenRow[] };

export const SECTIONS: ScreenSection[] = [
  {
    title: '홈 · 알람',
    issue: '#30',
    rows: [
      { id: 'H01', name: '홈', href: '/' },
      { id: 'H02', name: '알람 목록', href: '/alarms' },
      { id: 'H03', name: '알람 설정 · 팀 주간회의', href: { pathname: '/alarm/[id]', params: { id: 'a1' } } },
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
      { id: 'G01', name: '새 그룹 만들기 (목업 번호 없음 · 와이어프레임 4번)', href: '/groups/new' },
      { id: 'G01', name: '초대 코드로 참여 (목업 번호 없음 · 와이어프레임 4번)', href: '/groups/join' },
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
];
