# 모듈 의존 그래프

`mobile/src` 안 파일들이 서로 무엇을 import하는지 그림으로 봅니다. 폴더(app · components · features · theme …)별로 묶이고, 순환 의존은 빨갛게 표시됩니다.

```bash
cd tools/deps-graph
npm install
npm run graph
```

- `out/deps.svg` — 브라우저로 열면 됨
- `out/deps.json` — 같은 내용을 데이터로(모듈 → import 목록, 순환 목록)
- `npm run check` — 순환 의존이 있으면 실패. CI에 넣을 수 있음

앱 `package.json`과는 별개라 앱 의존성이 늘지 않습니다. Graphviz 설치가 필요 없습니다.

`.js` 파일과 이미지 import는 그래프에 안 나옴(`ts` · `tsx`만). 경로를 못 푼 import가 있으면 `check`가 실패함.
