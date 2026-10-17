// Metro 설정 — Expo 기본 위에 공용 계산 폴더만 더함
//   서버 함수와 앱이 같은 계산 파일을 씀 (전체작업계획 8.1 Q4 A): supabase/functions/_shared/
//   앱은 경로 별칭 @shared/*로 가져옴 (tsconfig paths, 시험은 jest-expo가 같은 별칭을 읽음)
//   _shared 안의 파일은 순수 TS(Deno · Node API 없음)만 앱에 가져옴 — calc/ · ring-package.ts · tz.ts. commit*.ts 같은 서버 전용 파일은 가져오지 않음
//   mobile/ 밖 폴더라 watchFolders에 있어야 Metro가 읽음 (EAS · Cloudflare 빌드는 레포 전체를 내려받으므로 ../supabase가 있음)
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../supabase/functions/_shared')];

module.exports = config;
