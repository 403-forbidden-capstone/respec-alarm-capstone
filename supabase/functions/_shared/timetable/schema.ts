// 시간표 사진 읽기 출력 스키마 — 기준 스키마(callLlm이 API용으로 바꾸고, 돌아온 답을 이 전체로 다시 검증).
// 실험실 지문 대조를 받는 schemas/ 7개와 따로 둠(새 지점이라 실험실 원본이 없음). 바뀌면 id를 .v2로 올릴 것.
// 요일은 앱 Weekday 타입(월 화 수 목 금 토 일) 그대로 — 앱이 따로 바꾸지 않아도 됨.
import type { JsonSchema } from '../ai/schema.ts';

export const TIMETABLE_WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;
export type TimetableWeekday = (typeof TIMETABLE_WEEKDAYS)[number];

export interface TimetableRow {
  title: string; // 과목 이름
  weekdays: TimetableWeekday[]; // 같은 시각 · 장소로 열리는 요일들 (월요일부터 순서)
  start: string; // 24시간 HH:MM
  end: string; // 24시간 HH:MM
  place: string | null; // 건물 · 강의실 글 (사진에 없으면 null)
}

export interface TimetableExtract {
  rows: TimetableRow[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'; // 사진을 얼마나 또렷하게 읽었는지 (LOW면 앱이 "꼼꼼히 확인" 안내)
}

const TIME = '^([01]\\d|2[0-3]):[0-5]\\d$';

export const TIMETABLE_SCHEMA_ID = 'timetable-extract.v1';

export const TIMETABLE_SCHEMA: JsonSchema = {
  $id: TIMETABLE_SCHEMA_ID,
  title: 'TimetableExtract',
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          weekdays: { type: 'array', items: { type: 'string', enum: [...TIMETABLE_WEEKDAYS] } },
          start: { type: 'string', pattern: TIME },
          end: { type: 'string', pattern: TIME },
          place: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['title', 'weekdays', 'start', 'end', 'place'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
  },
  required: ['rows', 'confidence'],
  additionalProperties: false,
};
