import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { confirm, toast } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { now } from '@/lib/clock';
import { userMessage } from '@/lib/errors';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';

import { deleteAppointment, leaveSharedAppointment, listPlaces, updateAppointment } from '../api';
import {
  deleteConfirmCopy,
  editValueOf,
  isEditChanged,
  LEAVE_CONFIRM,
  moveToast,
  needsScope,
  scopeWithoutAsking,
  toPatch,
  UNDO_MS,
  type ScheduleEditValue,
} from '../editSheet';
import { homeOf } from '../placeSheet';
import type { AlarmChange } from '../schedule';
import type { Appointment, AppointmentPatch, EditScope } from '../types';

// 지금 떠 있는 시트 — 한 번에 하나만 뜨므로 하나의 값으로 (null = 모두 닫힘)
//   edit = 일정 편집 시트, date · time · place = 편집 시트 위에서 고르는 시트, scopeSave · scopeDelete = 반복 범위, move = 알람 시각이 바뀌어요 확인
export type EditStep = 'edit' | 'date' | 'time' | 'place' | 'scopeSave' | 'scopeDelete' | 'move';

type PendingMove = { patch: AppointmentPatch; undo: AppointmentPatch; scope: EditScope; changes: AlarmChange[] };

type Args = {
  appointment: Pick<Appointment, 'id' | 'title' | 'at' | 'place' | 'importance' | 'recurrenceRule' | 'groupName' | 'canEdit'>;
  reload: () => Promise<unknown>; // 저장 · 되돌리기 뒤 화면 다시 읽기
};

// H03 일정 편집 · 삭제 · 되돌리기 흐름 (이슈 #211, D41 A · D44 A · N6) — 저장 · 삭제는 여기서 api를 부름 (시트는 값 · 콜백만)
//
// 삭제 되돌리기: 확인 뒤 화면에 머물며 "지운 일정"을 보이고 5초 토스트 [되돌리기]. 5초가 지나면 deleteAppointment를 부르고 이전 화면으로,
//   화면을 떠나면(← 이전 · 뒤로 가기 · 탭 이동) 바로 부름. 5초 안에 [되돌리기]를 누르면 타이머만 지우고 아무것도 부르지 않음 (실서버는 5초 안에 서버로 안 보냄)
//   타이머는 이 화면 안에만 둠 — 화면을 떠나면 타이머를 지우고 바로 부르며, 떠 있던 [되돌리기] 토스트는 "일정을 지웠어요"로 바꿈 (이미 보냈으니 눌러도 안 되는 단추가 안 남게)
export function useScheduleEdit({ appointment: a, reload }: Args) {
  const initial = useMemo(() => editValueOf(a), [a]);
  const [step, setStep] = useState<EditStep | null>(null);
  const [value, setValue] = useState<ScheduleEditValue>(initial);
  const [move, setMove] = useState<PendingMove | null>(null);
  const [deleted, setDeleted] = useState(false); // 지우기를 눌러 5초 안인 상태 — 화면은 "지운 일정"
  const { busy, run } = useAction(); // 저장
  const { run: runOther } = useAction(); // 삭제 확인 · 나는 빠지기 · 되돌리기
  const home = homeOf(useAuth().profile);

  const shared = a.groupName != null;
  const canEdit = a.canEdit !== false;
  const repeated = initial.repeatDays.length > 0;

  const id = a.id; // 화면은 일정마다 새로 뜸 (key) — 바뀌지 않음
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDelete = useRef<EditScope | null>(null); // 5초 안에 있는 삭제의 범위 — 아직 api를 안 부른 것
  const alive = useRef(true);

  // 화면을 떠날 때 — 5초 안의 삭제가 있으면 지금 부름
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      const scope = pendingDelete.current;
      if (!scope) return;
      pendingDelete.current = null;
      toast('일정을 지웠어요'); // 떠 있던 [되돌리기] 토스트를 먼저 바꿈 — 보내는 동안 눌러도 안 되는 단추가 남지 않게
      deleteAppointment(id, scope).catch((e: unknown) => toast(userMessage(e, '일정을 지우지 못했어요')));
    };
  }, [id]);

  const open = useCallback(() => {
    setValue(initial);
    setStep('edit');
  }, [initial]);
  const close = () => {
    if (!busy) setStep(null);
  };
  const back = () => setStep('edit'); // 날짜 · 시간 · 장소 · 범위 시트를 닫고 편집 시트로
  const change = (patch: Partial<ScheduleEditValue>) => setValue((v) => ({ ...v, ...patch }));

  // ── 저장 ──
  async function submit(patch: AppointmentPatch, undo: AppointmentPatch, scope: EditScope, confirmed: boolean) {
    const result = await updateAppointment(a.id, patch, scope, confirmed ? { confirmed: true } : {});
    if (result.needsConfirm) {
      setMove({ patch, undo, scope, changes: result.changes }); // 늦춰지는 알람이 있어 저장 전에 한 번 더 — 기존 "알람 시각이 바뀌어요" 시트
      setStep('move');
      return;
    }
    setMove(null);
    setStep(null);
    if (result.changes.length) {
      toast(moveToast(result.changes), {
        actionLabel: '되돌리기',
        duration: UNDO_MS,
        onAction: () =>
          void runOther(async () => {
            await updateAppointment(a.id, undo, scope, { confirmed: true }); // 되돌리기는 늦춤이어도 묻지 않음
            toast('되돌렸어요');
            await reload();
          }, '되돌리지 못했어요'),
      });
    } else {
      toast('일정을 고쳤어요');
    }
    await reload();
  }

  function save() {
    if (!canEdit || !isEditChanged(initial, value)) return;
    if (!value.title.trim()) {
      toast('일정명을 입력해 주세요');
      return;
    }
    // 시각을 옮겼는데 이미 지난 시각이면 저장하지 않음 (H05와 같은 기준 — 시각을 안 바꾼 편집은 그대로 저장)
    if (value.at.getTime() !== initial.at.getTime() && value.at.getTime() <= now().getTime()) {
      toast('이미 지난 시각이에요');
      return;
    }
    if (needsScope(repeated, toPatch(initial, value))) setStep('scopeSave');
    else void saveWith(scopeWithoutAsking(toPatch(initial, value)));
  }

  function saveWith(scope: EditScope) {
    const patch = toPatch(initial, value);
    const undo = toPatch(value, initial);
    return run(() => submit(patch, undo, scope, false), '저장하지 못했어요');
  }

  function pickSaveScope(scope: EditScope) {
    setStep('edit'); // 저장하는 동안 편집 시트의 [저장]이 돌아감
    void saveWith(scope);
  }

  function confirmMove() {
    if (!move) return;
    void run(() => submit(move.patch, move.undo, move.scope, true), '저장하지 못했어요');
  }

  function cancelMove() {
    if (busy) return;
    setMove(null);
    setStep('edit'); // 저장하지 않고 편집 시트로 — 고친 값은 그대로
  }

  // ── 삭제 ──
  function startDelete() {
    if (!canEdit) return;
    if (needsScope(repeated)) setStep('scopeDelete');
    else void confirmDelete('this');
  }

  function pickDeleteScope(scope: EditScope) {
    setStep('edit'); // 확인 창이 편집 시트 위에 뜸 — 취소하면 편집 시트에 그대로
    void confirmDelete(scope);
  }

  function confirmDelete(scope: EditScope) {
    return runOther(async () => {
      const ok = await confirm({ ...deleteConfirmCopy({ shared, repeated, scope }), destructive: true });
      if (!ok) return;
      pendingDelete.current = scope;
      setDeleted(true);
      setStep(null);
      // 5초 동안 다른 토스트를 띄우지 않음 — 이 화면은 "지운 일정"만 보이고 누를 곳이 없음
      toast('일정을 지웠어요', { actionLabel: '되돌리기', duration: UNDO_MS, onAction: undoDelete });
      timer.current = setTimeout(finishDelete, UNDO_MS);
    });
  }

  // [되돌리기] — 아직 아무것도 안 불렀으므로 타이머만 지우면 됨
  function undoDelete() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pendingDelete.current = null;
    setDeleted(false);
  }

  // 5초가 지남 — 지우고 이전 화면으로
  async function finishDelete() {
    const scope = pendingDelete.current;
    timer.current = null;
    if (!scope) return;
    pendingDelete.current = null;
    try {
      await deleteAppointment(id, scope);
    } catch (e) {
      toast(userMessage(e, '일정을 지우지 못했어요'));
      if (alive.current) setDeleted(false);
      return;
    }
    if (alive.current) backOrHome();
  }

  // ── 공동 약속에서 나만 빠지기 ──
  function leave() {
    void runOther(async () => {
      const ok = await confirm({ ...LEAVE_CONFIRM, destructive: true });
      if (!ok) return;
      await leaveSharedAppointment(a.id);
      setStep(null);
      toast('약속에서 빠졌어요');
      backOrHome();
    }, '약속에서 빠지지 못했어요');
  }

  const searchPlaces = useCallback((query: string) => listPlaces(query, home), [home]);

  return {
    step,
    initial,
    value,
    saving: busy,
    canEdit,
    shared,
    deleted,
    undoDelete,
    move,
    open,
    close,
    back,
    change,
    save,
    pickSaveScope,
    confirmMove,
    cancelMove,
    startDelete,
    pickDeleteScope,
    leave,
    searchPlaces,
    pickDate: () => setStep('date'),
    pickTime: () => setStep('time'),
    pickPlace: () => setStep('place'),
  };
}
