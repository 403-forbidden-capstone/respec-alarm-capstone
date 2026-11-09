import { describe, expect, it } from '@jest/globals';

import { filterSections, hrefPath, sectionIndexOfPath } from '../panelModel';
import { isFold, sectionsFor, type ScreenSection } from '../screenList';

// 웹 미리보기 패널 화면 목록 — 기능별 절 · 흐름 순서 · 실데이터에서 가짜 id 줄 숨김 · 거르기 · 지금 화면이 속한 절

const titles = (sections: ScreenSection[]) => sections.map((s) => s.title);

describe('화면 목록 데이터 (sectionsFor)', () => {
  it('기능별 절이 알람 → 친구 · 그룹 → 기록 · 제안 → AI · 루틴 순서', () => {
    expect(titles(sectionsFor('mock')).slice(0, 4)).toEqual(['알람', '친구 · 그룹', '기록 · 제안', 'AI · 루틴']);
  });

  it('친구 · 그룹은 친구 → 권한 → 그룹 만들기 · 참여 · 초대 → 그룹 상세 → 공동 약속 → 기상 · 깨우기 → 제안 → 약속 변경 → 공유 권한 → 차단 흐름 순서', () => {
    const friends = sectionsFor('mock').find((s) => s.title === '친구 · 그룹');
    expect(friends?.rows.map((r) => `${r.id}:${hrefPath(r.href)}`)).toEqual([
      'G01:/group',
      'F02:/friends/sy',
      '—:/groups/new',
      '—:/groups/join',
      '—:/invite',
      'G02:/groups/cap',
      'H05:/schedule/new',
      'G03:/groups/cap/members/sy',
      'G04:/friends/sy/alarms',
      '—:/alarm/changed',
      'F03:/permissions',
      '—:/blocks',
    ]);
  });

  it('목업 번호가 없는 화면은 번호 칸이 — 이고, 이름은 짧음(번호 + 짧은 이름)', () => {
    const rows = sectionsFor('mock').flatMap((s) => s.rows);
    expect(rows.every((r) => r.id.length > 0)).toBe(true);
    expect(rows.filter((r) => r.id === '—').map((r) => r.name)).toEqual(expect.arrayContaining(['새 그룹 만들기', '초대 코드로 참여', '차단 목록', '약속 변경 확인']));
    // 예전의 긴 설명("목업 번호 없음 · 와이어프레임 4번" 등)은 이름에 없음
    expect(rows.some((r) => r.name.includes('와이어프레임'))).toBe(false);
  });

  it('가짜 데이터 모드는 가짜 id 줄까지 전부, 실데이터 모드는 가짜 id(sy · cap · a1 …)를 쓰는 줄을 숨김', () => {
    const mock = sectionsFor('mock').flatMap((s) => s.rows);
    const real = sectionsFor('real').flatMap((s) => s.rows);
    expect(mock.some((r) => r.fake)).toBe(true);
    expect(real.some((r) => r.fake || r.mockOnly)).toBe(false);
    // 가짜 id를 안 쓰는 줄은 실데이터에서도 남음
    expect(real.map((r) => r.id)).toEqual(expect.arrayContaining(['H01', 'H02', 'G01', 'R02', 'A02']));
    expect(real.map((r) => r.id)).not.toContain('G03');
    // 그룹 상세 · 권한 줄이 다 숨겨져도 절은 남음(친구와 그룹 · 새 그룹 · 코드 참여 · 차단 목록)
    expect(titles(sectionsFor('real'))).toContain('친구 · 그룹');
  });

  it('/dev/screens가 쓰는 평평한 rows와 패널이 쓰는 items가 같은 줄을 가짐', () => {
    for (const section of sectionsFor('mock')) {
      const fromItems = section.items.flatMap((item) => (isFold(item) ? item.rows : [item]));
      expect(section.rows).toEqual(fromItems);
    }
  });
});

describe('화면 목록 순수 함수 (panelModel)', () => {
  const sections = sectionsFor('mock');

  it('hrefPath: 문자열 · [param]을 값으로 바꾼 객체 주소', () => {
    expect(hrefPath('/alarms')).toBe('/alarms');
    expect(hrefPath('/alarms?x=1')).toBe('/alarms');
    expect(hrefPath({ pathname: '/groups/[id]/members/[userId]', params: { id: 'cap', userId: 'sy' } })).toBe('/groups/cap/members/sy');
  });

  it('지금 열린 화면이 속한 절 — 못 찾으면 맨 위 절', () => {
    expect(titles(sections)[sectionIndexOfPath(sections, '/groups/cap/members/sy')]).toBe('친구 · 그룹');
    expect(titles(sections)[sectionIndexOfPath(sections, '/records')]).toBe('기록 · 제안');
    expect(titles(sections)[sectionIndexOfPath(sections, '/')]).toBe('알람');
    expect(sectionIndexOfPath(sections, '/모르는/주소')).toBe(0);
  });

  it('거르기: 번호 · 이름 글자(대소문자 무시)에 맞는 줄만, 빈 칸이면 그대로, 맞는 줄이 없는 절은 빠짐', () => {
    expect(filterSections(sections, '')).toBe(sections);
    expect(filterSections(sections, '   ')).toBe(sections);
    const g03 = filterSections(sections, 'g03');
    expect(g03.flatMap((s) => s.rows.map((r) => r.id))).toEqual(['G03']);
    const wake = filterSections(sections, '깨우기');
    expect(wake.flatMap((s) => s.rows.map((r) => r.id))).toContain('G03');
    expect(titles(filterSections(sections, 'zzzz'))).toEqual([]);
  });

  it('거르기: 접히는 묶음은 묶음 이름이 맞으면 통째로, 아니면 맞는 줄만', () => {
    const fold = { fold: '온보딩 3단계', rows: [{ id: 'L02', name: '1/3 내 아이디', href: '/onboarding' as const }, { id: 'L02', name: '2/3 닉네임', href: '/onboarding' as const }] };
    const section: ScreenSection = { title: '처음', issue: '#25', rows: fold.rows, items: [fold] };
    const whole = filterSections([section], '온보딩');
    expect(whole[0].rows).toHaveLength(2);
    const one = filterSections([section], '닉네임');
    expect(one[0].rows.map((r) => r.name)).toEqual(['2/3 닉네임']);
  });
});
