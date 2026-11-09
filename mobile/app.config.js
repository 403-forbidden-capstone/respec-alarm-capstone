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

module.exports = ({ config }) => {
  const file = googleServicesFile();
  if (!file) return config;
  return { ...config, android: { ...config.android, googleServicesFile: file } };
};
