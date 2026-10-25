/**
 * 自包含网页登录：默认直接打开抖音官方授权页，本地回调换票 → 加密落盘。
 * DOUBAO_LOGIN_FLOW=doubao 时改为本机展示豆包网页登录二维码。
 * 完全不依赖豆包电脑版；凭证存入本地加密存储，供 pnpm serve 复用。
 *
 * 用法：pnpm log-in [--no-browser]
 */

import { interactiveLogin } from '../src/auth';
import { settings } from '../src/config';

async function main(): Promise<void> {
  console.log(`登录形态: ${settings.loginFlow}`);
  console.log(`登录网关: ${settings.authBaseUrl}`);
  console.log(`对话网关: ${settings.baseUrl}`);
  console.log(`凭证文件: ${settings.credentialPath}`);

  const state = await interactiveLogin({
    openBrowser: !process.argv.includes('--no-browser'),
    onLoginPage: (url) => console.log(`授权页: ${url}`),
  });
  console.log('\n登录完成。现在可以运行 `pnpm serve` 启动插件。');
  console.log(`uid=${state.uid || '<空>'}  nickname=${state.nickname || '<空>'}  Cookie=${state.cookies.length} 条`);
  process.exit(0);
}

main().catch((e) => {
  console.error('login failed:', e.message);
  process.exit(1);
});
