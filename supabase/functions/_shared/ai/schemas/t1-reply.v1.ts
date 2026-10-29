// 생성 파일 — 고치지 말 것. 실험실 schemas/t1-reply.v1.json을 gen.mjs로 옮긴 것 (팀 레포에는 JSON 사본을 두지 않음 — gen.mjs 머리 주석).
// 실험실과 같은지는 지문 대조(schema.test.ts)로 확인. 바뀌면 새 id(.v2)로 만들 것.
import type { JsonSchema } from '../schema.ts';

const schema: JsonSchema = {
  "$id": "t1-reply.v1",
  "title": "T1Output",
  "type": "object",
  "properties": {
    "reply": {
      "type": "string"
    },
    "acts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "SERVER_Q",
              "CONFIRM",
              "CLARIFY",
              "REFLECT",
              "OTHER_Q"
            ]
          },
          "ref": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "type",
          "ref"
        ],
        "additionalProperties": false
      }
    },
    "end": {
      "type": "boolean"
    }
  },
  "required": [
    "reply",
    "acts",
    "end"
  ],
  "additionalProperties": false
};

export default schema;
