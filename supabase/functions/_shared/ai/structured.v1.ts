// 공개 JSON 계약 structured.v1 — conversation_sessions.extracted_data의 모양 (다른 담당자가 읽는 계약, 노션 'Voice AI 구조화 결과').
// 모델에 보내는 스키마가 아니라 저장 직전 검사용이라 schemas/(모델 스키마 모음)에 두지 않음. final-core.ts의 Structured 타입과 같은 모양.
// 칸을 바꾸면 판(structured.v2)을 올리고 노션 문서도 같이 고친다.
import { validate, type JsonSchema } from './schema.ts';
import { BEHAVIOR_KINDS, EFFECTS, HABITS, MOODS } from './schemas/extract.v2.ts';
import { REASON_TAGS } from './types.ts';

const n = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });
const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const TIME = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
const ISO = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$' };
const SOURCE = { enum: ['stated', 'confirmed', 'inferred'] };
const CONFIRM = { enum: ['saved', 'declined', 'needs_confirm'] };
const CAUSE = { enum: REASON_TAGS.map((t) => t.toLowerCase()) };
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const any = {}; // 모델 출력(extract.v2)에서 그대로 옮긴 칸 — 모양은 extract.v2가 이미 검사함

export const STRUCTURED_V1: JsonSchema = obj({
  schema_version: { enum: ['structured.v1'] },
  session: obj({
    session_id: str,
    reference_date: DATE,
    session_type: { enum: ['night', 'morning', 'anytime'] },
    input_modes: arr({ enum: ['text', 'voice'] }),
    started_at: str,
    ended_at: str,
    extracted_at: str,
    extractor: obj({ prompt: str, schema: { enum: ['extract.v2'] } }),
  }),
  day_review: obj({ events: arr(obj({ text: str, time: n(TIME), important: bool, source: SOURCE })), memorable: n(str) }),
  mood_condition: obj({
    mood: arr({ enum: [...MOODS] }), valence: n({ type: 'integer', minimum: -2, maximum: 2 }), valence_source: { enum: ['inferred'] },
    fatigue: n({ type: 'integer', minimum: 1, maximum: 5 }), stress: n({ type: 'integer', minimum: 1, maximum: 5 }), causes: arr(str), condition_note: n(str), source: SOURCE,
  }),
  habit_signals: arr(obj({ habit: { enum: [...HABITS] }, note: str, date: n(DATE), recurring: bool, source: SOURCE })),
  goals_routine: obj({ goals: arr(obj({ habit: { enum: [...HABITS] }, goal_text: str, source: SOURCE })), wanted_routine: n(str), suggestion_response: { type: 'null' } }),
  behavior: arr(obj({
    id: { type: 'string', pattern: '^b\\d+$' },
    kind: { enum: BEHAVIOR_KINDS.map((k) => k.toLowerCase()) },
    date: n(DATE), time: n(TIME), at: n(ISO), minutes: n(int),
    appointment: n(obj({ appointment_id: n(str), title: n(str), link: { enum: ['linked', 'unlinked'] } })),
    reasons: arr(CAUSE), source: SOURCE, status: { enum: ['recorded', 'needs_confirm'] }, issue: n({ enum: ['no_date', 'uncertain', 'conflict', 'unlinked'] }), note: n(str),
  })),
  sleep_wake: arr(obj({
    date: DATE, sleep_at: n(ISO), wake_at: n(ISO), alarm_rang_at: n(ISO), wake_delay_minutes: n(int),
    wake_delay_basis: n({ enum: ['stated_minutes', 'stated_alarm_time', 'scheduled_wake_alarm'] }), overslept: n(bool), sleep_satisfaction: n(int), planned_sleep_at: n(ISO),
    source: SOURCE, behavior_refs: arr(str),
  })),
  schedule_outcomes: arr(obj({
    date: n(DATE), appointment_id: n(str), appointment_title: n(str), link: { enum: ['linked', 'unlinked'] }, is_late: n(bool), late_minutes: n(int), causes: arr(CAUSE),
    departed_at: n(ISO), arrived_at: n(ISO), source: SOURCE, status: { enum: ['recorded', 'needs_confirm'] }, behavior_refs: arr(str),
  })),
  alarm_feedback: arr(obj({ effect: { enum: [...EFFECTS] }, alarm_type: n(str), date: n(DATE), note: n(str), db_feedback_type: n(str), source: SOURCE })),
  appointments: arr(obj({
    title: str, date: n(DATE), time: n(TIME), place: n(str), importance: n(str), transport: n(str), repeat: n(str),
    status: CONFIRM, card_id: n(str), appointment_id: n(str), unclear: n(str), source: SOURCE,
  })),
  todos: arr(obj({ title: str, type: { enum: ['TASK', 'ITEM'] }, due_date: n(DATE), appointment_id: n(str), appointment_title: n(str), source: SOURCE, stored: n({ enum: ['inserted', 'duplicate', 'failed'] }) })),
  alarm_changes: arr(any),
  prep_adjustment: any,
  other: obj({ importance_updates: arr(any), fact_feedback: arr(any), reason_tags: arr(any), safety_flag: bool }),
  pending: arr(obj({ section: str, ref: str, reason: str, text: str })),
  storage: arr(obj({
    table: { enum: ['todos', 'daily_records'] }, key: str, column: n(str),
    result: { enum: ['inserted', 'duplicate', 'written', 'kept_existing', 'failed', 'skipped_out_of_range'] },
  })),
});

/** 저장 직전 검사 — 맞지 않으면 문제 목록 (코드 버그라 저장 단계를 실패로 남김) */
export function structuredProblems(value: unknown): string[] {
  const r = validate(STRUCTURED_V1, value);
  return r.valid ? [] : r.errors.map(String);
}
