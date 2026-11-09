// 로컬 스택이 잠깐 바쁠 때 나는 네트워크 오류('fetch failed')는 세 번까지 다시 시도함 — 서버 결함이 아니라 도구 환경 문제로 가려 "이상 결과"로 안 세게.
// 응답이 온 오류(4xx · 5xx)는 그대로 돌려줌.
export async function retryFetch(input, init) {
  let last;
  for (let i = 0; i < 4; i += 1) {
    try {
      return await fetch(input, init);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last;
}
