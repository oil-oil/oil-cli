import { t } from './i18n.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { chmod, mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CliError } from './io.js';

export function configPath(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    if (!env.APPDATA) throw new CliError(t('missingAppdata'));
    return path.join(env.APPDATA, 'oil', 'config.json');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config'), 'oil', 'config.json');
}

export function isPendingDevice(device) {
  return device && ['device_code', 'user_code', 'verification_uri', 'verification_uri_complete'].every((key) => typeof device[key] === 'string' && device[key])
    && Number.isFinite(device.expires_at) && device.expires_at > 0 && Number.isFinite(device.interval) && device.interval > 0;
}

const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export function isPendingCheckout(checkout) {
  if (!checkout || !['id', 'url', 'skill', 'plan', 'api', 'token_hash'].every((key) => typeof checkout[key] === 'string' && checkout[key])) return false;
  try {
    const url = new URL(checkout.url);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && /^[a-f0-9]{64}$/.test(checkout.token_hash);
  } catch { return false; }
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
    if (data.pending_checkout !== undefined && !isPendingCheckout(data.pending_checkout)) throw new Error('invalid config');
    if (!hasAuth && !data.pending_device && !data.pending_checkout) throw new Error('invalid config');
    await chmod(file, 0o600);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new CliError(t('configRead'), 1, 'config_read');
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

// 会话只能由创建它的令牌向同一服务器查询；不把环境令牌写进配置。
export async function readPendingCheckout(skill, token, api) {
  const checkout = (await readConfig())?.pending_checkout;
  return checkout?.skill === skill && checkout.token_hash === tokenHash(token) && origin(checkout.api) === origin(api) ? checkout : null;
}

export async function savePendingCheckout(checkout, token, api) {
  return await saveConfig({ ...await readConfig(), pending_checkout: { ...checkout, api, token_hash: tokenHash(token) } });
}

export async function clearPendingCheckout(id) {
  const data = await readConfig();
  if (data?.pending_checkout?.id !== id) return;
  delete data.pending_checkout;
  if (data.token || data.pending_device) await saveConfig(data);
  else await logout();
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
    throw new CliError(t('configWrite'), 1, 'config_write');
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
  return file;
}

// 保存令牌时一并清除待领取记录；显式令牌登录也可修复坏配置。
export async function saveAuth(token, email, api) {
  let pending;
  // 显式令牌登录仍能修复坏配置；同一令牌重新登录时保留付款进度。
  try {
    const checkout = (await readConfig())?.pending_checkout;
    if (checkout && checkout.token_hash === tokenHash(token) && origin(checkout.api) === origin(api)) pending = checkout;
  } catch (error) { if (!(error instanceof CliError) || error.error !== 'config_read') throw error; }
  return await saveConfig({ token, email, api, ...(pending ? { pending_checkout: pending } : {}) });
}

export async function savePendingDevice(device) {
  return await saveConfig({ ...await readConfig(), pending_device: device });
}

export async function clearPendingDevice() {
  const data = await readConfig();
  if (!data?.pending_device) return;
  delete data.pending_device;
  if (data.token || data.pending_checkout) await saveConfig(data);
  else await logout();
}

export async function logout() {
  try { await rm(configPath(), { force: true }); }
  catch { throw new CliError(t('configDelete'), 1, 'config_write'); }
}
