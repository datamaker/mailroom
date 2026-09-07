# 배포 메모

## 네트워크 구성

mailroom 은 한 프로세스지만 **두 개의 얼굴**이 필요하다.

| 경로 | 누가 부르나 | 노출 |
|---|---|---|
| `/t/`, `/u/`, `/p/`, `/w/`, `/s/`, `/api/public/`, `/api/webhooks/` | 구독자 브라우저·메일 클라이언트, AWS SNS | **인터넷 공개 필수** |
| 그 외 전부 (관리 UI, `/api/*`, `/v1/*`) | 직원, CLI | VPN 뒤 |

공개 경로를 VPN 뒤에 두면 이미 보낸 메일의 오픈 추적·클릭·수신거부 링크가 전부 죽는다.
**NLB 를 새로 만들거나 리스너를 추가할 필요는 없다.** `opentunnel-nlb` 의 TCP :443 이
이미 인스턴스 `:8443` 으로 오고 있고, TCP 패스스루라 SNI 가 nginx 까지 그대로 온다.
gatehouse 가 그 포트의 `default_server` 이므로, `server_name mail.datasee.co.kr` 을 명시한
블록을 같은 :8443 에 얹으면 SNI 로 갈라진다. Route53 에 `mail.datasee.co.kr` A alias 를
`auth.datasee.co.kr` 과 같은 NLB 로 걸어 주면 끝.

`limit_req_zone` 은 nginx.conf 의 http 블록에 있어야 한다:

```nginx
limit_req_zone $binary_remote_addr zone=mailroom_public:10m rate=20r/s;
```

## SES

- 리전은 **us-east-1** (프로덕션 액세스, 5만/일, 14/초). ap-northeast-2 는 샌드박스라 못 쓴다.
- 발신 도메인(`bioweekly.co.kr`, `cacheby.com`, `labsby.com`)은 이미 검증돼 있다.
- 인스턴스 롤에 `ses:SendEmail`, `ses:SendRawEmail` 이 필요하다. 없으면 발송이 전부 실패한다.
- 바운스/스팸신고를 받으려면 구성 세트를 만들고 이벤트 대상을 SNS 로 걸어
  `https://mail.datasee.co.kr/api/webhooks/ses` 를 구독시킨다. 첫 요청의
  `SubscriptionConfirmation` 은 서버가 자동으로 확인한다(AWS 도메인만).
- `MAILROOM_SEND_RATE` 는 계정 한도보다 낮게. 22,000명 발송은 12/s 기준 약 30분 걸린다.

## 배포 절차 (cacheby-app)

```bash
# 소스 갱신
cd /opt/mailroom && git pull --ff-only
# 빌드 + 기동 (마이그레이션은 부팅 시 자동)
docker compose up -d --build mailroom
```

compose 프로젝트명이 디렉터리명에 묶여 있으니 **반드시 `/opt/mailroom` 에서** 올린다.
다른 경로에서 올리면 볼륨이 새로 생겨 DB 가 빈 채로 뜬다.

## 이미지 보관

기본은 Postgres 의 `assets.data`(bytea) 다. 백업이 DB 하나로 끝나 소규모엔 편하지만,
이미지가 늘면 S3 로 돌린다. 어느 쪽이든 `/a/<id>` 주소는 계속 살아 있어서
**이미 발송된 메일의 이미지가 깨지지 않는다** — S3 모드에서는 그 주소가 CDN 으로 301 한다.

```
MAILROOM_ASSET_STORE=s3
MAILROOM_ASSET_BUCKET=images.bioweekly.co.kr
MAILROOM_ASSET_REGION=ap-northeast-2
MAILROOM_ASSET_PREFIX=mailroom
MAILROOM_ASSET_BASE_URL=https://images.bioweekly.co.kr
```

버킷은 퍼블릭 액세스가 전부 차단돼 있고 CloudFront(OAC)만 `s3:GetObject` 를 갖는다.
**그 정책에 쓰기를 얹지 말 것** — 예전에 CDN 에 쓰기를 열어 익명 업로드가 뚫린 적이 있다.
쓰기는 인스턴스 롤로만 한다. `cacheby-app-role` 인라인 정책에 필요한 문장:

```json
{
  "Sid": "mailroomAssets",
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::images.bioweekly.co.kr/mailroom/*"
}
```

보관 위치를 바꾼 뒤 이미 DB 에 들어와 있던 이미지는 따라 올려야 한다.
`/a/<id>` 주소는 그대로라 발송된 메일과 웹 아카이브는 손댈 필요가 없다.

```bash
docker compose exec mailroom node server/dist/scripts/move-assets.js          # 미리보기
docker compose exec mailroom node server/dist/scripts/move-assets.js --apply
```

`docker-compose.yml` 의 `environment:` 에 변수를 나열하는 구조라, `.env` 에만
적으면 컨테이너까지 가지 않는다 — compose 파일에도 같이 넣어야 한다.

SVG 는 받지 않는다. Gmail·Outlook 이 어차피 걸러 내는데, 주소로 직접 열면 스크립트가
도는 저장형 XSS 통로만 남는다.

## 외부 이미지 끌어오기

이관해 온 뉴스레터는 이미지가 예전 서비스 CDN 을 가리킨다. 그쪽을 해지하면 지난
뉴스레터와 웹 아카이브가 통째로 깨지므로 바이트를 우리 쪽으로 옮겨야 한다.

```bash
cd /opt/mailroom
docker compose exec mailroom node server/dist/scripts/rehost-images.js          # 미리보기
docker compose exec mailroom node server/dist/scripts/rehost-images.js --apply
```

템플릿의 `content` 와 캠페인의 `content`·`content_html`(웹 아카이브가 쓰는 발송 스냅샷)을
모두 훑는다. 받아오지 못한 주소는 그대로 남기고 로그에 남긴다.

## 알림

발송은 3만 통이 30분에 걸쳐 나가므로 중간에 무너져도 화면을 안 보면 모른다.
슬랙 incoming webhook 을 걸어 두면 발송 완료·실패·스팸 신고 급증을 알린다.

```
MAILROOM_ALERT_WEBHOOK=https://hooks.slack.com/services/...
MAILROOM_ALERT_FAILURE_RATE=0.05   # 이 비율 넘게 실패하면 경고로 올린다
```

- 발송 완료 — 성공·실패 수와 실패 원인 상위 3개
- 발송 작업 최종 실패 — 재시도가 다 떨어졌을 때
- 스팸 신고 0.1% 초과 — SES 가 발송을 조이는 선

설정 > 알림에서 "테스트 보내기"로 연결을 확인할 수 있다. 사고가 났을 때 처음
시험하게 되면 늦다.
