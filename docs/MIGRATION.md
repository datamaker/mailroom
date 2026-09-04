# 스티비 → mailroom 이관

## 순서

1. **발신자 주소 등록** — 설정 > 발신자 관리에서 쓰던 주소를 넣고 "새로고침"으로
   SPF/DKIM/DMARC 를 확인한다. SES 에서도 해당 도메인이 검증돼 있어야 실제로 나간다.
   (현재 검증됨: `bioweekly.co.kr`, `cacheby.com`, `labsby.com`)

2. **주소록 만들기** — 스티비의 주소록 하나당 하나씩. 푸터 정보(회사명·주소·전화번호)를
   같이 채운다. 광고성 메일에 법적으로 필요하다.

3. **사용자 정의 필드 맞추기** — 스티비에서 쓰던 key 를 그대로 만든다.
   바이오위클리/캐시바이 기준: `name`, `company`, `tel`, `userid`, `created_at`.
   key 가 같아야 기존 메일머지 태그(`$%company%$`)가 그대로 동작한다.

4. **구독자 내보내기 → 가져오기** — 스티비에서 구독자 목록 CSV 를 받아
   주소록 > 구독자 목록 > CSV 가져오기에 올린다. 헤더는 필드 이름(한글)이든 key 든 받는다.
   `광고성 정보 수신 동의` 열은 Y/N 을 인식한다.
   수신거부자도 반드시 함께 옮긴다 — 안 옮기면 거부한 사람에게 다시 발송된다.

   ```bash
   mailroom subs import <listId> stibee-export.csv
   ```

5. **연동 바꾸기** — 코드에서 `https://api.stibee.com/v1` → `https://mailroom.datasee.co.kr/v1`,
   `AccessToken` 헤더 값을 mailroom API 키로. 주소록 id 는 숫자가 아니라 uuid 이므로
   slug 를 쓰는 쪽이 편하다.

   ```diff
   - POST https://api.stibee.com/v1/lists/436491/subscribers
   + POST https://mailroom.datasee.co.kr/v1/lists/cacheby-update/subscribers
   ```

6. **구독 폼 교체** — 주소록 > 구독 화면에서 폼 주소(`/s/<slug>`)를 확인하고
   기존 스티비 폼 링크를 바꾼다. 직접 만든 폼은
   `POST /api/public/lists/<slug>/subscribe` 로 보내면 된다.

7. **템플릿 옮기기** — 스티비에서 이메일 > HTML 내보내기(웹 게시용)로 받은 HTML 을
   `html` 상자에 통째로 붙이면 그대로 나간다. 이후 편집이 필요하면 블록으로 쪼갠다.

8. **병행 운영 기간** — 첫 1~2회는 mailroom 에서 소규모 세그먼트로만 보내
   도달률·오픈율을 스티비와 비교한 뒤 전량 전환한다.

## 안 옮겨지는 것

- **과거 발송 통계** — 스티비에 남는다. 필요하면 이메일별 CSV 를 따로 받아 보관한다.
- **랜딩 페이지**(`bioweekly.stibee.com`) — mailroom 범위 밖. 별도 정적 사이트로 옮긴다.
- **자동 이메일(웰컴 메일, 행동 기반 발송)** — 아직 미구현. 구독 확인 이메일(더블 옵트인)은
  동작한다.

## 주의

- 이관 직후 첫 대량 발송은 SES 평판에 영향을 준다. 22,000명을 한 번에 쏘기 전에
  `MAILROOM_SEND_RATE` 를 낮춰(예: 8/s) 나눠 보내는 편이 안전하다.
- 스티비가 관리하던 하드바운스 목록은 넘어오지 않는다. 초기 몇 회는 바운스가 평소보다
  많이 잡히고, 그때 `suppressions` 에 자동으로 쌓인다.
