import { afterEach, describe, expect, it } from '@jest/globals';

import { db, kst } from '@/mocks/data';

import { manualTimes, moveAlarm } from '../adjust';
import { getAppointment, previewAlarms, saveAlarmSettings } from '../api';
import { createEdits, fromEditRow, settingsEdits, toEditPayloads } from '../edits';
import type { AlarmSettingsDraft, Estimate, UserEditLog } from '../types';

// 고친 값 기록 줄 만들기(edits.ts, 실데이터가 alarm-commit의 edits로 보냄)가 가짜 데이터의 saveAlarmSettings가 쌓는 기록(db.editLogs)과 같은 줄을 만드는지
//   같은 일정 · 같은 초안으로 둘을 돌려 대조 — 가짜 규칙(F9 · D42 C)이 바뀌면 실데이터도 같이 바뀌게

const SEEDS = db.appointments.map((a) => ({ ...a }));
const ID = 'a1'; // 팀 주간회의: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50

afterEach(() => {
  db.appointments.splice(0, db.appointments.length, ...SEEDS.map((a) => ({ ...a })));
  db.editLogs.length = 0;
  db.disabledKinds.clear();
  db.disabledAppointments.clear();
  db.intensityOverrides = {};
  db.events.length = 0;
});

const settingsOf = async (): Promise<AlarmSettingsDraft> => {
  const a = (await getAppointment(ID))!;
  return {
    ...a.edits,
    kinds: Object.fromEntries(a.alarms.filter((x) => x.kind !== 'ARRIVE').map((x) => [x.kind, x.enabled])),
    levels: { sound: null, voice: null, vibration: null },
  };
};

// 기록 줄에서 비교할 칸만 (at은 쌓은 시각이라 뺌)
const shape = (lines: readonly (Omit<UserEditLog, 'at'> | UserEditLog)[]) =>
  lines.map((l) => ({
    screen: l.screen,
    field: l.field,
    appointmentId: l.appointmentId,
    alarmType: l.alarmType,
    alarmId: l.alarmId,
    autoValue: l.autoValue instanceof Date ? l.autoValue.getTime() : l.autoValue,
    editedValue: l.editedValue instanceof Date ? l.editedValue.getTime() : l.editedValue,
  }));

// 가짜 saveAlarmSettings를 돌린 결과 기록 vs settingsEdits
async function expectSame(patch: (draft: AlarmSettingsDraft) => AlarmSettingsDraft) {
  const saved = (await getAppointment(ID))!;
  const draft = patch(await settingsOf());
  const preview = await previewAlarms(ID, draft); // 가짜 계산 — 실데이터에서는 alarm-suggest 응답
  const lines = settingsEdits(saved, draft, { alarms: preview.alarms, autoTravelMinutes: preview.autoTravelMinutes, autoPrepareMinutes: preview.autoPredictedPrepMinutes });
  db.editLogs.length = 0;
  await saveAlarmSettings(ID, draft);
  expect(shape(lines)).toEqual(shape(db.editLogs));
  return lines;
}

describe('H03 고친 값 기록 — 가짜 saveAlarmSettings와 같은 줄', () => {
  it('아무것도 안 바꾸면 기록 없음', async () => {
    expect(await expectSame((d) => d)).toEqual([]);
  });

  it('여유 · 출발 위치 · 이동 수단 (입력하는 값은 고치기 전 값이 auto)', async () => {
    const lines = await expectSame((d) => ({ ...d, bufferMinutes: 15, origin: '세종대학교', transport: 'CAR' }));
    expect(lines.map((l) => l.field)).toEqual(['buffer_minutes', 'origin', 'transport']);
  });

  it('직접 입력한 이동 · 준비 (계산하는 값은 자동 계산값이 auto)', async () => {
    const lines = await expectSame((d) => ({ ...d, travelMinutes: 40, prepareMinutes: 45 }));
    expect(lines.map((l) => [l.field, l.autoValue, l.editedValue])).toEqual([
      ['travel_minutes', 50, 40],
      ['prepare_minutes', 60, 45],
    ]);
  });

  it('알람 시각을 직접 고름 (기상을 옮기면 준비도 따라가지만 기록은 기상만)', async () => {
    const preview = await previewAlarms(ID, await settingsOf());
    const moved = moveAlarm(preview.alarms, 'WAKE', kst(22, 450)); // 7:30
    const lines = await expectSame((d) => ({ ...d, times: manualTimes(moved) }));
    expect(lines.map((l) => [l.field, l.alarmType])).toEqual([['scheduled_at', 'WAKE']]);
  });

  it('종류별 켜기 · 끄기', async () => {
    const lines = await expectSame((d) => ({ ...d, kinds: { ...d.kinds, WAKE: false } }));
    expect(lines.map((l) => [l.field, l.alarmType, l.autoValue, l.editedValue])).toEqual([['alarm_enabled', 'WAKE', true, false]]);
  });

  it('강도 직접 고르기 (DB 칸 이름: 배경음 sound_key · 말소리 voice_tone · 진동 intensity)', async () => {
    const lines = await expectSame((d) => ({ ...d, levels: { sound: 2, voice: null, vibration: 0 } }));
    expect(lines.map((l) => [l.field, l.autoValue, l.editedValue])).toEqual([
      ['sound_key', 1, 2],
      ['intensity', 1, 0],
    ]);
  });

  it('여러 곳을 한꺼번에 바꿔도 같은 줄 · 같은 순서', async () => {
    const preview = await previewAlarms(ID, await settingsOf());
    const moved = moveAlarm(preview.alarms, 'DEPARTURE', kst(22, 535));
    const lines = await expectSame((d) => ({
      ...d,
      bufferMinutes: 5,
      travelMinutes: 55,
      times: manualTimes(moved),
      kinds: { ...d.kinds, PREPARE: false },
      levels: { sound: 0, voice: 2, vibration: null },
    }));
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  it('직접 입력했던 이동을 자동으로 되돌리면 edited_value null (자동으로 되돌림)', async () => {
    await saveAlarmSettings(ID, { ...(await settingsOf()), travelMinutes: 40 });
    db.editLogs.length = 0;
    const lines = await expectSame((d) => ({ ...d, travelMinutes: null }));
    expect(lines.map((l) => [l.field, l.editedValue])).toEqual([['travel_minutes', null]]);
  });
});

describe('H05 고친 값 기록 (createEdits)', () => {
  const estimate = (): Estimate =>
    ({
      appointment: {
        id: 'draft:1',
        alarms: [
          { id: 'draft:WAKE', kind: 'WAKE', at: kst(22, 450), enabled: true, auto: kst(22, 480) },
          { id: 'draft:PREPARE', kind: 'PREPARE', at: kst(22, 480), enabled: true },
          { id: 'draft:ARRIVE', kind: 'ARRIVE', at: kst(22, 590), enabled: true },
        ],
      },
    }) as unknown as Estimate;

  it('직접 고른 시각마다 한 줄 (자동값 → 고친 값)', () => {
    const lines = createEdits(estimate());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ screen: 'H05', field: 'scheduled_at', alarmType: 'WAKE', autoValue: kst(22, 480), editedValue: kst(22, 450) });
  });

  it('서버로 보낼 때는 날짜가 ISO 글자', () => {
    const payloads = toEditPayloads(createEdits(estimate()));
    expect(payloads).toEqual([{ screen: 'H05', field: 'scheduled_at', alarm_type: 'WAKE', auto_value: kst(22, 480).toISOString(), edited_value: kst(22, 450).toISOString() }]);
  });
});

describe('user_edit_logs 행 → 화면 기록 (fromEditRow)', () => {
  it('칸을 화면 이름으로, 비어 있는 연결은 빼고 ROUTINE 알람은 종류를 비움', () => {
    const log = fromEditRow({
      created_at: '2025-05-22T01:00:00+00:00',
      screen: 'H03',
      field: 'travel_minutes',
      appointment_id: 'appt-1',
      alarm_id: null,
      alarm_type: 'ROUTINE',
      auto_value: 50,
      edited_value: null,
    });
    expect(log).toEqual({ at: new Date('2025-05-22T01:00:00Z'), screen: 'H03', field: 'travel_minutes', appointmentId: 'appt-1', autoValue: 50, editedValue: null });
  });
});
