// 시간표 사진 읽기 호출 — 가짜 데이터 모드는 미리 정한 시간표를, 실데이터는 서버 함수 timetable-extract(Claude가 사진을 읽음, 앱에 키 없음)를 부름
// 사진은 서버에서 읽고 바로 버려짐(저장 안 함). 앱도 base64를 이 호출 밖에 두지 않음
import { callEdge } from '@/lib/edge';
import { isMock } from '@/lib/mode';

import { extractBody, photoFailure, toBatch, type ExtractResponse, type PickedPhoto } from './photo';
import type { ImportBatch } from './timetableImport';

// 서버 마감 28초 — 앱은 그보다 길게 기다림 (lib/edge 기본 20초로는 모자람)
const EXTRACT_TIMEOUT_MS = 35_000;

// 가짜 데이터 모드의 읽은 결과 — 에브리타임식 시간표 한 장
const MOCK_RESPONSE: ExtractResponse = {
  confidence: 'HIGH',
  rows: [
    { title: '자료구조', weekdays: ['월', '수'], start: '10:30', end: '12:00', place: '공학관 301' },
    { title: '운영체제', weekdays: ['화', '목'], start: '13:00', end: '14:30', place: '정보관 B102' },
    { title: '캡스톤디자인', weekdays: ['금'], start: '09:00', end: '11:50', place: null },
  ],
};

export async function extractTimetable(photo: PickedPhoto): Promise<ImportBatch> {
  if (isMock()) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return toBatch(MOCK_RESPONSE);
  }
  try {
    const res = await callEdge<ExtractResponse>('timetable-extract', extractBody(photo), { timeoutMs: EXTRACT_TIMEOUT_MS });
    return toBatch(res);
  } catch (e) {
    throw photoFailure(e);
  }
}
