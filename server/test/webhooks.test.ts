import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSign, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { closeDb, db, makeApp } from './helpers.js';

/**
 * SES 웹훅(SNS) 서명 검증 테스트.
 * 테스트용 RSA 키와 자체 서명 인증서를 만들어 "SNS 가 서명한 메시지"를 흉내 낸다.
 * 인증서 로더를 갈아 끼우므로 네트워크는 타지 않는다.
 */

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:mailroom-ses-events';
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem';

function makeCert(dir: string, name: string) {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=sns.amazonaws.com'],
    { stdio: 'ignore' }
  );
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(crt, 'utf8') };
}

/** AWS 문서의 서명 대상 문자열을 테스트 쪽에서 따로 만든다(구현을 그대로 베끼지 않도록). */
function canonical(msg: Record<string, string>) {
  const lines: string[] = [];
  const push = (k: string) => lines.push(k, msg[k]);
  push('Message');
  push('MessageId');
  if (msg.Type === 'Notification') {
    if (msg.Subject !== undefined) push('Subject');
  } else {
    push('SubscribeURL');
  }
  push('Timestamp');
  if (msg.Type !== 'Notification') push('Token');
  push('TopicArn');
  push('Type');
  return lines.join('\n') + '\n';
}

function sign(msg: Record<string, string>, key: string, version: '1' | '2' = '2') {
  const algorithm = version === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  return {
    ...msg,
    SignatureVersion: version,
    Signature: createSign(algorithm).update(canonical(msg), 'utf8').sign(key, 'base64'),
    SigningCertURL: CERT_URL,
  };
}

function notification(sesEvent: unknown, extra: Record<string, string> = {}) {
  return {
    Type: 'Notification',
    MessageId: randomUUID(),
    TopicArn: TOPIC,
    Message: JSON.stringify(sesEvent),
    Timestamp: new Date().toISOString(),
    ...extra,
  };
}

const complaint = (email: string) => ({
  eventType: 'Complaint',
  mail: { messageId: `test-${randomUUID()}` },
  complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: 'abuse' },
});

const hardBounce = (email: string) => ({
  eventType: 'Bounce',
  mail: { messageId: `test-${randomUUID()}` },
  bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: email }] },
});

describe('SES 웹훅 SNS 서명 검증', () => {
  let dir: string;
  let good: { key: string; cert: string };
  let other: { key: string; cert: string };
  let app: FastifyInstance; // 토픽 제한 없음
  let strictApp: FastifyInstance; // 토픽 허용 목록 있음
  let listId: string;
  const certLoads: string[] = [];
  const confirmed: string[] = [];
  const emails: string[] = [];

  const loadCert = async (url: string) => {
    certLoads.push(url);
    return good.cert;
  };
  const confirmSubscription = async (url: string) => {
    confirmed.push(url);
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailroom-sns-'));
    good = makeCert(dir, 'good');
    other = makeCert(dir, 'other');
    app = await makeApp({ webhook: { loadCert, confirmSubscription, topicArns: [] } });
    strictApp = await makeApp({ webhook: { loadCert, confirmSubscription, topicArns: [TOPIC] } });
    const { one } = await db();
    const list = await one<{ id: string }>('insert into lists (name, slug) values ($1, $2) returning id', [
      'sns-test',
      `sns-test-${randomUUID()}`,
    ]);
    listId = list!.id;
  });

  after(async () => {
    const { query } = await db();
    await query('delete from lists where id = $1', [listId]); // 구독자는 cascade
    await query('delete from suppressions where email = any($1)', [emails]);
    await app.close();
    await strictApp.close();
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 구독 중인 구독자 한 명을 만든다. */
  async function subscriber() {
    const email = `sns-${randomUUID()}@example.com`;
    emails.push(email);
    const { query } = await db();
    await query(`insert into subscribers (list_id, email, status) values ($1, $2, 'subscribed')`, [listId, email]);
    return email;
  }

  async function state(email: string) {
    const { one } = await db();
    const sub = await one<{ status: string }>('select status from subscribers where list_id = $1 and email = $2', [
      listId,
      email,
    ]);
    const sup = await one<{ reason: string }>('select reason from suppressions where email = $1', [email]);
    return { status: sub?.status, suppressed: sup?.reason ?? null };
  }

  const untouched = { status: 'subscribed', suppressed: null };

  /** SNS 는 JSON 본문을 text/plain 으로 보낸다. */
  const post = (target: FastifyInstance, body: unknown) =>
    target.inject({
      method: 'POST',
      url: '/api/webhooks/ses',
      headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': 'Notification' },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('서명이 맞는 Notification(v2, SHA256)은 처리된다', async () => {
    const email = await subscriber();
    const res = await post(app, sign(notification(complaint(email)), good.key, '2'));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await state(email), { status: 'unsubscribed', suppressed: 'complaint' });
  });

  it('서명이 맞는 Notification(v1, SHA1)도 처리된다', async () => {
    const email = await subscriber();
    const res = await post(app, sign(notification(hardBounce(email)), good.key, '1'));
    assert.equal(res.statusCode, 200);
    assert.equal((await state(email)).suppressed, 'hard_bounce');
  });

  it('Subject 가 있는 Notification 도 서명이 맞으면 처리된다', async () => {
    const email = await subscriber();
    const res = await post(app, sign(notification(complaint(email), { Subject: 'Amazon SES Email Event Notification' }), good.key));
    assert.equal(res.statusCode, 200);
    assert.equal((await state(email)).suppressed, 'complaint');
  });

  it('application/json 으로 와도 똑같이 검증·처리한다', async () => {
    const email = await subscriber();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/ses',
      payload: sign(notification(complaint(email)), good.key),
    });
    assert.equal(res.statusCode, 200);
    assert.equal((await state(email)).suppressed, 'complaint');
  });

  it('같은 메시지를 두 번 받아도 결과가 같다', async () => {
    const email = await subscriber();
    const msg = sign(notification(complaint(email)), good.key);
    assert.equal((await post(app, msg)).statusCode, 200);
    assert.equal((await post(app, msg)).statusCode, 200);
    assert.deepEqual(await state(email), { status: 'unsubscribed', suppressed: 'complaint' });
  });

  it('서명 없는 메시지는 403 — 아무것도 바뀌지 않는다', async () => {
    const email = await subscriber();
    const res = await post(app, notification(complaint(email)));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(await state(email), untouched);
  });

  it('SNS 봉투 없이 SES 이벤트만 보내면 403', async () => {
    const email = await subscriber();
    for (const body of [complaint(email), hardBounce(email)]) {
      const res = await post(app, body);
      assert.equal(res.statusCode, 403);
    }
    assert.deepEqual(await state(email), untouched);
  });

  it('서명 뒤에 내용을 바꾸면 403', async () => {
    const victim = await subscriber();
    const signed = sign(notification(complaint(`someone-else-${randomUUID()}@example.com`)), good.key);
    const res = await post(app, { ...signed, Message: JSON.stringify(complaint(victim)) });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(await state(victim), untouched);

    // 토픽만 바꿔도 서명이 깨진다.
    const res2 = await post(app, { ...sign(notification(complaint(victim)), good.key), TopicArn: `${TOPIC}-x` });
    assert.equal(res2.statusCode, 403);
    assert.deepEqual(await state(victim), untouched);
  });

  it('다른 키로 서명한 메시지는 403', async () => {
    const email = await subscriber();
    const res = await post(app, sign(notification(complaint(email)), other.key));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(await state(email), untouched);
  });

  it('SNS 가 아닌 인증서 주소는 가져오지도 않고 403', async () => {
    const email = await subscriber();
    const signed = sign(notification(complaint(email)), good.key);
    for (const SigningCertURL of [
      'https://evil.example.com/cert.pem',
      'https://sns.us-east-1.amazonaws.com.evil.example.com/cert.pem',
      'https://evil-sns.us-east-1.amazonaws.com/cert.pem',
      'https://s3.amazonaws.com/attacker-bucket/cert.pem',
      'https://attacker-bucket.s3.us-east-1.amazonaws.com/cert.pem',
      'https://sns.us-east-1.amazonaws.com@evil.example.com/cert.pem',
      'https://sns.us-east-1.amazonaws.com:8443/cert.pem',
      'http://sns.us-east-1.amazonaws.com/cert.pem',
      'https://sns.us-east-1.amazonaws.com/cert.txt',
      'https://sns.us-east-1.amazonaws.com/cert.pem.txt',
      '',
    ]) {
      const before = certLoads.length;
      const res = await post(app, { ...signed, SigningCertURL });
      assert.equal(res.statusCode, 403, SigningCertURL);
      assert.equal(certLoads.length, before, `인증서를 가져오면 안 된다: ${SigningCertURL}`);
    }
    assert.deepEqual(await state(email), untouched);
  });

  it('지원하지 않는 SignatureVersion·Type 은 403', async () => {
    const email = await subscriber();
    const signed = sign(notification(complaint(email)), good.key);
    assert.equal((await post(app, { ...signed, SignatureVersion: '3' })).statusCode, 403);
    assert.equal((await post(app, { ...signed, Type: 'Whatever' })).statusCode, 403);
    assert.deepEqual(await state(email), untouched);
  });

  it('JSON 이 아닌 본문은 400', async () => {
    assert.equal((await post(app, 'not json')).statusCode, 400);
    assert.equal((await post(app, '"just a string"')).statusCode, 400);
  });

  it('인증서를 못 가져오면 503 — SNS 가 재시도하도록', async () => {
    const email = await subscriber();
    const failing = await makeApp({
      webhook: {
        loadCert: async () => {
          throw new Error('network down');
        },
        topicArns: [],
      },
    });
    const res = await post(failing, sign(notification(complaint(email)), good.key));
    await failing.close();
    assert.equal(res.statusCode, 503);
    assert.deepEqual(await state(email), untouched);
  });

  it('토픽 허용 목록: 목록에 있는 토픽은 처리, 없는 토픽은 서명이 맞아도 403', async () => {
    const ok = await subscriber();
    assert.equal((await post(strictApp, sign(notification(complaint(ok)), good.key))).statusCode, 200);
    assert.equal((await state(ok)).suppressed, 'complaint');

    const email = await subscriber();
    const foreign = { ...notification(complaint(email)), TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker-topic' };
    const res = await post(strictApp, sign(foreign, good.key));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(await state(email), untouched);

    // 허용 목록이 없는 앱은 서명만 맞으면 받는다.
    assert.equal((await post(app, sign(foreign, good.key))).statusCode, 200);
  });

  describe('구독 확인', () => {
    const confirmation = (SubscribeURL: string, topic = TOPIC) => ({
      Type: 'SubscriptionConfirmation',
      MessageId: randomUUID(),
      Token: 'tok-' + randomUUID(),
      TopicArn: topic,
      Message: 'You have chosen to subscribe to the topic.',
      SubscribeURL,
      Timestamp: new Date().toISOString(),
    });
    const URL_OK = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=y';

    it('서명이 맞으면 SubscribeURL 을 호출한다', async () => {
      confirmed.length = 0;
      const res = await post(app, sign(confirmation(URL_OK), good.key));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(confirmed, [URL_OK]);
    });

    it('서명이 없거나 틀리면 호출하지 않는다', async () => {
      confirmed.length = 0;
      assert.equal((await post(app, confirmation(URL_OK))).statusCode, 403);
      assert.equal((await post(app, sign(confirmation(URL_OK), other.key))).statusCode, 403);
      const signed = sign(confirmation(URL_OK), good.key);
      assert.equal((await post(app, { ...signed, SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?evil' })).statusCode, 403);
      assert.deepEqual(confirmed, []);
    });

    it('서명이 맞아도 SNS 호스트가 아닌 SubscribeURL 은 호출하지 않는다', async () => {
      confirmed.length = 0;
      for (const url of [
        'https://evil.example.com/confirm',
        'https://169.254.169.254.amazonaws.com/latest/meta-data',
        'https://attacker-bucket.s3.amazonaws.com/x',
        'http://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      ]) {
        const res = await post(app, sign(confirmation(url), good.key));
        assert.equal(res.statusCode, 200, url);
      }
      assert.deepEqual(confirmed, []);
    });

    it('허용 목록에 없는 토픽의 구독 확인은 거절한다', async () => {
      confirmed.length = 0;
      const res = await post(strictApp, sign(confirmation(URL_OK, 'arn:aws:sns:us-east-1:999999999999:attacker-topic'), good.key));
      assert.equal(res.statusCode, 403);
      assert.deepEqual(confirmed, []);
    });

    it('UnsubscribeConfirmation 은 서명만 확인하고 SubscribeURL 은 부르지 않는다', async () => {
      confirmed.length = 0;
      const msg = { ...confirmation(URL_OK), Type: 'UnsubscribeConfirmation' };
      assert.equal((await post(app, sign(msg, good.key))).statusCode, 200);
      assert.deepEqual(confirmed, []);
    });
  });
});
