// app.json 위에 덧씌우는 설정 — 파일이 있을 때만 들어가는 값 하나(안드로이드 푸시용 google-services.json)
//   · google-services.json은 키 파일이라 레포에 없음(.gitignore). 파일이 없는 곳(웹 빌드 · CI · 다른 팀원 PC)에서는 이 값을 넣지 않아 그대로 동작함
//   · EAS 빌드: 빌드 환경 변수 GOOGLE_SERVICES_JSON(파일 종류, `eas env:create --type file`)이 있으면 그 경로를 씀 — 레포 압축에 파일이 안 실려도 됨
//   · 로컬 빌드(expo run:android): mobile/google-services.json이 있으면 씀
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
  return { ...config, name: `${config.name} 개발`, version: DEV_VERSION };
}

module.exports = ({ config }) => {
  const base = variantConfig(config);
  const file = googleServicesFile();
  if (!file) return base;
  return { ...base, android: { ...base.android, googleServicesFile: file } };
};
