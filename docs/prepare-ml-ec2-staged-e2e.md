# CatBoost C1/W4 임시 EC2 배포 검증 → HTTPS → Supabase 인계 계획

> 범위: Re:Spec Alarm C1/W4. **테스트용 독립 EC2와 팀의 공통 운영 EC2(#471/#472)를 혼동하지 않는다.**
> 작성: 2026-11-12. 이번 문서는 *검증된 사실*과 *추후 실행할 절차*를 분리한다.

## 1. 현재 완료된 검증 (실제 사용자 실행 로그)

- 독립 테스트 EC2: Ubuntu **24.04.5 LTS**, ARM64 `aarch64`, `t4g.small`, 메모리 약 1.8GiB, 루트 EBS 20GiB.
- Docker Engine **29.9.3**, Docker Compose **v5.7.1**; `docker run --rm hello-world` 성공.
- 모델 파일: `/opt/respec/models/v4_age_only/c1_mae.cbm`, `w4_mae.cbm`; EC2에서 원본 SHA-256 모두 `OK`.
- 코드: PR #480의 `services/prepare-ml/{app.py,Dockerfile,requirements.txt,.dockerignore}`, `deploy/prepare-ml.compose.example.yml`을 수동 전송하여 실행.
- 배포 경로: `~/respec-ml-deploy`, 모델 volume: **읽기 전용**, `deploy/ml.env`: 소유자만 읽기/쓰기 (`chmod 600`), 키는 Git/이미지에 미포함.
- 컨테이너 `respec-prepare-ml-prepare-ml-1`: `respec-prepare-ml:local`, host `127.0.0.1:8093` → container `8091`, `Up (healthy)`.
- EC2 `GET /health`: **200**, `{"ok":true,"loaded_models":["c1_mae","w4_mae"]}`.
- EC2 인증된 `POST /predict`:
  - C1: raw `50.30598289707526` → **50분**, 200.
  - W4: raw `59.97985147436078` → **60분**, 200 (가상 전날 준비 60분).
  - 인증 없음: **401**.
- Mac → SSH 터널(`-L 18093:127.0.0.1:8093`) → EC2 `/health`: **200**, 두 모델 로딩.
- 컨테이너 재시작 후 `healthy` 복구, **EC2 전체 재부팅** 후 Docker `active`, 컨테이너 `healthy`, `/health` 200.
- **2026-11-12 기준 사용자 요청으로 EC2 중지(Stop).** 재개 전에는 API 사용 불가. 중지된 인스턴스의 퍼블릭 IPv4는 재시작 시 달라질 수 있으므로 기존 IP를 문서·시크릿에 고정하지 않는다.
- 상기 50/60분은 예측 API 스모크 입력의 응답이지 실제 사용자에 대한 MAE 또는 서비스 정확도 검증이 아니다.

### 모델 SHA-256 (전송 시 재검증 기준)

| 모델 | sha256 |
|---|---|
| `c1_mae.cbm` | `e8def4a0753a4a5d90472c638ccbe85a3838aa366134c1a279fd1a7f850da7e8` |
| `w4_mae.cbm` | `16cc8bd739c17caa363ab8b5976fc155b9ce43c92cd1ffd6848999a95c8f77b7` |

## 2. HTTPS 결정 (비용·팀 병렬 작업 분리)

### 임시 E2E: Cloudflare **Quick Tunnel**

- **권장 목적:** 임시 합성 입력 통신 테스트. 기존 Cloudflare Mac 터널 실험과 동일한 원리로, 이번에는 *EC2에서 직접* `cloudflared`를 실행.
- 도메인·Cloudflare 계정 추가 구매 없이 임시 `https://<랜덤>.trycloudflare.com` 주소 생성.
- API 자체는 계속 `127.0.0.1:8093`에만 바인딩. EC2 Security Group에 **8093, 8091, 80, 443 인바운드 규칙을 추가하지 않는다**. SSH 22는 허용된 IP만.
- URL과 연결은 일시적이며 `cloudflared` 종료/인스턴스 Stop 시 끊김. **고정 운영 주소나 자동복구 경로로 취급하지 않는다**.
- Quick Tunnel은 공개 URL이므로, 비밀키 없는 요청 401 및 고엔트로피 `CATBOOST_API_TOKEN` 필수. FastAPI의 `/models`(토큰 필수), `/docs`, `/openapi.json`도 노출될 수 있으므로 **짧은 시험 기간만 사용**. 임시 주소를 사용자 앱의 고정 설정, 문서, 소스에 하드코딩하지 않는다.

### 팀 운영: #471/#472의 nginx + 공식 HTTPS

- 운영 도메인 `https://api.<실제-팀-도메인>/ml`에서 `/health`, `/predict`만 프록시하고 `/ml/models`는 **404**. nginx 설정과 팀 Compose/GHCR 배포 소유자는 BE.
- 모델 서비스는 여전히 내부 네트워크/loopback으로 노출하고 외부 포트를 직접 공개하지 않는다.
- 임시 테스트 EC2에서 검증한 `.cbm` 파일 두 개와 읽기 전용 마운트 설정을 공통 서버에 **재배포**하는 것. 두 서버를 합치는 작업이 아니다.
- 팀 도메인과 BE의 공통 서버 준비 여부가 확인되기 전에 별도 고정 도메인·Elastic IP·ALB 같은 비용 자원을 임의 생성하지 않는다.

공식 근거: [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [Cloudflare Ubuntu 설치](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/), [Supabase Edge secrets](https://supabase.com/docs/guides/functions/secrets).

## 3. EC2를 다시 켜는 날: 임시 HTTPS 통합 테스트 절차 (지금은 실행하지 않음)

### 3-A. 복구 검사

1. AWS 콘솔에서 기존 테스트 인스턴스를 **Start** 후 퍼블릭 IPv4 주소 새로 확인. 새 VM 생성 및 재설치 불필요.
2. Mac에서 SSH 접속(개인키 내용 공유/커밋 금지).
3. EC2에서:
   ```bash
   sudo docker ps
   sudo docker inspect -f '{{.State.Health.Status}}' respec-prepare-ml-prepare-ml-1
   curl -fsS http://127.0.0.1:8093/health
   ```
   `healthy` 및 `ok=true` 확인 이후에만 다음으로 진행.

### 3-B. cloudflared 설치 및 임시 HTTPS 생성 (EC2 터미널)

```bash
# Cloudflare 공식 Ubuntu APT 저장소. 모델 파일이나 env 내용은 변경하지 않음.
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update
sudo apt-get install -y cloudflared
cloudflared --version

# EC2 loopback의 모델 API만 대상으로 임시 HTTPS URL 발급.
# 종료할 때 Ctrl+C, 테스트 전용. systemd 서비스로 등록하지 않음.
cloudflared tunnel --url http://127.0.0.1:8093
```

- 출력된 임시 `https://<랜덤>.trycloudflare.com` 호스트만 복사. URL은 비밀이 아니지만 누구나 접근할 수 있으므로 공개 공유는 피한다.
- 터널 터미널은 열린 상태 유지. **터널 시작 = Supabase 연결 성공이 아님**.

### 3-C. HTTPS 연결 검사 (별도 터미널; 실제 주소로 대체)

```bash
TUNNEL_URL='https://<실제-발급된-임시주소>.trycloudflare.com'
curl -fsS "$TUNNEL_URL/health"  # ok=true, C1/W4 두 모델 필수
curl -sS -o /dev/null -w 'unauth_predict_http=%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"model":"c1_mae","features":{}}' "$TUNNEL_URL/predict"  # 401
```

- 필요시 실제 EC2의 `deploy/ml.env`에서 API 키를 **출력하지 않고** 로컬 셸 변수로 읽어 제한된 시험 요청만 수행. URL·키를 화면 캡처, GitHub, PR, 로그에 함께 남기지 않음.
- 모델 서버의 `/health`가 외부에서 200이어도 `/predict`의 인증/응답 타입을 별도로 검증한다.
- 테스트 후 `unset TOKEN TUNNEL_URL`, `cloudflared`는 Ctrl+C로 종료.

### 3-D. Supabase: 합성 입력 통신만 먼저 검사

- 환경변수는 **Supabase Edge Functions → Secrets**에서만 설정: `PREPARE_ML_URL=https://<임시 주소>`, `PREPARE_ML_API_TOKEN=<EC2 deploy/ml.env의 실제 토큰>`. Expo/mobile/.env/GitHub에는 비밀값을 두지 않음.
- **`PREPARE_ML_ENABLED=0` 유지**. 프로필 승인 없이 일반 앱에서 자동 ML을 켜지 않음.
- 이미 존재하는 `alarm-suggest-ml-test`는 합성 프로필과 가상 전날 준비 60분, **미리보기만 반환·DB 저장 없음**. 사용하려면 배포된 함수가 최신 코드인지 검증하고 `PREPARE_ML_TEST_ENABLED=1`, `PREPARE_ML_TEST_USER_IDS=<정확히 승인한 테스트 UUID>`를 별도로 준비해야 한다. 현재 그 두 시크릿 값/활성 상태는 확인되지 않았음. 실제 사용자 동의·실계정 테스트가 아니라 개발용 데모 계정만 사용한다.
- 테스트 함수 `alarm-suggest-ml-test`와 일반 `alarm-suggest`/`alarm-commit`의 실제 모델 경로를 혼동하지 않는다. 합성 테스트 함수 성공은 **앱 저장 E2E 성공이 아님**.
- 완료 즉시 `PREPARE_ML_TEST_ENABLED=0`으로 차단하고 임시 URL을 제거하거나 재설정한다. `PREPARE_ML_ENABLED=0` 유지.

## 4. 실제 앱 C1/W4 E2E 게이트 (PR #493 승인 이후)

1. PR #493 `private.approve_prepare_ml_test_profile`의 팀 DB 리뷰와 migration 배포 완료. 보호테이블에서 현재 승인행 **0건**인 것을 확인했으므로 사용자 임의 승인을 하지 않는다.
2. 데모 계정에 나이/휴무 입력·선택형 동의 기록 → 지정된 테스트 계정 1명의 UUID/이메일을 별도 확인 → DB 관리자만 수동 승인.
3. 보호 테이블의 `codebook_version='2024-time-use-age-holiday-v1'` 및 동의 시각 일치 확인.
4. 운영 비밀값 `PREPARE_ML_ALLOWED_USER_IDS`에 테스트 UUID **1명만**, `PREPARE_ML_CODEBOOK_VERSION`을 승인 버전과 정확히 맞추고 EC2 HTTPS가 정상인 상태에서만 **한시적으로** `PREPARE_ML_ENABLED=1` 시험. 전역 사용 허용이 아니라 나머지 접근 제어와 함께 동작.
5. C1: 전날 기록 없는 경우; W4: **정확히 전날 로컬 날짜** 준비시간 기록 있는 경우. 자동 준비시간·기상 포함 일정만 모델 사용, 수동 입력·당일 이후 일정은 P80 유지.
6. 오류 시 P80 폴백, 모델 출처/분, `alarm-suggest` 미리보기 vs `alarm-commit` 저장의 `alarms`/`appointment_participants` 타임스탬프 일치 검증. 필요 시 테스트 데이터 정리는 해당 계정에서 승인받고 진행.
7. 종료 시 `PREPARE_ML_ENABLED=0`, `PREPARE_ML_TEST_ENABLED=0`, 테스트 UUID allowlist 정리. 신뢰된 모델의 서비스 실제 오차와 조사자료 프록시 라벨 간 차이는 별도 평가.

**주의:** Supabase 실제 Edge 코드 배포 상태/시크릿 값을 위 절차 전에 확인. PR 병합만으로 원격 Edge 배포가 자동으로 동기화됐다고 가정하지 않는다.

## 5. 서버 인계 (BE #471/#472)

| AI 전달 내용 | BE 통합 내용 |
|---|---|
| `services/prepare-ml` / Dockerfile / PR #480 | 공통 arm64 GHCR build 및 `deploy/compose.yml` 통합 |
| EC2 모델 2개와 SHA-256, 읽기 전용 경로 | 공통 서버에 인증된 SCP로 복사, 서버측 sha256 검증 |
| `deploy/prepare-ml.compose.example.yml` | 운영 nginx `/ml/health` · `/ml/predict` HTTPS 프록시, `/ml/models` 404 |
| 건강 상태·인증·추론·재부팅 자동 복구 검증 로그 | 운영 환경 HTTPS/배포 rollback/감시 재검증 |
| `CATBOOST_API_TOKEN` 환경변수 명세 | 운영 서버 전용 토큰 재발급, Supabase Edge Secrets 연결 |

- 실제 모델 파일·키는 PR/GitHub/팀 채팅에 넣지 않는다. 테스트 서버의 토큰을 팀 공통 운영 서버에 재사용하지 않는다.
- #480 병합/코드 리뷰, #493 승인/마이그레이션, #471/#472 운영 배포는 **서로 별개의 완료 조건**이다.
