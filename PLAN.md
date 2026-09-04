# mailroom — 사내 뉴스레터 발송 플랫폼

## 왜
기존 뉴스레터 SaaS 연간 요금제로 22,691/25,000 구독자를 쓰고 있고,
바이오위클리·캐시바이 등 5개 주소록을 운영 중이다. 발송 자체는 이미 우리가
프로덕션 SES(us-east-1, 5만/일, 14/초, cacheby.com·bioweekly.co.kr·labsby.com
도메인 검증 완료)를 갖고 있으므로, 그 서비스가 제공하는 것은 사실상
**주소록 관리 + 블록 에디터 + 발송 큐 + 통계** 네 가지다. 이걸 자체 구현하면
요금이 사라지고, 무엇보다 **CLI/MCP로 AI가 직접 뉴스레터를 만들고 쏠 수 있다**.

## 범위
포함: 주소록(구독자/그룹/세그먼트/사용자정의필드/구독폼), 이메일(블록 에디터,
템플릿, 예약/발송, 테스트발송, HTML 내보내기), **발송 통계**, 발신자 관리,
API 키, CLI + MCP.
제외(사용자 지시): 랜딩 "페이지" 기능, 요금제/결제, 워크스페이스 과금 통계.
로그인은 사내 SSO(gatehouse OIDC) 하나로 통일 — 자체 비밀번호 없음.

## 스택 (lookout/gatehouse 컨벤션 그대로)
- npm workspaces: `server` / `web` / `cli`
- Fastify 4 + TypeScript ESM + `pg` (raw SQL 마이그레이션), PostgreSQL 16
- Vite + React 18 + react-router (web)
- commander + @modelcontextprotocol/sdk (cli, `mailroom mcp`)
- 발송: AWS SES v2 기본 / SMTP(nodemailer) 대체 — provider 인터페이스로 분리
- 큐: Postgres `FOR UPDATE SKIP LOCKED` (Redis 의존 없음), 워커는 서버 프로세스 내장
- 포트: 서버 9200, web dev 5182, dev postgres 5436

## 데이터 모델
workspace(단일) / users(SSO JIT) / api_keys
lists(주소록) → custom_fields, subscribers, groups, subscriber_groups, segments
senders(발신자 주소 + SPF/DKIM/DMARC 상태)
templates(블록 JSON)
campaigns(이메일) → campaign_recipients → events(open/click/bounce/complaint/unsub)
send_jobs(큐), suppressions(하드바운스/스팸신고 전역 차단)

## 단계
- P0 스캐폴드: 모노레포, 스키마/마이그레이션, 설정, 인증(SSO+API키)
- P1 주소록: 구독자 CRUD/검색/필터/CSV, 그룹, 세그먼트, 사용자정의필드,
  구독폼 + 구독확인메일 + 수신거부/구독정보변경 화면
- P2 콘텐츠: 블록 스키마 + 이메일 HTML 렌더러, 템플릿, 머지태그, 테스트발송,
  HTML 내보내기(이메일용/웹게시용)
- P3 발송: 캠페인 마법사, 예약, 큐/워커, SES 프로바이더, 오픈픽셀/클릭추적,
  SES 이벤트(바운스/컴플레인) 수신
- P4 통계: 캠페인 대시보드(발송성공/오픈/클릭/수신거부, 24h 추이, 링크 TOP,
  구독자 TOP, 모바일vs데스크톱), 기간/태그/주소록 필터, CSV
- P5 CLI + MCP
- P6 배포: Dockerfile, compose, nginx conf(gatehouse deploy/), 마이그레이션 가이드

## 구독자 연동 v1 API
기존 연동(구독폼, 서버측 구독자 추가)이 그대로 붙도록 v1 호환 엔드포인트를 둔다:
`POST /v1/lists/:listId/subscribers` (eventOccuredBy/confirmEmailYN/groupIds/subscribers,
응답 `{Ok, Error, Value}`), `DELETE /v1/lists/:listId/subscribers`,
`POST /v1/lists/:listId/subscribers/unsubscribe`. 인증 헤더는 `AccessToken`.
