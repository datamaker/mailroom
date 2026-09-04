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
    .command('export <id> [outFile]')
    .description('템플릿을 HTML로 뽑기')
    .action(async (id, outFile) => {
      const { html } = await api<any>(`/api/templates/${id}/html`);
      if (outFile) {
        writeFileSync(outFile, html);
        console.log(`${chalk.green('저장됨')} ${outFile}`);
      } else process.stdout.write(html);
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
