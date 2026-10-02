import { hostname, platform } from 'node:os';
import { CliError } from './io.js';
import { readAuth, saveAuth } from './config.js';

export const isCI = () => {
  const value = process.env.CI?.trim().toLowerCase();
  return Boolean(value && !['0', 'false', 'no', 'off'].includes(value));
};

const expired = () => new CliError('设备码已过期，请重新运行 oil login。', 1, 'expired_token');

export async function login(ctx, suppliedToken) {
  let token = suppliedToken, email;
  if (token) {
    ctx.output.remember(token);
    email = (await ctx.client.me(token)).email;
  } else {
    if (isCI()) throw new CliError('CI 环境需要设置 OIL_TOKEN，或先运行 oil login --token <令牌>。', 3, 'unauthorized', { token_environment: 'OIL_TOKEN' });
    const started = ctx.now();
    const device = await ctx.client.request('/api/cli/device', { method: 'POST', body: { client_name: hostname(), platform: platform() } });
    if (typeof device?.device_code !== 'string' || !device.device_code || typeof device.user_code !== 'string' || !device.user_code || typeof device.verification_uri !== 'string' || typeof device.verification_uri_complete !== 'string' || !Number.isFinite(device.interval) || device.interval <= 0 || !Number.isFinite(device.expires_in) || device.expires_in <= 0) throw new CliError('设备码接口的数据不完整。', 1, 'invalid_response');
    // device_code 与令牌一样不能出现在输出里。
    ctx.output.remember(device.device_code);
    const deadline = started + Math.min(device.expires_in * 1000, 600_000);
    let interval = device.interval * 1000;
    ctx.output.write({ event: 'device', verification_uri: device.verification_uri, user_code: device.user_code, verification_uri_complete: device.verification_uri_complete },
      [`请打开：${device.verification_uri}`, `设备代码：${device.user_code}`, '在浏览器里核对代码并允许登录；最长等待 10 分钟，按 Ctrl+C 取消。']);
    const opened = await ctx.openBrowser(device.verification_uri_complete);
    if (!opened && !ctx.options.json) ctx.output.write({ event: 'browser', opened }, [`无法打开浏览器，请打开：${device.verification_uri_complete}`]);
    while (!token) {
      const remaining = deadline - ctx.now();
      if (remaining <= 0) throw expired();
      await ctx.sleep(Math.min(interval, remaining), undefined, { signal: ctx.signal });
      if (ctx.now() >= deadline) throw expired();
      try {
        const result = await ctx.client.request('/api/cli/token', { method: 'POST', body: { device_code: device.device_code }, timeoutMs: Math.min(30_000, deadline - ctx.now()) });
        if (ctx.now() >= deadline) throw expired();
        if (typeof result?.token !== 'string' || !result.token || /[\r\n\0]/.test(result.token) || typeof result.email !== 'string' || !result.email) throw new CliError('登录接口的数据不完整。', 1, 'invalid_response');
        token = result.token;
        email = result.email;
      } catch (error) {
        if (ctx.now() >= deadline) throw expired();
        if (error instanceof CliError && error.details.http_status === 400) {
          if (error.error === 'authorization_pending') continue;
          if (error.error === 'slow_down') { interval += 5000; continue; }
          if (error.error === 'access_denied') throw new CliError('你拒绝了这次登录，请重新运行 oil login。', 1, 'access_denied');
          if (error.error === 'expired_token') throw expired();
        }
        // 网络抖动或服务端 5xx 不打断登录，等到期限前继续轮询
        if (error instanceof CliError && (error.error === 'network' || error.details.http_status >= 500)) continue;
        throw error;
      }
    }
  }
  ctx.output.remember(token);
  const file = await saveAuth(token, email);
  const warnings = process.env.OIL_TOKEN && process.env.OIL_TOKEN !== token ? ['OIL_TOKEN 优先于本机配置；使用新保存的令牌时请取消该环境变量。'] : [];
  ctx.token = token;
  ctx.output.write({ event: 'login', status: 'complete', token, email, config: file, warnings }, [`已登录：${email}`, `已保存令牌：${token}`, ...warnings]);
  return 0;
}

export async function loadAuth(ctx) {
  if (ctx.authLoaded) return;
  ctx.token = (await readAuth())?.token;
  ctx.output.remember(ctx.token);
  ctx.authLoaded = true;
}

export async function requireLogin(ctx) {
  await loadAuth(ctx);
  if (ctx.token) return;
  await login(ctx);
}
