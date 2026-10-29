// 생성 파일 — 고치지 말 것. 실험실 schemas/t3-reason.v1.json을 gen.mjs로 옮긴 것 (팀 레포에는 JSON 사본을 두지 않음 — gen.mjs 머리 주석).
// 실험실과 같은지는 지문 대조(schema.test.ts)로 확인. 바뀌면 새 id(.v2)로 만들 것.
import type { JsonSchema } from '../schema.ts';

const schema: JsonSchema = {
  "$id": "t3-reason.v1",
  "title": "T3Output",
  "type": "object",
  "properties": {
    "tags": {
      "type": "array",
      "items": {
        "enum": [
          "MORE_TASKS",
          "OVERSLEPT",
          "HAIR_WASH",
          "TRAFFIC",
          "UNEXPECTED",
          "ESTIMATE_SHORT",
          "ETC",
          "MAKEUP",
          "PRESENTATION",
          "NONE"
        ]
      }
    }
  },
  "required": [
    "tags"
  ],
  "additionalProperties": false
};

export default schema;
