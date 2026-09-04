/** 구독폼·수신거부처럼 로그인 없이 보이는 최소한의 공개 페이지 셸. */
export function page(title: string, body: string) {
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',-apple-system,sans-serif;
         background:#f6f7f9; color:#222; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .card { background:#fff; border-radius:12px; padding:32px; max-width:440px; width:100%;
          box-shadow:0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06); }
  h1 { font-size:20px; margin:0 0 16px; }
  p { line-height:1.7; margin:0 0 12px; }
  .muted { color:#777; font-size:14px; }
  label { display:block; margin:0 0 14px; font-size:14px; color:#444; }
  label.check { display:flex; align-items:center; gap:8px; }
  input[type=text], input[type=email], input:not([type]) {
    display:block; width:100%; box-sizing:border-box; margin-top:6px; padding:10px 12px;
    border:1px solid #dcdfe4; border-radius:6px; font-size:15px; }
  button { background:#e8543f; color:#fff; border:0; border-radius:6px; padding:12px 20px;
           font-size:15px; font-weight:600; cursor:pointer; width:100%; }
  button.danger { background:#d33; }
  a { color:#0f62fe; }
  @media (prefers-color-scheme: dark) {
    body { background:#16181c; color:#e8e8e8; }
    .card { background:#1f2226; box-shadow:none; }
    .muted { color:#9aa0a6; }
    input[type=text], input[type=email], input:not([type]) { background:#16181c; border-color:#33383f; color:#e8e8e8; }
  }
</style>
</head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
}
