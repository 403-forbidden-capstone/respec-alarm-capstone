import { router } from 'expo-router';

import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

import { nextPreviewRing } from '../api';
import { KIND_LABEL } from '../types';

// 웹 울림 미리보기에서 같은 일정의 다음 알람으로 넘어가기 (ringPreview.ts) — alarmId가 없거나 다음 알람이 없으면 null
export function useNextRing(alarmId: string | null) {
  const { data } = useLoad(() => (alarmId ? nextPreviewRing(alarmId) : Promise.resolve(null)));
  if (!data) return null;
  return {
    label: `다음 알람 울려 보기 · ${KIND_LABEL[data.kind]} ${formatTime(data.at)}`,
    open: () => router.replace({ pathname: '/ring', params: { alarm: data.id } }),
  };
}
