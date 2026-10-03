import { CliError } from './io.js';
import { isCI } from './auth.js';

const entitlement = (account, name) => account.subscriptions.find((s) =>
  s.skill === name && ['active', 'canceling', 'past_due', 'lifetime', 'trialing'].includes(s.status));

// 只在本次命令里记住解锁结果；付款会话不落盘，重跑时重新查账号。
export async function requirePurchase(ctx, name, { plan, force = false } = {}) {
  const unlocked = ctx.unlockedSkills ??= new Set();
  if (!force) {
    if (unlocked.has(name)) return;
    if (entitlement(await ctx.client.me(ctx.token), name)) { unlocked.add(name); return; }
  }
  const pending = (url, details = {}) => new CliError(
    `在浏览器打开 ${url} 完成付款，然后再运行一次刚才的命令。`,
    3, 'payment_pending', { skill: name, url, purchase_url: url, next_command: ctx.nextCommand, ...details });
  if (isCI()) {
    const query = new URLSearchParams({ skill: name, ...(plan ? { plan } : {}) });
    throw pending(ctx.client.url(`/api/store/checkout?${query}`), { ci: true, opened: false });
  }

  const waitMs = ctx.terminal ? 900_000 : 60_000;
  const deadline = ctx.now() + waitMs;
  let checkout;
  const complete = (subscription, details = {}) => {
    unlocked.add(name);
    ctx.output.write({ event: 'subscribed', skill: name, ...(subscription ? { subscription } : {}), ...details }, [`已解锁 ${name}。`]);
  };
  try {
    checkout = await ctx.client.request('/api/store/checkout', { method: 'POST', token: ctx.token,
      body: { skill: name, ...(plan ? { plan } : {}) }, timeoutMs: Math.min(30_000, waitMs) });
  } catch (error) {
    // 结账接口的判定也是实时授权结果，无需再等 me 同步。
    if (error instanceof CliError && error.error === 'already_active' && error.details.http_status === 409) {
      complete(null, { already_active: true });
      return;
    }
    throw error;
  }
  try {
    const url = new URL(checkout?.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new CliError('服务返回的付款链接无效。', 1, 'invalid_response'); }
  const browserBudget = Math.min(5000, deadline - ctx.now());
  const opened = browserBudget > 0 && await ctx.openBrowser(checkout.url, browserBudget);
  const warnings = opened ? [] : ['没能自动打开浏览器，请手动打开上面的链接。'];
  ctx.output.write({ event: 'checkout', skill: name, url: checkout.url, opened, warnings,
    max_wait_seconds: waitMs / 1000, next_command: ctx.nextCommand },
    [`付款页面：${checkout.url}`, ...warnings,
      `等待购买生效，每 3 秒检查一次；最长等待 ${ctx.terminal ? '15 分钟' : '60 秒'}，按 Ctrl+C 取消。`]);
  while (ctx.now() < deadline) {
    await ctx.sleep(Math.min(3000, deadline - ctx.now()), undefined, { signal: ctx.signal });
    if (ctx.now() >= deadline) break;
    let account;
    try { account = await ctx.client.me(ctx.token, { timeoutMs: Math.min(30_000, deadline - ctx.now()) }); }
    catch (error) {
      if (ctx.now() >= deadline) break;
      if (error instanceof CliError && (error.error === 'network' || error.details.http_status >= 500)) continue;
      throw error;
    }
    const subscription = entitlement(account, name);
    if (ctx.now() < deadline && subscription) { complete(subscription); return; }
  }
  throw pending(checkout.url, { opened, max_wait_seconds: waitMs / 1000 });
}
