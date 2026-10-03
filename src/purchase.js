import { CliError } from './io.js';
import { isCI } from './auth.js';
import { readPendingCheckout, savePendingCheckout, clearPendingCheckout } from './config.js';
import { findSkill } from './client.js';
import { t, skillLabel, planLabel, priceLabel } from './i18n.js';

const entitlement = (account, name) => account?.subscriptions.find((s) =>
  s.skill === name && ['active', 'canceling', 'past_due', 'lifetime', 'trialing'].includes(s.status));
const retryable = (error) => error instanceof CliError && (error.error === 'network' || error.details.http_status >= 500);

function purchaseDetails(product, name, plan) {
  const price = product.prices[plan];
  return { product_name: skillLabel(name), plan, amount: price?.amount ?? price?.unit_amount ?? null,
    currency: price?.currency ?? null, purchase_type: plan === 'lifetime' ? 'one_time' : 'subscription',
    purchase_description: planLabel(plan), price_label: priceLabel(price) };
}

export async function requirePurchase(ctx, name, { plan, force = false } = {}) {
  const unlocked = ctx.unlockedSkills ??= new Set();
  if (!force && unlocked.has(name)) return;
  const { product } = findSkill(ctx.catalog, name);
  const selectedPlan = plan || product.offer?.[0] || Object.keys(product.prices)[0] || 'lifetime';
  let details = purchaseDetails(product, name, selectedPlan);
  let checkout = await readPendingCheckout(name, ctx.token, ctx.client.base);
  let state;
  // 恢复时先查原会话。查询暂时失败也保留它，不创建另一张付款页。
  if (checkout) {
    try { state = await ctx.client.checkoutStatus(checkout.id, ctx.token); }
    catch (error) { if (!retryable(error)) throw error; }
  }
  if (!force) {
    let account;
    try { account = await ctx.client.me(ctx.token); }
    catch (error) { if (!state?.entitled) throw error; }
    if (state?.entitled || entitlement(account, name)) {
      unlocked.add(name);
      if (checkout) await clearPendingCheckout(checkout.id);
      return;
    }
  }
  if (state?.entitled) {
    unlocked.add(name);
    await clearPendingCheckout(checkout.id);
    return;
  }
  if (checkout && state && !state.paid && (state.status === 'expired' || (state.status === 'open' && checkout.plan !== selectedPlan))) {
    await clearPendingCheckout(checkout.id);
    checkout = null;
  }
  if (checkout) details = purchaseDetails(product, name, checkout.plan);
  const pending = (url, extra = {}) => new CliError(
    t(state?.paid || state?.status === 'complete' ? 'paymentProcessing' : 'pendingPayment', { url }),
    3, 'payment_pending', { skill: name, url, purchase_url: url, next_command: ctx.nextCommand, ...details,
      ...(checkout ? { id: checkout.id } : {}), ...extra });
  if (isCI()) {
    const query = new URLSearchParams({ skill: name, ...(plan ? { plan } : {}), ...(ctx.client.explicitLanguage ? { lang: ctx.client.lang } : {}) });
    throw pending(checkout?.url || ctx.client.url(`/api/store/checkout?${query}`), { ci: true, opened: false });
  }

  const waitMs = ctx.terminal ? 900_000 : 60_000;
  const deadline = ctx.now() + waitMs;
  const complete = async (subscription, extra = {}) => {
    unlocked.add(name);
    if (checkout) await clearPendingCheckout(checkout.id);
    ctx.output.write({ event: 'subscribed', skill: name, ...(subscription ? { subscription } : {}), ...extra }, [t('purchased', { name: skillLabel(name) })]);
  };
  const resumed = Boolean(checkout);
  if (!checkout) {
    try {
      checkout = await ctx.client.request('/api/store/checkout', { method: 'POST', token: ctx.token,
        body: { skill: name, ...(plan ? { plan } : {}), ...(ctx.client.explicitLanguage ? { lang: ctx.client.lang } : {}) }, timeoutMs: Math.min(30_000, waitMs) });
    } catch (error) {
      // 与服务端保持一致：409 已代表履约完成。
      if (error instanceof CliError && error.error === 'already_active' && error.details.http_status === 409) {
        await complete(null, { already_active: true });
        return;
      }
      throw error;
    }
    try {
      const url = new URL(checkout?.url);
      if (typeof checkout.id !== 'string' || !checkout.id || typeof checkout.reused !== 'boolean'
        || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { throw new CliError(t('invalidCheckout'), 1, 'invalid_response'); }
    // 先落盘，再打开浏览器；中断和超时后都能恢复。
    await savePendingCheckout({ id: checkout.id, url: checkout.url, skill: name, plan: selectedPlan }, ctx.token, ctx.client.base);
  }
  const processing = state?.paid || state?.status === 'complete';
  const browserBudget = Math.min(5000, deadline - ctx.now());
  const opened = !processing && browserBudget > 0 && await ctx.openBrowser(checkout.url, browserBudget);
  const warnings = opened || processing ? [] : [t('browserWarning')];
  const message = t('checkoutSummary', { name: details.product_name, price: t('pricePlan', { price: details.price_label, plan: details.purchase_description }) });
  ctx.output.write({ event: 'checkout', skill: name, id: checkout.id, url: checkout.url, reused: resumed || checkout.reused, resumed, opened, warnings, ...details, message,
    max_wait_seconds: waitMs / 1000, next_command: ctx.nextCommand },
    [message, processing ? t('paymentProcessing') : t('paymentPage', { url: checkout.url }), ...warnings,
      t('paymentWait', { duration: t(ctx.terminal ? 'fifteenMinutes' : 'sixtySeconds') })]);
  while (ctx.now() < deadline) {
    await ctx.sleep(Math.min(3000, deadline - ctx.now()), undefined, { signal: ctx.signal });
    if (ctx.now() >= deadline) break;
    try { state = await ctx.client.checkoutStatus(checkout.id, ctx.token, { timeoutMs: Math.min(30_000, deadline - ctx.now()) }); }
    catch (error) { if (!retryable(error)) throw error; }
    if (ctx.now() >= deadline) break;
    let account;
    try { account = await ctx.client.me(ctx.token, { timeoutMs: Math.min(30_000, deadline - ctx.now()) }); }
    catch (error) { if (!retryable(error) && !state?.entitled) throw error; }
    const subscription = entitlement(account, name);
    if (ctx.now() < deadline && (state?.entitled || subscription)) { await complete(subscription); return; }
    if (state?.status === 'expired' && !state.paid) {
      await clearPendingCheckout(checkout.id);
      throw new CliError(t('expiredCheckout'), 3, 'payment_pending', { skill: name, id: checkout.id, url: checkout.url, purchase_url: checkout.url, next_command: ctx.nextCommand, ...details });
    }
  }
  throw pending(checkout.url, { opened, max_wait_seconds: waitMs / 1000 });
}
