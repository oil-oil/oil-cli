import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './io.js';

const exec = promisify(execFile);

export async function openBrowser(value, platform = process.platform, runner = exec) {
  let url;
  try {
    url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new CliError('服务返回的浏览器链接无效。', 1, 'invalid_response'); }
  const options = { timeout: 5000, windowsHide: true, maxBuffer: 1024, env: process.env };
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = platform === 'win32'
    ? ['/d', '/v:off', '/s', '/c', 'start "" "%OIL_BROWSER_URL%"']
    : [url.href];
  if (platform === 'win32') options.env = { ...process.env, OIL_BROWSER_URL: url.href };
  try { await runner(command, args, options); return true; }
  catch { return false; }
}
