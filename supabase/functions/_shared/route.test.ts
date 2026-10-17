// 이동시간 폴백 순서 — 7장 7.1.2
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TravelSample } from './calc/travel.ts';
import { KakaoError } from './kakao.ts';
import { resolveAutoTravel, resolveTravel, type TravelDeps } from './route.ts';

const ORIGIN = { lat: 37.5547, lng: 126.9707 };
const DEST = { lat: 37.4979, lng: 127.0276 };
const args = { origin: ORIGIN, destination: DEST, transport: 'TRANSIT' as const };

const sample = (minutes: number): TravelSample => ({
  origin: ORIGIN,
  destination: DEST,
  transport: 'TRANSIT',
  departedAt: new Date('2026-10-01T00:00:00Z'),
  arrivedAt: new Date(Date.parse('2026-10-01T00:00:00Z') + minutes * 60_000),
});

const kakaoOk: TravelDeps['kakao'] = async () => ({ minutes: 38, partial: false });
const kakaoFail: TravelDeps['kakao'] = async () => {
  throw new KakaoError('TIMEOUT', 'late');
};

test('1 카카오가 되면 API', async () => {
  const r = await resolveAutoTravel(args, { kakao: kakaoOk, samples: async () => [sample(40), sample(41), sample(42)] });
  assert.deepEqual(r.choice, { minutes: 38, source: 'API', needsConfirmation: false, note: '길찾기 기준' });
  assert.deepEqual(r.warnings, []);
});

test('카카오가 일부 구간만 줬으면 API + 경고', async () => {
  const r = await resolveAutoTravel(args, { kakao: async () => ({ minutes: 30, partial: true }) });
  assert.equal(r.choice?.source, 'API');
  assert.equal(r.warnings[0].code, 'KAKAO_PARTIAL');
});

test('2 카카오 실패 + 같은 경로 실측 3건 이상 → CACHED 중앙값 (표시용, 저장은 안 함)', async () => {
  const r = await resolveAutoTravel(args, { kakao: kakaoFail, samples: async () => [sample(40), sample(50), sample(45)] });
  assert.equal(r.choice?.source, 'CACHED');
  assert.equal(r.choice?.minutes, 45);
  assert.equal(r.choice?.sampleCount, 3);
  assert.deepEqual(r.warnings.map((w) => [w.code, w.detail]), [['KAKAO_FAILED', 'TIMEOUT']]);
});

test('키가 없으면 경고만 남기고 다음 단계로 (F10)', async () => {
  const r = await resolveAutoTravel(args, { samples: async () => [sample(40), sample(50), sample(45)] });
  assert.equal(r.choice?.source, 'CACHED');
  assert.equal(r.warnings[0].code, 'KAKAO_NOT_CONFIGURED');
});

test('3 실측 부족 → 직선거리 근사값, 사용자 확인 필수', async () => {
  const r = await resolveAutoTravel(args, { kakao: kakaoFail, samples: async () => [sample(40)] });
  assert.equal(r.choice?.source, 'ESTIMATE');
  assert.equal(r.choice?.needsConfirmation, true);
  assert.ok((r.choice?.minutes ?? 0) > 20 && (r.choice?.minutes ?? 99) < 50);
});

test('기록을 못 읽어도 근사값으로', async () => {
  const r = await resolveAutoTravel(args, {
    samples: async () => {
      throw new Error('db down');
    },
  });
  assert.equal(r.choice?.source, 'ESTIMATE');
});

test('좌표가 없으면 길이 없음 (null) — 직접 입력해야 함', async () => {
  const r = await resolveAutoTravel({ transport: 'TRANSIT', destination: DEST }, { kakao: kakaoOk });
  assert.equal(r.choice, null);
  assert.equal(r.warnings[0].code, 'NO_COORDINATES');
});

test('4 직접 입력은 MANUAL로 먼저, 호출 없이 (미리 보기가 아니면 자동 값은 구하지 않음)', async () => {
  let calls = 0;
  const kakao: TravelDeps['kakao'] = async () => {
    calls++;
    return { minutes: 38, partial: false };
  };
  const r = await resolveTravel({ ...args, override: 70 }, { kakao });
  assert.deepEqual(r.chosen, { minutes: 70, source: 'MANUAL', needsConfirmation: false, note: '직접 입력' });
  assert.equal(r.auto, null);
  assert.equal(calls, 0);

  const preview = await resolveTravel({ ...args, override: 70 }, { kakao }, { wantAuto: true });
  assert.equal(preview.chosen?.minutes, 70);
  assert.equal(preview.auto?.minutes, 38); // "자동으로 되돌리면" 이 값
  assert.equal(calls, 1);
});

test('직접 입력은 좌표가 없어도 됨', async () => {
  const r = await resolveTravel({ transport: 'WALK', override: 15 }, {});
  assert.equal(r.chosen?.source, 'MANUAL');
});
