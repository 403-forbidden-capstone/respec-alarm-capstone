// ④ 지난 날 기록 목업 (R02 주간 · 일간, A03 일기) — 가짜 데이터
// 오늘(5월 22일)의 기록은 db가 들고(기상 확인 · 알람 해제 같은 일이 쌓임), 그 앞날은 여기 고정값
// 규칙은 features/records/api.ts의 markOf와 맞춤: 지난 평일은 기록 완료(알람 → 기상 확인 → 출발 → 도착), 주말은 일부 기록(직접 입력 한 줄)
// 화면은 이 파일을 직접 읽지 않고 features/records/api.ts를 거침. 실데이터는 daily_records · alarm_events를 날짜로 읽음 (#41)
import { dateParts } from '@/lib/format';

import { TODAY } from './data';

export type PastDay = {
  day: number; // 2025년 5월 day일
  wake: number | null; // 기상 확인 시각 (0시부터 분) — 주간 평균 기상. 없으면 null
  score: number | null; // 그날 실행 점수 — 주간 막대. 점수식은 D26(열림)이라 목업 값 그대로
  appointment: { title: string; place: string; at: number } | null; // 그날 아침 약속 (at = 0시부터 분)
  planned: [number, string][]; // 설정한 알람 [분, 이름]
  actual: [number, string, string][]; // 실제로 일어난 일 [분, 일, 출처]
};

// 지난 평일은 모두 9시 수업 — 이동 50분 + 여유 10분이라 8시 출발, 도착 목표는 약속 10분 전
const CLASS = { title: '수업', place: '세종대학교', at: 540 };
const DEPART = CLASS.at - 60;

// 평일 하루 — 기상 알람(분) · 기상 확인(분) · 점수 · 지각 분(점수가 낮은 날)
function weekday(day: number, alarm: number, woke: number, score: number, late = 0): PastDay {
  return {
    day,
    wake: woke,
    score,
    appointment: CLASS,
    planned: [
      [alarm, '기상 알람'],
      [alarm + 10, '준비 알람'],
      [DEPART, '출발 알람'],
      [CLASS.at - 10, '도착 목표'],
    ],
    actual: [
      [alarm, '기상 알람 울림', '자동'],
      [alarm + 3, '기상 알람 해제', '자동'],
      [woke, '기상 확인', '자동 판정'],
      [DEPART + (late ? 8 : 2), '집 출발', '자동 · 지오펜스'],
      late ? [CLASS.at + late, `도착 · ${late}분 지각`, '자동 · 지오펜스'] : [CLASS.at - 8, '도착 · 지각 아님', '자동 · 지오펜스'],
    ],
  };
}

// 주말 하루 — 알람 없이 저녁에 직접 입력한 한 줄만 (일부 기록)
function weekend(day: number, at: number, label: string): PastDay {
  return { day, wake: null, score: null, appointment: null, planned: [], actual: [[at, label, '직접 입력']] };
}

// 5월 1~21일. 5월 19~21일은 예전 목업(지난 사흘) 값 그대로 — 5월 12~16일 평균 기상 오전 7:33(453분)이 "지난주" 비교 기준
const PAST_DAYS: PastDay[] = [
  weekday(1, 435, 449, 81),
  weekday(2, 435, 446, 77),
  weekend(3, 1260, '준비물 저장 · 운동복'),
  weekend(4, 1230, '일정 저장 · 스터디'),
  weekday(5, 435, 455, 71),
  weekday(6, 435, 441, 88),
  weekday(7, 440, 452, 79),
  weekday(8, 435, 447, 85),
  weekday(9, 440, 459, 66, 4),
  weekend(10, 1275, '준비물 저장 · 노트북'),
  weekend(11, 1240, '일정 저장 · 도서관 스터디'),
  weekday(12, 435, 460, 82),
  weekday(13, 435, 449, 68, 3),
  weekday(14, 440, 458, 79),
  weekday(15, 435, 447, 90),
  weekday(16, 440, 451, 74),
  weekend(17, 1250, '준비물 저장 · 과제 출력물'),
  weekend(18, 1235, '일정 저장 · 스터디'),
  weekday(19, 435, 451, 76),
  weekday(20, 435, 440, 92),
  weekday(21, 435, 444, 84),
];

// date의 지난 날 기록 — 오늘 · 앞날 · 목업에 없는 달은 null
export function pastDay(date: Date): PastDay | null {
  const { year, month, day } = dateParts(date);
  if (year !== 2025 || month !== 5 || day >= TODAY) return null;
  return PAST_DAYS.find((d) => d.day === day) ?? null;
}
