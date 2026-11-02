import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api.js';
import { json, table, truncate, when } from '../format.js';

export function templatesCommand() {
  const cmd = new Command('templates').alias('tpl').description('템플릿 관리');

  cmd
    .command('ls')
    .description('템플릿 목록')
    .option('--json', 'JSON 출력')
    .action(async (opts) => {
      const { templates } = await api<any>('/api/templates');
      if (opts.json) return console.log(json(templates));
      console.log(
        table(
          templates.map((t: any) => ({
            ID: t.id.slice(0, 8),
            이름: truncate(t.name, 34),
            상자: t.block_count,
            마지막수정: when(t.updated_at),
          }))
        )
      );
    });

  cmd
    .command('import <htmlFile>')
    .description('이메일 HTML을 블록으로 되살려 템플릿으로 저장')
    .requiredOption('-n, --name <name>', '템플릿 이름')
    .action(async (file, opts) => {
      const html = readFileSync(file, 'utf8');
      const r = await api<any>('/api/templates/import', { method: 'POST', body: { html, name: opts.name } });
      console.log(
        `${chalk.green('가져옴')} ${r.template.name} ${chalk.dim(r.template.id)} — ` +
          `상자 ${r.stats.blocks}개, 이미지 ${r.stats.images}개` +
          (r.stats.rawCount ? `, 원본 그대로 남긴 상자 ${r.stats.rawCount}개` : '')
      );
    });

  cmd
    .command('show <id>')
    .description('템플릿 상자 목록 (id·종류·앞부분) — 어느 상자를 바꿀지 찾을 때')
    .option('--json', '템플릿 전체를 JSON 으로')
    .action(async (id, opts) => {
      const { template } = await api<any>(`/api/templates/${id}`);
      if (opts.json) return console.log(json(template));
      const blocks: any[] = template.content ?? [];
      console.log(chalk.bold(template.name), chalk.dim(template.id));
      console.log(`상자 ${blocks.length}개 · 마지막수정 ${when(template.updated_at)}`);
      console.log(
        table(
          blocks.map((b, i) => ({
            순서: i,
            ID: b.id,
            종류: b.type,
            내용: truncate(blockSummary(b), 60),
          }))
        )
      );
    });

  cmd
    .command('export <id> [outFile]')
    .description('템플릿을 HTML 로 뽑기 (--blocks 면 상자 JSON — 고쳐서 campaigns create --blocks 에 넣는다)')
    .option('--blocks', '렌더된 HTML 대신 상자(블록) JSON 배열로')
    .action(async (id, outFile, opts) => {
      let out: string;
      if (opts.blocks) {
        const { template } = await api<any>(`/api/templates/${id}`);
        out = JSON.stringify(template.content ?? [], null, 2) + '\n';
      } else {
        const { html } = await api<any>(`/api/templates/${id}/html`);
        out = html;
      }
      if (outFile) {
        writeFileSync(outFile, out);
        console.log(`${chalk.green('저장됨')} ${outFile} (${out.length} bytes)`);
      } else process.stdout.write(out);
    });

  cmd
    .command('from-campaign <campaignId>')
    .description('만든 이메일을 템플릿으로 저장')
    .requiredOption('-n, --name <name>', '템플릿 이름')
    .action(async (campaignId, opts) => {
      const r = await api<any>(`/api/templates/from-campaign/${campaignId}`, {
        method: 'POST',
        body: { name: opts.name },
      });
      console.log(`${chalk.green('저장됨')} ${r.template.name} ${chalk.dim(r.template.id)}`);
    });

  cmd
    .command('apply <campaignId> <templateId>')
    .description('작성 중인 이메일에 템플릿 입히기')
    .action(async (campaignId, templateId) => {
      await api(`/api/campaigns/${campaignId}/apply-template`, { method: 'POST', body: { templateId } });
      console.log(chalk.green('적용됨'));
    });

  cmd
    .command('rm <id>')
    .description('템플릿 삭제')
    .action(async (id) => {
      await api(`/api/templates/${id}`, { method: 'DELETE' });
      console.log('삭제됨');
    });

  return cmd;
}

/** 상자 한 줄 요약 — 텍스트 상자는 태그를 벗긴 본문, 나머지는 대표 속성 */
function blockSummary(b: any): string {
  switch (b.type) {
    case 'text':
    case 'html':
      return stripTags(b.html ?? '');
    case 'image':
      return b.alt || b.src || '';
    case 'button':
      return `${b.text ?? ''} → ${b.href ?? ''}`;
    case 'columns':
      return `${b.columns?.length ?? 0}단 ${stripTags(b.columns?.map((c: any) => c.html ?? '').join(' ') ?? '')}`;
    case 'webview':
      return b.text ?? '';
    case 'divider':
    case 'spacer':
    case 'footer':
      return '';
    default:
      return JSON.stringify(b).slice(0, 60);
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
