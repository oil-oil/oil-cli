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

export function isPendingDevice(device) {
  return device && ['device_code', 'user_code', 'verification_uri', 'verification_uri_complete'].every((key) => typeof device[key] === 'string' && device[key])
    && Number.isFinite(device.expires_at) && device.expires_at > 0 && Number.isFinite(device.interval) && device.interval > 0;
}

async function readConfig() {
  try {
    const file = configPath();
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid config');
    const hasAuth = data.token !== undefined || data.email !== undefined;
    if (hasAuth && (typeof data.token !== 'string' || !data.token || typeof data.email !== 'string' || !data.email)) throw new Error('invalid config');
    if (data.api !== undefined && typeof data.api !== 'string') throw new Error('invalid config');
    if (data.pending_device !== undefined && !isPendingDevice(data.pending_device)) throw new Error('invalid config');
    if (!hasAuth && !data.pending_device) throw new Error('invalid config');
    await chmod(file, 0o600);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new CliError('无法读取配置，请检查 config.json 和文件权限。', 1, 'config_read');
  }
}

const origin = (value) => { try { return new URL(value).origin; } catch { return null; } };

// 保存的令牌只发给签发它的服务器：OIL_API 指向别处时当作没有登录。
// 旧配置没有记录服务器，视为默认的 ui.oiloil.org。OIL_TOKEN 是用户显式提供的，不受限制。
export async function readAuth(api) {
  if (process.env.OIL_TOKEN) return { token: process.env.OIL_TOKEN, email: null };
  const data = await readConfig();
  if (!data?.token) return null;
  if (origin(data.api || 'https://ui.oiloil.org') !== origin(api)) return null;
  return { token: data.token, email: data.email };
}

export async function readPendingDevice() {
  return (await readConfig())?.pending_device ?? null;
}

async function saveConfig(data) {
  const file = configPath();
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch {
    throw new CliError('无法保存配置，请检查配置目录权限。', 1, 'config_write');
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
  return file;
}

// 保存令牌时一并清除待领取记录；显式令牌登录也可修复坏配置。
export async function saveAuth(token, email, api) {
  return await saveConfig({ token, email, api });
}

export async function savePendingDevice(device) {
  return await saveConfig({ ...await readConfig(), pending_device: device });
}

export async function clearPendingDevice() {
  const data = await readConfig();
  if (!data?.pending_device) return;
  delete data.pending_device;
  if (data.token) await saveConfig(data);
  else await logout();
}

export async function logout() {
  try { await rm(configPath(), { force: true }); }
  catch { throw new CliError('无法删除配置，请检查文件权限。', 1, 'config_write'); }
}
