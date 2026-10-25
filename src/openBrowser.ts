import { spawn } from 'node:child_process';

/**
 * 尽力在系统默认浏览器打开 URL；失败不抛错（终端会打印链接供手动打开）。
 *
 * Windows 上不能直接 `cmd /c start "" <url>`：URL 里的 `&` 会被 cmd.exe
 * 当作命令分隔符，导致参数被截断（抖音 OAuth URL 尤其明显）。
 * 这里用 rundll32 的 FileProtocolHandler，URL 作为单个参数传递，不经过 cmd 解析。
 */
export function openExternal(url: string): void {
  try {
    if (process.platform === 'win32') {
      const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', () => {});
      child.unref();
      return;
    }
    const cmd =
      process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
    const child = spawn(cmd.file, cmd.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 忽略：链接已打印 */
  }
}
