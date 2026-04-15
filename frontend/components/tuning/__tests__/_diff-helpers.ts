// Pure-TS extraction of the diff algorithm in diff-viewer.tsx so it can be
// unit-tested without importing React. Keep the two implementations in sync.

export type Token = { text: string; type: 'equal' | 'add' | 'del' };

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

export function diffTokensForTesting(a: string, b: string): Token[] {
  const A = tokenize(a);
  const B = tokenize(b);
  const N = Math.min(A.length, 1600);
  const M = Math.min(B.length, 1600);
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      dp[i][j] = A[i - 1] === B[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: Token[] = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      out.push({ text: A[i - 1], type: 'equal' });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ text: A[i - 1], type: 'del' });
      i--;
    } else {
      out.push({ text: B[j - 1], type: 'add' });
      j--;
    }
  }
  while (i > 0) {
    out.push({ text: A[i - 1], type: 'del' });
    i--;
  }
  while (j > 0) {
    out.push({ text: B[j - 1], type: 'add' });
    j--;
  }
  out.reverse();
  return out;
}
