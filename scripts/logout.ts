/**
 * 删除本地加密凭证（退出登录）。
 * 用法：pnpm log-out -- --yes
 */

import { settings } from '../src/config';
import { deleteBlob, readBlob } from '../src/credentialStore';

function main(): void {
  if (!process.argv.includes('--yes')) {
    console.log('将删除本地豆包凭证：' + settings.credentialPath);
    console.log('确认后请加 --yes 执行：pnpm log-out -- --yes');
    return;
  }
  const existed = readBlob(settings.credentialPath) !== null;
  if (!existed) {
    console.log('本地凭证不存在，无需退出。');
    return;
  }
  const removed = deleteBlob(settings.credentialPath);
  console.log(removed ? `已删除 ${settings.credentialPath}` : '本地凭证不存在。');
  console.log('如需继续使用，请重新运行 `pnpm log-in`。');
}

main();
