// 목업 시나리오 데이터 — mockup.html의 고정 데이터 · initState를 옮김 (2025년 5월 22일 목요일, 10시 팀 주간회의 예시)
// 화면은 이 폴더를 직접 읽지 않고 features/*/api.ts를 거침. 기능별로 실데이터가 붙으면 그 부분을 지움
// 바꾼 값(알람 켜기 · 권한 등)은 앱을 다시 열 때까지만 남음
import type { Importance, IntensityAxis, Level, Place, RingKind, Transport, UserEditLog, WakePhase } from '@/features/alarm/types';
import type { SuggestionStatus } from '@/features/records/types';
import type { PermissionSet } from '@/features/social/types';

// 2025년 5월 day일 한국 시각 minutes분 (600 = 오전 10:00, 음수면 전날)
export function kst(day: number, minutes: number) {
  return new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
}

export const TODAY = 22; // 시나리오의 오늘 (목요일)

export type MockPerson = { id: string; name: string; short: string; initial: string; handle: string | null };

export const people: Record<string, MockPerson> = {
  me: { id: 'me', name: '나', short: '나', initial: '나', handle: null },
  sy: { id: 'sy', name: '이수연', short: '수연', initial: '수', handle: '@etion' },
  jh: { id: 'jh', name: '김지형', short: '지형', initial: '지', handle: '@vmgfh' },
  js: { id: 'js', name: '전준성', short: '준성', initial: '준', handle: '@jackjs' },
  bj: { id: 'bj', name: '강범준', short: '범준', initial: '범', handle: '@june' },
  mom: { id: 'mom', name: '엄마', short: '엄마', initial: '엄', handle: null },
  dad: { id: 'dad', name: '아빠', short: '아빠', initial: '아', handle: null },
};

// 가짜 장소 검색(place-search)이 거르는 목록 — 서울 대학가 12곳. 주소 · 좌표는 어림값이고 category는 카카오 category_name 모양
//   travelMinutes = 집 기준 이동시간 (가짜 길찾기용, mockTravel). 앞의 4곳은 처음부터 있던 곳
export const places: (Place & { travelMinutes: number })[] = [
  { name: '세종대학교', travelMinutes: 50, address: '서울 광진구 능동로 209', lat: 37.5509, lng: 127.0736, category: '교육,학문 > 대학교' },
  { name: '학교 도서관', travelMinutes: 45, address: '서울 광진구 능동로 209 학술정보원', lat: 37.5502, lng: 127.0742, category: '교육,학문 > 도서관' },
  { name: '강남역 2번출구', travelMinutes: 40, address: '서울 강남구 강남대로 396', lat: 37.4979, lng: 127.0276, category: '교통,수송 > 지하철,전철 > 수도권2호선' },
  { name: '홍대입구역', travelMinutes: 35, address: '서울 마포구 양화로 160', lat: 37.5572, lng: 126.9245, category: '교통,수송 > 지하철,전철 > 수도권2호선' },
  { name: '서울대학교', travelMinutes: 55, address: '서울 관악구 관악로 1', lat: 37.4598, lng: 126.9519, category: '교육,학문 > 대학교' },
  { name: '연세대학교', travelMinutes: 40, address: '서울 서대문구 연세로 50', lat: 37.5658, lng: 126.9386, category: '교육,학문 > 대학교' },
  { name: '고려대학교', travelMinutes: 45, address: '서울 성북구 안암로 145', lat: 37.5894, lng: 127.0323, category: '교육,학문 > 대학교' },
  { name: '한양대학교', travelMinutes: 35, address: '서울 성동구 왕십리로 222', lat: 37.5557, lng: 127.0436, category: '교육,학문 > 대학교' },
  { name: '건국대학교', travelMinutes: 40, address: '서울 광진구 능동로 120', lat: 37.5409, lng: 127.0794, category: '교육,학문 > 대학교' },
  { name: '건대입구역', travelMinutes: 35, address: '서울 광진구 아차산로 243', lat: 37.5404, lng: 127.0692, category: '교통,수송 > 지하철,전철 > 수도권2호선' },
  { name: '신촌역', travelMinutes: 35, address: '서울 서대문구 신촌로 90', lat: 37.5551, lng: 126.9368, category: '교통,수송 > 지하철,전철 > 수도권2호선' },
  { name: '건대 앞 카페', travelMinutes: 40, address: '서울 광진구 능동로 110', lat: 37.5415, lng: 127.0702, category: '음식점 > 카페 > 커피전문점' },
];

// 검색어 없이 장소를 열 때 보이는 "최근에 쓴 곳" — 처음부터 있던 4곳
export const recentMockPlaces = places.slice(0, 4);

// 이동 수단별 이동시간 배율 (대중교통 기준)
export const transportFactor: Partial<Record<Transport, number>> = { TRANSIT: 1, CAR: 0.7, WALK: 1.6 };
// 집이 아닌 곳에서 출발하면 집 기준 이동시간에 곱하는 값 — 시드 일정 a2(세종대학교 → 강남역 20분 = 집 기준 40분의 절반)와 같은 값. 실데이터는 길찾기가 출발 위치로 계산
export const awayFromHomeFactor = 0.5;

export type MockAppointment = {
  id: string;
  seriesId?: string; // 반복 묶음 번호 (appointments.series_id) — 같은 반복의 회차는 같은 값. 없으면 한 번뿐인 일정
  title: string;
  at: Date;
  place: string;
  origin: string;
  transport: Transport;
  travelMinutes: number;
  travelSource: string;
  bufferMinutes: number;
  beforePrepMinutes: number;
  prepMinutes: number;
  predictedPrepMinutes: number;
  importance: Importance;
  recurrenceRule: string | null; // 반복 규칙 RRULE (appointments.recurrence_rule) — 없으면 반복 없음
  groupId: string | null;
  creatorId?: string; // 공동 약속을 만든 사람 (people의 id) — 없으면 나. 만든 사람만 고치고 지울 수 있음 (N6)
  items: string[];
  withWake: boolean;
  // 사용자가 직접 고른 값 (H03 · H05 확인 시트, D42 C) — 있으면 위의 자동 계산값보다 먼저 씀 (강도 intensityOverrides와 같은 규칙)
  //   travelMinutes = 예상 이동, predictedPrepMinutes = 준비 시간(공통 P80 + 개인 보정 대신), times = 알람 시각
  manual?: { travelMinutes?: number; predictedPrepMinutes?: number; times?: Partial<Record<RingKind, Date>> };
  // 만든 알람 종류 (H05 알람 줄 · D46) — 없으면 계산된 알람 전부. 빈 목록 = 알람 없는 일정 (종류를 만들어 두고 끈 것과 다름)
  kinds?: RingKind[];
};

export type MockGroup = { id: string; name: string; initial: string; members: string[]; since: string };

export type MockMemberAlarm = {
  id: string;
  day: number;
  chain: [number, string][]; // [분, 기상 · 준비 · 출발]
  appointmentLabel: string;
  levelName: string;
  note: string;
};

// 그룹원의 5월 22일 하루 [분, 일, 출처]
export const timelines: Record<string, [number, string, string?][]> = {
  sy: [[450, '알람 울림'], [452, '알람 해제'], [455, '기상 확인', '본인 응답'], [458, '준비 시작'], [520, '출발'], [588, '도착']],
  jh: [[440, '알람 울림'], [444, '알람 해제'], [450, '기상 확인', '자동 판정'], [480, '준비 시작'], [530, '출발'], [592, '도착']],
  js: [[530, '알람 울림'], [532, '알람 해제'], [535, '기상 확인', '자동 판정'], [538, '준비 시작'], [565, '출발'], [591, '도착']],
};

export const memberAlarms: Record<string, MockMemberAlarm[]> = {
  sy: [
    { id: 's1', day: 22, chain: [[450, '기상'], [458, '준비'], [520, '출발']], appointmentLabel: '팀 주간회의 · 세종대학교 · 오전 10:00', levelName: '중', note: '준비 70분 · 이동 70분 · 여유 10분' },
    { id: 's2', day: 23, chain: [[520, '기상'], [530, '준비'], [580, '출발']], appointmentLabel: '교양 수업 · 광화문 · 오전 10:30', levelName: '약', note: '준비 60분 · 이동 40분 · 여유 10분' },
  ],
  jh: [
    { id: 'j1', day: 22, chain: [[440, '기상'], [480, '준비'], [530, '출발']], appointmentLabel: '팀 주간회의 · 세종대학교 · 오전 10:00', levelName: '중', note: '준비 90분 · 이동 60분 · 여유 10분' },
  ],
  js: [
    { id: 'k1', day: 22, chain: [[530, '기상'], [538, '준비'], [565, '출발']], appointmentLabel: '팀 주간회의 · 세종대학교 · 오전 10:00', levelName: '강', note: '준비 35분 · 이동 25분 · 여유 10분' },
  ],
};

// 지난 날 기상 기록 (R02 주간) · 일간 기록은 mocks/records.ts

const off = (): PermissionSet => ({ viewAlarm: false, editAlarm: false, viewWake: false });

// 반복 묶음 예시 — 매주 월 · 수 오전 9시 영어 스터디. 서버(alarm-roll)가 앞으로 14일치 회차를 회차마다 새 약속으로 미리 만들어 두는 모양을 흉내 (시나리오 시각 5월 22일 아침부터 4회)
//   day는 5월 기준 일(32 = 6월 1일). 오늘(22일)·내일(23일)에는 회차가 없어 홈 오늘 일정 · 아침 흐름은 그대로
const STUDY_SERIES = 'series-study';
const studyOccurrence = (id: string, day: number): MockAppointment => ({
  id, seriesId: STUDY_SERIES, title: '영어 스터디', at: kst(day, 540), place: '학교 도서관', origin: '집', transport: 'TRANSIT',
  travelMinutes: 45, travelSource: '길찾기', bufferMinutes: 10, beforePrepMinutes: 20, prepMinutes: 20,
  predictedPrepMinutes: 40, importance: 'LOW', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE', groupId: null, items: [], withWake: true,
});

// 바뀌는 값 — api.ts만 읽고 씀
export const db = {
  appointments: [
    {
      id: 'a1', title: '팀 주간회의', at: kst(22, 600), place: '세종대학교', origin: '집', transport: 'TRANSIT',
      travelMinutes: 50, travelSource: '길찾기 + 내 실측 3회', bufferMinutes: 10, beforePrepMinutes: 30, prepMinutes: 20,
      predictedPrepMinutes: 60, importance: 'NORMAL', recurrenceRule: 'FREQ=WEEKLY;BYDAY=TH', groupId: 'cap', items: ['노트북', '회의 자료'], withWake: true,
    },
    {
      id: 'a2', title: '저녁약속', at: kst(22, 1080), place: '강남역 2번출구', origin: '세종대학교', transport: 'TRANSIT',
      travelMinutes: 20, travelSource: '길찾기', bufferMinutes: 5, beforePrepMinutes: 0, prepMinutes: 20,
      predictedPrepMinutes: 25, importance: 'LOW', recurrenceRule: null, groupId: null, items: [], withWake: false,
    },
    {
      id: 'a3', title: '수업', at: kst(23, 540), place: '세종대학교', origin: '집', transport: 'TRANSIT',
      travelMinutes: 50, travelSource: '길찾기 + 내 실측 5회', bufferMinutes: 10, beforePrepMinutes: 10, prepMinutes: 20,
      predictedPrepMinutes: 40, importance: 'NORMAL', recurrenceRule: 'FREQ=WEEKLY;BYDAY=FR', groupId: null, items: ['과제 출력물'], withWake: true,
    },
    {
      // 알람 없는 일정 — 일정은 있고 알람은 처음부터 만들지 않음 (H05에서 알람을 모두 끄고 저장한 것과 같은 모양)
      id: 'a4', title: '치과 예약', at: kst(22, 930), place: '동네 치과', origin: '집', transport: 'TRANSIT',
      travelMinutes: 20, travelSource: '길찾기', bufferMinutes: 10, beforePrepMinutes: 0, prepMinutes: 20,
      predictedPrepMinutes: 25, importance: 'LOW', recurrenceRule: null, groupId: null, items: [], withWake: false, kinds: [],
    },
    studyOccurrence('st1', 26),
    studyOccurrence('st2', 28),
    studyOccurrence('st3', 33),
    studyOccurrence('st4', 35),
  ] as MockAppointment[],
  trash: [] as { batch: number; index: number; appointment: MockAppointment }[], // 지운 일정 (restoreAppointment가 되살림) — 한 번에 지운 것은 같은 batch
  left: [] as MockAppointment[], // 내가 빠진 공동 약속 (leaveSharedAppointment) — 되살리지 않음
  disabledAppointments: new Set<string>(),
  disabledKinds: new Set<string>(), // `${일정 id}:${종류}`
  intensityOverrides: {} as Record<string, Partial<Record<IntensityAxis, Level>>>,
  lateCount4w: 1, // 최근 4주 늦잠 지각
  wakeThetaMinutes: 1, // 기상 판정 기준 θ
  me: { wakeAt: null as Date | null, departAt: null as Date | null, arriveAt: null as Date | null },
  // 지금 진행 중인 기상 판정 (목업 S.wake · S.ring) — 기상 알람 하나만. 홈 · 그룹의 내 상태가 읽음
  wake: {
    alarmId: null as string | null,
    phase: 'idle' as WakePhase,
    ringAt: null as Date | null, // 울린 시각
    dismissedAt: null as Date | null, // 실제로 끈 시각
    usage: 0, // 누적 사용 · 해제 후 10분 (분) — 지금은 시연 값 (목업 S.wake.usage)
    recent: 0, // 최근 사용 · 뒤쪽 5분 (분)
  },
  wakeConfirmations: {} as Record<string, { at: Date; how: 'self' | 'auto'; usage: number; recent: number }>, // 알람 id별 기상 확정 (그때 사용 시간 포함)
  snoozes: {} as Record<string, { at: Date; minutes: number }>, // 미룬 알람 id별 다시 울릴 시각 (H07 미루기 → H01 표시 · 취소)
  snoozeCounts: {} as Record<string, number>, // 알람 id별 이미 미룬 횟수 (한도 3번, D3 기본안 A) — 다시 울려도 해제하기 전까지 남음
  events: [] as { at: Date; label: string; source: string }[], // 오늘 실제로 일어난 일
  editLogs: [] as UserEditLog[], // 사용자가 자동 값을 직접 고친 기록 (user_edit_logs) — 개인화에 쓸 자료
  journalWritten: false,
  todos: [
    { id: 't1', title: '노트북', day: 22, done: true },
    { id: 't2', title: '회의 자료', day: 22, done: false },
    { id: 't3', title: '과제 출력물', day: 23, done: false },
  ],
  morningRoutine: { id: 'r1', title: '차분한 출근 준비', steps: ['물 마시기', '스트레칭', '샤워', '출발'], done: 0 },
  friends: ['sy', 'jh', 'js'],
  requests: ['bj'],
  groups: {
    cap: { id: 'cap', name: '캡스톤팀', initial: '캡', members: ['me', 'sy', 'jh', 'js'], since: '2025년 3월부터 함께하는 중' },
    fam: { id: 'fam', name: '우리 가족', initial: '가족', members: ['me', 'mom', 'dad'], since: '2023년 1월부터 함께하는 중' },
  } as Record<string, MockGroup>,
  // 내가 준 권한
  grants: {
    friend: {
      sy: { viewAlarm: true, editAlarm: true, viewWake: false },
      jh: off(),
      js: off(),
    } as Record<string, PermissionSet>,
    group: {
      cap: { viewAlarm: true, editAlarm: false, viewWake: true },
      fam: off(),
    } as Record<string, PermissionSet>,
  },
  // 내가 받은 권한 (사람별 · 관계별)
  received: {
    sy: [
      { source: '친구', sourceType: 'FRIEND', sourceId: 'sy', viewAlarm: true, editAlarm: true, viewWake: false },
      { source: '캡스톤팀', sourceType: 'GROUP', sourceId: 'cap', viewAlarm: true, editAlarm: false, viewWake: true },
    ],
    jh: [{ source: '캡스톤팀', sourceType: 'GROUP', sourceId: 'cap', viewAlarm: true, editAlarm: false, viewWake: true }],
    js: [{ source: '캡스톤팀', sourceType: 'GROUP', sourceId: 'cap', viewAlarm: false, editAlarm: false, viewWake: true }],
  } as Record<string, (PermissionSet & { source: string; sourceType: 'FRIEND' | 'GROUP'; sourceId: string })[]>,
  sharedAlarms: {} as Record<string, { on: boolean; shift: number }>, // 공유받은 알람을 내가 바꾼 값
  shareLog: [] as { at: Date; text: string }[],
  suggestion: { id: 's1', appointmentId: 'a3', minutes: 10, status: 'PENDING' as SuggestionStatus, appliedMinutes: 0 },
};
