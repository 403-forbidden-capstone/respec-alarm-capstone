# 순수 외출 준비시간 통합 · 병합/배포 검증 안내 (PR #577)

상태: **리뷰 및 자동 검사 진행 중 / main·팀 공용 DB 미병합·미배포**. 이 문서는 과거 phase 1 초안을 대체하며 현재 통합 PR(#554/#555/#573 포함)의 코드 상태를 기록함.

## 서로 다른 두 타깃을 혼동하지 않기
- 기존 `profiles.default_prepare_minutes`, `appointment_participants.prepare_minutes`: **기상 → 출발** 전체 시간. 기존 P80/C1/W4 경로는 기본 유지.
- 신규 `profiles.default_outing_prep_minutes`: 사용자가 확인한 **준비 시작 → 실제 출발**(5–240분). 기존 값에서 자동 복사/추정하지 않음.
- 신규 참여 조건 `outing_prep_minutes/source/model`: 별도 순수 준비시간과 근거. 적용되지 않은 일정을 임의로 순수 준비시간으로 재해석하지 않음.
- `prepare_value_source`: 옛 전체 준비시간의 `LEGACY`, `AUTO`, `MANUAL` 의미를 구분.

## 계산 및 기능 게이트
- `departure = appointment - travel - buffer`.
- `prepare = departure - pure_outing_prep`.
- `wake = prepare - before_prepare_tasks - wake_lead`(기상 알람이 있는 경우만).
- 기본 **PURE_PREP_APPLY_ENABLED=OFF**. 허용 목록(`PURE_PREP_ALLOWED_USER_IDS`)까지 일치할 때에만 순수 시간을 실제 알람 계산에 적용. 개인 일정만 선행 적용하며 그룹 약속은 별도 검증 전까지 제외.
- 오래된 C1/W4(기상→출발)와 신규 순수 시간 예측은 **혼합 금지**. CatBoost v2(PR #549)와 학습 프록시를 운영 활성화하지 않음.
- H05 신규 일정은 자동 미리보기 준비시간 스냅샷을 commit에서 다시 비교해 변경 시 거절. 반면 H03의 이미 저장된 AUTO 일정은 과거 DB값을 미리보기 스냅샷인 양 전송하지 않고 서버에서 재계산. 명시적 MANUAL 및 레거시 값은 유지.

## 실측 기록 사용의 보수적 규칙
- 출발: `departed_source = LOCATION`, 준비 시작: `prepare_started_source = PREPARE_ALARM`이며 시간 역전/중복/미래값이 없을 때만 후보.
- `ROUTINE_STEP`은 첫 활동이 아침식사·과제처럼 **실제 외출 준비 이전의 활동**일 수 있어 현재 순수 준비 시작으로 인정하지 않음. 이력 품질을 별도 검증한 후 포함 여부 결정.
- **직접 입력**은 5–240분 허용. **자동 개인 이력**은 10–240분만 유효한 관측치로 인정(5–9분은 위치/활동 라벨 오차에 취약). 이력이 3건 미만이면 검증된 사용자 입력값으로 대체.
- 개인 기록 기반 자동 적용은 `PURE_PREP_HISTORY_ENABLED` 및 동의 조건으로 추가 보호하며 기본 OFF. `PREPARE` 알람 해제 시각이 실제 준비 시작과 항상 같은 것은 아니므로, 이 설정은 실측 검증 전 활성화 금지.

## 마이그레이션 순서 (2026-11-22 최신 main 기준)
최신 main `20261121120200_group_life_day.sql` 뒤에 아래 3개를 순서대로 적용한다.

1. `20261122120000_pure_outing_prep_semantics.sql` — 독립 nullable 컬럼과 범위·출처 제약, 기존 행 backfill 금지.
2. `20261122121000_legacy_prepare_value_source.sql` — 기존 전체 준비시간 출처 LEGACY 기본값.
3. `20261122122000_pure_prep_roll_payload.sql` — 반복 회차 RPC의 준비시간·출처 저장 및 실행 권한 제한.

**주의:** 저장소 `.github/workflows/db-check.yml`이 main의 migration 변경을 감지하면 `supabase db push`를 공용 프로젝트에 자동 실행할 수 있음. 따라서 실제 main 병합은 migration/권한/복구 시나리오 승인 후 진행할 것. GitHub PR DB 검사는 실서비스에 쓰지 않음.

## 병합 전 필수 확인
1. 최신 main 커밋을 반영하고 순수 준비 feature gate 기본 OFF 및 Cloud REST/Edge 비밀값 비노출 확인.
2. CI DB 검증: PGlite/RLS 검사, 실제 임시 PostgreSQL 마이그레이션, `mobile/src/types/database.ts` 자동 생성 스키마 일치.
3. 모바일 `npm run typecheck`, `npm run lint`, 전체 Jest, 웹 export 및 Golden 검사를 최신 HEAD에서 수행. Android 네이티브 실기기 울림은 별도 배포 게이트.
4. 기존 레거시 60분·순수 35/40분 독립 저장, 기존 AUTO H03 저장, 수동값 우선, 반복 회차 출처 일치, 기상 없는 일정 회귀 테스트.
5. 병합 전 팀 리뷰/공용 DB의 자동 마이그레이션 영향 확인. DB/Edge/앱 배포와 기능 활성화는 별도 단계.

> 이 문서에서 `ROUTINE_STEP`과 5–9분 관측을 제외한 것은 **현재 구현의 보수적 QA 기준**이지, 팀에서 새 서비스 정책을 최종 결정했다는 의미는 아님. 공식 기획·정책 결정은 팀 검토 후 반영.
