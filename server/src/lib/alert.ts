import { config } from '../config.js';

/**
 * 사람한테 알리기.
 *
 * 발송은 되돌릴 수 없는데다 3만 통이 30분에 걸쳐 나가므로, 중간에 무너져도
 * 화면을 들여다보지 않으면 모른다. 슬랙 incoming webhook 형식으로 던진다
 * (Discord·Teams 등 대부분 { text } 를 받는다).
 *
 * 알림이 실패해도 발송은 계속돼야 한다 — 여기서 던지는 예외는 삼킨다.
 */
export type AlertLevel = 'info' | 'warn' | 'error';

const ICON: Record<AlertLevel, string> = { info: '✅', warn: '⚠️', error: '🚨' };

export function alertsEnabled(): boolean {
  return Boolean(config.alertWebhook);
}

export async function alert(level: AlertLevel, title: string, lines: string[] = []): Promise<void> {
  const text = [`${ICON[level]} *mailroom* — ${title}`, ...lines.map((l) => `• ${l}`)].join('\n');
  if (!config.alertWebhook) {
    if (level !== 'info') console.warn(`[alert] ${title} ${lines.join(' / ')}`);
    return;
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(config.alertWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) console.warn(`[alert] webhook ${res.status}`);
  } catch (e) {
    console.warn('[alert] 실패', (e as Error).message);
  }
}

export function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return `${Math.round((part / whole) * 1000) / 10}%`;
}
