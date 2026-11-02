import { router } from 'expo-router';

import { Button } from '@/components/ui';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

import { nextPreviewAlarm } from '../ringPreview';
import { KIND_LABEL } from '../types';

// 웹 울림 미리보기에서 같은 일정의 다음 알람으로 넘어가기 (ringPreview.ts) — alarmId가 없거나 다음 알람이 없으면 null
export function useNextRing(alarmId: string | null) {
  const { data } = useLoad(() => (alarmId ? nextPreviewAlarm(alarmId) : Promise.resolve(null)));
  if (!data) return null;
  return {
    label: `다음 알람 울려 보기 · ${KIND_LABEL[data.kind]} ${formatTime(data.at)}`,
    open: () => router.replace({ pathname: '/ring', params: { alarm: data.id } }),
  };
}

// 기상 확인(H08) 확정 뒤 — 다음 알람(준비 · 출발)이 있으면 버튼 하나
export function NextRingButton({ alarmId }: { alarmId: string }) {
  const next = useNextRing(alarmId);
  return next ? <Button label={next.label} onPress={next.open} /> : null;
}
