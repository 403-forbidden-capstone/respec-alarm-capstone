import { describe, expect, it } from '@jest/globals';

import { cleanHandle, cleanInviteCode, inviteMessage, isValidHandle, relationAction } from '../draft';
import type { FriendRelation } from '../types';

describe('아이디 입력 정리', () => {
  it('앞뒤 공백 · 앞 @를 떼고 소문자로', () => {
    expect(cleanHandle('  @EtIon ')).toBe('etion');
    expect(cleanHandle('respec_kim')).toBe('respec_kim');
    expect(cleanHandle('')).toBe('');
  });

  it('@는 맨 앞 하나만 뗌 (가운데 @는 규칙 검사에서 걸림)', () => {
    expect(cleanHandle('@@a')).toBe('@a');
    expect(isValidHandle(cleanHandle('@@a'))).toBe(false);
  });

  it('아이디 규칙: 영문 소문자 · 숫자 · 밑줄 3~20자', () => {
    expect(isValidHandle('abc')).toBe(true);
    expect(isValidHandle('a_1'.repeat(6) + 'ab')).toBe(true); // 20자
    expect(isValidHandle('ab')).toBe(false); // 2자
    expect(isValidHandle('a'.repeat(21))).toBe(false);
    expect(isValidHandle('Abc')).toBe(false); // 정리 전 대문자
    expect(isValidHandle('a-b')).toBe(false);
    expect(isValidHandle('가나다')).toBe(false);
    expect(isValidHandle('')).toBe(false);
  });
});

describe('초대 코드 정리', () => {
  it('공백을 모두 빼고 대문자로', () => {
    expect(cleanInviteCode(' abcd 1234 ')).toBe('ABCD1234');
    expect(cleanInviteCode('ab\tcd\n12')).toBe('ABCD12');
    expect(cleanInviteCode('   ')).toBe('');
  });

  it('가짜 모드 코드의 -는 그대로', () => {
    expect(cleanInviteCode('cap-6kq3')).toBe('CAP-6KQ3');
  });
});

describe('초대 문구', () => {
  it('그룹 이름과 코드가 들어감', () => {
    expect(inviteMessage('캡스톤팀', 'ABCD1234')).toBe("Re:Spec 알람 '캡스톤팀' 그룹에 초대해요. 초대 코드: ABCD1234");
  });
});

describe('관계 → 버튼', () => {
  it('아직 아무 사이도 아니면 요청, 받은 요청이 있으면 수락 버튼', () => {
    expect(relationAction('NONE')).toEqual({ label: '친구 요청', action: 'request' });
    expect(relationAction('RECEIVED')).toEqual({ label: '수락', action: 'accept' });
  });

  it('이미 친구 · 보낸 요청 · 나는 누를 버튼 없이 상태 글자만', () => {
    expect(relationAction('FRIEND')).toEqual({ label: '이미 친구예요', action: null });
    expect(relationAction('SENT')).toEqual({ label: '요청 보냄', action: null });
    expect(relationAction('SELF')).toEqual({ label: '내 아이디예요', action: null });
  });

  it('관계 다섯 가지 모두 글자가 있음', () => {
    const all: FriendRelation[] = ['SELF', 'FRIEND', 'SENT', 'RECEIVED', 'NONE'];
    for (const r of all) expect(relationAction(r).label).not.toBe('');
  });
});
