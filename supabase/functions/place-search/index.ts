// place-search — 장소 검색 (카카오 로컬 키워드 검색). H05 도착지 · 출발지 · 온보딩 집 검색
//   입력: { query, lat?, lng?, limit? }  (정확도순 — lat · lng는 가까운 쪽으로 치우치게만 쓰고, "…역"이면 지하철역이 맨 위, 같은 이름 지점은 가까운 순)
//   응답: { places: [{ id, name, address, lat, lng, category? }] } — 결과가 없으면 빈 배열 (재검색 유도, 8장 8.2.2)
//   KAKAO_REST_API_KEY가 없으면 NOT_CONFIGURED(503). 응답은 저장하지 않음 (카카오 약관)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { KakaoError, searchPlaces } from '../_shared/kakao.ts';
import { Reader, readJson } from '../_shared/read.ts';

Deno.serve(
  serve(async (req) => {
    await requireUser(req);
    const root = Reader.root(await readJson(req));
    const query = root.string('query', { required: true, min: 1, max: 100 });
    const lat = root.number('lat', { min: -90, max: 90 });
    const lng = root.number('lng', { min: -180, max: 180 });
    const limit = root.int('limit', { min: 1, max: 15 });
    if ((lat == null) !== (lng == null)) root.problemAt(lat == null ? 'lat' : 'lng', 'lat · lng는 같이 있어야 해요');
    root.finish();

    const key = getEnv('KAKAO_REST_API_KEY');
    if (!key) throw new HttpError('NOT_CONFIGURED', '장소 검색 키가 아직 설정되지 않았어요');

    try {
      const places = await searchPlaces(key, {
        query: query as string,
        ...(lat != null && lng != null ? { near: { lat, lng } } : {}),
        size: limit ?? 10,
      });
      return jsonResponse({ places });
    } catch (e) {
      if (e instanceof KakaoError) {
        // 401/403 = 키가 틀렸거나 카카오맵(로컬) 사용 설정이 꺼져 있음 → 설정 문제
        if (e.kind === 'AUTH') throw new HttpError('NOT_CONFIGURED', '장소 검색 키가 맞지 않거나 카카오 로컬 사용 설정이 꺼져 있어요');
        if (e.kind === 'RATE_LIMIT') throw new HttpError('RATE_LIMITED', '잠시 후 다시 검색해 주세요');
        throw new HttpError('PLACE_UNAVAILABLE', '장소 검색을 지금은 쓸 수 없어요. 잠시 후 다시 시도해 주세요');
      }
      throw e;
    }
  }),
);
