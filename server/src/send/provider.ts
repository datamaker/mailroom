import { config } from '../config.js';

export interface OutgoingMessage {
  to: string;
  from: string;         // "이름 <주소>" 형태 허용
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  /** SES 이벤트를 캠페인/수신자로 되돌려 붙이기 위한 태그 */
  tags?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
}

export interface MailProvider {
  readonly name: string;
  send(msg: OutgoingMessage): Promise<SendResult>;
}

class ConsoleProvider implements MailProvider {
  readonly name = 'console';
  async send(msg: OutgoingMessage): Promise<SendResult> {
    console.log(`[mail:console] to=${msg.to} subject=${msg.subject} (${msg.html.length} bytes)`);
    return { messageId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}

class SesProvider implements MailProvider {
  readonly name = 'ses';
  private client: any;

  private async getClient() {
    if (!this.client) {
      const { SESv2Client } = await import('@aws-sdk/client-sesv2');
      this.client = new SESv2Client({ region: config.send.ses.region });
    }
    return this.client;
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = await this.getClient();

    // SES 태그는 [A-Za-z0-9_-]만 허용한다 — 값이 어긋나면 발송 자체가 400으로 죽는다.
    const tags = Object.entries(msg.tags || {})
      .map(([Name, Value]) => ({ Name, Value: String(Value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) }))
      .slice(0, 10);

    const res = await client.send(
      new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to] },
        ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
        ConfigurationSetName: config.send.ses.configurationSet || undefined,
        EmailTags: tags.length ? tags : undefined,
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: msg.html, Charset: 'UTF-8' },
              ...(msg.text ? { Text: { Data: msg.text, Charset: 'UTF-8' } } : {}),
            },
            Headers: msg.headers
              ? Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value }))
              : undefined,
          },
        },
      })
    );
    return { messageId: res.MessageId as string };
  }
}

class SmtpProvider implements MailProvider {
  readonly name = 'smtp';
  private transport: any;

  private async getTransport() {
    if (!this.transport) {
      const nodemailer = (await import('nodemailer')).default;
      this.transport = nodemailer.createTransport({
        host: config.send.smtp.host,
        port: config.send.smtp.port,
        secure: config.send.smtp.secure,
        auth: config.send.smtp.user
          ? { user: config.send.smtp.user, pass: config.send.smtp.pass }
          : undefined,
        pool: true,
        maxConnections: 5,
      });
    }
    return this.transport;
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const transport = await this.getTransport();
    const info = await transport.sendMail({
      from: msg.from,
      to: msg.to,
      replyTo: msg.replyTo,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers: msg.headers,
    });
    return { messageId: String(info.messageId || '').replace(/^<|>$/g, '') };
  }
}

/**
 * 발송 잠금을 프로바이더 경계에서 강제한다. 라우트 가드만 두면 새 발송 경로를
 * 하나 추가할 때마다 빠뜨릴 수 있는데, 여기서 막으면 어떤 경로로도 못 나간다.
 */
class LockedProvider implements MailProvider {
  readonly name: string;
  constructor(private inner: MailProvider) {
    this.name = `${inner.name}(locked)`;
  }
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const to = msg.to.trim().toLowerCase();
    if (!config.send.allowedRecipients.includes(to)) {
      throw new Error(
        `발송이 잠겨 있습니다(MAILROOM_SEND_LOCK). ${msg.to} 로 보내지 않았습니다. ` +
          '허용 주소는 MAILROOM_ALLOWED_RECIPIENTS 에만 있습니다.'
      );
    }
    return this.inner.send(msg);
  }
}

export function sendLocked() {
  return config.send.lock;
}

let provider: MailProvider | null = null;

export function mailProvider(): MailProvider {
  if (provider) return provider;
  switch (config.send.provider) {
    case 'smtp':
      provider = new SmtpProvider();
      break;
    case 'console':
      provider = new ConsoleProvider();
      break;
    default:
      provider = new SesProvider();
  }
  if (config.send.lock) provider = new LockedProvider(provider);
  return provider;
}

/** 테스트에서 주입할 수 있게 열어 둔다. */
export function setMailProvider(p: MailProvider) {
  provider = p;
}

export function formatFrom(name: string | null | undefined, email: string) {
  if (!name) return email;
  // 헤더는 latin1만 안전하다 — 한글 발신자명은 MIME 인코딩해야 한다.
  if (/^[\x20-\x7E]*$/.test(name)) return `"${name.replace(/"/g, '')}" <${email}>`;
  const encoded = `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
  return `${encoded} <${email}>`;
}
