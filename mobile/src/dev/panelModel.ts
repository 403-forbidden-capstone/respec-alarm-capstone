// 웹 미리보기 왼쪽 패널(components/dev/DevicePanel)의 "데이터 모드" · "개발 도구" 블록이 무엇을 보여 줄지 — 판단만 하는 순수 함수 (시험: __tests__/panelModel.test.ts)
// 규칙은 /dev/screens 맨 위와 같음: 모드 규칙은 lib/modePolicy.ts, 이 파일은 그 결과를 패널 글자 · 줄로 옮길 뿐
import type { Href } from 'expo-router';

import type { DataMode } from '@/lib/modePolicy';

import type { ScreenItem, ScreenRow, ScreenSection } from './screenList';

export type ModeBlockInput = {
  mode: DataMode;
  ready: boolean; // lib/flags REAL_DATA_READY
  canUseReal: boolean; // lib/mode canUseRealData (스위치가 켜졌고 Supabase 값이 있음)
  locked: boolean; // lib/mode modeLocked (폰 출시용 빌드 — 웹 패널에서는 늘 false)
  devLogin: boolean; // lib/mode devLoginVisible
  signedIn: boolean;
  email: string | null;
  nickname: string | null;
};

// 모드 아래 한 줄 — 가짜 모드는 계정 줄이 없음
export type AccountLine =
  | { kind: 'none' }
  | { kind: 'signedIn'; label: string | null } // 이메일, 없으면(카카오 등) 닉네임, 그것도 없으면 null (화면은 "로그인됨"만 보임)
  | { kind: 'signedOut'; devLogin: boolean }; // 로그인 전 — devLogin이면 "개발용 이메일 로그인" 버튼

export type ModeBlock = {
  realDisabled: boolean; // 실데이터를 흐리게 (이 빌드에서 못 씀)
  reason: string | null; // 흐리게 한 이유 한 줄
  account: AccountLine;
};

// 이메일 → 닉네임 순, 둘 다 없으면 null (공백만 있는 값은 없는 것으로)
export function accountLabel(email: string | null | undefined, nickname: string | null | undefined): string | null {
  return email?.trim() || nickname?.trim() || null;
}

// 모드를 못 바꾸는 빌드(locked)면 null — /dev/screens가 토글을 아예 안 그리는 것과 같음
export function modeBlock(input: ModeBlockInput): ModeBlock | null {
  if (input.locked) return null;
  // 실데이터를 못 쓰는 이유는 둘뿐 (lib/modePolicy.ts 표): 스위치가 꺼졌거나, 켜졌는데 Supabase 값이 없거나
  const reason = input.canUseReal
    ? null
    : !input.ready
      ? 'REAL_DATA_READY가 꺼져 있어 실데이터를 쓸 수 없어요'
      : 'Supabase 주소 · 키가 없어 실데이터를 쓸 수 없어요';
  const account: AccountLine =
    input.mode !== 'real' || !input.canUseReal
      ? { kind: 'none' }
      : input.signedIn
        ? { kind: 'signedIn', label: accountLabel(input.email, input.nickname) }
        : { kind: 'signedOut', devLogin: input.devLogin };
  return { realDisabled: !input.canUseReal, reason, account };
}

// 패널 "개발 도구" — 누르면 프레임 안에서 열림 (src/app/dev/ 아래 화면)
export type DevTool = { href: Href; name: string; note: string };

export const DEV_TOOLS: readonly DevTool[] = [
  { href: '/dev/alarm-test', name: '알람 테스트', note: '예약 · 울림 · 기록 · 권한' },
  { href: '/dev/ui', name: '부품 모음', note: '색 · 글자 · 버튼 견본' },
  // "화면 목록"은 패널의 같은 이름 블록과 겹쳐서 "개발 메뉴"로 부름 — 로그인 화면의 "개발 메뉴에서 이메일로 로그인"과 같은 이름
  { href: '/dev/screens', name: '개발 메뉴', note: '이메일 로그인 · 화면 번호로 열기' },
];

// ---- 화면 목록 (패널 맨 위) ----

// href를 열렸을 때의 주소 글자로 — '/alarm/[id]' + { id: 'a1' } → '/alarm/a1'. usePathname()과 맞춰 보려는 용도
export function hrefPath(href: Href): string {
  if (typeof href === 'string') return href.split('?')[0];
  const params = (href as { params?: Record<string, unknown> }).params ?? {};
  const pathname = (href as { pathname: string }).pathname;
  return pathname.replace(/\[(\w+)\]/g, (_, key: string) => String(params[key] ?? `[${key}]`));
}

const rowsOf = (item: ScreenItem): ScreenRow[] => ('fold' in item ? item.rows : [item]);

// 지금 열린 화면이 속한 절의 번호 — 못 찾으면 0 (맨 위 절). 같은 화면이 여러 절에 있으면 먼저 나온 절
export function sectionIndexOfPath(sections: ScreenSection[], pathname: string): number {
  const at = sections.findIndex((section) => section.rows.some((row) => hrefPath(row.href) === pathname));
  return at < 0 ? 0 : at;
}

// 거르기 칸 — 번호나 이름에 글자가 들어 있는 줄만 (대소문자 무시). 묶음은 이름이 맞으면 통째로, 아니면 맞는 단계만. 비면 그대로
export function filterSections(sections: ScreenSection[], query: string): ScreenSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  const hit = (text: string) => text.toLowerCase().includes(q);
  const rowHit = (row: ScreenRow) => hit(row.id) || hit(row.name);
  return sections
    .map((section) => {
      const items = section.items
        .map((item): ScreenItem | null => {
          if (!('fold' in item)) return rowHit(item) ? item : null;
          if (hit(item.fold)) return item;
          const rows = item.rows.filter(rowHit);
          return rows.length ? { ...item, rows } : null;
        })
        .filter((item): item is ScreenItem => item != null);
      return { ...section, items, rows: items.flatMap(rowsOf) };
    })
    .filter((section) => section.items.length > 0);
}
