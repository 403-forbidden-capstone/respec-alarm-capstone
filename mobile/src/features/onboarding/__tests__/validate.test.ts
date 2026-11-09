import { describe, expect, it } from '@jest/globals';

import { CONSENT_ITEMS, PRIVACY_VERSION } from '../consent';
import { cleanHandle, cleanNickname, isHandleFormat, isNicknameOk, NICKNAME_MAX, shouldSaveHandle } from '../validate';

describe('아이디 검사', () => {
  it('앞뒤 공백 · 앞의 @를 떼고 소문자로', () => {
    expect(cleanHandle('  @Respec_Kim ')).toBe('respec_kim');
  });

  it('영문 소문자 · 숫자 · _ 3~20자만 통과 (대문자는 소문자로 바꾼 뒤 검사)', () => {
    expect(isHandleFormat('respec_kim')).toBe(true);
    expect(isHandleFormat('@Kim_01')).toBe(true);
    expect(isHandleFormat('ab')).toBe(false);
    expect(isHandleFormat('a'.repeat(21))).toBe(false);
    expect(isHandleFormat('a'.repeat(20))).toBe(true);
    expect(isHandleFormat('kim-01')).toBe(false);
    expect(isHandleFormat('김지형')).toBe(false);
    expect(isHandleFormat('')).toBe(false);
  });
});

describe('아이디 저장 여부', () => {
  it('이미 저장한 아이디와 같으면 저장 · 중복 확인을 안 함', () => {
    expect(shouldSaveHandle('respec_kim', 'respec_kim')).toBe(false);
  });

  it('다르면 저장함 — 저장해 둔 게 없을 때(null · undefined)도', () => {
    expect(shouldSaveHandle('respec_lee', 'respec_kim')).toBe(true);
    expect(shouldSaveHandle('respec_kim', null)).toBe(true);
    expect(shouldSaveHandle('respec_kim', undefined)).toBe(true);
  });
});

describe('닉네임 검사', () => {
  it('공백만이면 막음', () => {
    expect(isNicknameOk('')).toBe(false);
    expect(isNicknameOk('   ')).toBe(false);
  });

  it('앞뒤 공백은 떼고 1~30자면 통과', () => {
    expect(cleanNickname('  지형 ')).toBe('지형');
    expect(isNicknameOk('지')).toBe(true);
    expect(isNicknameOk('가'.repeat(NICKNAME_MAX))).toBe(true);
    expect(isNicknameOk('가'.repeat(NICKNAME_MAX + 1))).toBe(false);
  });
});

describe('개인정보 안내 상수', () => {
  it('항목 5개(위치 · 화면 사용 · 음성 · 기상 공유 · 알람 공유), 항목마다 세 줄이 다 있고 판 번호는 숫자', () => {
    expect(CONSENT_ITEMS.map((item) => item.title)).toEqual(['위치', '화면 사용', '음성', '기상 공유', '알람 공유']);
    for (const item of CONSENT_ITEMS) {
      expect(item.reads).not.toBe('');
      expect(item.doesNotRead).not.toBe('');
      expect(item.friends).not.toBe('');
    }
    expect(typeof PRIVACY_VERSION).toBe('number');
    expect(PRIVACY_VERSION).toBeGreaterThanOrEqual(1);
  });
});
