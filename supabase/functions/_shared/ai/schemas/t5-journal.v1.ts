// 생성 파일 — 고치지 말 것. 실험실 schemas/t5-journal.v1.json을 gen.mjs로 옮긴 것 (팀 레포에는 JSON 사본을 두지 않음 — gen.mjs 머리 주석).
// 실험실과 같은지는 지문 대조(schema.test.ts)로 확인. 바뀌면 새 id(.v2)로 만들 것.
import type { JsonSchema } from '../schema.ts';

const schema: JsonSchema = {
  "$id": "t5-journal.v1",
  "title": "T5Output",
  "type": "object",
  "properties": {
    "diary": {
      "type": "string"
    },
    "coaching": {
      "type": "string"
    },
    "encouragement": {
      "type": "string"
    },
    "mood": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        {
          "type": "null"
        }
      ]
    },
    "routine_intent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "time": {
              "enum": [
                "MORNING",
                "EVENING",
                "NIGHT_BEFORE"
              ]
            },
            "problem": {
              "type": "string"
            },
            "goal": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "time",
            "problem",
            "goal",
            "keywords"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "routine_reason": {
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
    "diary",
    "coaching",
    "encouragement",
    "mood",
    "routine_intent",
    "routine_reason"
  ],
  "additionalProperties": false
};

export default schema;
