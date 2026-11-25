// 서버가 만든 판 (실험실 JSON 없음). extract-fast.v3의 alarm_changes 항목에 shift 칸 하나를 더함 (T2F.v2-f, #625):
//   shift — 알람 상대 변경 분(부호 포함, "10분 당겨" → -10). 0 = 상대 변경 아님. 바뀔 시각은 서버가 지금 알람 시각에서 계산함
// null 허용(anyOf)을 쓰지 않음 — union 수가 API 상한을 넘으면 T2F 전체가 sentinel 방식으로 바뀜(v2 주석). 그래서 0으로 "없음"
// 선택 칸(required에 없음) — 빠지면 0으로 봄 (예전 녹화 출력도 그대로 통과)
// v3 파일은 그대로 두고 복사해서 더함 — 겹치는 칸의 규칙이 v3와 같다는 것이 코드로 보이게.
import type { JsonSchema } from '../schema.ts';
import v3 from './extract-fast.v3.ts';

const schema = structuredClone(v3) as JsonSchema & { properties: Record<string, JsonSchema & { items: { properties: Record<string, JsonSchema> } }> };
schema.$id = 'extract-fast.v4';
schema.properties.alarm_changes.items.properties.shift = { type: 'integer', minimum: -720, maximum: 720 };

export default schema;
