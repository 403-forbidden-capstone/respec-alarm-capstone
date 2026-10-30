// 앱 진입 파일 — 지오펜스 신호를 받는 작업을 expo-router 화면보다 먼저 정의함 (package.json main)
//   앱이 꺼진 채 OS가 지오펜스 신호로 JS만 깨우면 이 진입 파일만 실행되고 화면(_layout)은 평가되지 않음.
//   expo-task-manager는 작업을 전역 범위에서 정의해야 하므로 여기서 불러옴 (features/location/task)
//   그 뒤 expo-router 진입을 그대로 부름
import './src/features/location/task';
import 'expo-router/entry';
