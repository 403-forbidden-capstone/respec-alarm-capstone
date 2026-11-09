import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { VIEW_ALARM_NOTE } from '../types';
import { messageLimit } from '../relationMessages';
import { previewProblem } from '../groupTexts';

// 친구 13장 · 15장 앱 층 (시험케이스 13-22 · 15-23 · 15-25 · 15-26) — 개인정보 안내 문구, 앱 번들에 서비스 키 없음, 실패 문구 통일
const SRC = path.resolve(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

describe('F03 알람 조회 안내 (13-22)', () => {
  it("'일정 장소도 보여요 · 집 · 출발지는 안 보여요'", () => {
    expect(VIEW_ALARM_NOTE).toBe('일정 장소도 보여요 · 집 · 출발지는 안 보여요');
  });
});

describe('앱 번들에 서비스 키 없음 (15-23)', () => {
  it('앱 소스에 service_role 키 · 환경변수 이름이 없음 (공개 anon 키만 씀)', () => {
    const hits = sourceFiles(SRC).filter((f) => /service_role|SERVICE_ROLE/.test(fs.readFileSync(f, 'utf8')));
    expect(hits.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});

describe('실패 문구 통일 (15-25 · 15-26)', () => {
  it('제한이 걸린 곳은 모두 같은 모양 — 잠시 뒤 다시 해 주세요(남은 시간)', () => {
    expect(messageLimit(42)).toBe('잠시 뒤 다시 해 주세요(42초)');
    expect(messageLimit(120)).toBe('잠시 뒤 다시 해 주세요(2분)');
    expect(previewProblem({ status: 'LIMIT', retryAfterSeconds: 42 } as never)).toBe(messageLimit(42)); // 코드 미리보기도 같은 모양
  });

  it('차단 · 탈퇴 · 없는 대상은 구분 없이 같은 문구, 제한일 때만 시간이 보임', () => {
    // 친구 요청 · 아이디 검색 · 링크는 서버가 없음 · 탈퇴 · 차단을 같은 NOT_FOUND로 주고 앱은 한 문구만 씀 (relations.test · newUi.test가 호출 경로를 확인)
    expect(messageLimit(5)).toContain('다시 해 주세요');
    expect('사용자를 찾을 수 없어요').not.toMatch(/차단|탈퇴|분|초/);
  });
});
