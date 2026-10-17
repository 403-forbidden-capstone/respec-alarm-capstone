// 알람 기능이 메모리에 들고 있는 것을 비움 — 로그아웃 · 계정 전환 때 부름 (lib/session signOutAndCleanup에서, 앞 계정의 장소 좌표 · 읽어 둔 알람 설정 ·
// 저장을 기다리던 고친 값 기록이 다음 계정에 섞이지 않게). 폰에 걸린 알람 · 올리지 못한 울림 기록은 session이 따로 정리함
import { forgetAllDetails } from './detailCache';
import { clearEdits } from './editQueue';
import { forgetPlaces } from './places';

export function resetAlarmMemory(): void {
  forgetAllDetails();
  clearEdits();
  forgetPlaces();
}
