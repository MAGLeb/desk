// Builds test/sample.canvas by driving the real MCP server the way an agent would.
// Usage: node scripts/sample.mjs <project-dir>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = path.resolve(process.argv[2] ?? 'sample-project');
fs.mkdirSync(dir, { recursive: true });
fs.rmSync(path.join(dir, '.desk'), { recursive: true, force: true });

const client = new Client({ name: 'sample', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp-server.js')], cwd: dir }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`${name}: ${r.content[0].text}`);
  if (r.isError) process.exit(1);
};

await call('board_focus', { text: '**Goal this week:** ship the paid plans beta\nFocus today: Stripe webhooks', color: 'orange' });
await call('board_add', {
  items: [
    {
      id: 'now',
      label: 'Now',
      color: 'yellow',
      children: [
        { id: 'hooks', text: '**Stripe webhooks**\n- [x] Verify the signature\n- [ ] Handle retries\n- [ ] Logs in `billing/webhooks.ts:42`' },
        { id: 'plans', text: '**Plans**\n- [ ] Prices in config\n- [ ] 14-day trial' },
      ],
    },
    {
      id: 'next',
      label: 'Next',
      children: [
        { text: '**Emails**\n- [ ] Receipt after payment\n- [ ] Reminder 3 days before renewal' },
        { text: '**Cancel subscription** from the account page' },
      ],
    },
    {
      id: 'done',
      label: 'Done',
      color: 'green',
      children: [
        { text: '**Data model**\n- [x] `Subscription` table\n- [x] Migrations' },
        { text: '**Pricing page**\n- [x] Copy\n- [x] Plan comparison' },
      ],
    },
  ],
});
// 269 = (3 columns + 2 gaps − 2 arrow gaps) / 3, so the diagram lines up with the columns.
await call('board_add', {
  items: [
    { id: 'checkout', text: '**Checkout Session**\nthe user pays on Stripe', width: 269 },
    { id: 'webhook', text: '**Webhook**\n`checkout.session.completed`', color: 'yellow', width: 269 },
    { id: 'db', text: '**Database**\nthe subscription is active', width: 269 },
  ],
  arrows: [
    { from: 'checkout', to: 'webhook', label: 'event' },
    { from: 'webhook', to: 'db', label: 'write' },
  ],
  layout: 'flow-right',
  position: { below: 'now' },
});
await call('board_add', {
  items: [{ id: 'risk', text: '**Risk:** the webhook can arrive twice, so the handler must be idempotent', color: 'red', width: 269 }],
  arrows: [{ from: 'risk', to: 'webhook' }],
  position: { below: 'webhook' },
});
await client.close();
fs.copyFileSync(path.join(dir, '.desk', 'board.canvas'), 'test/sample.canvas');
console.log('→ test/sample.canvas');
