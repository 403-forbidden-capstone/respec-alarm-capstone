// main 직접 push 막기 (lefthook pre-push, #494)
// 무료 private 조직이라 GitHub 보호 규칙을 못 써서, push 전 검사에서 main으로 가는 push를 막음.
// git이 표준 입력으로 "<로컬 ref> <로컬 sha> <원격 ref> <원격 sha>" 줄을 넘김 → 원격 ref가 main이면 실패.
// 급할 때 건너뛰기: git push --no-verify

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const toMain = input
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[2])
    .includes('refs/heads/main');
  if (!toMain) return;
  console.error('main에 직접 push는 막혀 있음. 브랜치를 만들어 PR로 올려 주세요.');
  console.error('  git switch -c fix/<이슈번호>-<내용>  →  git push -u origin HEAD');
  console.error('급할 때만: git push --no-verify');
  process.exit(1);
});
