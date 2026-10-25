/**
 * 真实账号冒烟测试：发一条极短消息，验证登录 Cookie 与上游对话链路。
 * 会消耗一次豆包对话额度，必须显式加 --yes。
 *
 * 用法：pnpm smoke -- --yes [--model doubao-fast]
 */

import { getSession, initTokenManager } from '../src/auth';
import { DoubaoClient } from '../src/doubaoClient';
import { DEFAULT_MODEL } from '../src/config';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  initTokenManager();
  if (!process.argv.includes('--yes')) {
    console.log('将向豆包发送一条测试消息（消耗少量额度）。确认后请加 --yes：');
    console.log('  pnpm smoke -- --yes');
    return;
  }
  const model = argValue('--model') || DEFAULT_MODEL;
  const state = await getSession();
  const client = new DoubaoClient(state);
  console.log(`model=${model} mode=${client.chatMode} uid=${state.uid || '<empty>'}`);
  console.log('发送：请只回复两个字：收到');
  let text = '';
  let reasoning = '';
  let mode = '';
  for await (const d of client.chat({
    model,
    messages: [{ role: 'user', content: '请只回复两个字：收到' }],
    onMode: (m) => {
      mode = m;
    },
  })) {
    if (d.reasoning) {
      reasoning += d.reasoning;
      process.stdout.write(`\x1b[2m${d.reasoning}\x1b[0m`);
    }
    if (d.text) {
      text += d.text;
      process.stdout.write(d.text);
    }
  }
  console.log('\n---');
  console.log('mode:', mode || '<unknown>');
  console.log('text:', JSON.stringify(text));
  console.log('reasoning:', JSON.stringify(reasoning.slice(0, 200)));
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke failed:', e.message);
  if (e?.kind) console.error('kind:', e.kind, 'code:', e.code, 'status:', e.status);
  process.exit(1);
});
