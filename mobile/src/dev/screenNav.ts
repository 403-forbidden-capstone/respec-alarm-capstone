// 웹 미리보기 패널 "화면 목록"이 무엇을 어떻게 보여 줄지 — 판단만 하는 순수 함수 (시험: __tests__/screenNav.test.ts)
//   목록 데이터는 screenList.ts, 여기는 실데이터 id 채우기 · 거르기 · 지금 화면이 속한 절 찾기 · 온보딩 같은 이어진 줄 접기
import type { Href } from 'expo-router';

import type { DataMode } from '@/lib/modePolicy';

import { sectionsFor, type ScreenRow, type ScreenTargets, type TargetNeed } from './screenList';

export const EMPTY_TARGETS: ScreenTargets = { friendId: null, groupId: null, appointmentId: null, alarmId: null };

const TARGET_KEY: Record<TargetNeed, keyof ScreenTargets> = { friend: 'friendId', group: 'groupId', appointment: 'appointmentId', alarm: 'alarmId' };
const MISSING_TEXT: Record<TargetNeed, string> = { friend: '(친구 없음)', group: '(그룹 없음)', appointment: '(일정 없음)', alarm: '(다음 알람 없음)' };
const LOADING_TEXT = '(불러오는 중)';

// 패널이 그리는 한 줄 — missing이 있으면 흐리게 하고 누를 수 없음
export type ResolvedRow = { row: ScreenRow; name: string; href: Href; missing: string | null };
export type PanelSection = { title: string; issue: string; rows: ResolvedRow[] };

// 실데이터면 가짜 id 줄을 내 첫 친구 · 그룹 · 다음 알람으로 바꿈. 없으면 missing(이유 글자), 읽는 중이면 '(불러오는 중)'
export function resolveRow(row: ScreenRow, mode: DataMode, targets: ScreenTargets, loading = false): ResolvedRow {
  if (mode !== 'real' || !row.real) return { row, name: row.name, href: row.href, missing: null };
  const name = row.real.name ?? row.name;
  const lacking = row.real.needs.find((need) => !targets[TARGET_KEY[need]]);
  if (lacking) return { row, name, href: row.href, missing: loading ? LOADING_TEXT : MISSING_TEXT[lacking] };
  return { row, name, href: row.real.href(targets), missing: null };
}

export function panelSections(mode: DataMode, targets: ScreenTargets, loading = false): PanelSection[] {
  return sectionsFor(mode).map((section) => ({
    title: section.title,
    issue: section.issue,
    rows: section.rows.map((row) => resolveRow(row, mode, targets, loading)),
  }));
}

// 거르기 — 공백으로 나눈 글자가 모두 화면 번호 + 이름에 들어 있는 줄만 (대소문자 무시). 줄이 없는 절은 뺌
export function filterSections(sections: PanelSection[], query: string): PanelSection[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sections;
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((r) => {
        const hay = `${r.row.id} ${r.name}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      }),
    }))
    .filter((section) => section.rows.length > 0);
}

// 주소 틀('/alarm/[id]')이 지금 주소('/alarm/a1')와 맞는지
function hrefPath(href: Href): string {
  const raw = typeof href === 'string' ? href : (href as { pathname: string }).pathname;
  return raw.split('?')[0];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function pathMatches(href: Href, pathname: string): boolean {
  const pattern = hrefPath(href)
    .split(/\[[^\]/]+\]/)
    .map(escapeRegExp)
    .join('[^/]+');
  return new RegExp(`^${pattern}/?$`).test(pathname);
}

// 지금 열린 화면이 속한 절 이름 (없으면 null). 같은 주소가 여러 절에 있으면 앞 절
export function currentSectionTitle(sections: readonly PanelSection[], pathname: string): string | null {
  return sections.find((section) => section.rows.some((r) => pathMatches(r.href, pathname)))?.title ?? null;
}

// 온보딩 단계처럼 `group`이 같은 줄이 이어지면 한 덩어리로 (패널이 한 줄로 접어 보임). 나머지는 그대로
export type RowItem = { kind: 'row'; row: ResolvedRow } | { kind: 'group'; name: string; rows: ResolvedRow[] };

export function foldRows(rows: readonly ResolvedRow[]): RowItem[] {
  const out: RowItem[] = [];
  for (const r of rows) {
    const name = r.row.group;
    const last = out[out.length - 1];
    if (name && last?.kind === 'group' && last.name === name) last.rows.push(r);
    else if (name) out.push({ kind: 'group', name, rows: [r] });
    else out.push({ kind: 'row', row: r });
  }
  return out;
}
