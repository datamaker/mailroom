#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { ApiError } from './api.js';
import { loginCommand } from './commands/login.js';
import { listsCommand } from './commands/lists.js';
import { subscribersCommand } from './commands/subscribers.js';
import { campaignsCommand } from './commands/campaigns.js';
import { templatesCommand } from './commands/templates.js';
import { automationsCommand } from './commands/automations.js';
import { statsCommand } from './commands/stats.js';
import { doctorCommand } from './commands/doctor.js';
import { mcpCommand } from './commands/mcp.js';

const program = new Command();

program
  .name('mailroom')
  .description('mailroom CLI — 사내 뉴스레터 주소록·발송·통계')
  .version('0.1.0');

program.addCommand(loginCommand());
program.addCommand(listsCommand());
program.addCommand(subscribersCommand());
program.addCommand(campaignsCommand());
program.addCommand(templatesCommand());
program.addCommand(automationsCommand());
program.addCommand(statsCommand());
program.addCommand(doctorCommand());
program.addCommand(mcpCommand());

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ApiError) {
    console.error(chalk.red(`오류 ${err.status}`), err.message);
  } else {
    console.error(chalk.red('오류'), (err as Error).message);
  }
  process.exit(1);
});
