import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { db, kst } from '@/mocks/data';

import { deleteAppointment, getAppointment, getDaySchedule, getNextAlarm, leaveSharedAppointment, listAppointments, restoreAppointment, updateAppointment } from '../api';
import type { AppointmentPatch } from '../types';

// 일정 수정 · 삭제 앱 함수 (이슈 #211, D41 A) — 가짜 모드. 실서버(4c)는 realEdit.ts로 넘기는지만 봄 (요청 · 응답 변환은 realEdit.test.ts)
let mockIsMock = true;
const mockRealEdit = {
  updateAppointment: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  deleteAppointment: jest.fn<(...args: unknown[]) => Promise<void>>(),
  restoreAppointment: jest.fn<(...args: unknown[]) => Promise<void>>(),
  leaveSharedAppointment: jest.fn<(...args: unknown[]) => Promise<void>>(),
};
jest.mock('../realEdit', () => ({
  updateAppointment: (...args: unknown[]) => mockRealEdit.updateAppointment(...args),
  deleteAppointment: (...args: unknown[]) => mockRealEdit.deleteAppointment(...args),
  restoreAppointment: (...args: unknown[]) => mockRealEdit.restoreAppointment(...args),
  leaveSharedAppointment: (...args: unknown[]) => mockRealEdit.leaveSharedAppointment(...args),
}));
jest.mock('@/lib/mode', () => ({ ...jest.requireActual<object>('@/lib/mode'), isMock: () => mockIsMock }));

const SEEDS = db.appointments.map((a) => ({ ...a }));
const ID = 'a1'; // 팀 주간회의 오전 10:00: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50 (캡스톤팀 공동 약속, 내가 만듦)

beforeEach(() => {
  mockIsMock = true;
});

afterEach(() => {
  db.appointments.splice(0, db.appointments.length, ...SEEDS.map((a) => ({ ...a })));
  db.trash.length = 0;
  db.left.length = 0;
  db.editLogs.length = 0;
  db.disabledKinds.clear();
  db.disabledAppointments.clear();
  db.intensityOverrides = {};
  db.events.length = 0;
});

const times = async (id: string) => Object.fromEntries((await getAppointment(id))!.alarms.map((x) => [x.kind, formatTime(x.at)]));
const listed = async () => (await listAppointments({ everyOccurrence: true })).map((a) => a.id);

// a1을 매일 같은 시각의 3회차 묶음으로 — 5월 22일(목) · 29일 · 6월 5일 오전 10:00
function makeSeries() {
  const first = db.appointments.find((a) => a.id === ID)!;
  first.seriesId = 's1';
  for (const [id, week] of [['a1b', 1], ['a1c', 2]] as const) {
    db.appointments.push({ ...first, id, at: kst(22 + 7 * week, 600), seriesId: 's1' });
  }
}

describe('updateAppointment — 알람 다시 계산', () => {
  it('앞당기면 바로 저장하고 전 → 후를 돌려줌 (needsConfirm false)', async () => {
    const result = await updateAppointment(ID, { at: kst(22, 570) }, 'this'); // 10:00 → 9:30
    expect(result.needsConfirm).toBe(false);
    expect(result.changes.map((c) => [c.kind, formatTime(c.from), formatTime(c.to)])).toEqual([
      ['WAKE', '오전 8:00', '오전 7:30'],
      ['PREPARE', '오전 8:30', '오전 8:00'],
      ['DEPARTURE', '오전 9:00', '오전 8:30'],
    ]);
    expect(await times(ID)).toMatchObject({ WAKE: '오전 7:30', DEPARTURE: '오전 8:30' });
  });

  it('5분 이상 늦추면 저장하지 않고 needsConfirm — confirmed로 다시 부르면 저장', async () => {
    const patch: AppointmentPatch = { at: kst(22, 630) }; // 10:30
    const preview = await updateAppointment(ID, patch, 'this');
    expect(preview.needsConfirm).toBe(true);
    expect(preview.changes.map((c) => [c.kind, formatTime(c.to)])).toEqual([
      ['WAKE', '오전 8:30'],
      ['PREPARE', '오전 9:00'],
      ['DEPARTURE', '오전 9:30'],
    ]);
    expect((await times(ID)).WAKE).toBe('오전 8:00'); // 아직 그대로

    const saved = await updateAppointment(ID, patch, 'this', { confirmed: true });
    expect(saved.needsConfirm).toBe(false);
    expect(saved.changes).toEqual(preview.changes);
    expect((await times(ID)).WAKE).toBe('오전 8:30');
  });

  it('늦춤이 5분 미만이면 묻지 않고 저장 (기존 확인 시트와 같은 기준)', async () => {
    expect((await updateAppointment(ID, { at: kst(22, 604) }, 'this')).needsConfirm).toBe(false);
    expect((await times(ID)).WAKE).toBe('오전 8:04');
    expect((await updateAppointment(ID, { at: kst(22, 609) }, 'this')).needsConfirm).toBe(true); // 5분 더 늦춤 (원래 대비 9분 → 이번 호출 기준 5분)
  });

  it('되돌리기 = 이전 값을 confirmed로 같은 함수에 넣음 — 늦춤이어도 묻지 않음', async () => {
    const before = await times(ID);
    await updateAppointment(ID, { at: kst(22, 570) }, 'this');
    const undo = await updateAppointment(ID, { at: kst(22, 600) }, 'this', { confirmed: true });
    expect(undo.needsConfirm).toBe(false);
    expect(await times(ID)).toEqual(before);
  });

  it('제목만 바꾸면 changes가 빈 목록', async () => {
    const result = await updateAppointment(ID, { title: '  주간회의 (온라인) ' }, 'this');
    expect(result).toEqual({ changes: [], needsConfirm: false });
    expect((await getAppointment(ID))!.title).toBe('주간회의 (온라인)');
  });

  it('장소를 바꾸면 이동시간이 다시 계산돼 출발이 늦춰짐 (세종대 50 → 홍대입구역 35분)', async () => {
    const result = await updateAppointment(ID, { place: '홍대입구역' }, 'this');
    expect(result.needsConfirm).toBe(true); // 출발 9:00 → 9:15
    expect(result.changes.find((c) => c.kind === 'DEPARTURE')).toMatchObject({ from: kst(22, 540), to: kst(22, 555) });
    await updateAppointment(ID, { place: '홍대입구역' }, 'this', { confirmed: true });
    const saved = (await getAppointment(ID))!;
    expect(saved.place).toBe('홍대입구역');
    expect(saved.travelMinutes).toBe(35);
  });

  it('중요도를 바꾸면 강도에 반영됨 (보통 → 매우 중요: 시각은 그대로)', async () => {
    expect((await getAppointment('a1'))!.level).toBe(1); // 중요 + 늦잠 1회 → 중
    const result = await updateAppointment(ID, { importance: 'HIGH' }, 'this');
    expect(result).toEqual({ changes: [], needsConfirm: false });
    expect((await getAppointment(ID))!.level).toBe(2);
  });

  it('그날 첫 일정이 바뀌면 기상 알람이 따라감 (저녁약속을 아침으로 앞당김)', async () => {
    expect((await times('a2')).WAKE).toBeUndefined();
    await updateAppointment('a2', { at: kst(22, 480) }, 'this', { confirmed: true }); // 오전 8:00 — 팀 주간회의(10:00)보다 앞
    expect((await times('a2')).WAKE).toBeDefined();
    expect((await times(ID)).WAKE).toBeUndefined(); // 이제 팀 주간회의는 준비부터
  });

  it('없는 일정 · 빈 제목은 UserError', async () => {
    await expect(updateAppointment('nope', { title: 'x' }, 'this')).rejects.toBeInstanceOf(UserError);
    await expect(updateAppointment(ID, { title: '  ' }, 'this')).rejects.toThrow('일정 이름을 입력해 주세요');
  });
});

describe('반복 scope', () => {
  it("'this'는 그 회차만, 'following'은 그 회차와 뒤 회차 (같은 간격으로 옮김)", async () => {
    makeSeries();
    await updateAppointment('a1b', { at: kst(29, 570) }, 'this'); // 두 번째 회차만 9:30
    expect((await times('a1b')).WAKE).toBe('오전 7:30');
    expect((await times('a1c')).WAKE).toBe('오전 8:00');
    expect((await times(ID)).WAKE).toBe('오전 8:00');

    await updateAppointment('a1b', { at: kst(29, 540) }, 'following'); // 두 번째 회차부터 9:00 (30분 앞당김)
    expect((await times('a1b')).WAKE).toBe('오전 7:00');
    expect((await times('a1c')).WAKE).toBe('오전 7:30');
    expect((await times(ID)).WAKE).toBe('오전 8:00'); // 앞 회차는 그대로
    expect(db.appointments.find((a) => a.id === 'a1c')!.at).toEqual(kst(36, 570)); // 날짜는 유지
  });

  it('반복 요일은 following에만 반영됨', async () => {
    makeSeries();
    await updateAppointment('a1b', { repeatDays: ['월', '수'] }, 'this');
    expect(db.appointments.find((a) => a.id === 'a1b')!.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=TH');
    await updateAppointment('a1b', { repeatDays: ['월', '수'] }, 'following');
    expect(db.appointments.filter((a) => a.seriesId === 's1').map((a) => a.recurrenceRule)).toEqual([
      'FREQ=WEEKLY;BYDAY=TH',
      'FREQ=WEEKLY;BYDAY=MO,WE',
      'FREQ=WEEKLY;BYDAY=MO,WE',
    ]);
  });

  it('묶음이 없으면 scope와 상관없이 그 일정 하나', async () => {
    await updateAppointment('a3', { title: '수업 (바뀜)' }, 'following');
    expect((await getAppointment('a3'))!.title).toBe('수업 (바뀜)');
    expect((await getAppointment('a1'))!.title).toBe('팀 주간회의');
  });

  it("삭제도 'this'는 한 회차, 'following'은 뒤 회차까지 — 되살리면 함께 돌아옴", async () => {
    makeSeries();
    await deleteAppointment('a1b', 'this');
    expect(await listed()).toEqual(expect.arrayContaining([ID, 'a1c']));
    expect(await listed()).not.toContain('a1b');
    await restoreAppointment('a1b');

    await deleteAppointment('a1b', 'following');
    const left = await listed();
    expect(left).toContain(ID);
    expect(left).not.toContain('a1b');
    expect(left).not.toContain('a1c');
    await restoreAppointment('a1c'); // 같이 지운 것 중 어느 것을 불러도 함께
    expect(await listed()).toEqual(expect.arrayContaining([ID, 'a1b', 'a1c']));
    expect(db.appointments.map((a) => a.id).slice(-2)).toEqual(['a1b', 'a1c']); // 원래 자리
  });
});

describe('deleteAppointment · restoreAppointment', () => {
  it('지우면 목록 · 하루 일정 · 다음 알람에서 사라지고, 되살리면 돌아옴', async () => {
    const order = db.appointments.map((a) => a.id);
    await deleteAppointment(ID, 'following'); // 반복이 아니어도 / 묶음이 없어도 그 일정 하나
    expect(await listed()).not.toContain(ID);
    expect((await getDaySchedule(kst(22, 0))).map((x) => x.appointmentId)).not.toContain(ID);
    expect((await getNextAlarm())?.appointment.id).not.toBe(ID);
    expect(await getAppointment(ID)).toBeNull();

    await restoreAppointment(ID);
    expect(await listed()).toContain(ID);
    expect((await getDaySchedule(kst(22, 0))).map((x) => x.appointmentId)).toContain(ID);
    expect(db.appointments.map((a) => a.id)).toEqual(order); // 자리도 그대로
    expect(db.trash).toEqual([]);
  });

  it('그날 첫 일정을 지워도 저녁 일정(계산된 기상이 낮 12시 이후)에는 기상 알람이 붙지 않음 (#320)', async () => {
    await deleteAppointment(ID, 'this');
    expect((await times('a2')).WAKE).toBeUndefined();
  });

  it('그날 첫 일정을 지우면 다음 일정에 기상 알람이 붙고, 되살리면 다시 준비부터', async () => {
    db.appointments.find((a) => a.id === 'a2')!.at = kst(22, 720); // 저녁약속을 낮 12시로 — 기상이 낮 12시 전이어야 붙음(#320)
    expect((await times('a2')).WAKE).toBeUndefined();
    await deleteAppointment(ID, 'this');
    expect((await times('a2')).WAKE).toBeDefined();
    await restoreAppointment(ID);
    expect((await times('a2')).WAKE).toBeUndefined();
    expect((await times(ID)).WAKE).toBe('오전 8:00');
  });

  it('지운 적 없는 일정을 되살려도 아무 일 없음', async () => {
    await restoreAppointment(ID);
    await restoreAppointment('nope');
    expect(db.appointments.map((a) => a.id)).toEqual(SEEDS.map((a) => a.id));
  });

  it('없는 일정은 UserError', async () => {
    await expect(deleteAppointment('nope', 'this')).rejects.toBeInstanceOf(UserError);
  });
});

describe('공동 약속', () => {
  const theirs = () => {
    db.appointments.find((a) => a.id === ID)!.creatorId = 'sy'; // 수연이 만든 캡스톤팀 약속
  };

  it('남이 만든 공동 약속은 고치지도 지우지도 못함', async () => {
    theirs();
    await expect(updateAppointment(ID, { title: '바꿈' }, 'this')).rejects.toThrow('공동 약속은 만든 사람만 고칠 수 있어요');
    await expect(updateAppointment(ID, { title: '바꿈' }, 'this')).rejects.toBeInstanceOf(UserError);
    await expect(deleteAppointment(ID, 'this')).rejects.toThrow('공동 약속은 만든 사람만 고칠 수 있어요');
    expect((await getAppointment(ID))!.title).toBe('팀 주간회의');
    expect(await listed()).toContain(ID);
  });

  it('내가 만든 공동 약속은 고치고 지울 수 있음', async () => {
    await updateAppointment(ID, { title: '바꿈' }, 'this');
    await deleteAppointment(ID, 'this');
    expect(await listed()).not.toContain(ID);
  });

  it('나는 빠지기 — 내 목록 · 알람만 사라지고 다른 일정은 그대로', async () => {
    theirs();
    const others = (await listed()).filter((id) => id !== ID);
    await leaveSharedAppointment(ID);
    expect(await listed()).toEqual(others);
    expect((await getDaySchedule(kst(22, 0))).map((x) => x.appointmentId)).not.toContain(ID);
    expect(await getAppointment(ID)).toBeNull();
    expect(db.left.map((a) => a.id)).toEqual([ID]); // 약속 자체는 남은 사람에게 있음
    expect(db.trash).toEqual([]); // 지운 것이 아니라 빠진 것 — 되살리기 없음
    await restoreAppointment(ID);
    expect(await listed()).not.toContain(ID);
  });

  it('공동 약속이 아니거나 내가 만든 약속이면 빠질 수 없음', async () => {
    await expect(leaveSharedAppointment('a2')).rejects.toThrow('공동 약속이 아니에요');
    await expect(leaveSharedAppointment(ID)).rejects.toBeInstanceOf(UserError); // 내가 만듦
    await expect(leaveSharedAppointment('nope')).rejects.toBeInstanceOf(UserError);
  });
});

describe('실데이터 모드 (4c)', () => {
  it('네 함수 모두 realEdit(서버 appointment-edit)로 넘김 — 가짜 db는 안 건드림', async () => {
    mockIsMock = false;
    mockRealEdit.updateAppointment.mockResolvedValueOnce({ changes: [], needsConfirm: true });
    await expect(updateAppointment(ID, { title: 'x' }, 'following', { confirmed: true })).resolves.toEqual({ changes: [], needsConfirm: true });
    expect(mockRealEdit.updateAppointment).toHaveBeenCalledWith(ID, { title: 'x' }, 'following', { confirmed: true });
    await deleteAppointment(ID, 'this');
    expect(mockRealEdit.deleteAppointment).toHaveBeenCalledWith(ID, 'this');
    await restoreAppointment(ID);
    expect(mockRealEdit.restoreAppointment).toHaveBeenCalledWith(ID);
    await leaveSharedAppointment(ID);
    expect(mockRealEdit.leaveSharedAppointment).toHaveBeenCalledWith(ID);
    expect(db.appointments.map((x) => x.id)).toContain(ID);
  });

  it('realEdit의 UserError는 그대로 화면까지 올라감', async () => {
    mockIsMock = false;
    mockRealEdit.restoreAppointment.mockRejectedValueOnce(new UserError('이 일정은 되돌릴 수 없어요. 새로 만들어 주세요'));
    await expect(restoreAppointment(ID)).rejects.toBeInstanceOf(UserError);
  });
});
