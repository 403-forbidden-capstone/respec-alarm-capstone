// 생성 파일 — 고치지 말 것. 실험실 schemas/assist-e4.v1.json을 gen.mjs로 옮긴 것 (팀 레포에는 JSON 사본을 두지 않음 — gen.mjs 머리 주석).
// 실험실과 같은지는 지문 대조(schema.test.ts)로 확인. 바뀌면 새 id(.v2)로 만들 것.
import type { JsonSchema } from '../schema.ts';

const schema: JsonSchema = {
  "$id": "assist-e4.v1",
  "title": "AssistE4",
  "description": "E4 추천 비서 출력 — 내일 알람 앞당김(기상→출발 · 기상 늦어짐 · 이동 더 걸림) + 근거 있는 패턴 + 사용자에게 보낼 말",
  "type": "object",
  "properties": {
    "morning_minutes": {
      "type": "integer",
      "minimum": 15,
      "maximum": 240,
      "description": "내일 기상 확인 → 출발까지 걸릴 분 (5일 중 4일은 충분한 길이)"
    },
    "wake_offset": {
      "type": "integer",
      "minimum": 0,
      "maximum": 30,
      "description": "알람이 울린 뒤 기상이 확인될 때까지 늦어지는 분 — 알람을 이만큼 앞당김"
    },
    "travel_extra": {
      "type": "integer",
      "minimum": 0,
      "maximum": 30,
      "description": "일정에 적힌 이동 시간보다 더 걸릴 분 — 이만큼 더 일찍 나서도록 알람을 앞당김"
    },
    "patterns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "PREP_WEEKDAY",
              "PREP_TAG",
              "EVENT_PREP",
              "SLOW_START",
              "PREP_DRIFT",
              "OVERSLEEP_WEEKDAY",
              "WAKE_DELAY",
              "TRAVEL_OVER",
              "TRAVEL_WEEKDAY",
              "TRAVEL_RAIN",
              "OTHER"
            ]
          },
          "weekday": {
            "anyOf": [
              {
                "enum": [
                  "MON",
                  "TUE",
                  "WED",
                  "THU",
                  "FRI",
                  "SAT",
                  "SUN"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "tag": {
            "anyOf": [
              {
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
                  "EXAM"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "effect_minutes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 120
          },
          "evidence_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "kind",
          "weekday",
          "tag",
          "effect_minutes",
          "evidence_ids"
        ],
        "additionalProperties": false
      }
    },
    "message": {
      "type": "string"
    }
  },
  "required": [
    "morning_minutes",
    "wake_offset",
    "travel_extra",
    "patterns",
    "message"
  ],
  "additionalProperties": false
};

export default schema;
