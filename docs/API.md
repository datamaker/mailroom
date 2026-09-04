# API

인증: `AccessToken: mrk_…` 또는 `Authorization: Bearer mrk_…` 헤더.
브라우저는 SSO 세션 쿠키를 쓴다.

## 주소록

```
GET    /api/lists
POST   /api/lists                     {name, default_sender_name, default_sender_email, footer_*}
GET    /api/lists/:id
PATCH  /api/lists/:id
DELETE /api/lists/:id

GET    /api/lists/:id/fields
POST   /api/lists/:id/fields          {key, label, type, default_value, required}
PATCH  /api/lists/:id/fields/:fieldId
DELETE /api/lists/:id/fields/:fieldId

GET    /api/lists/:id/groups
POST   /api/lists/:id/groups          {name}
DELETE /api/lists/:id/groups/:groupId

GET    /api/lists/:id/segments
POST   /api/lists/:id/segments        {name, match, conditions[]}
PATCH  /api/lists/:id/segments/:segmentId
DELETE /api/lists/:id/segments/:segmentId

POST   /api/lists/:id/audience/count  {groupIds, segmentIds, adAgreedOnly}
```

### 세그먼트 조건

```jsonc
{ "type": "field",         "key": "company", "op": "contains", "value": "대학교" }
{ "type": "status",        "value": "subscribed" }
{ "type": "ad_agreed",     "value": true }
{ "type": "group",         "op": "in", "value": ["<groupId>"] }
{ "type": "subscribed_at", "op": "within_days", "value": 30 }
{ "type": "activity",      "op": "opened", "campaignId": "<uuid>", "withinDays": 90 }
```

`op` (field): `eq` `neq` `contains` `not_contains` `starts_with` `ends_with` `is_empty` `is_not_empty`
`op` (activity): `opened` `not_opened` `clicked` `not_clicked`

## 구독자

```
GET    /api/lists/:id/subscribers            ?q= &status= &groupId= &segmentId= &filter= &limit= &offset=
GET    /api/lists/:id/subscribers/export     ?status=      → CSV
GET    /api/lists/:id/subscribers/:subId
POST   /api/lists/:id/subscribers            {subscribers:[{email, name, …}], groupIds, by, clearEmpty}
PATCH  /api/lists/:id/subscribers/:subId     {fields, status, ad_agreed, groupIds}
POST   /api/lists/:id/subscribers/status     {emails:[], status}
POST   /api/lists/:id/subscribers/import     {csv, groupIds, clearEmpty, mapping}
DELETE /api/lists/:id/subscribers            {emails:[]}
```

`by: "SUBSCRIBER"` 는 본인이 신청한 경우로 보고 수신거부 상태를 되살린다.
`by: "MANUAL"`(기본)은 수신거부를 존중해 건너뛴다.

## 이메일

```
GET    /api/campaigns                 ?status= &listId= &tag= &q= &from= &to=
POST   /api/campaigns                 {list_id, subject, content[], …}
GET    /api/campaigns/:id
PATCH  /api/campaigns/:id
DELETE /api/campaigns/:id
POST   /api/campaigns/:id/duplicate

GET    /api/campaigns/:id/html        ?mode=email|web &sample=1
POST   /api/render/preview            {content[], styles}       ← 저장 전 미리보기
GET    /api/campaigns/:id/audience    → {count, issues[]}       ← 발송 전 점검
POST   /api/campaigns/:id/test        {recipients:[]}
POST   /api/campaigns/:id/send
POST   /api/campaigns/:id/schedule    {scheduled_at}
POST   /api/campaigns/:id/pause | /resume | /cancel
```

## 통계

```
GET /api/campaigns/:id/stats           발송성공·오픈·클릭·수신거부, 시간별 추이, 링크·구독자 순위, 오픈 환경
GET /api/campaigns/:id/recipients      ?event=opened|clicked|not_opened &status=
GET /api/campaigns/:id/stats/export    → CSV
GET /api/stats/overview                ?from= &to= &listIds= &tags= &interval=week|month
GET /api/stats/dashboard
```

## 공개 경로 (인증 없음)

```
GET  /t/o/:token.gif        오픈 픽셀
GET  /t/c/:token/:linkId    클릭 추적 후 302
GET  /w/:slug               웹에서 보기
GET|POST /u/:token          수신거부 (POST 는 RFC 8058 원클릭)
GET|POST /p/:token          구독 정보 변경
GET|POST /s/:slug           구독 폼
POST /api/public/lists/:slug/subscribe
POST /api/webhooks/ses      SES 이벤트(SNS)
```
