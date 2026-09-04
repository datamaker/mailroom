import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { api } from '../api.js';
import { markdownToBlocks, wrapNewsletter } from '../markdown.js';

/**
 * MCP 서버 모드. Claude 같은 도구가 mailroom 을 직접 다룰 수 있게 한다.
 * 발송처럼 되돌릴 수 없는 동작은 confirm 플래그를 강제한다.
 */
export function mcpCommand() {
  return new Command('mcp')
    .description('MCP 서버로 실행 (stdio) — AI 도구에서 mailroom 조작')
    .action(async () => {
      const server = new McpServer({ name: 'mailroom', version: '0.1.0' });
      registerTools(server);
      await server.connect(new StdioServerTransport());
    });
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

function registerTools(server: McpServer) {
  server.tool(
    'mailroom_lists',
    '주소록(구독자 목록) 전체를 조회한다. 구독자 수와 주소록 ID를 확인할 때 쓴다.',
    {},
    async () => ok(await api('/api/lists'))
  );

  server.tool(
    'mailroom_list_detail',
    '주소록 하나의 상세 정보 — 사용자 정의 필드, 그룹, 세그먼트, 구독 상태별 인원.',
    { listId: z.string().describe('주소록 ID') },
    async ({ listId }) => {
      const [detail, fields, groups, segments] = await Promise.all([
        api(`/api/lists/${listId}`),
        api(`/api/lists/${listId}/fields`),
        api(`/api/lists/${listId}/groups`),
        api(`/api/lists/${listId}/segments`),
      ]);
      return ok({ ...(detail as object), ...(fields as object), ...(groups as object), ...(segments as object) });
    }
  );

  server.tool(
    'mailroom_subscribers_search',
    '주소록에서 구독자를 검색한다. 이메일과 모든 사용자 정의 필드 값을 함께 훑는다.',
    {
      listId: z.string(),
      query: z.string().optional().describe('검색어'),
      status: z.enum(['subscribed', 'unsubscribed', 'deleted', 'all']).optional(),
      segmentId: z.string().optional(),
      groupId: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) =>
      ok(
        await api(`/api/lists/${args.listId}/subscribers`, {
          query: {
            q: args.query,
            status: args.status,
            segmentId: args.segmentId,
            groupId: args.groupId,
            limit: args.limit ?? 20,
          },
        })
      )
  );

  server.tool(
    'mailroom_subscriber_add',
    '구독자를 추가하거나 갱신한다. 이미 있으면 필드만 갱신되고, 수신거부한 사람을 되살리지는 않는다.',
    {
      listId: z.string(),
      email: z.string(),
      fields: z.record(z.string()).optional().describe('name, company 등 사용자 정의 필드'),
      adAgreed: z.boolean().optional(),
      groupIds: z.array(z.string()).optional(),
    },
    async (args) =>
      ok(
        await api(`/api/lists/${args.listId}/subscribers`, {
          method: 'POST',
          body: {
            subscribers: [{ email: args.email, ...(args.fields ?? {}), ad_agreed: args.adAgreed }],
            groupIds: args.groupIds,
          },
        })
      )
  );

  server.tool(
    'mailroom_campaigns',
    '이메일(캠페인) 목록. 상태·주소록·태그로 걸러 본다.',
    {
      status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'all']).optional(),
      listId: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => ok(await api('/api/campaigns', { query: { ...args, limit: args.limit ?? 20 } as any }))
  );

  server.tool(
    'mailroom_campaign_get',
    '이메일 하나의 상세 — 제목, 발신자, 블록 콘텐츠, 상태.',
    { campaignId: z.string() },
    async ({ campaignId }) => ok(await api(`/api/campaigns/${campaignId}`))
  );

  server.tool(
    'mailroom_campaign_create',
    [
      '마크다운으로 뉴스레터를 새로 만든다(초안 상태, 발송하지 않음).',
      '지원 문법: # 제목, 본문 문단, - 목록, ![alt](이미지URL), [버튼문구](링크){.button}, --- 구분선.',
      '$%name%$ 같은 메일머지 태그를 넣으면 수신자별로 치환된다.',
    ].join(' '),
    {
      listId: z.string().describe('보낼 주소록 ID'),
      subject: z.string().describe('이메일 제목'),
      markdown: z.string().describe('본문 마크다운'),
      senderName: z.string().optional(),
      senderEmail: z.string().optional(),
      tags: z.array(z.string()).optional(),
      isAd: z.boolean().optional().describe('광고성 이메일이면 true — 제목에 (광고)가 붙는다'),
    },
    async (args) => {
      const content = wrapNewsletter(markdownToBlocks(args.markdown));
      return ok(
        await api('/api/campaigns', {
          method: 'POST',
          body: {
            list_id: args.listId,
            subject: args.subject,
            sender_name: args.senderName,
            sender_email: args.senderEmail,
            tags: args.tags,
            is_ad: args.isAd ?? false,
            content,
          },
        })
      );
    }
  );

  server.tool(
    'mailroom_campaign_update',
    '초안 이메일의 제목이나 본문(마크다운)을 고친다. 발송된 이메일은 수정할 수 없다.',
    {
      campaignId: z.string(),
      subject: z.string().optional(),
      markdown: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.subject) body.subject = args.subject;
      if (args.tags) body.tags = args.tags;
      if (args.markdown) body.content = wrapNewsletter(markdownToBlocks(args.markdown));
      if (!Object.keys(body).length) return fail('변경할 항목이 없습니다.');
      return ok(await api(`/api/campaigns/${args.campaignId}`, { method: 'PATCH', body }));
    }
  );

  server.tool(
    'mailroom_campaign_target',
    '발송 대상을 그룹/세그먼트로 좁힌다. 설정 후 대상 인원을 돌려준다.',
    {
      campaignId: z.string(),
      groupIds: z.array(z.string()).optional(),
      segmentIds: z.array(z.string()).optional(),
      adAgreedOnly: z.boolean().optional(),
    },
    async (args) => {
      await api(`/api/campaigns/${args.campaignId}`, {
        method: 'PATCH',
        body: {
          target: {
            groupIds: args.groupIds,
            segmentIds: args.segmentIds,
            adAgreedOnly: args.adAgreedOnly ?? false,
          },
        },
      });
      return ok(await api(`/api/campaigns/${args.campaignId}/audience`));
    }
  );

  server.tool(
    'mailroom_campaign_check',
    '발송 전 점검 — 대상 인원과 빠진 항목(제목/발신자/푸터/발신자 인증)을 알려준다.',
    { campaignId: z.string() },
    async ({ campaignId }) => ok(await api(`/api/campaigns/${campaignId}/audience`))
  );

  server.tool(
    'mailroom_campaign_preview',
    '렌더된 이메일 HTML을 돌려준다. 길면 앞부분만 보여준다.',
    { campaignId: z.string(), sample: z.boolean().optional().describe('메일머지에 샘플 값 채우기') },
    async ({ campaignId, sample }) => {
      const res = await api<any>(`/api/campaigns/${campaignId}/html`, {
        query: { sample: sample ? '1' : undefined },
      });
      const html: string = res.html;
      return ok({
        subject: res.subject,
        bytes: html.length,
        html: html.length > 20000 ? html.slice(0, 20000) + '\n<!-- 이하 생략 -->' : html,
      });
    }
  );

  server.tool(
    'mailroom_campaign_test_send',
    '테스트 수신자(최대 5명)에게만 보낸다. 구독자에게는 가지 않는다.',
    { campaignId: z.string(), recipients: z.array(z.string()).max(5) },
    async ({ campaignId, recipients }) =>
      ok(await api(`/api/campaigns/${campaignId}/test`, { method: 'POST', body: { recipients } }))
  );

  server.tool(
    'mailroom_campaign_send',
    [
      '구독자 전원에게 실제로 발송한다. 되돌릴 수 없다.',
      'confirm 을 true 로 넘겨야 실행되며, 그 전에 사람에게 대상 인원과 제목을 확인받아야 한다.',
    ].join(' '),
    {
      campaignId: z.string(),
      confirm: z.boolean().describe('사람이 발송을 명시적으로 승인했을 때만 true'),
    },
    async ({ campaignId, confirm }) => {
      const pre = await api<any>(`/api/campaigns/${campaignId}/audience`);
      if (!confirm) {
        return fail(
          `발송하지 않았습니다. 대상 ${pre.count}명. 사람에게 확인받은 뒤 confirm: true 로 다시 호출하세요.` +
            (pre.issues.length ? `\n점검 사항: ${pre.issues.join(' / ')}` : '')
        );
      }
      const res = await api(`/api/campaigns/${campaignId}/send`, { method: 'POST' });
      return ok({ ...(res as object), audience: pre.count });
    }
  );

  server.tool(
    'mailroom_campaign_schedule',
    '예약 발송을 건다. ISO 8601 시각을 넘긴다. 취소는 mailroom_campaign_cancel.',
    {
      campaignId: z.string(),
      scheduledAt: z.string().describe('ISO 8601, 예: 2026-09-07T07:00:00+09:00'),
      confirm: z.boolean().describe('사람이 예약을 승인했을 때만 true'),
    },
    async ({ campaignId, scheduledAt, confirm }) => {
      if (!confirm) return fail('예약하지 않았습니다. 사람에게 확인받은 뒤 confirm: true 로 다시 호출하세요.');
      return ok(
        await api(`/api/campaigns/${campaignId}/schedule`, {
          method: 'POST',
          body: { scheduled_at: scheduledAt },
        })
      );
    }
  );

  server.tool(
    'mailroom_campaign_cancel',
    '예약되었거나 일시중지된 발송을 취소한다.',
    { campaignId: z.string() },
    async ({ campaignId }) => ok(await api(`/api/campaigns/${campaignId}/cancel`, { method: 'POST' }))
  );

  server.tool(
    'mailroom_campaign_stats',
    '발송 통계 — 발송성공/오픈/클릭/수신거부, 시간별 추이, 많이 클릭한 링크, 오픈 환경.',
    { campaignId: z.string() },
    async ({ campaignId }) => ok(await api(`/api/campaigns/${campaignId}/stats`))
  );

  server.tool(
    'mailroom_stats_overview',
    '기간·주소록·태그로 묶은 전체 발송 통계.',
    {
      from: z.string().optional().describe('YYYY-MM-DD'),
      to: z.string().optional(),
      listIds: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      interval: z.enum(['week', 'month']).optional(),
    },
    async (args) =>
      ok(
        await api('/api/stats/overview', {
          query: {
            from: args.from,
            to: args.to,
            listIds: args.listIds?.join(','),
            tags: args.tags?.join(','),
            interval: args.interval,
          },
        })
      )
  );
}
