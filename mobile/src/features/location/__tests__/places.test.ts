import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { filterArgs, type FakeCall, type FakeResult } from '@/features/alarm/testkit/fakeSupabase';
import { UserError } from '@/lib/errors';

import { deleteUserPlace, listUserPlaces, resetMockUserPlaces, saveUserPlace } from '../api';
import { LIMIT_MESSAGE } from '../userPlaces';

// 실데이터는 가짜 Supabase로 쿼리 모양만 확인 (진짜 RLS · 5개 제한 트리거는 supabase/tests/db-check.mjs), 가짜 모드는 메모리 배열
let mockRoutes: Record<string, (call: FakeCall) => FakeResult | undefined> = {};
const mockCalls: FakeCall[] = [];
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder: build } = jest.requireActual<typeof import('@/features/alarm/testkit/fakeSupabase')>('@/features/alarm/testkit/fakeSupabase');
  return {
    supabase: {
      from: (table: string) =>
        build(table, (call) => {
          mockCalls.push(call);
          return mockRoutes[`${call.table}:${call.op}`]?.(call);
        }),
    },
  };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
let mockIsMock = true;
jest.mock('@/lib/mode', () => ({ isMock: () => mockIsMock }));

beforeEach(() => {
  mockIsMock = true;
  mockRoutes = {};
  mockCalls.length = 0;
  resetMockUserPlaces();
});

const spot = (label: string, extra = {}) => ({ label, name: `${label} 정문`, lat: 37.55, lng: 127.07, ...extra });

describe('가짜 모드', () => {
  it('처음에는 학교 · 회사가 있고, 읽은 배열을 고쳐도 원본은 그대로', async () => {
    const list = await listUserPlaces();
    expect(list.map((p) => p.label)).toEqual(['학교', '회사']);
    list.pop();
    expect((await listUserPlaces()).length).toBe(2);
  });

  it('저장하면 맨 뒤에 붙고, 지우면 사라지고, 없는 이름표를 지워도 괜찮음', async () => {
    await saveUserPlace(spot('알바'));
    expect((await listUserPlaces()).map((p) => p.label)).toEqual(['학교', '회사', '알바']);
    await deleteUserPlace('회사');
    expect((await listUserPlaces()).map((p) => p.label)).toEqual(['학교', '알바']);
    await expect(deleteUserPlace('없음')).resolves.toBeUndefined();
  });

  it('같은 이름표로 저장하면 덮어씀 (자리 그대로, 옛 반경 · 주소는 남지 않음)', async () => {
    await saveUserPlace(spot('회사', { name: '새 회사', lat: 37.5, lng: 127.0 }));
    const list = await listUserPlaces();
    expect(list.map((p) => p.label)).toEqual(['학교', '회사']);
    expect(list[1]).toEqual({ label: '회사', name: '새 회사', lat: 37.5, lng: 127.0 });
  });

  it('5개까지 — 6번째 새 이름표는 UserError, 있는 이름표를 덮어쓰는 것은 5개여도 통과, 지운 뒤에는 다시 저장', async () => {
    await saveUserPlace(spot('알바'));
    await saveUserPlace(spot('도서관'));
    await saveUserPlace(spot('동아리방'));
    const sixth = saveUserPlace(spot('여섯째'));
    await expect(sixth).rejects.toBeInstanceOf(UserError);
    await expect(sixth).rejects.toThrow(LIMIT_MESSAGE);
    await expect(saveUserPlace(spot('학교', { name: '후문' }))).resolves.toMatchObject({ name: '후문' });
    expect((await listUserPlaces()).length).toBe(5);
    await deleteUserPlace('동아리방');
    await expect(saveUserPlace(spot('여섯째'))).resolves.toMatchObject({ label: '여섯째' });
  });

  it('잘못된 값은 저장 전에 UserError', async () => {
    await expect(saveUserPlace(spot('학교', { lat: 200 }))).rejects.toBeInstanceOf(UserError);
    await expect(saveUserPlace(spot('  '))).rejects.toBeInstanceOf(UserError);
  });
});

describe('실데이터', () => {
  beforeEach(() => {
    mockIsMock = false;
  });

  it('목록: 내 user_id로 좁혀 만든 순서로 읽고, numeric 글자도 숫자로', async () => {
    mockRoutes['user_places:select'] = () => ({
      data: [{ label: '학교', name: '정문', address: '서울 1', lat: '37.550900', lng: '127.073600', radius_m: 200 }],
    });
    const list = await listUserPlaces();
    expect(list).toEqual([{ label: '학교', name: '정문', address: '서울 1', lat: 37.5509, lng: 127.0736, radiusM: 200 }]);
    const [call] = mockCalls;
    expect(call.table).toBe('user_places');
    expect(filterArgs(call, 'eq', 'user_id')).toEqual(['user-1']);
    expect(call.filters.filter(([m]) => m === 'order').map((f) => f[1])).toEqual(['created_at', 'label']);
    expect(call.columns).toBe('label, name, address, lat, lng, radius_m');
  });

  it('저장: (user_id, label)로 upsert하고 없는 칸도 null로 보냄', async () => {
    mockRoutes['user_places:upsert'] = (call) => ({ data: { ...(call.payload as object), radius_m: null } });
    const saved = await saveUserPlace({ label: ' 학교 ', name: '정문', lat: 37.55, lng: 127.07 });
    expect(saved).toEqual({ label: '학교', name: '정문', lat: 37.55, lng: 127.07 });
    const [call] = mockCalls;
    expect(call.op).toBe('upsert');
    expect(call.options).toEqual({ onConflict: 'user_id,label' });
    expect(call.payload).toEqual({ user_id: 'user-1', label: '학교', name: '정문', address: null, lat: 37.55, lng: 127.07, radius_m: null });
  });

  it('저장: 5개 제한 트리거(54000)는 이유 문구, 그 밖의 오류는 원문 그대로', async () => {
    mockRoutes['user_places:upsert'] = () => ({ error: { code: '54000', message: '자주 가는 곳은 5개까지 저장할 수 있음' } });
    await expect(saveUserPlace(spot('여섯째'))).rejects.toThrow(LIMIT_MESSAGE);
    await expect(saveUserPlace(spot('여섯째'))).rejects.toBeInstanceOf(UserError);

    mockRoutes['user_places:upsert'] = () => ({ error: { code: '23514', message: 'check violation' } });
    const err = await saveUserPlace(spot('여섯째')).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UserError);
    expect(err).toMatchObject({ code: '23514' });
  });

  it('지우기: 내 user_id · 이름표로만 좁힘, 오류는 던짐', async () => {
    await deleteUserPlace('학교');
    const [call] = mockCalls;
    expect(call.op).toBe('delete');
    expect(filterArgs(call, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(call, 'eq', 'label')).toEqual(['학교']);

    mockRoutes['user_places:delete'] = () => ({ error: { code: '42501', message: 'denied' } });
    await expect(deleteUserPlace('학교')).rejects.toMatchObject({ code: '42501' });
  });

  it('읽기 오류는 던짐', async () => {
    mockRoutes['user_places:select'] = () => ({ error: { message: 'network' } });
    await expect(listUserPlaces()).rejects.toMatchObject({ message: 'network' });
  });
});
