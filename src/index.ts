import { runServer } from './server';

runServer().catch((e) => {
  console.error('[doubao] 启动失败:', e);
  process.exit(1);
});
