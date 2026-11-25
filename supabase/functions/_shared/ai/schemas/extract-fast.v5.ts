// 서버가 만든 판 (실험실 JSON 없음). extract-fast.v4에 alarm_new 칸 하나를 더함 (T2F.v2-g):
//   alarm_new — 일정 없이 울릴 기본 알람을 새로 만들어 달라는 요청. 항목 하나 = 알람 하나 (여러 개면 따로)
//     date "" = 날짜 말 없음 · time "" = 시각 없음(상대 시각이거나 되물음) · ampm false = 오전 · 오후 말 없음(서버가 지금 뒤 가장 가까운 쪽) · after 0 = 상대 시각 아님
// null 허용(anyOf)을 쓰지 않음 — union 수가 API 상한을 넘으면 T2F 전체가 sentinel 방식으로 바뀜(v2 주석). 그래서 빈 글자 · 0으로 "없음"
// 선택 칸(required에 없음) — 빠지면 빈 목록으로 봄 (예전 녹화 출력도 그대로 통과)
import type { JsonSchema } from '../schema.ts';
import v4 from './extract-fast.v4.ts';

const schema = structuredClone(v4) as JsonSchema & { properties: Record<string, JsonSchema> };
schema.$id = 'extract-fast.v5';
schema.properties.alarm_new = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' },
      time: { type: 'string', pattern: '^(([01]\\d|2[0-3]):[0-5]\\d)?$' },
      ampm: { type: 'boolean' },
      after: { type: 'integer', minimum: 0, maximum: 2880 },
      save: { enum: ['CONFIRMED', 'DECLINED', 'UNCONFIRMED'] },
    },
    required: ['date', 'time', 'ampm', 'after', 'save'],
    additionalProperties: false,
  },
};

export default schema;
