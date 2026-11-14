// 서버가 만든 판 (실험실 JSON 없음 — extract.v2처럼 서버에서 더한 판). extract-fast.v1에 준비물(items)만 더함 (T2F.v2-d):
//   대화 중에 말한 준비물을 끝 정리(T2)를 기다리지 않고 todos(ITEM)에 바로 넣으려고. date "" = 날짜를 모름 → 서버가 되물음
//   date를 null 허용(anyOf)으로 두면 union 수가 API 상한을 넘어 T2F 전체가 sentinel 방식으로 바뀜 — 그래서 빈 글자로 모름을 나타냄
//   items는 선택 칸(required에 없음) — 빠지면 빈 목록으로 봄 (예전 녹화 출력도 그대로 통과)
// v1 파일은 그대로 두고 복사해서 더함 — 겹치는 칸의 규칙이 v1과 같다는 것이 코드로 보이게.
import type { JsonSchema } from '../schema.ts';
import v1 from './extract-fast.v1.ts';

const schema = structuredClone(v1) as JsonSchema & { properties: Record<string, JsonSchema> };
schema.$id = 'extract-fast.v2';
schema.properties.items = {
  type: 'array',
  items: {
    type: 'object',
    properties: { title: { type: 'string', maxLength: 100 }, date: { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' } },
    required: ['title', 'date'],
    additionalProperties: false,
  },
};

export default schema;
