// 위치 감지 출발 · 도착 — 화면(홈 감지 정정 줄 · 감지 안내) · 백그라운드 작업 · 일기가 부르는 곳. 데이터 접근은 이 파일에서만 합니다
// 가짜 데이터는 아래, 실데이터 모드면 함수 맨 앞에서 real.ts(Supabase)로 넘김 (docs/screen-data-map.md "실데이터 연결 규칙")
//   함수 이름 · 인자는 레인 L2 지시서 6절 "홈 감지 정정 줄"과 같음: listDetections · rejectDetection · undoReject (+ 귀가 취소 retractDeparture)
import { now } from '@/lib/clock';
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
  type LocationDetection,
  type RejectInput,
  type RejectSnapshot,
} from './detections';
import * as real from './real';

export type { DetectionKind, LocationDetection, RejectInput, RejectScreen, RejectSnapshot } from './detections';

// ---------------------------------------------------------------------------
// 가짜 데이터 — 위치 감지는 돌지 않음(가짜 모드는 원탭 그대로, 레인 L2 1절). 화면 초안(L5 · 웹 미리보기)이 볼 수 있게
//   지난 평일 기록(mocks/records)에 "자동 · 지오펜스"로 남은 출발 · 도착을 감지로 돌려줌. 참여 조건 id = mock-<5월 날짜>
//   [아니에요] · 되돌리기 · 귀가 취소는 앱을 다시 열 때까지 메모리에서만 (기록 화면 목업 줄은 그대로). 고친 값 기록은 가짜 db.editLogs에 쌓음
//   (가짜 값을 지난 평일 기록에서 만드는 것은 근거 없음 — 작성자 판단: 기록 화면 목업과 같은 값을 보이려고)
// ---------------------------------------------------------------------------

const MOCK_GEO_SOURCE = '자동 · 지오펜스'; // mocks/records 출처 글자
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
    const isLate = kind === 'ARRIVE' ? label.endsWith('분 지각') : null;
    return [{ participantId: `mock-${p.day}`, kind, at, source: 'LOCATION', settled: isSettled(at, nowMs), isLate }];
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

// [아니에요] 1탭 정정 (D61) — 위치 값만 지움(시각 · 출처 · 지각 판정 · 이동시간 · 그 출발로 셈한 준비 실측 · 기록 화면 위치 줄) + 고친 값 기록 한 줄
//   지금 값이 위치가 아니면(원탭 값 · 이미 지움) 아무것도 안 하고 null. 돌려준 값을 5초 안에 undoReject로 넘기면 되돌림
export async function rejectDetection(input: RejectInput): Promise<RejectSnapshot | null> {
  if (!isMock()) return real.rejectDetection(input);
  const found = mockFind(input.participantId, input.kind);
  if (!found) return null;
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

// 도착 전 귀가 — 위치로 쓴 출발을 지움 (transitions RETRACT_DEPART, L6 안건후보: 집 이탈 약속 붙이기 기본안). 사용자 정정이 아니라 고친 값 기록 없음
//   저장된 출발이 at과 같고 출처가 위치일 때만. 지웠으면 true
export async function retractDeparture(input: { participantId: string; at: Date | number }): Promise<boolean> {
  if (!isMock()) return real.retractDeparture(input);
  const found = mockFind(input.participantId, 'DEPART');
  const atMs = typeof input.at === 'number' ? input.at : input.at.getTime();
  if (!found || found.at.getTime() !== atMs) return false;
  mockVoided.add(mockKey(input.participantId, 'DEPART'));
  return true;
}
