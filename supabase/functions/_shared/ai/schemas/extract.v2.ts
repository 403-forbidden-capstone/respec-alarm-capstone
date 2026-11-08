// 서버가 만든 판 (실험실 JSON 없음 — T1.v1.4처럼 서버에서 더한 판). extract.v1에 대화 끝 정리(voice-commit)가 쓰는 칸만 더함 (T2.v3):
//   todos[].appointment_title · behavior(실제 행동 · 지각 진술) · alarm_feedback · day_review · mood_condition · habit_signals · goals_routine
//   이것은 모델 출력(내부) 모양. 다른 담당자가 읽는 공개 모양은 structured.v1(conversation_sessions.extracted_data)이고 final-core.ts가 이 출력에서 만든다.
// v1 파일은 그대로 두고 복사해서 더함 — 겹치는 칸의 규칙이 v1과 같다는 것이 코드로 보이게.
import type { JsonSchema } from '../schema.ts';
import { REASON_TAGS } from '../types.ts';
import v1 from './extract.v1.ts';

const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });
const str = { type: 'string' };
const TIME = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const SOURCE = { enum: ['stated', 'confirmed', 'inferred'] };
const ALARM_TYPE = { enum: ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'] };
export const HABITS = ['late_bedtime', 'phone_in_bed', 'snooze_repeat', 'skip_breakfast', 'slow_prep', 'forgot_item', 'late_departure', 'irregular_wake', 'other'] as const;
export const MOODS = ['good', 'calm', 'tired', 'stressed', 'anxious', 'sad', 'angry', 'mixed'] as const;
export const EFFECTS = ['helpful', 'too_weak', 'too_strong', 'missed', 'annoying_sound', 'wrong_time'] as const;
export const BEHAVIOR_KINDS = ['SLEEP', 'WAKE', 'ALARM_RING', 'SNOOZE', 'PREP_START', 'PREP_DURATION', 'PREP_OVER', 'DEPART', 'ARRIVE', 'LATE'] as const;
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const scale = (min: number, max: number) => nullable({ type: 'integer', minimum: min, maximum: max });

const schema = structuredClone(v1) as JsonSchema & { properties: Record<string, JsonSchema>; required: string[] };
schema.$id = 'extract.v2';

const todoItem = (schema.properties.todos as { items: JsonSchema & { properties: Record<string, JsonSchema>; required: string[] } }).items;
todoItem.properties.appointment_title = nullable(str);
todoItem.required.push('appointment_title');

const added: Record<string, JsonSchema> = {
  behavior: arr(obj({
    kind: { enum: [...BEHAVIOR_KINDS] },
    date: nullable(DATE),
    time: nullable(TIME),
    minutes: scale(0, 600),
    appointment_ref: nullable(str),
    appointment_title: nullable(str),
    reasons: arr({ enum: [...REASON_TAGS] }),
    source: SOURCE,
    uncertain: nullable(str),
  })),
  alarm_feedback: arr(obj({
    effect: { enum: [...EFFECTS] },
    alarm_type: nullable(ALARM_TYPE),
    date: nullable(DATE),
    note: nullable({ type: 'string', maxLength: 100 }),
    source: SOURCE,
  })),
  day_review: obj({
    events: arr(obj({ text: str, time: nullable(TIME), important: { type: 'boolean' }, source: SOURCE })),
    memorable: nullable({ type: 'string', maxLength: 200 }),
  }),
  mood_condition: obj({
    mood: arr({ enum: [...MOODS] }),
    valence: scale(-2, 2),
    fatigue: scale(1, 5),
    stress: scale(1, 5),
    causes: arr(str),
    source: SOURCE,
  }),
  habit_signals: arr(obj({ habit: { enum: [...HABITS] }, note: str, date: nullable(DATE), recurring: { type: 'boolean' }, source: SOURCE })),
  goals_routine: obj({
    goals: arr(obj({ habit: { enum: [...HABITS] }, goal_text: str, source: SOURCE })),
    wanted_routine: nullable({ type: 'string', maxLength: 200 }),
  }),
};
Object.assign(schema.properties, added);
schema.required.push(...Object.keys(added));

export default schema;
