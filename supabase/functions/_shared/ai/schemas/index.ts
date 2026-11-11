// 기준 스키마 모음 — id로 찾음. 채택한 7개 + 서버 판 extract.v2(실험실 schemas/와 같은 내용, 지문은 schema.test.ts가 대조).
// 새 판(.v2)은 새 파일을 만들고 여기에 한 줄 더함 — 쓰던 판 파일을 고치지 않음 (프롬프트와 같은 규칙, prompts/index.ts 머리 주석).
// 돌려주는 객체는 얼려 있음(고치면 오류) — 바꾸려면 복사해서.
import { deepFreeze, type JsonSchema } from '../schema.ts';
import assistE4 from './assist-e4.v1.ts';
import extract from './extract.v1.ts';
import extractV2 from './extract.v2.ts';
import extractFast from './extract-fast.v1.ts';
import extractFastV2 from './extract-fast.v2.ts';
import t1Reply from './t1-reply.v1.ts';
import t3Reason from './t3-reason.v1.ts';
import t4Diary from './t4-diary.v1.ts';
import t5Journal from './t5-journal.v1.ts';

const ALL = {
  't1-reply.v1': t1Reply,
  'extract.v1': extract,
  'extract.v2': extractV2, // 서버 판 (T2.v3 — 대화 끝 정리)
  'extract-fast.v1': extractFast,
  'extract-fast.v2': extractFastV2, // 서버 판 (T2F.v2-d — 준비물 items)
  't3-reason.v1': t3Reason,
  't4-diary.v1': t4Diary,
  't5-journal.v1': t5Journal,
  'assist-e4.v1': assistE4,
};

export type SchemaId = keyof typeof ALL;

export const SCHEMAS: Readonly<Record<SchemaId, JsonSchema>> = deepFreeze(ALL);

export function schemaOf(id: string): JsonSchema {
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, id)) throw new Error(`스키마 없음: ${id}`);
  return SCHEMAS[id as SchemaId];
}
