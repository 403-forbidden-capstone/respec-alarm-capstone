# golden — 알람 계산 골든 도구

서버 전환(알람 계산을 서버 레포의 Python으로 옮기는 작업)에서 **TS 결과를 기준값으로 뽑아 두는 도구**입니다. 같은 입력을 TS와 Python에 넣어 결과가 같은지 비교하는 쪽이 서버 레포이고, 이 폴더는 입력 시나리오와 TS 결과(골든 파일)를 만들고 지킵니다.
앱이 `@shared/calc`로 같은 TS를 계속 쓰므로 TS는 없어지지 않습니다(앱 화면 값의 기준). 그래서 두 벌이 함께 사는 동안 어긋나지 않게 하는 장치입니다. 규칙은 서버 완결점 문서 9-6 · 9-7.

```text
시나리오(입력, scenarios/*.ts) → TS 함수 실행 → data/<모듈>.json (입력 + TS 결과)
                                                      ├─ 본 레포 push 전 검사: 지금 TS 결과 = 커밋된 골든인지 (check)
                                                      └─ 서버 레포 CI: Python 결과 = 골든인지 (서버 레포 몫)
```

## 실행

레포 맨 위에서, Node 24 이상(`.ts`를 바로 읽음. 설치할 것 없음):

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/golden/golden.ts generate   # 골든을 새로 뽑아 data/에 씀
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/golden/golden.ts check      # 커밋된 골든 = 지금 TS 결과인지 (다르면 어느 사례가 어떻게 다른지 보이고 종료 코드 1)
node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "tools/golden/*.test.ts"   # 도구 자체 시험
```

- `check`는 push 전 검사(`lefthook.yml`)에서도 돎. `supabase/functions/_shared/**` 또는 `tools/golden/**`가 들어간 push만 검사하고 1초쯤 걸림. 급하면 `git push --no-verify`.
- `generate`는 끝에 **오류로 기록된 사례 목록**을 보여 줌. 일부러 넣은 오류(잘못된 날짜 글자 · 이동시간 없음 · 검증 못 통과한 계획의 저장)여야 하고, 처음 보는 이름이 있으면 시나리오 실수일 수 있음.
- 시간대와 상관없음: 계산이 서울 등 명시한 시간대로만 도는지 `TZ`를 바꿔 가며 같은 결과가 나오는지 시험이 확인함.

## 골든 파일 (`data/<모듈>.json`)

모듈 하나 = 파일 하나 = Python판 모듈 하나(서버 레포 시험 하나).

```json
{
  "format": 1,
  "module": "chain",
  "baseCommit": "b140f701…(40자)",
  "sourceSha256": "…(64자)",
  "cases": [
    {"id": "chain/alarmChain/basic-with-wake", "fn": "alarmChain", "args": [ {입력} ], "output": [ {결과} ]},
    {"id": "recur/weekdayOfDate/bad-abc", "fn": "weekdayOfDate", "args": ["abc"], "error": {"name": "RangeError", "message": "…"}}
  ]
}
```

- `fn`은 TS 함수 이름 그대로(Python은 snake_case로 옮겨도 이 이름으로 찾음), `args`는 앞에서부터 그대로 넘기는 인자 목록.
- 결과는 `output`, 던진 오류는 `error`(이름 · 메시지), 둘 다 없으면 함수가 `undefined`를 돌려준 것(Python은 `None`). 던지는 입력은 일부러 몇 개 넣었고 메시지는 TS 코드에 적힌 글자 그대로.
- `fn: "$constants"` 사례: 모듈이 내보내는 상수 · 표 전체(`PAST_GRACE_MINUTES`, `LEVEL_FIELDS`, `AVERAGE_SPEED_KMH` 등. 정규식은 `source` 글자).
- 합친 함수: 서버가 실제로 이어 부르는 순서를 한 번에 시험하려고 둔 것. `toSuggestionOfPlan(inputs, travel, mode)` = `computePlan` → `toSuggestion`(미리보기), `diffAlarmsOfPlan(inputs, travel, options)` = `computePlan(save)` → `diffAlarms`(저장), `intensityReasonOf(...)` = `resolveIntensity` → `intensityReason`. 정의는 `registry.ts`.
- `baseCommit`: 뽑을 때 `origin/main`과 이 브랜치의 공통 조상(main 쪽 커밋이라 squash 머지 뒤에도 남음). 소스가 같은지는 `sourceSha256`(계산 소스 파일 내용 해시, 줄바꿈은 `\n`으로 맞춤)로 봄. 두 값은 `check`가 비교하지 않음(결과만 비교).

### 값 표현

| TS 값 | 골든 JSON | Python에서 |
|---|---|---|
| `Date` | `{"$date": "2026-11-16T01:00:00.000Z"}` (UTC, 밀리초 3자리) | UTC `datetime`으로 읽고, 결과도 같은 글자로 비교 |
| `NaN` · `Infinity` · `-Infinity` | `{"$num": "NaN"}` 등 | `math.nan` · `math.inf` |
| `-0` | `0` | (JSON.stringify와 같음 — 앱이 받는 응답에서도 0) |
| 객체 속성이 `undefined` | 그 속성이 없음 | 키 없음 |
| 배열 안 `undefined` | `null` | `None` |
| 문자 · 불리언 · `null` · 객체 · 배열 | 그대로 | 그대로 |

- 숫자는 **값**으로 비교(`5`와 `5.0`은 같음). 소수는 상대 오차 1e-12 안으로 비교(삼각함수 구현 차이가 마지막 자리에서 날 수 있음). 정수 · 글자 · 날짜는 정확히.
- 객체는 키 순서와 상관없이 비교.

## 모듈 · 소스

| 골든 파일 | 서버 TS 소스 (`supabase/functions/_shared/`) |
|---|---|
| `types` | `calc/types.ts` (상수만) |
| `time` · `chain` · `order` · `validate` · `depart` · `wake` · `importance` · `suggest` · `travel` · `intensity` · `prepare` · `recur` | `calc/<같은 이름>.ts` |
| `tz` | `tz.ts` |
| `plan-core` | `plan-core.ts` (+ 합친 함수) |
| `commit-core` | `commit-core.ts` (+ 합친 함수) |
| `ring-package` | `ring-package.ts` |

범위: **순수 계산**(DB · 네트워크 없음)만. 이동시간 호출 · 예측 서버 호출 · DB 읽고 쓰기(`plan.ts` · `commit.ts` · `edit-run.ts` 등)는 입력으로 받는 값(이미 정해진 이동시간 · 예측 결과 · DB 행)만 넣음. 카카오 응답은 약관상 저장하지 못해 합성 이동시간만 씀. 현재 시각은 항상 입력(`now`)으로 넣음.

## 시나리오 (`scenarios/`)

- 손으로 고른 경계(사례 이름이 뜻을 말함: `wake-exactly-grace`, `radius-edge-299` …)와 **고정 씨앗 난수**(`rand-<번호>`, 어느 PC에서든 같은 수열)를 섞음. 파일마다 씨앗이 달라 한 파일의 난수 사례 수를 바꿔도 다른 파일 사례는 안 바뀜.
- JS와 Python이 갈리기 쉬운 곳을 일부러 넣음: `Math.round`는 .5를 위로(−1.5 → −1, −0.5 → 0) · 소수 분을 밀리초로 내림 · 문자 → 숫자(`Number('0x1A')` = 26, `Number('')` = 0, `Number('1e2')` = 100) · 시각 경계(5분 · 10분 · 12:00 정각 · 300m · 1ms 차이) · 서울 밖 시간대(뉴욕 · 런던의 일광절약 전환일, 로드하우의 30분 전환, 인도의 30분 오프셋, UTC, 상파울루) · 문장 끝 받침 판정(`이에요` / `예요`)과 닫는 괄호 처리.
- 넣지 않은 것: 형식은 맞지만 없는 날짜(`2026-02-30`은 JS가 3월 2일로 넘김) · 연도 100 미만(`Date.UTC`가 1900년대로 읽음) · 엔진마다 메시지가 다른 오류 · 오프셋 시간대 이름(`+09:00`) · 시간대 약칭(`KST`). 앱이 보내는 값(IANA 이름 · `YYYY-MM-DD`)만 대상. 모르는 시간대 이름(`Not/AZone`)은 서울로 되돌아가는 규칙이라 넣음.
- 오류로 끝나는 사례도 사례임: Python판도 같은 이름의 오류를 던져야 함(메시지는 TS 글자 그대로).

## 바꿀 때 (서버 완결점 9-6)

| 상황 | 할 일 |
|---|---|
| 알람 계산 TS의 동작을 바꾸는 PR | `golden.ts generate`로 골든을 새로 뽑아 같은 PR에 올림. push 전 검사가 막으면 의도한 변경인지 확인. 서버 레포 Python판도 같은 작업으로 맞춤(서버로 넘어간 함수는 서버 PR 먼저 머지, 아직 Edge인 함수는 TS 먼저) |
| 한쪽만 바꿀 수밖에 없음 | PR 본문에 "되돌릴 때 생기는 차이"를 적음 |
| 계산 모듈에 함수를 새로 내보냄 | `scenarios/`에 사례를 추가(안 하면 도구 시험이 어느 함수에 사례가 없는지 알려 주며 실패) |
| 시나리오만 바꿈 | `generate` 뒤 골든 diff가 시나리오 변경만큼인지 확인 |
| 계산이 `now`를 비롯한 환경값을 새로 읽음 | 입력으로 받게 바꾸고 사례에 넣음(시간대 시험이 숨은 의존을 잡음) |

`edit.ts` · `roll.ts` · `suggest-run.ts` 등 3차에서 옮길 순수 로직은 이번 범위가 아님. 그때 모듈을 `registry.ts`에 더함.
