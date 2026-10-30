// 시간표 채우기(D66-1 A 캡처 · D 폰 캘린더) 공통 — 읽어 온 수업을 확인 화면의 줄(ClassRow)로 바꾸는 순수 함수 (시험: __tests__/timetableImport.test.ts)
// 두 길(사진 · 캘린더)이 같은 모양 ImportedClass로 모이고, 이 파일은 어느 길에서 왔는지 모름 — 줄마다 고치기 · 빼기 · 저장은 직접 입력과 같은 TimetableStep · useTimetableStep
import { sortDays } from '@/features/alarm/repeat';
import type { Place } from '@/features/alarm/types';
import type { Weekday } from '@/lib/weekday';

import type { ClassRow } from './components/TimetableStep';

export type ImportSource = 'photo' | 'calendar';
export type ImportConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

// 읽어 온 수업 하나 — 요일 여러 개가 한 줄 (같은 시각 · 장소). 끝 시각은 확인 화면에 쓰지 않지만 길마다 있으면 들고 감
export type ImportedClass = {
  title: string;
  weekdays: Weekday[];
  startMinutes: number; // 0시부터 분
  endMinutes?: number;
  place: string | null; // 건물 · 강의실 글. 모르면 null
};

export type ImportBatch = {
  source: ImportSource;
  classes: ImportedClass[];
  confidence?: ImportConfidence; // 사진 읽기만 있음 (캘린더는 규칙이라 없음)
};

// 같은 수업인지 보는 열쇠 — 이름 공백 무시 · 요일 순서 무시 · 시작 시각
const keyOf = (title: string, days: readonly Weekday[], startMinutes: number | null) => `${title.replace(/\s+/g, '')}|${sortDays([...days]).join('')}|${startMinutes ?? ''}`;

export type ImportPlan = {
  accepted: ImportedClass[]; // 줄로 더할 것 (이미 있는 수업 · 같은 묶음 안 중복은 뺌, 자리가 모자라면 앞에서부터)
  skipped: number; // 이미 있어서 뺀 수
  overflow: number; // 자리가 없어 못 더한 수
};

// existing = 지금 화면의 채워진 줄들, limit = 줄 수 상한(MAX_CLASS_ROWS)
export function planImport(existing: readonly ClassRow[], incoming: readonly ImportedClass[], limit: number): ImportPlan {
  const seen = new Set(existing.map((row) => keyOf(row.name, row.days, row.startMinutes)));
  const accepted: ImportedClass[] = [];
  let skipped = 0;
  let overflow = 0;
  for (const c of incoming) {
    const key = keyOf(c.title, c.weekdays, c.startMinutes);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    if (existing.length + accepted.length >= limit) {
      overflow += 1;
      continue;
    }
    seen.add(key);
    accepted.push(c);
  }
  return { accepted, skipped, overflow };
}

export function classRowOf(c: ImportedClass, id: string): ClassRow {
  return { id, name: c.title, days: sortDays([...c.weekdays]), startMinutes: c.startMinutes, place: c.place ?? '' };
}

// 학교 위치를 줄에 맞춤 — 좌표가 아직 없고 이미 저장하지 않은 줄의 id. 장소 글자는 그대로 두고(건물 · 강의실), 비어 있는 줄만 학교 이름으로 채움
export function campusTargets(rows: readonly ClassRow[], hasCoords: (id: string) => boolean): string[] {
  return rows.filter((row) => row.result !== 'ok' && !hasCoords(row.id)).map((row) => row.id);
}

export const campusCoords = (place: Place | null): { lat: number; lng: number } | null =>
  place && Number.isFinite(place.lat) && Number.isFinite(place.lng) ? { lat: place.lat as number, lng: place.lng as number } : null;

// 확인 화면을 처음 열 때 이미 가져온 것이 있을 때(설정에서 들어온 경우) — 빈 화면에서 시작하는 plan + 줄 + 안내 한 번에. 줄 id는 class-1부터
export function startImport(batch: ImportBatch, limit: number): { rows: ClassRow[]; notice: ImportNotice } {
  const plan = planImport([], batch.classes, limit);
  return { rows: plan.accepted.map((c, i) => classRowOf(c, `class-${i + 1}`)), notice: importNotice(batch, plan, limit) };
}

export type ImportNotice = {
  headline: string;
  details: string[];
  warn: boolean; // 못 읽었거나 또렷하지 않음 — 확인 문구를 강하게
};

// 가져온 직후 확인 화면 위에 보여 줄 안내 — 몇 개를 가져왔고, 뭘 뺐고, 얼마나 확인해야 하는지
export function importNotice(batch: ImportBatch, plan: ImportPlan, limit: number): ImportNotice {
  const found = batch.classes.length;
  if (found === 0) {
    return {
      headline: batch.source === 'photo' ? '수업을 찾지 못했어요' : '가져올 수업이 없어요',
      details: [batch.source === 'photo' ? '시간표가 또렷하게 보이는 캡처인지 확인하고 다시 골라 주세요' : '앞으로 2주 동안 매주 반복되는 일정이 없어요'],
      warn: true,
    };
  }
  const added = plan.accepted.length;
  const headline = batch.source === 'photo' ? `사진에서 수업 ${found}개를 읽었어요` : `캘린더에서 매주 반복 일정 ${found}개를 찾았어요`;
  const details: string[] = [];
  const unsure = batch.confidence === 'LOW';
  details.push(unsure ? '또렷하게 읽지 못했어요. 한 줄씩 꼼꼼히 확인해 주세요' : batch.confidence === 'MEDIUM' ? '일부는 짐작해서 읽었어요. 시각과 요일을 확인해 주세요' : '맞는지 확인하고, 틀린 줄은 고치거나 빼 주세요');
  if (plan.skipped > 0) details.push(`이미 있는 수업 ${plan.skipped}개는 뺐어요`);
  if (plan.overflow > 0) details.push(`수업은 ${limit}개까지 넣을 수 있어서 ${plan.overflow}개는 못 넣었어요. 나머지는 일정 화면에서 추가해 주세요`);
  if (added === 0 && plan.skipped > 0 && plan.overflow === 0) details[0] = '모두 이미 있는 수업이에요';
  return { headline, details, warn: unsure || plan.overflow > 0 };
}
