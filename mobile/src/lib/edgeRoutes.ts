// 서버 전환 스위치 — callEdge가 함수마다 "Edge로 부를지, 우리 서버(FastAPI)로 부를지" 정하는 데 쓰는 것 (M2, 완결점 1-9)
//
// 스위치는 두 겹:
//   1) 서버 주소는 앱 빌드에 고정 — EXPO_PUBLIC_API_BASE_URL (https · origin 하나만). 없거나 모양이 틀리면 서버를 아예 안 씀
//      → DB 표가 잘못 바뀌어도 로그인 토큰이 남의 주소로 가지 않음 (표는 edge / server만 고름)
//   2) 함수별 길은 DB 표 server_routes → RPC get_server_routes()가 "나에게 적용되는 값"(edge · server)만 돌려줌
//      (canary = 지정한 계정만 server — RPC가 풀어서 주므로 앱은 edge · server만 봄)
//
// 안전 쪽으로만 기울게:
//   · 표를 못 읽으면(오류 · 모양이 이상함 · 3초 넘게 걸림) 전부 edge. 옛 값도 안 씀 (표를 server로 두고 되돌리려는 사람이 있는데 낡은 값으로 server를 부르면 안 됨)
//   · 로그인이 없으면 edge (표는 로그인한 사람만 읽을 수 있고, 서버도 토큰이 있어야 받음)
//   · 읽는 데 성공하면 5분, 실패하면 30초 동안 그 결과를 씀 (실패할 때마다 매 호출이 기다리지 않게). 사용자가 바뀌면 바로 다시 읽음
//
// 차단기: 서버가 연속 3번 못 쓸 상태(edge.ts의 serverUnusable: 네트워크 · 시간 초과 · 서버 오류 · 서버 설정 안 됨 · AUTH_UNAVAILABLE, 읽기 함수는 경로 없음 404 · 405도)로
//   답하면 5분 동안 읽기 함수는 서버를 건너뛰고 바로 Edge. 5분이 지나면 **한 건만** 서버로 시험해 보내고(나머지는 그 결과가 나올 때까지 Edge),
//   성공하면 풀리고 실패하면 바로 다시 5분. (읽기 함수 판단 · 실제 대체는 edge.ts)
import { supabase } from './supabase';

export type RouteMode = 'edge' | 'server';

const ROUTES_TTL_MS = 5 * 60_000;
const ROUTES_FAILURE_TTL_MS = 30_000;
const ROUTES_TIMEOUT_MS = 3_000;

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5 * 60_000;
const BREAKER_PROBE_MS = 10_000; // 시험 한 건이 결과를 기록하지 못해도(예외 등) 이 시간 뒤에는 다음 한 건이 시험

// 서버 주소 — https · origin만 (경로 · 쿼리 · 해시 · 사용자 정보가 붙으면 안 씀). 끝의 / 는 뺌
export function serverBaseUrl(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  return url.origin;
}

// ---------- 함수별 길 (표) ----------

type RouteCache = { userId: string; at: number; ttl: number; modes: Map<string, RouteMode> };
let cache: RouteCache | null = null;
let loading: { userId: string; promise: Promise<RouteCache> } | null = null;

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readRoutes(): Promise<Map<string, RouteMode>> {
  const { data, error } = await supabase.rpc('get_server_routes');
  if (error || !Array.isArray(data)) throw new Error('get_server_routes');
  const modes = new Map<string, RouteMode>();
  // 'server'만 server — 그 밖의 값(edge · 모르는 값)은 표에 없는 것과 같이 edge
  for (const row of data) if (row && typeof row.name === 'string' && row.mode === 'server') modes.set(row.name, 'server');
  return modes;
}

async function loadRoutes(userId: string): Promise<RouteCache> {
  try {
    return { userId, at: Date.now(), ttl: ROUTES_TTL_MS, modes: await withTimeout(readRoutes(), ROUTES_TIMEOUT_MS) };
  } catch {
    return { userId, at: Date.now(), ttl: ROUTES_FAILURE_TTL_MS, modes: new Map() }; // 못 읽으면 전부 edge
  }
}

export async function routeFor(name: string): Promise<RouteMode> {
  if (!serverBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL)) return 'edge';
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id;
    if (!userId) return 'edge';
    let current = cache;
    if (!current || current.userId !== userId || Date.now() - current.at >= current.ttl) {
      if (!loading || loading.userId !== userId) {
        const promise: Promise<RouteCache> = loadRoutes(userId)
          .then((loaded) => {
            // 그 사이 다른 사용자가 읽기를 시작했다면(loading이 바뀜) 늦게 끝난 이 결과는 캐시에 쓰지 않음 — 새 사용자의 캐시를 덮어쓰지 않게
            if (loading?.promise === promise) cache = loaded;
            return loaded;
          })
          .finally(() => {
            if (loading?.promise === promise) loading = null;
          });
        loading = { userId, promise };
      }
      current = await loading.promise; // 동시에 여러 호출이 와도 표는 한 번만 읽음
    }
    return current.modes.get(name) ?? 'edge';
  } catch {
    return 'edge';
  }
}

// ---------- 차단기 ----------

let failures = 0;
let openUntil = 0;

// 지금 열려 있는지(읽기만). 5분이 지나면 닫힌 것으로 보임 — 시험 호출을 보낼지는 claimServerAttempt가 정함
export function breakerOpen(): boolean {
  return failures >= BREAKER_THRESHOLD && Date.now() < openUntil;
}

// 읽기 함수가 서버로 가도 되는지. 닫혀 있으면 모두 통과, 열려 있으면 막음,
// 5분이 지났으면 첫 한 건만 통과(시험)시키고 그 결과가 기록될 때까지(또는 10초) 나머지는 막음
export function claimServerAttempt(): boolean {
  if (failures < BREAKER_THRESHOLD) return true;
  const now = Date.now();
  if (now < openUntil) return false;
  openUntil = now + BREAKER_PROBE_MS;
  return true;
}

export function recordServerSuccess(): void {
  failures = 0;
  openUntil = 0;
}

// 연속 실패 횟수를 세어 임계값에 닿으면 5분 동안 염. 시험 한 건이 실패하면 횟수가 이미 임계값 이상이라 바로 다시 5분.
// 닫혀 있다가 열린 순간(또는 시험이 실패해 다시 열린 순간)에만 true — 호출하는 쪽이 로그를 한 번만 남기게
export function recordServerFailure(): boolean {
  const wasOpen = breakerOpen();
  failures += 1;
  if (failures < BREAKER_THRESHOLD) return false;
  const probing = failures > BREAKER_THRESHOLD && wasOpen && openUntil - Date.now() <= BREAKER_PROBE_MS;
  openUntil = Date.now() + BREAKER_OPEN_MS;
  return !wasOpen || probing;
}

// 시험 때 상태를 처음으로
export function resetEdgeRoutes(): void {
  cache = null;
  loading = null;
  failures = 0;
  openUntil = 0;
}
