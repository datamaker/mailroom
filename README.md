# mailroom

셀프호스트 뉴스레터 플랫폼. 주소록·구독자 관리, 블록 에디터, 예약 발송, 발송 통계를
갖추고 있고, **CLI 와 MCP 로 AI가 직접 뉴스레터를 만들고 보낼 수 있다.**

발송은 AWS SES(또는 SMTP)를 쓴다. 쓰던 뉴스레터 서비스에서 구독자와 템플릿을
그대로 가져올 수 있다.

```
┌─ web ──────────┐   ┌─ cli / mcp ────┐
│ 이메일 에디터   │   │ mailroom …     │
│ 주소록·통계     │   │ mailroom mcp   │
└────────┬───────┘   └────────┬───────┘
         └────── Fastify API ─┴──────┐
                                     │
        PostgreSQL ── 큐(워커) ── AWS SES ── 구독자
                          ▲                    │
                          └── 오픈/클릭/바운스 ─┘
```

## 무엇이 있고 무엇이 없나

있는 것 — 주소록(구독자, 그룹, 세그먼트, 사용자 정의 필드, 구독 폼, CSV 가져오기/내보내기),
이메일(블록 에디터, 템플릿, 메일머지, 테스트 발송, 예약, HTML 내보내기),
발송 통계(발송성공·오픈·클릭·수신거부, 시간별 추이, 링크·구독자 순위, 오픈 환경),
발신자 관리(SPF/DKIM/DMARC 확인), API 키, 수신 차단 목록.

없는 것 — 랜딩 "페이지" 기능, 요금제/결제. 로그인은 사내 SSO 하나뿐(자체 비밀번호 없음).

## 빠르게 띄우기

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres:5436
cp .env.example .env.dev                          # 값 채우기
npm install
npm run dev                                       # http://localhost:9200
npm run dev:web                                   # http://localhost:5182 (에디터 HMR)
```

SSO 없이 혼자 볼 때는 `.env.dev` 에 `MAILROOM_DEV_AUTH_EMAIL=you@datasee.co.kr` 을 두면
인증을 건너뛴다. **프로덕션에서는 절대 켜지 말 것** — 인증이 통째로 열린다.

프로덕션 배포는 [`deploy/README.md`](deploy/README.md) 참고. 공개 경로를 VPN 뒤에 두면
발송한 메일의 링크가 전부 죽으므로 그 문서를 먼저 읽는 게 좋다.

## 설정

| 환경변수 | 설명 |
|---|---|
| `MAILROOM_PUBLIC_URL` | 추적·구독 링크에 박히는 주소. **인터넷에서 열려야 한다** |
| `MAILROOM_SECRET` | 추적/구독 토큰 서명 키. 바뀌면 발송된 메일의 링크가 전부 무효 |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | gatehouse SSO |
| `MAILROOM_ADMIN_EMAILS` | 첫 로그인 시 owner 로 올릴 이메일 |
| `MAILROOM_SEND_PROVIDER` | `ses`(기본) · `smtp` · `console` |
| `MAILROOM_SEND_RATE` | 초당 발송 상한. SES 계정 한도보다 낮게 |
| `AWS_SES_REGION` | 기본 `us-east-1` |
| `MAILROOM_WORKER` | `0` 이면 이 프로세스는 발송하지 않음(웹 전용 인스턴스) |

## CLI

```bash
npm i -g @datasee/mailroom-cli
mailroom login --url https://mailroom.datasee.co.kr --key mrk_...

mailroom lists ls
mailroom subs ls <listId> -q 대학교
mailroom subs import <listId> subscribers.csv

# 마크다운으로 뉴스레터 만들기
mailroom campaigns create --list <listId> --subject "9월 1주차" --markdown draft.md
mailroom campaigns check <id>
mailroom campaigns test <id> -e me@datasee.co.kr
mailroom campaigns send <id> --yes
mailroom campaigns stats <id>
```

`--yes` 없이 `send` 를 부르면 대상 인원만 보여주고 아무것도 보내지 않는다.

### 마크다운 문법

| 쓰면 | 나오는 상자 |
|---|---|
| `# 제목` | 텍스트(제목) |
| 빈 줄로 나눈 문단 | 텍스트 |
| `- 항목` / `1. 항목` | 텍스트(목록) |
| `![alt](url)` | 이미지 |
| `[문구](url){.button}` | 버튼 |
| `---` | 구분선 |
| `<!-- spacer:32 -->` | 공백 |

`$%name%$`, `$%company%$` 처럼 사용자 정의 필드 키를 쓰면 수신자별로 치환된다.
`$%unsubscribe%$`, `$%preferences%$`, `$%webview%$` 는 링크로 바뀐다.

## MCP (AI에서 조작)

```bash
claude mcp add mailroom -- mailroom mcp
# 또는 ~/.claude.json / claude_desktop_config.json 에
# { "command": "mailroom", "args": ["mcp"],
#   "env": { "MAILROOM_URL": "https://…", "MAILROOM_API_KEY": "mrk_…" } }
```

도구: 주소록 조회, 구독자 검색/추가, 이메일 생성(마크다운)·수정·대상 설정·미리보기·점검·
테스트 발송·발송·예약·취소·통계.

발송과 예약은 `confirm: true` 없이는 실행되지 않는다. AI가 혼자 22,000명에게 메일을
쏘는 사고를 막기 위한 것으로, 사람에게 대상 인원과 제목을 확인받은 뒤에만 넘기도록 되어 있다.

## 구독자 연동 API (v1)

외부 서비스에서 구독자를 넣고 빼는 엔드포인트. 인증 헤더는 `AccessToken`.

```
POST   /v1/lists/:listId/subscribers              {eventOccuredBy, confirmEmailYN, groupIds, subscribers[]}
DELETE /v1/lists/:listId/subscribers              [이메일…]
POST   /v1/lists/:listId/subscribers/unsubscribe  [이메일…]
```

응답은 `{Ok, Error, Value}` 모양이고, `:listId` 자리에 주소록 uuid 나 slug 를 쓴다.
흔한 뉴스레터 서비스의 v1 API 와 모양을 맞춰 두어서, 쓰던 연동은 base URL 과 토큰만
바꾸면 그대로 붙는다. 이관 절차는 [`docs/MIGRATION.md`](docs/MIGRATION.md) 참고.

## 라이선스

MIT
