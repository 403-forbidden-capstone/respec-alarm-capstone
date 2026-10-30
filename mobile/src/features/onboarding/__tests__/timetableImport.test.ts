import { describe, expect, it } from '@jest/globals';

import type { ClassRow } from '../components/TimetableStep';
import { campusCoords, campusPlaceText, campusTargets, classRowOf, importNotice, missingCoords, planImport, type ImportBatch, type ImportedClass } from '../timetableImport';

const row = (patch: Partial<ClassRow> = {}): ClassRow => ({ id: 'r1', name: '자료구조', days: ['월', '수'], startMinutes: 630, place: '공학관 301', ...patch });
const cls = (patch: Partial<ImportedClass> = {}): ImportedClass => ({ title: '운영체제', weekdays: ['화', '목'], startMinutes: 780, place: '정보관 B102', ...patch });

describe('planImport — 이미 있는 수업 · 상한', () => {
  it('새 수업은 모두 더함', () => {
    const plan = planImport([], [cls(), cls({ title: '캡스톤', weekdays: ['금'] })], 10);
    expect(plan.accepted).toHaveLength(2);
    expect(plan.skipped).toBe(0);
    expect(plan.overflow).toBe(0);
  });

  it('이름 공백 · 요일 순서가 달라도 같은 수업이면 뺌 (이미 있는 줄 · 같은 묶음 안 중복)', () => {
    const plan = planImport([row({ name: '자료 구조', days: ['수', '월'] })], [cls({ title: '자료구조', weekdays: ['월', '수'], startMinutes: 630 }), cls(), cls()], 10);
    expect(plan.accepted.map((c) => c.title)).toEqual(['운영체제']);
    expect(plan.skipped).toBe(2);
  });

  it('시작 시각이 다르면 다른 수업', () => {
    const plan = planImport([row()], [cls({ title: '자료구조', weekdays: ['월', '수'], startMinutes: 900 })], 10);
    expect(plan.accepted).toHaveLength(1);
  });

  it('상한을 넘는 수업은 앞에서부터 받고 나머지는 overflow로 셈', () => {
    const existing = [row({ id: 'a' }), row({ id: 'b', name: '다른 수업' })];
    const incoming = [cls({ title: 'A' }), cls({ title: 'B' }), cls({ title: 'C' })];
    const plan = planImport(existing, incoming, 4);
    expect(plan.accepted.map((c) => c.title)).toEqual(['A', 'B']);
    expect(plan.overflow).toBe(1);
  });
});

describe('classRowOf', () => {
  it('요일은 월요일부터 · 장소 없으면 빈 글자 · 끝 시각은 줄에 안 가져감', () => {
    const r = classRowOf(cls({ weekdays: ['목', '화'], place: null, endMinutes: 870 }), 'import-1');
    expect(r).toEqual({ id: 'import-1', name: '운영체제', days: ['화', '목'], startMinutes: 780, place: '' });
  });
});

describe('학교 위치 맞추기', () => {
  it('좌표 없는 줄만 · 이미 저장한 줄(ok)은 건드리지 않음', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', result: 'ok' })];
    expect(campusTargets(rows, (id) => id === 'b')).toEqual(['a']);
  });

  it('학교를 바꾸면 지난 학교로 맞춘 줄도 대상, 직접 장소를 고른 줄(fromCampus에 없음)은 제외', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const all = () => true; // 모두 좌표 있음
    expect(campusTargets(rows, all, new Set(['a', 'c']))).toEqual(['a', 'c']);
    expect(campusTargets(rows, all)).toEqual([]);
  });

  it('장소 글자: 비었거나 지난 학교 이름이면 새 학교 이름, 건물 글자는 그대로', () => {
    const old = { name: '세종대학교', lat: 1, lng: 2 };
    const next = { name: '서울대학교', lat: 3, lng: 4 };
    expect(campusPlaceText('', null, next)).toBe('서울대학교');
    expect(campusPlaceText('세종대학교', old, next)).toBe('서울대학교');
    expect(campusPlaceText('공학관 301', old, next)).toBe('공학관 301');
  });

  it('이동시간을 못 구하는 줄 수: 채운 줄 중 좌표 없는 것만 (비어 있는 줄 · 저장한 줄 제외)', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', result: 'ok' }), row({ id: 'd', name: '', days: [], startMinutes: null, place: '' })];
    expect(missingCoords(rows, (id) => id === 'a')).toBe(1);
    expect(missingCoords(rows, () => true)).toBe(0);
  });

  it('좌표가 둘 다 있을 때만 쓸 수 있음', () => {
    expect(campusCoords({ name: '세종대학교', lat: 37.55, lng: 127.07 })).toEqual({ lat: 37.55, lng: 127.07 });
    expect(campusCoords({ name: '세종대학교', lat: 37.55 })).toBeNull();
    expect(campusCoords(null)).toBeNull();
  });
});

describe('importNotice', () => {
  const photo = (over: Partial<ImportBatch> = {}): ImportBatch => ({ source: 'photo', classes: [cls(), cls({ title: 'B' })], confidence: 'HIGH', ...over });
  const planOf = (b: ImportBatch, limit = 10) => planImport([], b.classes, limit);

  it('사진, 또렷함: 몇 개를 읽었는지 + 확인 안내, 경고 아님', () => {
    const b = photo();
    const n = importNotice(b, planOf(b), 10);
    expect(n.headline).toBe('사진에서 수업 2개를 읽었어요');
    expect(n.details).toEqual(['맞는지 확인하고, 틀린 줄은 고치거나 빼 주세요']);
    expect(n.warn).toBe(false);
  });

  it('사진, LOW: 꼼꼼히 확인 + 경고', () => {
    const b = photo({ confidence: 'LOW' });
    const n = importNotice(b, planOf(b), 10);
    expect(n.details[0]).toBe('또렷하게 읽지 못했어요. 한 줄씩 꼼꼼히 확인해 주세요');
    expect(n.warn).toBe(true);
  });

  it('사진, MEDIUM: 짐작한 부분 안내, 경고 아님', () => {
    const b = photo({ confidence: 'MEDIUM' });
    expect(importNotice(b, planOf(b), 10).details[0]).toBe('일부는 짐작해서 읽었어요. 시각과 요일을 확인해 주세요');
  });

  it('하나도 못 읽으면 다시 고르기 안내 (캘린더는 2주 안내)', () => {
    const p = photo({ classes: [] });
    expect(importNotice(p, planOf(p), 10)).toEqual({ headline: '수업을 찾지 못했어요', details: ['시간표가 또렷하게 보이는 캡처인지 확인하고 다시 골라 주세요'], warn: true });
    const c: ImportBatch = { source: 'calendar', classes: [] };
    expect(importNotice(c, planOf(c), 10).details).toEqual(['앞으로 2주 동안 매주 반복되는 일정이 없어요']);
  });

  it('캘린더: 문구가 다르고 confidence 없이도 됨', () => {
    const c: ImportBatch = { source: 'calendar', classes: [cls()] };
    const n = importNotice(c, planOf(c), 10);
    expect(n.headline).toBe('캘린더에서 매주 반복 일정 1개를 찾았어요');
    expect(n.warn).toBe(false);
    expect(n.details).toContain('이미 저장한 수업이 있다면 빼 주세요');
  });

  it('이미 있는 수업 · 상한 초과를 알려 줌, 상한 초과는 경고', () => {
    const b = photo({ classes: [cls({ title: 'A' }), cls({ title: 'B' }), cls({ title: 'C' })] });
    const plan = planImport([row()], b.classes, 2);
    const n = importNotice(b, plan, 2);
    expect(n.details).toContain('수업은 2개까지 넣을 수 있어서 2개는 못 넣었어요. 나머지는 일정 화면에서 추가해 주세요');
    expect(n.warn).toBe(true);
  });

  it('전부 이미 있는 수업이면 그렇게 말함', () => {
    const b: ImportBatch = { source: 'calendar', classes: [cls({ title: '자료구조', weekdays: ['월', '수'], startMinutes: 630 })] };
    const n = importNotice(b, planImport([row()], b.classes, 10), 10);
    expect(n.details[0]).toBe('모두 이미 있는 수업이에요');
    expect(n.details).toContain('이미 있는 수업 1개는 뺐어요');
  });
});
