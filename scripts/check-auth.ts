/**
 * 诊断：检查本地凭证、Cookie 名称、账号信息与上游连通性（不打印任何 Cookie 值）。
 * 用法：pnpm check-auth
 *
 * 默认（DOUBAO_AUTO_LOGIN=0）不弹登录页：未登录时只提示 pnpm log-in。
 */

import { fetchAccountInfo, getAuthStatus, getSession, initTokenManager, jarOf } from '../src/auth';
import { settings } from '../src/config';
import { queryDoubaoAccount } from '../src/webLogin';
import { getNeedsCaptcha } from '../src/doubaoClient';

async function main(): Promise<void> {
  initTokenManager();
  console.log('登录网关      :', settings.authBaseUrl);
  console.log('对话网关      :', settings.baseUrl);
  console.log('凭证文件      :', settings.credentialPath);

  const status = getAuthStatus();
  console.log('登录状态      :', JSON.stringify(status, null, 2));

  if (!status.loggedIn) {
    console.log('\n尚未登录（或凭证缺失）。运行 `pnpm log-in` 完成网页扫码登录。');
    process.exit(status.storeKind === 'none' ? 1 : 0);
  }

  const state = await getSession();
  console.log('uid           :', state.uid || '<empty>');
  console.log('nickname      :', state.nickname || '<empty>');
  console.log('source        :', state.source);
  console.log('cookie count  :', state.cookies.length);
  console.log('cookie names  :', jarOf(state).names().join(', '));
  console.log('cookie lens   :', jsend(jarOf(state).describe()));
  console.log('device id     :', state.device.deviceId);
  console.log('web id        :', state.device.webId);
  console.log('fp            :', state.device.fp);
  console.log('needs captcha :', getNeedsCaptcha());

  const account = await fetchAccountInfo(state);
  const direct = await queryDoubaoAccount(jarOf(state), { baseUrl: settings.baseUrl });
  console.log('account(api)  :', account ? JSON.stringify(account) : '<不可用（不影响对话）>');
  console.log('account(probe):', direct ? JSON.stringify(direct) : '<不可用（不影响对话）>');

  console.log('\n提示：账号接口可能要求 a_bogus 签名；失败不代表对话 Cookie 无效。');
  console.log('若对话报 710012001，请重新 `pnpm log-in`；若报 710022004，先在浏览器完成人机验证。');
  process.exit(0);
}

function jsend(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

main().catch((e) => {
  console.error('check-auth failed:', e.message);
  process.exit(1);
});
