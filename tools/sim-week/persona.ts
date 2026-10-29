// 가상 유저의 세계 — ai-lab 캐릭터(p01~p08 dev) 한 사람의 한 주를 읽어 "진짜 일어나는 일"의 재료를 만든다.
//   data/personas.json (기본 필드) + data/timelines.json (같은 사람의 7일 일정) + data/personas-v3.json (말투 · 습관 · 이동 사정)
//   앱은 이 세계를 직접 못 보고, 대화와 기록(L1 · L2)으로만 앎. 이 파일은 읽기만 함 — 계산은 l1.ts / day.ts / location.ts.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { calc, geoArea } from './bridge.ts';
import { addDaysKey, kstDate, weekdayOf } from './time.ts';
import { hashOf } from './rng.ts';
import type { Importance, Persona, Place, SituationId, Transport, WorldAppt, WorldDay } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = <T>(file: string): T => JSON.parse(readFileSync(resolve(HERE, 'data', file), 'utf8')) as T;

type TimelineDay = {
  persona_id: string;
  day_index: number;
  date: string;
  weekday: string;
  appointments: { ref: string; title: string; date: string; time: string; place: string; importance: Importance | null; importance_confirmed: boolean; transport: Transport; travel_minutes: number; repeat: 'NONE' | 'WEEKLY' }[];
  wake: { date: string; time: string };
  [k: string]: unknown;
};

let cache: { personas: Persona[]; timelines: Record<string, TimelineDay[]> } | null = null;

function load() {
  if (cache) return cache;
  const base = readJson<Persona[]>('personas.json');
  const v3 = readJson<Record<string, unknown>[]>('personas-v3.json');
  const personas = base.map((p) => {
    const extra = v3.find((x) => x.id === p.id) as { speech?: Persona['speech']; flow?: Persona['flow'] } | undefined;
    return { ...p, speech: extra?.speech, flow: extra?.flow } as Persona;
  });
  cache = { personas, timelines: readJson<Record<string, TimelineDay[]>>('timelines.json') };
  return cache;
}

export const PERSONA_IDS = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08'] as const;

export function loadPersonas(ids?: readonly string[]): Persona[] {
  const { personas } = load();
  const want = ids && ids.length ? ids : PERSONA_IDS;
  return want.map((id) => {
    if (/^p(09|1[0-2])$/.test(id)) throw new Error(`${id}는 시험용 사람이라 호출 금지 (ai-lab 규칙)`);
    const found = personas.find((p) => p.id === id);
    if (!found) throw new Error(`모르는 사람: ${id}`);
    return found;
  });
}

export const DAYS = 7;

// 일정에 붙는 말(준비물): 이름 규칙으로 정함 — 가상 사용자가 "준비물"을 물으면 말하는 사실
export function itemsFor(title: string): string[] {
  if (/(시험|중간고사|기말)/.test(title)) return ['학생증', '컴퓨터용 사인펜'];
  if (/(면접)/.test(title)) return ['자기소개서 출력본'];
  if (/(실습)/.test(title)) return ['실습복', '명찰'];
  if (/(크리틱|발표)/.test(title)) return ['작업물 출력본'];
  return [];
}

// ---------------------------------------------------------------------------
// 장소 — 좌표 · 분류. 카카오를 못 부르므로 시험이 만든 좌표 (집에서 "카카오 대역 분 수"만큼 떨어진 곳)
// ---------------------------------------------------------------------------

const HOME_BASE = { lat: 37.5, lng: 126.9 };

export function homeOf(p: Persona): Place {
  const i = PERSONA_IDS.indexOf(p.id as (typeof PERSONA_IDS)[number]);
  return { name: '집', lat: HOME_BASE.lat + 0.02 * i, lng: HOME_BASE.lng + 0.02 * i, category: null, kind: 'UNKNOWN', radiusM: 200 };
}

// 길찾기(카카오)가 줄 법한 분 수 — v3 인물 카드의 api_estimate_min (평소보다 짧게 나오는 사정이 적혀 있음), 없으면 평소 이동
export function kakaoMinutes(p: Persona): number {
  return p.flow?.travel?.api_estimate_min ?? p.travel_minutes;
}

const SCHOOL = '한빛대학교';

// 이름으로 카카오 분류 흉내 — 장소 검색 결과의 category_name 모양 ("교육,학문 > 학교 > 대학교")
export function categoryFor(placeName: string): string {
  if (/카페|스터디카페/.test(placeName)) return '음식점 > 카페';
  if (/병원/.test(placeName)) return '의료,건강 > 병원 > 종합병원';
  if (/역\b/.test(placeName) && !/카페/.test(placeName)) return '교통,수송 > 지하철,전철 > 수도권3호선';
  if (/편의점/.test(placeName)) return '가정,생활 > 편의점';
  return '교육,학문 > 학교 > 대학교'; // 학교 안 건물
}

function offset(from: { lat: number; lng: number }, distM: number, bearingDeg: number) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / 111_320;
  const dLng = (distM * Math.sin(rad)) / (111_320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

// 장소 하나를 세계에 놓음. nominalMinutes = 앱이 좌표 거리로 근사할 때 나오는 분 (= estimateTravelMinutes 와 같게 거리를 역산)
export function placeAt(p: Persona, name: string, transport: Transport, nominalMinutes: number, opts: { distanceM?: number; asCampus?: boolean } = {}): Place {
  const home = homeOf(p);
  const speed = (calc.AVERAGE_SPEED_KMH as Record<Transport, number>)[transport];
  const distKm = (nominalMinutes / (60 * calc.DETOUR_FACTOR)) * speed;
  const distM = opts.distanceM ?? Math.round(distKm * 1000);
  const bearing = hashOf(p.id, name) % 360;
  const pos = offset(home, distM, bearing);
  const category = opts.asCampus ? '교육,학문 > 학교 > 대학교' : categoryFor(name);
  const fullName = opts.asCampus ? SCHOOL : /대학교/.test(category) ? `${SCHOOL} ${name}` : name;
  const kind = geoArea.placeKind({ name: fullName, category });
  return { name: fullName, shortName: opts.asCampus ? SCHOOL : name, lat: pos.lat, lng: pos.lng, category, kind, radiusM: geoArea.defaultRadiusFor(category, fullName) };
}

// ---------------------------------------------------------------------------
// 섞을 위치 상황 — 사람 × 날 (README 표). 이 표가 곧 시험 설계: 6종이 한 주에 모두 나오게 흩뿌림
// ---------------------------------------------------------------------------

// 인덱스 0=월 … 6=일
const PLAN: Record<string, Partial<Record<number, SituationId>>> = {
  p01: { 0: 'CAMPUS', 1: 'JOG', 2: 'CONVENIENCE', 3: 'RETURN', 4: 'SUBWAY_DUP' },
  p02: { 2: 'CONVENIENCE', 3: 'RETURN', 4: 'JOG' }, // 화(1)는 기숙사 → 공학관이 걸어서 400m대라 원래 "500m 안 약속" (주입 아님)
  p03: { 0: 'SUBWAY_DUP', 2: 'CAMPUS', 3: 'RETURN', 5: 'CONVENIENCE' },
  p04: { 0: 'JOG', 2: 'NEAR', 3: 'CONVENIENCE', 4: 'RETURN' },
  p05: { 0: 'CONVENIENCE', 1: 'JOG', 2: 'RETURN', 3: 'SUBWAY_DUP' },
  p06: { 0: 'CONVENIENCE', 1: 'NEAR', 2: 'JOG', 3: 'CAMPUS', 4: 'RETURN' },
  p07: { 1: 'JOG', 2: 'CONVENIENCE', 3: 'RETURN' },
  p08: { 0: 'CAMPUS', 1: 'SUBWAY_DUP', 2: 'JOG', 3: 'CONVENIENCE', 4: 'NEAR' },
};

export const situationOf = (personaId: string, dayIndex: number): SituationId | null => PLAN[personaId]?.[dayIndex] ?? null;
export const SITUATIONS: readonly SituationId[] = ['CONVENIENCE', 'JOG', 'RETURN', 'NEAR', 'CAMPUS', 'SUBWAY_DUP'];

// ---------------------------------------------------------------------------
// 하루
// ---------------------------------------------------------------------------

// 사람의 평소 기상 (알람이 없는 날 · 알람이 없어서 못 맞춘 날) — 인물 카드의 chronotype
function lazyWake(p: Persona): string {
  return p.chronotype === 'LATE' ? '10:30' : p.chronotype === 'EARLY' ? '07:10' : '08:50';
}

export function worldDay(p: Persona, dayIndex: number): WorldDay {
  const { timelines } = load();
  const tl = timelines[p.id]?.[dayIndex];
  if (!tl) throw new Error(`${p.id} ${dayIndex + 1}일차 일정이 없음 (1~${DAYS})`);
  const home = homeOf(p);
  const situation = situationOf(p.id, dayIndex);
  const weekday = weekdayOf(tl.date);

  const appts: WorldAppt[] = tl.appointments.map((a, i) => {
    const campus = situation === 'CAMPUS' && i === 0;
    const place = placeAt(p, a.place, a.transport, kakaoMinutes(p) * (a.travel_minutes / p.travel_minutes), { asCampus: campus });
    return {
      id: `${p.id}-d${dayIndex + 1}-a${i + 1}`,
      day: dayIndex + 1,
      date: a.date,
      time: a.time,
      at: kstDate(a.date, a.time),
      title: a.title,
      place,
      importance: a.importance,
      transport: a.transport,
      travelMinutes: a.travel_minutes, // 진짜 평소 이동 (실측 기준)
      repeat: a.repeat,
      buildingOffsetM: campus ? 450 : 0, // 대표 위치에서 실제 건물까지 걸어야 하는 거리 (CAMPUS 상황)
      synthetic: false,
    };
  });

  // 500m 안 약속 — 집앞 스터디카페 (시험이 만든 일정, 표에 표시됨)
  if (situation === 'NEAR') {
    const at = kstDate(tl.date, '20:00');
    appts.push({
      id: `${p.id}-d${dayIndex + 1}-a${appts.length + 1}`,
      day: dayIndex + 1,
      date: tl.date,
      time: '20:00',
      at,
      title: '동네 스터디카페 공부',
      place: placeAt(p, '집앞 스터디카페', 'WALK', 5, { distanceM: 380 }),
      importance: 'LOW',
      transport: 'WALK',
      travelMinutes: 6,
      repeat: 'NONE',
      buildingOffsetM: 0,
      synthetic: true,
    });
  }
  appts.sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    personaId: p.id,
    day: dayIndex + 1,
    date: tl.date,
    weekday,
    appts,
    home,
    situation,
    naturalWake: kstDate(tl.date, tl.appointments.length === 0 ? tl.wake.time : lazyWake(p)),
    labWake: tl.wake.time,
  };
}

// 요일별로 더 걸리는 준비 (recurring_reasons) — 대화에서 알려 주기 전까지 앱은 모르는 "진짜 사정"
export function extraPrep(p: Persona, weekday: string): { minutes: number; tags: string[] } {
  const tags: string[] = [];
  let minutes = 0;
  for (const r of p.recurring_reasons) {
    if (r.weekdays.includes(weekday)) {
      minutes += r.extra_minutes;
      tags.push(r.tag);
    }
  }
  return { minutes, tags };
}

export { addDaysKey };
