// 방금 읽은 알람 설정(H03)의 저장된 값 — 값을 바꿀 때마다 부르는 미리 보기(alarm-suggest)가 저장된 값을 다시 읽지 않게 (실데이터)
// 읽을 때 넣고, 이 일정을 바꾸는 쓰기(켜기 · 끄기 · 강도 · 저장)가 끝나면 지움. 메모리에만 둠
import type { AppointmentDetail } from './types';

const cache = new Map<string, AppointmentDetail>();

export const rememberDetail = (detail: AppointmentDetail) => void cache.set(detail.id, detail);
export const recallDetail = (id: string) => cache.get(id);
export const forgetDetail = (id: string) => void cache.delete(id);
export const forgetAllDetails = () => cache.clear();
