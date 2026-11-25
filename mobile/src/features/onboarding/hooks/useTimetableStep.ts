import { useRef, useState } from 'react';

import { toast } from '@/components/ui';
import { createAppointment, estimateAppointment } from '@/features/alarm/api';
import { mergeFollowUps, saveNotice } from '@/features/alarm/saveNotice';
import type { LatLng, Place, SaveFollowUp, Transport } from '@/features/alarm/types';
import { askNotifications } from '@/features/permissions';
import { now } from '@/lib/clock';
import { UserError, userMessage } from '@/lib/errors';
import { useLoad } from '@/lib/useLoad';

import type { ClassRow } from '../components/TimetableStep';
import { loadExistingKeys } from '../existingApi';
import { firstDate, MAX_CLASS_ROWS, needsRetry, rowStatus, toDraft } from '../timetable';
import { campusCoords, campusPlaceText, campusTargets, classRowOf, importNotice, isExistingClass, missingCoords, planImport, startImport, type ImportBatch, type ImportNotice } from '../timetableImport';

const DEFAULT_START = 9 * 60; // 시각 시트를 처음 열 때 보여 주는 시각 (오전 9:00)
const SOURCE = '온보딩 시간표'; // createAppointment의 출처 글자

// 수업 시간표 단계(L02-6, D66-1 B 직접 입력 초안)의 상태 · 동작
// 저장: 채운 줄을 위에서부터 한 줄씩 차례로 estimateAppointment → createAppointment (동시에 부르지 않음 — 카카오 도보 하루 한도)
//   성공한 줄은 result 'ok' (다시 안 만들고 편집도 막음, 지우기만), 실패한 줄은 'error' + 이유를 달고 거기서 멈춤 → 고쳐서 다시 누르면 'ok'가 아닌 줄만 이어서 저장
//   첫 성공 뒤 알림 안내를 한 번 (N3 · D38) — 온보딩 중에는 앱 화면이 막혀 있어 화면 이동은 하지 않음
// transport = 온보딩 '아침 준비'에서 고른(또는 프로필) 이동 수단 — 모든 줄이 같이 씀
// initial = 화면을 열 때 이미 가져온 수업이 있을 때(학교 시간표에서 사진 · 캘린더로 들어온 경우) — 처음부터 줄 + 안내가 채워져 있음
export function useTimetableStep(transport: Transport, initial?: ImportBatch | null) {
  const [start] = useState(() => (initial ? startImport(initial, MAX_CLASS_ROWS) : null));
  const [rows, setRows] = useState<ClassRow[]>(start?.rows ?? []);
  const [coords, setCoords] = useState<Record<string, LatLng>>({}); // 줄 id → 고른 장소의 좌표 (없는 장소는 항목 없음)
  const [placeFor, setPlaceFor] = useState<string | null>(null); // 장소 시트가 열려 있는 줄
  const [timeFor, setTimeFor] = useState<string | null>(null); // 시각 시트가 열려 있는 줄
  const [campus, setCampus] = useState<Place | null>(null); // 가져온 수업 전체에 맞출 학교 위치 (한 번 고르면 뒤에 가져오는 줄에도 적용)
  const [campusOpen, setCampusOpen] = useState(false);
  const [fromCampus, setFromCampus] = useState<ReadonlySet<string>>(new Set()); // 학교 위치로 맞춘 줄 id — 학교를 바꾸면 이 줄들도 새 학교로. 직접 장소를 고른 줄은 빠짐
  const [imported, setImported] = useState(start != null); // 가져온 수업이 있었음 — 좌표 없는 줄 저장 막기 · 학교 위치 카드를 보여 줄지
  const [notice, setNotice] = useState<ImportNotice | null>(start?.notice ?? null); // 가져온 직후 확인 안내 (사진 · 캘린더 길)
  const [included, setIncluded] = useState<ReadonlySet<string>>(new Set()); // 이미 있는 수업인데 사용자가 "그래도 넣기"를 고른 줄 id
  const existing = useLoad(loadExistingKeys).data; // 이미 저장한 반복 일정 열쇠 (못 읽으면 undefined → 중복 표시 없이 지금처럼)
  const seq = useRef(start?.rows.length ?? 0);
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
    setFromCampus((set) => new Set([...set].filter((x) => x !== id))); // 직접 고른 장소는 학교를 바꿔도 그대로
    setCoords((all) => {
      const { [id]: _old, ...rest } = all;
      return Number.isFinite(place.lat) && Number.isFinite(place.lng) ? { ...rest, [id]: { lat: place.lat as number, lng: place.lng as number } } : rest;
    });
    setPlaceFor(null);
  }

  // 가져온 수업(사진 · 캘린더)을 줄로 더함 — 비어 있는 줄은 치우고, 이미 있는 수업은 건너뛰고, 상한(MAX_CLASS_ROWS)을 넘으면 앞에서부터만. 학교를 이미 골랐으면 새 줄에도 그 위치를 적용(장소 글자가 비면 학교 이름)
  // 지금 렌더의 rows를 기준으로 하므로 한 렌더 안에서 두 번 부르지 않음 (사진 읽기는 한 번에 한 장 — usePhotoImport가 읽는 동안 막음)
  function addImported(batch: ImportBatch) {
    const kept = rows.filter((row) => rowStatus(row) !== 'empty');
    const plan = planImport(kept, batch.classes, MAX_CLASS_ROWS);
    const added = plan.accepted.map((c) => {
      seq.current += 1;
      const row = classRowOf(c, `class-${seq.current}`);
      return campus ? { ...row, place: campusPlaceText(row.place, null, campus) } : row;
    });
    setRows([...kept, ...added]);
    setImported(true);
    const at = campusCoords(campus);
    if (at && added.length) {
      setCoords((all) => ({ ...all, ...Object.fromEntries(added.map((row) => [row.id, at])) }));
      setFromCampus((set) => new Set([...set, ...added.map((row) => row.id)]));
    }
    setNotice(importNotice(batch, plan, MAX_CLASS_ROWS));
    return plan.accepted.length;
  }

  // 학교 위치를 고르거나 바꿈 — 좌표가 없는 줄과 지난 학교로 맞춘 줄 모두에 적용 (건물 · 강의실 글자는 그대로 두고, 비었거나 지난 학교 이름이면 새 학교 이름). 직접 고른 줄 · 저장한 줄은 그대로. 좌표가 없는 장소는 못 씀
  function pickCampus(place: Place) {
    const at = campusCoords(place);
    if (!at) {
      toast('이 장소는 위치를 몰라 쓸 수 없어요. 다른 곳을 찾아 주세요');
      return;
    }
    setCampus(place);
    setCampusOpen(false);
    const ids = new Set(campusTargets(rows, (id) => coords[id] != null, fromCampus));
    if (!ids.size) return;
    const previous = campus;
    setCoords((all) => ({ ...all, ...Object.fromEntries([...ids].map((id) => [id, at])) }));
    setFromCampus((set) => new Set([...set, ...ids]));
    setRows((list) => list.map((row) => (ids.has(row.id) ? { ...row, place: campusPlaceText(row.place, previous, place) } : row)));
  }

  // 가져온 수업 중 이미 저장한 수업과 같은 줄은 기본으로 저장에서 뺌(existing 'skip') — 제목 · 요일 · 시각을 고치면 바로 다시 판정됨. 직접 입력만 쓴 단계는 표시하지 않음
  const shown: ClassRow[] = rows.map((row) =>
    imported && existing && row.result !== 'ok' && isExistingClass(row, existing) ? { ...row, existing: included.has(row.id) ? 'include' : 'skip' } : row,
  );
  const active = shown.filter((row) => row.existing !== 'skip'); // 저장 · 검사 대상
  const filled = active.filter((row) => rowStatus(row) !== 'empty');
  // 가져온 수업은 장소 글자뿐이라 좌표가 없으면 이동시간을 못 구함 → 학교(또는 줄마다 장소)를 정해야 저장할 수 있음. 직접 입력만 쓴 단계는 그대로
  const missing = imported ? missingCoords(active, (id) => coords[id] != null) : 0;
  const canSave = filled.some((row) => rowStatus(row) === 'complete') && filled.every((row) => rowStatus(row) === 'complete') && missing === 0;

  // [저장하고 다음] — false면 그 단계에 머묾 (실패한 줄은 줄 옆에 이유가 보임)
  async function save(): Promise<boolean> {
    let made = 0;
    let failed = false;
    const followUps: (SaveFollowUp | undefined)[] = []; // 저장은 됐는데 폰 예약 · 준비물이 못 한 것 (saveNotice.ts)
    for (const row of shown) {
      if (row.existing === 'skip' || row.result === 'ok' || rowStatus(row) !== 'complete' || row.startMinutes == null) continue;
      try {
        const date = firstDate(row.days, row.startMinutes, now());
        const estimate = await estimateAppointment(toDraft(row, coords[row.id], transport, date));
        // 길찾기를 못 해 대략값만 나왔으면 저장하지 않음 — 반복 일정에 그대로 남기 때문. 다시 누르면 길찾기를 다시 부름
        const retry = needsRetry(estimate);
        if (retry) throw new UserError(retry);
        const saved = await createAppointment(estimate, SOURCE);
        followUps.push(saved.followUp);
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
    const merged = mergeFollowUps(followUps);
    if (failed) {
      // 실패한 줄이 있어도 이번에 저장된 수업의 안내는 같이 — 다시 누르면 저장된 줄은 건너뛰어 이 안내를 다시 볼 길이 없음
      const extra = saveNotice(merged, '저장한 수업 중');
      toast(`저장하지 못한 수업이 있어요. 표시된 줄을 확인해 주세요${extra ? `. ${extra}` : ''}`);
    } else {
      const notice = saveNotice(merged, '수업은 저장했지만');
      if (notice) toast(notice);
    }
    return !failed;
  }

  return {
    rows: shown,
    count: filled.filter((row) => rowStatus(row) === 'complete').length, // 저장할 수업 수 (이미 있는 수업으로 뺀 줄 제외, 이 화면에서 저장한 줄 포함)
    canSave,
    onToggleExisting: (id: string) =>
      setIncluded((set) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onChangeRow: change,
    onAddRow: () => {
      if (rows.length >= MAX_CLASS_ROWS) {
        toast(`수업은 ${MAX_CLASS_ROWS}개까지 넣을 수 있어요. 나머지는 일정 화면에서 추가해 주세요`);
        return;
      }
      seq.current += 1;
      const id = `class-${seq.current}`;
      // 학교를 이미 골랐으면 새 줄은 그 학교 위치를 씀 (줄마다 장소를 안 골라도 됨)
      const at = campusCoords(campus);
      setRows((list) => [...list, { id, name: '', days: [], startMinutes: null, place: at && campus ? campus.name : '' }]);
      if (at) {
        setCoords((all) => ({ ...all, [id]: at }));
        setFromCampus((set) => new Set([...set, id]));
      }
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
    addImported,
    notice,
    imported,
    missingCoords: missing,
    dismissNotice: () => setNotice(null),
    campus,
    campusOpen,
    openCampus: () => setCampusOpen(true),
    closeCampus: () => setCampusOpen(false),
    pickCampus,
  };
}
