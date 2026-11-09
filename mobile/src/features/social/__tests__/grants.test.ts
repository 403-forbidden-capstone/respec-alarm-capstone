import { describe, expect, it } from '@jest/globals';

import { F_SUYEON, friends, GROUP, JUNSEONG, ME, members, perms, SUYEON } from '../__fixtures__/seed';
import { effectiveOf, isValidSource, mergeGrants, unionPermissions, type FriendRow, type MemberRow, type PermRow } from '../grants';

// DB 판정 함수(private.is_valid_permission_source · private.granted_owner_ids)와 같은 규칙인지 — supabase/migrations/20261007000200_rls.sql 주석의 경우마다

const row = (over: Partial<PermRow>): PermRow => ({
  owner_id: SUYEON,
  grantee_id: ME,
  source_type: 'FRIEND',
  source_id: F_SUYEON,
  can_view_alarm: true,
  can_edit_alarm: true,
  can_view_wake: true,
  ...over,
});

describe('isValidSource — 출처가 살아 있어야 인정', () => {
  it('친구 출처: friend_id가 맞고 ACCEPTED이고 두 사람이 당사자일 때만 (방향은 상관없음)', () => {
    expect(isValidSource(row({}), friends, members)).toBe(true);
    expect(isValidSource(row({ owner_id: ME, grantee_id: SUYEON }), friends, members)).toBe(true);
    // 대기 중 요청 · 다른 사람 사이의 친구 관계 · 없는 friend_id는 아님
    const pending: FriendRow[] = friends.map((f) => (f.friend_id === F_SUYEON ? { ...f, status: 'PENDING' } : f));
    expect(isValidSource(row({}), pending, members)).toBe(false);
    expect(isValidSource(row({ grantee_id: JUNSEONG }), friends, members)).toBe(false);
    expect(isValidSource(row({ source_id: '20000000-0000-4000-8000-0000000000ff' }), friends, members)).toBe(false);
  });

  it('차단된 친구 관계도 인정 안 함', () => {
    const blocked: FriendRow[] = friends.map((f) => (f.friend_id === F_SUYEON ? { ...f, status: 'BLOCKED' } : f));
    expect(isValidSource(row({}), blocked, members)).toBe(false);
  });

  it('그룹 출처: 두 사람 다 그 그룹에 JOINED일 때만', () => {
    const group = row({ source_type: 'GROUP', source_id: GROUP });
    expect(isValidSource(group, friends, members)).toBe(true);
    const left: MemberRow[] = members.map((m) => (m.user_id === SUYEON ? { ...m, invite_status: 'LEFT' } : m));
    expect(isValidSource(group, friends, left)).toBe(false);
    const invited: MemberRow[] = members.map((m) => (m.user_id === ME ? { ...m, invite_status: 'INVITED' } : m));
    expect(isValidSource(group, friends, invited)).toBe(false);
    expect(isValidSource(group, friends, members.filter((m) => m.user_id !== SUYEON))).toBe(false);
  });
});

describe('effectiveOf — 실제로 효력 있는 권한', () => {
  it('출처가 끝난 행은 null', () => {
    expect(effectiveOf(row({ owner_id: JUNSEONG }), friends, members)).toBeNull();
  });

  it('친구 출처에는 기상 조회가 없음 — 행에 켜져 있어도 꺼짐 (기상은 그룹 동의 하나로만, 6-가)', () => {
    expect(effectiveOf(row({ can_view_wake: true }), friends, members)).toEqual({ viewAlarm: true, editAlarm: true, viewWake: false });
  });

  it('그룹 출처의 기상 조회는 준 사람이 그 그룹에서 기상 공유에 동의했을 때만', () => {
    const group = (owner_id: string) => row({ owner_id, source_type: 'GROUP', source_id: GROUP });
    expect(effectiveOf(group(SUYEON), friends, members)?.viewWake).toBe(true);
    // 준성은 동의가 꺼져 있어 기상 조회가 효력 없음 — 조회 · 설정은 동의와 상관없음
    expect(effectiveOf(group(JUNSEONG), friends, members)).toEqual({ viewAlarm: true, editAlarm: true, viewWake: false });
  });

  it('기상 조회는 권한 행의 값이 아니라 그룹 동의 하나 — 행이 꺼져 있어도 동의가 있으면 보이고, 알람 조회 · 설정은 행 그대로', () => {
    const base = row({ source_type: 'GROUP', source_id: GROUP, can_view_alarm: false, can_edit_alarm: false, can_view_wake: false });
    expect(effectiveOf(base, friends, members)).toEqual({ viewAlarm: false, editAlarm: false, viewWake: true });
  });

  it('데모 시드의 권한 행: 나에게 온 것 중 친구 출처와 동의 안 한 준성의 기상 조회는 효력 없음', () => {
    const toMe = perms.filter((p) => p.grantee_id === ME).map((p) => effectiveOf(p, friends, members)?.viewWake);
    expect(toMe).toEqual([false, false, true, true, false]);
  });
});

describe('mergeGrants · unionPermissions — 항목별 OR', () => {
  const g = (viewAlarm: boolean, editAlarm: boolean, viewWake: boolean) => ({ source: 'x', sourceType: 'GROUP' as const, sourceId: 'x', viewAlarm, editAlarm, viewWake });

  it('하나라도 허용하면 허용, count는 허용된 항목 수', () => {
    expect(mergeGrants([g(true, false, false), g(false, false, true)])).toMatchObject({ viewAlarm: true, editAlarm: false, viewWake: true, count: 2 });
    expect(mergeGrants([])).toMatchObject({ viewAlarm: false, editAlarm: false, viewWake: false, count: 0, rows: [] });
  });

  it('권한 집합 합치기', () => {
    expect(
      unionPermissions([
        { viewAlarm: false, editAlarm: false, viewWake: true },
        { viewAlarm: true, editAlarm: false, viewWake: false },
      ]),
    ).toEqual({ viewAlarm: true, editAlarm: false, viewWake: true });
    expect(unionPermissions([])).toEqual({ viewAlarm: false, editAlarm: false, viewWake: false });
  });
});
