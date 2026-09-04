# 배포 메모

## 네트워크 구성

mailroom 은 한 프로세스지만 **두 개의 얼굴**이 필요하다.

| 경로 | 누가 부르나 | 노출 |
|---|---|---|
| `/t/`, `/u/`, `/p/`, `/w/`, `/s/`, `/api/public/`, `/api/webhooks/` | 구독자 브라우저·메일 클라이언트, AWS SNS | **인터넷 공개 필수** |
| 그 외 전부 (관리 UI, `/api/*`, `/v1/*`) | 직원, CLI | VPN 뒤 |

공개 경로를 VPN 뒤에 두면 이미 보낸 메일의 오픈 추적·클릭·수신거부 링크가 전부 죽는다.
`opentunnel-nlb` 에 TCP 리스너를 하나 더 붙여 `mailroom-public` 타깃그룹 → 인스턴스 `:8444`
로 보내고, `mailroom-public.conf` 가 그 포트를 default_server 로 받는다
(gatehouse 의 `auth-public.conf` 가 `:8443` 을 쓰는 것과 같은 패턴).

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
