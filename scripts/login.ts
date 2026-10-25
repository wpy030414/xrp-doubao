/**
 * 网页扫码登录（自包含）：启动本机登录页 → 手机扫码 → 收集 Cookie → 加密落盘。
 * 完全不依赖豆包电脑版；凭证存入本地加密存储，供 pnpm serve 复用。
 *
 * 用法：pnpm log-in [--no-browser]
 */

import { interactiveLogin } from '../src/auth';
import { settings } from '../src/config';

async function main(): Promise<void> {
  console.log(`登录网关: ${settings.authBaseUrl}`);
  console.log(`对话网关: ${settings.baseUrl}`);
  console.log(`凭证文件: ${settings.credentialPath}`);

  const state = await interactiveLogin({
    openBrowser: !process.argv.includes('--no-browser'),
    onLoginPage: (url) => console.log(`登录页: ${url}`),
  });
  console.log('\n登录完成。现在可以运行 `pnpm serve` 启动插件。');
  console.log(`uid=${state.uid || '<空>'}  nickname=${state.nickname || '<空>'}  Cookie=${state.cookies.length} 条`);
  process.exit(0);
}

main().catch((e) => {
  console.error('login failed:', e.message);
  process.exit(1);
});
