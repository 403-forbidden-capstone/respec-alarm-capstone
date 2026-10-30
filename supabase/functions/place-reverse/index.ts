// place-reverse — 지도 핀 좌표 → 주소 (카카오 로컬 coord2address). 지도에서 핀을 옮겨 도착지 · 출발지를 정할 때
//   입력: { lat, lng }  (둘 다 필수)
//   응답: { place: { address, roadAddress, buildingName } | null } — 도로명이 있으면 address도 도로명. 바다 · 국외 등 주소가 없으면 place: null
//   KAKAO_REST_API_KEY가 없으면 NOT_CONFIGURED(503). 응답은 저장하지 않고 좌표도 로그에 남기지 않음 (카카오 약관)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { KakaoError, reverseAddress } from '../_shared/kakao.ts';
import { Reader, readJson } from '../_shared/read.ts';

Deno.serve(
  serve(async (req) => {
    await requireUser(req);
    const root = Reader.root(await readJson(req));
    const lat = root.number('lat', { required: true, min: -90, max: 90 });
    const lng = root.number('lng', { required: true, min: -180, max: 180 });
    root.finish();

    const key = getEnv('KAKAO_REST_API_KEY');
    if (!key) throw new HttpError('NOT_CONFIGURED', '주소 조회 키가 아직 설정되지 않았어요');

    try {
      const place = await reverseAddress(key, { lat: lat as number, lng: lng as number });
      return jsonResponse({ place });
    } catch (e) {
      if (e instanceof KakaoError) {
        // 401/403 = 키가 틀렸거나 카카오맵(로컬) 사용 설정이 꺼져 있음 → 설정 문제
        if (e.kind === 'AUTH') throw new HttpError('NOT_CONFIGURED', '주소 조회 키가 맞지 않거나 카카오 로컬 사용 설정이 꺼져 있어요');
        if (e.kind === 'RATE_LIMIT') throw new HttpError('RATE_LIMITED', '잠시 후 다시 시도해 주세요');
        throw new HttpError('PLACE_UNAVAILABLE', '주소를 지금은 불러올 수 없어요. 잠시 후 다시 시도해 주세요');
      }
      throw e;
    }
  }),
);
