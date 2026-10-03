import { hostname, platform } from 'node:os';
import { CliError } from './io.js';
import { readAuth, saveAuth, readPendingDevice, savePendingDevice, clearPendingDevice, isPendingDevice } from './config.js';

export const isCI = () => {
  const value = process.env.CI?.trim().toLowerCase();
  return Boolean(value && !['0', 'false', 'no', 'off'].includes(value));
};

const expired = () => new CliError('设备码已过期，请重新运行 oil login。', 1, 'expired_token');

const publicDevice = ({ user_code, verification_uri, verification_uri_complete, expires_at, interval }) =>
  ({ user_code, verification_uri, verification_uri_complete, expires_at, interval });

async function deviceLogin(ctx) {
  const waitDeadline = ctx.now() + (ctx.terminal ? 600_000 : 60_000);
  let device = await readPendingDevice();
  if (device) ctx.output.remember(device.device_code, { hide: true });
  if (device && device.expires_at <= ctx.now()) {
    await clearPendingDevice();
    device = null;
  }
  let resumed = Boolean(device);
  while (true) {
    if (!device) {
      const started = ctx.now();
      const result = await ctx.client.request('/api/cli/device', { method: 'POST', body: { client_name: hostname(), platform: platform() },
        timeoutMs: Math.max(1, Math.min(30_000, waitDeadline - started)) });
      // 无论响应是否完整，都先登记设备密钥，防止错误输出泄漏它。
      if (typeof result?.device_code === 'string') ctx.output.remember(result.device_code, { hide: true });
      device = { device_code: result?.device_code, user_code: result?.user_code, verification_uri: result?.verification_uri,
        verification_uri_complete: result?.verification_uri_complete, expires_at: started + result?.expires_in * 1000, interval: result?.interval };
      if (!Number.isFinite(result?.expires_in) || result.expires_in <= 0 || !isPendingDevice(device)) throw new CliError('设备码接口的数据不完整。', 1, 'invalid_response');
      // 在浏览器授权和轮询之前落盘，Agent 提前结束进程也能继续领取。
      await savePendingDevice(device);
    }
    const browserBudget = Math.min(5000, waitDeadline - ctx.now());
    const opened = browserBudget > 0 && await ctx.openBrowser(device.verification_uri_complete, browserBudget);
    const warnings = opened ? [] : ['没能自动打开浏览器，请手动打开上面的链接。'];
    ctx.output.write({ event: 'device', ...publicDevice(device), opened, warnings },
      [`请打开：${device.verification_uri_complete}`, `设备代码：${device.user_code}`, ...warnings,
        `在浏览器里核对代码并允许登录；最长等待 ${ctx.terminal ? '10 分钟' : '60 秒'}，按 Ctrl+C 取消。`]);

    try {
      while (true) {
        if (ctx.now() >= device.expires_at) throw expired();
        if (ctx.now() >= waitDeadline) {
          throw new CliError(`在浏览器打开 ${device.verification_uri_complete}，确认代码 ${device.user_code} 后点“允许”，然后再运行一次刚才的命令。`,
            3, 'authorization_pending', { ...publicDevice(device), next_command: ctx.nextCommand });
        }
        const deadline = Math.min(device.expires_at, waitDeadline);
        await ctx.sleep(Math.min(device.interval * 1000, deadline - ctx.now()), undefined, { signal: ctx.signal });
        if (ctx.now() >= deadline) continue;
        try {
          const result = await ctx.client.request('/api/cli/token', { method: 'POST', body: { device_code: device.device_code }, timeoutMs: Math.min(30_000, deadline - ctx.now()) });
          if (typeof result?.token !== 'string' || !result.token || /[\r\n\0]/.test(result.token) || typeof result.email !== 'string' || !result.email) throw new CliError('登录接口的数据不完整。', 1, 'invalid_response');
          return result;
        } catch (error) {
          if (error instanceof CliError && error.details.http_status === 400) {
            if (error.error === 'authorization_pending') continue;
            if (error.error === 'slow_down') {
              device.interval += 5;
              await savePendingDevice(device);
              continue;
            }
            if (error.error === 'access_denied') throw new CliError('你拒绝了这次登录，请重新运行 oil login。', 1, 'access_denied');
            if (error.error === 'expired_token') throw expired();
          }
          // 网络抖动或服务端 5xx 不打断登录，等到期限前继续轮询。
          if (error instanceof CliError && (error.error === 'network' || error.details.http_status >= 500)) continue;
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof CliError && ['access_denied', 'expired_token'].includes(error.error)) {
        await clearPendingDevice();
        // 失效的待领取记录自动换新；新代码被拒绝或过期则交给用户重试。
        if (resumed && ctx.now() < waitDeadline) {
          device = null;
          resumed = false;
          continue;
        }
      }
      throw error;
    }
  }
}

export async function login(ctx, suppliedToken) {
  let token = suppliedToken, email;
  if (token) {
    ctx.output.remember(token);
    email = (await ctx.client.me(token)).email;
  } else {
    if (isCI()) throw new CliError('CI 环境需要设置 OIL_TOKEN，或先运行 oil login --token <令牌>。', 3, 'unauthorized', { token_environment: 'OIL_TOKEN' });
    ({ token, email } = await deviceLogin(ctx));
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
  // 环境变量和 CI 沿用原有令牌规则；本机待领取登录优先完成。
  if (ctx.token && (process.env.OIL_TOKEN || isCI() || !await readPendingDevice())) return;
  await login(ctx);
}
