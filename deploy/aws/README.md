# 남은 AWS 설정 (권한 문제로 사람이 해야 하는 것)

`local-role` 로는 IAM 쓰기와 SNS 생성이 막혀 있다. CloudShell 이나 관리자 자격으로
아래 두 가지를 한 번만 실행하면 된다.

## 1. SES 발송 권한 (필수 — 없으면 발송이 전부 실패한다)

`cacheby-app-role` 에 SES 발송 권한이 없다. 확인:

```
aws sesv2 send-email … → AccessDeniedException: not authorized to perform 'ses:SendEmail'
```

기존 인라인 정책 `Policy` 에 `ses-policy-statements.json` 의 두 statement 를 덧붙인다:

```bash
ROLE=cacheby-app-role
aws iam get-role-policy --role-name $ROLE --policy-name Policy \
  --query PolicyDocument --output json > /tmp/policy.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/policy.json'))
add=json.load(open('ses-policy-statements.json'))
have={s.get('Sid') for s in d['Statement']}
d['Statement'] += [s for s in add if s['Sid'] not in have]
json.dump(d, open('/tmp/policy.json','w'), indent=2)
PY
aws iam put-role-policy --role-name $ROLE --policy-name Policy \
  --policy-document file:///tmp/policy.json
```

발송 신원은 검증된 세 도메인으로만 좁혀 두었다. 새 발신 도메인을 추가하면
`Resource` 에도 같이 넣어야 한다.

## 2. 바운스·스팸신고 수신 (SNS → 웹훅)

구성 세트 `mailroom` 은 이미 만들어 두었다(us-east-1, TLS 필수, 평판 지표 on).
여기에 SNS 이벤트 대상을 걸어야 하드바운스·스팸신고가 mailroom 의 차단 목록으로 들어온다.

```bash
TOPIC=$(aws sns create-topic --region us-east-1 --name mailroom-ses-events \
        --query TopicArn --output text)

aws sesv2 create-configuration-set-event-destination --region us-east-1 \
  --configuration-set-name mailroom \
  --event-destination-name sns \
  --event-destination "Enabled=true,MatchingEventTypes=BOUNCE,COMPLAINT,DELIVERY,\
SnsDestination={TopicArn=$TOPIC}"

aws sns subscribe --region us-east-1 --topic-arn $TOPIC \
  --protocol https --notification-endpoint https://mail.datasee.co.kr/api/webhooks/ses
```

구독 확인(`SubscriptionConfirmation`)은 mailroom 이 자동으로 처리한다 — AWS 도메인의
`SubscribeURL` 만 호출하도록 되어 있다. 확인은 아래로:

```bash
aws sns list-subscriptions-by-topic --region us-east-1 --topic-arn $TOPIC
```

## 3. (선택) datasee.co.kr 도메인을 SES 에 추가

`info@datasee.co.kr` 로 보내던 뉴스레터가 있는데 이 도메인은 SES 에
검증돼 있지 않다. 그대로 쓰려면 SES 에 도메인을 추가하고 DKIM CNAME 3개를
Route53 에 넣어야 한다. 현재 mailroom 의 기본 발신자는 검증된 도메인으로 잡아 두었다:
바이오위클리 → `info@bioweekly.co.kr`, 캐시바이 → `info@cacheby.com`,
랩스바이 → `notify@labsby.com`.
