# @datasee/mailroom-cli

[mailroom](https://github.com/datamaker/mailroom) — 셀프호스트 뉴스레터 플랫폼 —
을 터미널과 AI에서 다루는 CLI.

```bash
npm i -g @datasee/mailroom-cli
mailroom login --url https://mailroom.example.com --key mrk_...
```

주소록 조회, 구독자 검색·추가·CSV 가져오기/내보내기, 마크다운으로 뉴스레터 작성,
테스트 발송, 예약, 발송, 통계 조회를 지원한다. `mailroom mcp` 로 MCP 서버가 되어
Claude 같은 도구가 같은 일을 할 수 있다.

`MAILROOM_URL` / `MAILROOM_API_KEY` 환경변수가 설정 파일보다 우선한다.

전체 사용법은 상위 저장소의 README 를 참고.
