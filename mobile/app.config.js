// app.json 위에 덧씌우는 설정 — 환경에 따라 들어가는 값 세 가지
//   1) 안드로이드 푸시용 google-services.json
//     · 키 파일이라 레포에 없음(.gitignore). 파일이 없는 곳(웹 빌드 · CI · 다른 팀원 PC)에서는 이 값을 넣지 않아 그대로 동작함
//     · EAS 빌드: 빌드 환경 변수 GOOGLE_SERVICES_JSON(파일 종류, `eas env:create --type file`)이 있으면 그 경로를 씀 — 레포 압축에 파일이 안 실려도 됨
//     · 로컬 빌드(expo run:android): mobile/google-services.json이 있으면 씀
//   2) 빌드 종류 — 아래 variantConfig
//   3) 카카오 SDK 로그인(브라우저 없이 카카오톡 앱으로) — 환경 변수 KAKAO_NATIVE_APP_KEY
//     · 값 = 카카오 디벨로퍼스 → 로그인용 앱(지형) → [앱] > [플랫폼 키] > [네이티브 앱 키]. EAS는 환경 변수(Plain text), 로컬은 mobile/.env
//     · 있으면 카카오 설정 플러그인(로그인 돌아오는 화면)과 extra.kakaoNativeAppKey(lib/kakaoSdk가 읽음)를 넣음
//     · 없으면 둘 다 안 넣고, 앱은 지금처럼 브라우저로 카카오 로그인
//     · 키가 있고 없고에 따라 runtimeVersion(fingerprint)이 달라짐 — eas update는 `--environment`로 같은 EAS 환경 변수를 읽게 할 것
//     · app.json의 expo-build-properties(카카오 Maven 저장소)는 키와 상관없이 늘 필요 — 패키지가 설치돼 있으면 안드로이드 빌드에 같이 들어감
/* global __dirname */
const fs = require('fs');
const path = require('path');

function googleServicesFile() {
  const fromEnv = process.env.GOOGLE_SERVICES_JSON;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return fs.existsSync(path.join(__dirname, 'google-services.json')) ? './google-services.json' : undefined;
}

// 빌드 종류 — EXPO_PUBLIC_APP_VARIANT (eas.json 프로필 env, 앱 안 lib/modePolicy appVariantOf와 같은 규칙)
//   release = 실배포 APK: app.json 그대로 (이름 Re:Spec Alarm · 버전 1.0.0)
//   그 밖(dev · 비었음) = 개발자용 배포: 이름 뒤에 "개발", 버전 0.x — 폰에서 어느 쪽인지 바로 보이게. 데모 계정 로그인은 이쪽에만
const DEV_VERSION = '0.1.0';

function variantConfig(config) {
  if ((process.env.EXPO_PUBLIC_APP_VARIANT || '').trim() === 'release') return config;
  // 웹(Cloudflare 빌드에는 이 변수가 없음) 탭 이름 · manifest는 원래 이름 그대로 — 운영 사이트가 "개발"로 바뀌지 않게
  return { ...config, name: `${config.name} 개발`, version: DEV_VERSION, web: { ...config.web, name: config.web?.name ?? config.name, shortName: config.web?.shortName ?? config.name } };
}

function withGoogleServices(config) {
  const file = googleServicesFile();
  if (!file) return config;
  return { ...config, android: { ...config.android, googleServicesFile: file } };
}

function withKakaoLogin(config) {
  const nativeAppKey = (process.env.KAKAO_NATIVE_APP_KEY || '').trim();
  if (!nativeAppKey) return config;
  return {
    ...config,
    plugins: [
      ...(config.plugins || []),
      ['@react-native-kakao/core', { nativeAppKey, android: { authCodeHandlerActivity: true }, ios: { handleKakaoOpenUrl: true } }],
    ],
    extra: { ...config.extra, kakaoNativeAppKey: nativeAppKey },
  };
}

module.exports = ({ config }) => withKakaoLogin(withGoogleServices(variantConfig(config)));
