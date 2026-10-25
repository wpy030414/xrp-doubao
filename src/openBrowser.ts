import { spawn } from 'node:child_process';

/** 尽力在系统默认浏览器打开 URL；失败不抛错（终端会打印链接供手动打开） */
export function openExternal(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '""', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  try {
    const child = spawn(cmd.file, cmd.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 忽略：链接已打印 */
  }
}
