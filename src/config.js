import { homedir } from 'node:os';
import path from 'node:path';
import { chmod, mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CliError } from './io.js';

export function configPath(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    if (!env.APPDATA) throw new CliError('未设置 APPDATA，无法定位配置文件。');
    return path.join(env.APPDATA, 'oil', 'config.json');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config'), 'oil', 'config.json');
}

export async function readAuth() {
  if (process.env.OIL_TOKEN) return { token: process.env.OIL_TOKEN, email: null };
  try {
    const file = configPath();
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (typeof data.token !== 'string' || !data.token || typeof data.email !== 'string' || !data.email) throw new Error('invalid config');
    await chmod(file, 0o600);
    return { token: data.token, email: data.email };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new CliError('无法读取配置，请检查 config.json 和文件权限。', 1, 'config_read');
  }
}

export async function saveAuth(token, email) {
  const file = configPath();
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ token, email }) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch {
    throw new CliError('无法保存令牌，请检查配置目录权限。', 1, 'config_write');
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
  return file;
}

export async function logout() {
  try { await rm(configPath(), { force: true }); }
  catch { throw new CliError('无法删除配置，请检查文件权限。', 1, 'config_write'); }
}
