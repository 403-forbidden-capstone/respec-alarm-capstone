// 위치 감지 출발 · 도착 — 화면(홈 감지 정정 줄 · 감지 안내) · 백그라운드 작업 · 일기가 부르는 곳. 데이터 접근은 이 파일에서만 합니다
// 가짜 데이터는 아래, 실데이터 모드면 함수 맨 앞에서 real.ts(Supabase)로 넘김 (docs/screen-data-map.md "실데이터 연결 규칙")
//   함수 이름 · 인자는 레인 L2 지시서 6절 "홈 감지 정정 줄"과 같음: listDetections · rejectDetection · undoReject (+ 확인할 기록 listEarlierDepartures)
//   [아니에요]는 틀렸을 때만 누르는 정정 — 지운 뒤 다음 자동 감지를 기다림. 원탭은 자동 값이 없을 때만 대신 쓰는 길 (원탭 알림 건너뛰기는 PR 6)
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { isMock } from '@/lib/mode';
import { db, kst } from '@/mocks/data';
import { pastDay } from '@/mocks/records';
import type { UserEditLog } from '@/features/alarm/types';

import {
  DETECTION_ALARM,
  DETECTION_FIELD,
  isSettled,
  REJECTED_VALUE,
  type DetectionKind,
  type EarlierDeparture,
  type LocationDetection,
  type RejectInput,
  type RejectSnapshot,
} from './detections';
import * as real from './real';
import * as realPlaces from './realPlaces';
import {
  cleanLabel,
  LIMIT_MESSAGE,
  normalizeInput,
  wouldExceedLimit,
  type UserPlace,
  type UserPlaceInput,
} from './userPlaces';

export type { DetectionKind, EarlierDeparture, LocationDetection, RejectInput, RejectScreen, RejectSnapshot } from './detections';
export type { UserPlace, UserPlaceInput } from './userPlaces';

// ---------------------------------------------------------------------------
// 가짜 데이터 — 위치 감지는 돌지 않음(가짜 모드는 원탭 그대로, 레인 L2 1절). 화면 초안(L5 · 웹 미리보기)이 볼 수 있게
//   지난 평일 기록(mocks/records)에 "자동 · 지오펜스"로 남은 출발 · 도착을 감지로 돌려줌. 참여 조건 id = mock-<5월 날짜>
//   [아니에요] · 되돌리기는 앱을 다시 열 때까지 메모리에서만 (기록 화면 목업 줄은 그대로). 고친 값 기록은 가짜 db.editLogs에 쌓음
//   (가짜 값을 지난 평일 기록에서 만드는 것은 근거 없음 — 작성자 판단: 기록 화면 목업과 같은 값을 보이려고)
//   확인할 기록은 지각한 평일 하루(5월 13일)에만 앞 출발 하나를 둠 — 자기 전 대화(L4) 초안이 볼 수 있게 (근거 없음 — 작성자 판단, 기록 화면 목업에는 없음)
// ---------------------------------------------------------------------------

const MOCK_GEO_SOURCE = '자동 · 지오펜스'; // mocks/records 출처 글자
const MOCK_EARLIER_DEPARTURES: Record<number, number[]> = { 13: [465] }; // 5월 날짜 → 앞 출발 시각(0시부터 분) — 오전 7:45에 나갔다 들어옴
const mockVoided = new Set<string>();
const mockLogs = new Map<string, UserEditLog>();
const mockKey = (participantId: string, kind: DetectionKind) => `${participantId}:${kind}`;

function mockDetectionsOf(day: Date): LocationDetection[] {
  const p = pastDay(day);
  if (!p) return [];
  const nowMs = now().getTime();
  return p.actual.flatMap(([minutes, label, source]): LocationDetection[] => {
    const kind: DetectionKind | null = source !== MOCK_GEO_SOURCE ? null : label === '집 출발' ? 'DEPART' : label.startsWith('도착') ? 'ARRIVE' : null;
    if (!kind) return [];
    const at = kst(p.day, minutes);
    const base = { participantId: `mock-${p.day}`, at, source: 'LOCATION' as const, settled: isSettled(at, nowMs) };
    return [kind === 'ARRIVE' ? { ...base, kind, isLate: label.endsWith('분 지각') } : { ...base, kind, isLate: null }];
  });
}

function mockFind(participantId: string, kind: DetectionKind): LocationDetection | null {
  const day = /^mock-(\d+)$/.exec(participantId)?.[1];
  if (!day || mockVoided.has(mockKey(participantId, kind))) return null;
  return mockDetectionsOf(kst(Number(day), 0)).find((d) => d.kind === kind) ?? null;
}

// ---------------------------------------------------------------------------
// 함수
// ---------------------------------------------------------------------------

// 그날 위치로 잡은 출발 · 도착 (출처 LOCATION만, 시각순) — 홈 정정 줄 · 일기(settled인 것만 반영, D61)
export async function listDetections(day: Date): Promise<LocationDetection[]> {
  if (!isMock()) return real.listDetections(day);
  return mockDetectionsOf(day).filter((d) => !mockVoided.has(mockKey(d.participantId, d.kind)));
}

// 그날 '확인할 기록' — 더 늦은 위치 출발로 바뀐 앞 위치 출발 {참여 조건, 시각}, 시각순 (7.13.7 "출발이 여러 번 잡힘")
//   자기 전 대화(레인 L4)가 "8:10에 나갔다 들어왔죠?"로 확인할 때 씀. 지금 출발이 응답(원탭 · 직접 입력)인 약속은 이미 답했으니 뺌
export async function listEarlierDepartures(day: Date): Promise<EarlierDeparture[]> {
  if (!isMock()) return real.listEarlierDepartures(day);
  const p = pastDay(day);
  if (!p) return [];
  return (MOCK_EARLIER_DEPARTURES[p.day] ?? []).map((minutes) => ({ participantId: `mock-${p.day}`, at: kst(p.day, minutes) }));
}

// [아니에요] 1탭 정정 (D61) — 위치 값만 지움(시각 · 출처 · 지각 판정 · 이동시간 · 그 출발로 셈한 준비 실측 · 그 값의 기록 화면 위치 줄) + 고친 값 기록 한 줄
//   지금 값이 위치가 아니면(원탭 값 · 이미 지움) 또는 input.at이 지금 위치 값의 시각과 다르면(오래된 알림) 아무것도 안 하고 null. 돌려준 값을 5초 안에 undoReject로 넘기면 되돌림
//   지운 뒤는 다음 자동 감지(다음 이탈 · 진입)를 기다림 — 원탭은 자동 값이 없을 때만 대신 쓰는 길 (원탭 알림 건너뛰기는 PR 6)
export async function rejectDetection(input: RejectInput): Promise<RejectSnapshot | null> {
  if (!isMock()) return real.rejectDetection(input);
  const found = mockFind(input.participantId, input.kind);
  if (!found) return null;
  if (input.at != null && found.at.getTime() !== input.at) return null; // 오래된 알림 — real.ts와 같게
  const editId = `mock-reject:${mockKey(input.participantId, input.kind)}`;
  const log: UserEditLog = {
    at: now(),
    screen: input.screen,
    field: DETECTION_FIELD[input.kind],
    alarmType: DETECTION_ALARM[input.kind],
    autoValue: found.at,
    editedValue: REJECTED_VALUE,
  };
  mockVoided.add(mockKey(input.participantId, input.kind));
  db.editLogs.push(log);
  mockLogs.set(editId, log);
  return { participantId: input.participantId, kind: input.kind, at: found.at, editId };
}

// 5초 되돌리기 (L6 안건후보: 감지 안내 정정 · 채널 기본안) — 지운 값을 위치 출처로 다시 씀, 그 사이 다른 값이 들어왔으면 덮지 않음. 고친 값 기록은 지움
export async function undoReject(snapshot: RejectSnapshot): Promise<boolean> {
  if (!isMock()) return real.undoReject(snapshot);
  const restored = mockVoided.delete(mockKey(snapshot.participantId, snapshot.kind));
  const log = mockLogs.get(snapshot.editId);
  if (log) {
    const index = db.editLogs.indexOf(log);
    if (index >= 0) db.editLogs.splice(index, 1);
    mockLogs.delete(snapshot.editId);
  }
  return restored;
}

// ---------------------------------------------------------------------------
// 자주 가는 곳 (학교 · 회사 · 알바 등 최대 5개) — 설정 "자주 가는 곳" 줄 · 새 일정 장소 칩 · 온보딩 시간표 장소 기본값이 읽음
//   헤드 설계 10/30: 집은 profiles, 나머지는 표 user_places. 본인만 읽고 씀 (위치는 공유 안 함, Q13 · D59)
//   가짜 모드는 메모리 배열 — 앱을 다시 열면 처음 두 곳으로 돌아감
// ---------------------------------------------------------------------------

const MOCK_USER_PLACES: readonly UserPlace[] = [
  { label: '학교', name: '서울 광진구 능동로 209', address: '서울 광진구 능동로 209', lat: 37.5509, lng: 127.0736 },
  { label: '회사', name: '홍대입구역', address: '서울 마포구 양화로 160', lat: 37.5572, lng: 126.9245, radiusM: 300 },
];
let mockUserPlaces: UserPlace[] = MOCK_USER_PLACES.map((p) => ({ ...p }));

// 가짜 자리를 처음으로 되돌림 (시험 · 개발 화면)
export function resetMockUserPlaces(): void {
  mockUserPlaces = MOCK_USER_PLACES.map((p) => ({ ...p }));
}

// 내 자주 가는 곳 — 만든 순서
export async function listUserPlaces(): Promise<UserPlace[]> {
  if (!isMock()) return realPlaces.listUserPlaces();
  return mockUserPlaces.map((p) => ({ ...p }));
}

// 저장 — 같은 이름표가 있으면 덮어씀 (자리는 그대로, 값만 바뀜), 새 이름표인데 이미 5개면 UserError
export async function saveUserPlace(input: UserPlaceInput): Promise<UserPlace> {
  if (!isMock()) return realPlaces.saveUserPlace(input);
  const place = normalizeInput(input);
  const index = mockUserPlaces.findIndex((p) => p.label === place.label);
  if (index < 0 && wouldExceedLimit(mockUserPlaces, place.label)) throw new UserError(LIMIT_MESSAGE);
  if (index >= 0) mockUserPlaces[index] = place;
  else mockUserPlaces.push(place);
  return { ...place };
}

// 지우기 — 없는 이름표면 아무 일도 안 함
export async function deleteUserPlace(label: string): Promise<void> {
  if (!isMock()) return realPlaces.deleteUserPlace(label);
  const key = cleanLabel(label);
  mockUserPlaces = mockUserPlaces.filter((p) => p.label !== key);
}
