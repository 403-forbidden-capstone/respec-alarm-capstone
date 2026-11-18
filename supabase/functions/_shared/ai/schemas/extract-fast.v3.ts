// 서버가 만든 판 (실험실 JSON 없음 — extract-fast.v2처럼 서버에서 더한 판). extract-fast.v2에 두 칸을 더함 (T2F.v2-e):
//   pre_tasks  — 나가기 전에 집 · 온라인에서 하는 할 일(회의 · 과제 · 공부). 일정(appointments)이 아님 — 일정 카드를 만들지 않고 기상 시각을 확인하는 계기만 됨
//   wake_reply — 기상 시각에 대한 사용자 답: KEEP 그대로 · TIME 정한 시각 · VAGUE 시각 없이 "일찍" · NONE 말 없음. time "" = 시각 없음
// null 허용(anyOf)을 쓰지 않음 — union 수가 API 상한을 넘으면 T2F 전체가 sentinel 방식으로 바뀜(v2 주석). 그래서 빈 배열 · NONE · 빈 글자로 "없음"
// 두 칸 모두 선택 칸(required에 없음) — 빠지면 빈 목록 · NONE으로 봄 (예전 녹화 출력도 그대로 통과)
// v2 파일은 그대로 두고 복사해서 더함 — 겹치는 칸의 규칙이 v2와 같다는 것이 코드로 보이게.
import type { JsonSchema } from '../schema.ts';
import v2 from './extract-fast.v2.ts';

const schema = structuredClone(v2) as JsonSchema & { properties: Record<string, JsonSchema> };
schema.$id = 'extract-fast.v3';
schema.properties.pre_tasks = {
  type: 'array',
  items: {
    type: 'object',
    properties: { title: { type: 'string', maxLength: 100 } },
    required: ['title'],
    additionalProperties: false,
  },
};
schema.properties.wake_reply = {
  type: 'object',
  properties: {
    choice: { enum: ['NONE', 'KEEP', 'TIME', 'VAGUE'] },
    time: { type: 'string', pattern: '^(([01]\\d|2[0-3]):[0-5]\\d)?$' },
  },
  required: ['choice', 'time'],
  additionalProperties: false,
};

export default schema;
