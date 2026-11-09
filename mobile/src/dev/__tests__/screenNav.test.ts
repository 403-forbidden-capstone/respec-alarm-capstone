import { describe, expect, it } from '@jest/globals';

import { ONBOARDING_GROUP, sectionsFor, type ScreenRow, type ScreenTargets } from '../screenList';
import { currentSectionTitle, EMPTY_TARGETS, filterSections, foldRows, panelSections, pathMatches, resolveRow } from '../screenNav';

const TARGETS: ScreenTargets = { friendId: 'f-1', groupId: 'g-1', appointmentId: 'ap-1', alarmId: 'al-1' };

const row = (id: string, name: string, extra: Partial<ScreenRow> = {}): ScreenRow => ({ id, name, href: '/group', ...extra });

describe('실데이터에서 가짜 id 줄 채우기 (resolveRow)', () => {
  const friendRow = row('F02', '친구 권한 · 이수연', {
    href: { pathname: '/friends/[id]', params: { id: 'sy' } },
    real: { needs: ['friend'], href: (t) => ({ pathname: '/friends/[id]', params: { id: t.friendId as string } }), name: '친구 권한 · 내 첫 친구' },
  });

  it('가짜 데이터 모드는 가짜 id 그대로', () => {
    const r = resolveRow(friendRow, 'mock', TARGETS);
    expect(r.href).toEqual({ pathname: '/friends/[id]', params: { id: 'sy' } });
    expect(r.name).toBe('친구 권한 · 이수연');
    expect(r.missing).toBeNull();
  });

  it('실데이터는 내 첫 친구 id로 열고 이름도 바꿈', () => {
    const r = resolveRow(friendRow, 'real', TARGETS);
    expect(r.href).toEqual({ pathname: '/friends/[id]', params: { id: 'f-1' } });
    expect(r.name).toBe('친구 권한 · 내 첫 친구');
    expect(r.missing).toBeNull();
  });

  it('친구가 없으면 흐리게 — 이유 글자, 읽는 중이면 불러오는 중', () => {
    expect(resolveRow(friendRow, 'real', EMPTY_TARGETS).missing).toBe('(친구 없음)');
    expect(resolveRow(friendRow, 'real', EMPTY_TARGETS, true).missing).toBe('(불러오는 중)');
  });

  it('필요한 것이 둘이면 모두 있어야 열림 (그룹원 줄 = 그룹 + 친구)', () => {
    const member = row('G03', '그룹원 기상', {
      real: { needs: ['group', 'friend'], href: (t) => ({ pathname: '/groups/[id]/members/[userId]', params: { id: t.groupId as string, userId: t.friendId as string } }) },
    });
    expect(resolveRow(member, 'real', { ...TARGETS, friendId: null }).missing).toBe('(친구 없음)');
    expect(resolveRow(member, 'real', { ...TARGETS, groupId: null }).missing).toBe('(그룹 없음)');
    expect(resolveRow(member, 'real', TARGETS).href).toEqual({ pathname: '/groups/[id]/members/[userId]', params: { id: 'g-1', userId: 'f-1' } });
  });

  it('real이 없는 줄(id 없는 화면)은 실데이터에서도 그대로', () => {
    const plain = row('R02', '나의 기록', { href: '/records' });
    expect(resolveRow(plain, 'real', EMPTY_TARGETS)).toMatchObject({ href: '/records', missing: null });
  });
});

describe('목록 데이터 (screenList)', () => {
  it('절은 기능별이고 친구 · 그룹은 흐름 순서 (친구와 그룹 → 친구 권한 → 그룹 만들기 · 참여 → 그룹 상세 → 새 공동 약속 → 기상 → 공유받은 알람 → 공유 권한 → 차단)', () => {
    const sections = sectionsFor('mock');
    expect(sections.map((s) => s.title)).toEqual(expect.arrayContaining(['알람', '친구 · 그룹', '기록 · 제안', 'AI · 루틴']));
    const friends = sections.find((s) => s.title === '친구 · 그룹');
    const ids = friends?.rows.map((r) => r.id);
    expect(ids).toEqual(['G01', 'F02', '—', '—', '—', 'G02', 'H05', 'G03', 'G04', '—', 'F03', '—']);
  });

  it('목업 번호가 없는 화면은 번호 칸이 — 이고 새 길(차단 목록 · 약속 변경 · 초대 받기 · 다시 동의 · 계정 삭제 안내)이 들어 있음', () => {
    const all = sectionsFor('mock').flatMap((s) => s.rows);
    for (const path of ['/blocks', '/invite', '/groups/new', '/groups/join', '/account-deletion']) {
      const found = all.find((r) => r.href === path);
      expect(found?.id).toBe('—');
    }
    expect(all.some((r) => typeof r.href === 'object' && (r.href as { pathname: string }).pathname === '/alarm/changed')).toBe(true);
  });

  it('실데이터에는 가짜 id만 쓰는 줄이 없음 — 열 곳이 없는 줄은 숨기고 나머지는 real로 채움', () => {
    const rows = sectionsFor('real').flatMap((s) => s.rows);
    for (const r of rows) {
      const fake = JSON.stringify(r.href).match(/"(sy|cap|a1|a2|a3|st1|s1)(:[A-Z]+)?"/);
      if (fake) expect(r.real).toBeDefined(); // 가짜 id가 든 줄은 real이 있어 실제 id로 바뀜
    }
    expect(rows.every((r) => !r.mockOnly)).toBe(true);
  });

  it('온보딩 단계는 group으로 묶이고 가짜 데이터에만 있음', () => {
    const mockRows = sectionsFor('mock').flatMap((s) => s.rows);
    const steps = mockRows.filter((r) => r.group === ONBOARDING_GROUP);
    if (steps.length > 0) {
      expect(steps.every((r) => r.id === 'L02')).toBe(true);
      expect(sectionsFor('real').flatMap((s) => s.rows).some((r) => r.group === ONBOARDING_GROUP)).toBe(false);
    }
  });
});

describe('거르기 (filterSections)', () => {
  const sections = panelSections('mock', EMPTY_TARGETS);

  it('빈 글자는 그대로', () => {
    expect(filterSections(sections, '  ')).toBe(sections);
  });

  it('화면 번호로 거름 (대소문자 무시)', () => {
    const found = filterSections(sections, 'g03');
    expect(found.flatMap((s) => s.rows.map((r) => r.row.id))).toEqual(['G03']);
  });

  it('이름 글자로 거르고 줄이 없는 절은 뺌', () => {
    const found = filterSections(sections, '차단');
    expect(found.map((s) => s.title)).toEqual(['친구 · 그룹']);
    expect(found[0].rows.map((r) => r.name)).toEqual(['차단 목록']);
  });

  it('공백으로 나눈 글자는 모두 들어 있어야 함', () => {
    expect(filterSections(sections, '그룹 상세').flatMap((s) => s.rows.map((r) => r.row.id))).toContain('G02');
    expect(filterSections(sections, '그룹 zzzz')).toEqual([]);
  });
});

describe('지금 화면이 속한 절 (currentSectionTitle · pathMatches)', () => {
  const sections = panelSections('mock', EMPTY_TARGETS);

  it('주소 틀의 [id] 자리는 아무 값이나 맞음', () => {
    expect(pathMatches({ pathname: '/alarm/[id]', params: { id: 'a1' } }, '/alarm/st1')).toBe(true);
    expect(pathMatches({ pathname: '/alarm/[id]', params: { id: 'a1' } }, '/alarm/changed/x')).toBe(false);
    expect(pathMatches('/group', '/group')).toBe(true);
    expect(pathMatches('/group', '/groups/new')).toBe(false);
  });

  it('주소로 절을 찾음', () => {
    expect(currentSectionTitle(sections, '/')).toBe('알람');
    expect(currentSectionTitle(sections, '/alarm/a2')).toBe('알람');
    expect(currentSectionTitle(sections, '/groups/cap')).toBe('친구 · 그룹');
    expect(currentSectionTitle(sections, '/blocks')).toBe('친구 · 그룹');
    expect(currentSectionTitle(sections, '/records')).toBe('기록 · 제안');
    expect(currentSectionTitle(sections, '/nowhere')).toBeNull();
  });
});

describe('접기 (foldRows)', () => {
  it('group이 같은 줄이 이어지면 한 덩어리, 나머지는 그대로', () => {
    const rows = ['a', 'b', 'c', 'd'].map((n, i) => resolveRow(row('L02', n, i === 1 || i === 2 ? { group: '온보딩' } : {}), 'mock', EMPTY_TARGETS));
    const folded = foldRows(rows);
    expect(folded.map((f) => f.kind)).toEqual(['row', 'group', 'row']);
    expect(folded[1]).toMatchObject({ kind: 'group', name: '온보딩' });
    expect((folded[1] as { rows: unknown[] }).rows).toHaveLength(2);
  });
});
