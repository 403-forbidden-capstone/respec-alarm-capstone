// 생성 파일 — 고치지 말 것. 실험실 schemas/extract-fast.v1.json을 gen.mjs로 옮긴 것 (팀 레포에는 JSON 사본을 두지 않음 — gen.mjs 머리 주석).
// 실험실과 같은지는 지문 대조(schema.test.ts)로 확인. 바뀌면 새 id(.v2)로 만들 것.
import type { JsonSchema } from '../schema.ts';

const schema: JsonSchema = {
  "$id": "extract-fast.v1",
  "title": "ExtractFast",
  "type": "object",
  "properties": {
    "appointments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "ref": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "title": {
            "type": "string"
          },
          "date": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "time": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
              },
              {
                "type": "null"
              }
            ]
          },
          "place": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "importance": {
            "anyOf": [
              {
                "enum": [
                  "LOW",
                  "NORMAL",
                  "HIGH"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "transport": {
            "anyOf": [
              {
                "enum": [
                  "WALK",
                  "TRANSIT",
                  "BUS",
                  "SUBWAY",
                  "CAR"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "repeat": {
            "anyOf": [
              {
                "enum": [
                  "NONE",
                  "WEEKLY"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "save": {
            "enum": [
              "CONFIRMED",
              "DECLINED",
              "UNCONFIRMED"
            ]
          },
          "unclear": {
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
          "ref",
          "title",
          "date",
          "time",
          "place",
          "importance",
          "transport",
          "repeat",
          "save",
          "unclear"
        ],
        "additionalProperties": false
      }
    },
    "alarm_changes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "target": {
            "type": "string"
          },
          "appointment_ref": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "type": {
            "enum": [
              "WAKE",
              "PREPARE",
              "DEPARTURE",
              "ARRIVE"
            ]
          },
          "date": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "time": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
              },
              {
                "type": "null"
              }
            ]
          },
          "intensity": {
            "anyOf": [
              {
                "enum": [
                  "SOFT",
                  "NORMAL",
                  "STRONG"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "enabled": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "save": {
            "enum": [
              "CONFIRMED",
              "DECLINED",
              "UNCONFIRMED"
            ]
          }
        },
        "required": [
          "target",
          "appointment_ref",
          "type",
          "date",
          "time",
          "intensity",
          "enabled",
          "save"
        ],
        "additionalProperties": false
      }
    },
    "fact_feedback": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fact_id": {
            "type": "string"
          },
          "status": {
            "enum": [
              "CONFIRMED",
              "CORRECTED",
              "DENIED",
              "UNCLEAR"
            ]
          },
          "value_time": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
              },
              {
                "type": "null"
              }
            ]
          },
          "approx": {
            "type": "boolean"
          }
        },
        "required": [
          "fact_id",
          "status",
          "value_time",
          "approx"
        ],
        "additionalProperties": false
      }
    },
    "prep_adjustment": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "direction": {
              "enum": [
                "MORE",
                "LESS",
                "OK"
              ]
            },
            "minutes": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 120
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "direction",
            "minutes"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "safety_flag": {
      "type": "boolean"
    }
  },
  "required": [
    "appointments",
    "alarm_changes",
    "fact_feedback",
    "prep_adjustment",
    "safety_flag"
  ],
  "additionalProperties": false
};

export default schema;
