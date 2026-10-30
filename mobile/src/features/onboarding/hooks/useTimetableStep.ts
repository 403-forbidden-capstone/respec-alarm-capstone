import { useRef, useState } from 'react';

import { toast } from '@/components/ui';
import { createAppointment, estimateAppointment } from '@/features/alarm/api';
import type { LatLng, Place, Transport } from '@/features/alarm/types';
import { askNotifications } from '@/features/permissions';
import { now } from '@/lib/clock';
import { UserError, userMessage } from '@/lib/errors';

import type { ClassRow } from '../components/TimetableStep';
import { firstDate, MAX_CLASS_ROWS, needsRetry, rowStatus, toDraft } from '../timetable';

const DEFAULT_START = 9 * 60; // 시각 시트를 처음 열 때 보여 주는 시각 (오전 9:00)
const SOURCE = '온보딩 시간표'; // createAppointment의 출처 글자

// 수업 시간표 단계(L02-6, D66-1 B 직접 입력 초안)의 상태 · 동작
// 저장: 채운 줄을 위에서부터 한 줄씩 차례로 estimateAppointment → createAppointment (동시에 부르지 않음 — 카카오 도보 하루 한도)
//   성공한 줄은 result 'ok' (다시 안 만들고 편집도 막음, 지우기만), 실패한 줄은 'error' + 이유를 달고 거기서 멈춤 → 고쳐서 다시 누르면 'ok'가 아닌 줄만 이어서 저장
//   첫 성공 뒤 알림 안내를 한 번 (N3 · D38) — 온보딩 중에는 앱 화면이 막혀 있어 화면 이동은 하지 않음
// transport = 온보딩 '아침 준비'에서 고른(또는 프로필) 이동 수단 — 모든 줄이 같이 씀
export function useTimetableStep(transport: Transport) {
  const [rows, setRows] = useState<ClassRow[]>([]);
  const [coords, setCoords] = useState<Record<string, LatLng>>({}); // 줄 id → 고른 장소의 좌표 (없는 장소는 항목 없음)
  const [placeFor, setPlaceFor] = useState<string | null>(null); // 장소 시트가 열려 있는 줄
  const [timeFor, setTimeFor] = useState<string | null>(null); // 시각 시트가 열려 있는 줄
  const seq = useRef(0);
  const asked = useRef(false);

  const rowOf = (id: string) => rows.find((row) => row.id === id);
  const locked = (id: string) => rowOf(id)?.result === 'ok'; // 이미 저장한 줄은 고치지 않음

  // 줄 고치기 — 고치면 지난 저장 실패 표시는 지움
  function change(id: string, patch: Partial<ClassRow>) {
    if (locked(id)) return;
    setRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch, result: undefined, resultNote: undefined } : row)));
  }

  function mark(id: string, patch: Pick<ClassRow, 'result' | 'resultNote'>) {
    setRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function pickPlace(place: Place) {
    const id = placeFor;
    if (!id) return;
    change(id, { place: place.name });
    setCoords((all) => {
      const { [id]: _old, ...rest } = all;
      return Number.isFinite(place.lat) && Number.isFinite(place.lng) ? { ...rest, [id]: { lat: place.lat as number, lng: place.lng as number } } : rest;
    });
    setPlaceFor(null);
  }

  const filled = rows.filter((row) => rowStatus(row) !== 'empty');
  const canSave = filled.some((row) => rowStatus(row) === 'complete') && filled.every((row) => rowStatus(row) === 'complete');

  // [저장하고 다음] — false면 그 단계에 머묾 (실패한 줄은 줄 옆에 이유가 보임)
  async function save(): Promise<boolean> {
    let made = 0;
    let failed = false;
    for (const row of rows) {
      if (row.result === 'ok' || rowStatus(row) !== 'complete' || row.startMinutes == null) continue;
      try {
        const date = firstDate(row.days, row.startMinutes, now());
        const estimate = await estimateAppointment(toDraft(row, coords[row.id], transport, date));
        // 길찾기를 못 해 대략값만 나왔으면 저장하지 않음 — 반복 일정에 그대로 남기 때문. 다시 누르면 길찾기를 다시 부름
        const retry = needsRetry(estimate);
        if (retry) throw new UserError(retry);
        await createAppointment(estimate, SOURCE);
        mark(row.id, { result: 'ok', resultNote: undefined });
        made += 1;
      } catch (e) {
        mark(row.id, { result: 'error', resultNote: userMessage(e, '저장하지 못했어요') });
        failed = true;
        break;
      }
    }
    if (made > 0 && !asked.current) {
      asked.current = true;
      void askNotifications('alarm');
    }
    if (failed) toast('저장하지 못한 수업이 있어요. 표시된 줄을 확인해 주세요');
    return !failed;
  }

  return {
    rows,
    canSave,
    onChangeRow: change,
    onAddRow: () => {
      if (rows.length >= MAX_CLASS_ROWS) {
        toast(`수업은 ${MAX_CLASS_ROWS}개까지 넣을 수 있어요. 나머지는 일정 화면에서 추가해 주세요`);
        return;
      }
      seq.current += 1;
      setRows((list) => [...list, { id: `class-${seq.current}`, name: '', days: [], startMinutes: null, place: '' }]);
    },
    onRemoveRow: (id: string) => {
      if (locked(id)) {
        toast('이미 저장했어요. 일정 화면에서 지워 주세요');
        return;
      }
      setRows((list) => list.filter((row) => row.id !== id));
      setCoords(({ [id]: _gone, ...rest }) => rest);
    },
    onPickPlace: (id: string) => {
      if (!locked(id)) setPlaceFor(id);
    },
    onPickTime: (id: string) => {
      if (locked(id)) return;
      if (rowOf(id)?.startMinutes == null) change(id, { startMinutes: DEFAULT_START }); // 시트가 보여 주는 시각(오전 9:00)을 그대로 고른 것으로
      setTimeFor(id);
    },
    placeOpen: placeFor != null,
    closePlace: () => setPlaceFor(null),
    pickPlace,
    timeRow: timeFor ? rowOf(timeFor) : undefined,
    closeTime: () => setTimeFor(null),
    changeTime: (startMinutes: number) => {
      if (timeFor) change(timeFor, { startMinutes });
    },
    save,
  };
}
