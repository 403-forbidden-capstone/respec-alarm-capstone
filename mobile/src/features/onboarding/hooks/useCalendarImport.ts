import { useState } from 'react';

import { toast } from '@/components/ui';
import { now } from '@/lib/clock';
import { userMessage } from '@/lib/errors';

import type { CalendarChoice } from '../calendar';
import { ensureCalendarAccess, listCalendars, loadCandidates } from '../calendarApi';
import type { ImportBatch } from '../timetableImport';

type Phase = 'idle' | 'asking' | 'picking' | 'loading';

// [폰 캘린더에서 가져오기] — 권한 → 캘린더 고르기(하나뿐이면 건너뜀) → 앞으로 2주 매주 반복 일정 후보 → onBatch(가져온 수업)
// 서버를 안 부르고 폰 안에서 처리. 거부하면 직접 넣기 안내만 하고 끝 (권한을 다시 묻지 않는 경우는 폰 설정 안내)
export function useCalendarImport(onBatch: (batch: ImportBatch) => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [calendars, setCalendars] = useState<CalendarChoice[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const fail = (e: unknown) => {
    toast(userMessage(e, '캘린더를 읽지 못했어요. 다시 해 주세요'));
    setPhase('idle');
  };

  async function load(ids: readonly string[]) {
    setPhase('loading');
    try {
      onBatch(await loadCandidates(ids, now()));
      setPhase('idle');
    } catch (e) {
      fail(e);
    }
  }

  async function start() {
    if (phase !== 'idle') return;
    setPhase('asking');
    try {
      const access = await ensureCalendarAccess();
      if (access !== 'granted') {
        toast(access === 'blocked' ? '캘린더 권한이 꺼져 있어요. 폰 설정에서 허용하거나 직접 넣어 주세요' : '캘린더를 읽을 수 없어요. 직접 넣어 주세요');
        setPhase('idle');
        return;
      }
      const list = await listCalendars();
      if (list.length === 0) {
        toast('가져올 캘린더가 없어요. 직접 넣어 주세요');
        setPhase('idle');
        return;
      }
      if (list.length === 1) {
        await load([list[0].id]);
        return;
      }
      setCalendars(list);
      setPicked(new Set(list.map((c) => c.id))); // 처음엔 모두 켜 둠 — 빼고 싶은 것만 끔
      setPhase('picking');
    } catch (e) {
      fail(e);
    }
  }

  return {
    phase,
    busy: phase !== 'idle',
    reading: phase === 'asking' || phase === 'loading',
    calendars,
    picked,
    pickerOpen: phase === 'picking',
    start,
    toggle: (id: string) =>
      setPicked((set) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    closePicker: () => setPhase('idle'),
    confirm: () => {
      if (picked.size === 0) {
        toast('가져올 캘린더를 하나 이상 골라 주세요');
        return;
      }
      void load([...picked]);
    },
  };
}
