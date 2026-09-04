# @datasee/mailroom-cli

[mailroom](https://github.com/datamaker/mailroom) — 셀프호스트 뉴스레터 플랫폼 — 을
터미널에서 다루는 CLI. `mailroom mcp` 로 MCP 서버가 되어 Claude 같은 AI 도구가
주소록을 뒤지고, 뉴스레터를 쓰고, 성과를 읽을 수 있다.

```bash
npm i -g @datasee/mailroom-cli
mailroom login --url https://mailroom.example.com --key mrk_...
mailroom doctor
```

`doctor` 는 연결·인증·발신자 인증 상태를 한 번에 확인해 준다. 여기서 초록불이면
나머지도 다 된다.

## 자주 쓰는 것

```bash
mailroom lists ls                          # 주소록과 구독자 수
mailroom subs ls <listId> -q 대학교         # 이메일·이름·회사 어디든 검색
mailroom subs import <listId> people.csv   # CSV 로 일괄 추가
mailroom subs export <listId> out.csv

mailroom campaigns create --list <listId> --subject "9월 1주차" --markdown draft.md
mailroom campaigns check <id>              # 대상 인원과 빠진 것
mailroom campaigns test <id> -e me@example.com
mailroom campaigns send <id> --yes
mailroom campaigns stats <id>

mailroom templates ls
mailroom templates import newsletter.html -n "주간 템플릿"
mailroom auto ls
mailroom stats overview --from 2026-01-01 --interval month
```

`--yes` 없이 `send` 를 부르면 대상 인원만 보여주고 아무것도 보내지 않는다.
대부분의 명령에 `--json` 이 있다.

## 마크다운으로 뉴스레터 쓰기

블록 JSON 을 직접 조립하는 것보다 이쪽이 훨씬 쉽다.

| 쓰면 | 나오는 상자 |
|---|---|
| `# 제목` | 텍스트(제목) |
| 빈 줄로 나눈 문단 | 텍스트 |
| `- 항목` / `1. 항목` | 텍스트(목록) |
| `![alt](url)` | 이미지 |
| `[문구](url){.button}` | 버튼 |
| `---` | 구분선 |
| `<!-- spacer:32 -->` | 공백 |

`$%name%$`, `$%company%$` 처럼 구독자 필드 key 를 쓰면 사람마다 치환된다.
`$%unsubscribe%$` 는 수신거부 링크가 된다.

```bash
mailroom campaigns create --list <listId> --subject "..." --markdown - < draft.md
```

## MCP — AI에게 맡기기

```bash
claude mcp add mailroom -- mailroom mcp
```

또는 설정 파일에 직접:

```json
{
  "mcpServers": {
    "mailroom": {
      "command": "mailroom",
      "args": ["mcp"],
      "env": {
        "MAILROOM_URL": "https://mailroom.example.com",
        "MAILROOM_API_KEY": "mrk_..."
      }
    }
  }
}
```

도구 24개가 붙는다 — 주소록 조회·구독자 검색/추가, 이메일 생성(마크다운)·수정·
대상 설정·미리보기·발송 전 점검·테스트 발송·발송·예약·취소, 템플릿, 자동 이메일,
캠페인별·기간별 통계.

**되돌릴 수 없는 동작에는 잠금장치가 있다.** 발송·예약·자동 이메일 켜기는
`confirm: true` 없이는 실행되지 않고, 대신 대상 인원과 점검 결과를 돌려주며
사람에게 확인받으라고 답한다. AI가 혼자 수만 명에게 메일을 쏘는 사고를 막기 위한 것이다.

## 설정

`MAILROOM_URL` / `MAILROOM_API_KEY` 환경변수가 설정 파일보다 우선한다.
설정 파일은 `~/.config/mailroom/config.json` 이고 API 키가 들어 있어 `600` 으로 저장된다.
`MAILROOM_CONFIG` 로 위치를 바꿀 수 있다.

API 키는 mailroom 웹의 **설정 → API 키**에서 발급한다.

## 라이선스

MIT
