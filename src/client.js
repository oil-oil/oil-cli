import { t, language, command, skillLabel } from './i18n.js';
import { CliError } from './io.js';
import { isSkillName, isVersion } from './skills.js';

const invalid = (message) => new CliError(message, 1, 'invalid_response');

// store.md 规定了字段，但尚未规定目录的 JSON 外层和免费/付费字段的形状。
export function normalizeCatalog(data) {
  const products = Array.isArray(data) ? data : data?.products ?? data?.catalog;
  if (!Array.isArray(products)) throw invalid(t('catalogIncomplete'));
  const names = new Set(), ids = new Set();
  return products.map((product) => {
    if (!product || typeof product.id !== 'string' || !product.id || ids.has(product.id) || typeof product.name !== 'string' || !product.name) throw invalid(t('catalogDuplicate'));
    ids.add(product.id);
    const item = { ...product, prices: product.prices ?? {} };
    for (const type of ['free', 'paid']) {
      const variant = product[type];
      if (variant == null) { item[type] = null; continue; }
      const name = typeof variant === 'string' ? variant : variant.skill;
      if (!isSkillName(name) || names.has(name)) throw invalid(t('catalogInvalidSkill'));
      names.add(name);
      item[type] = { skill: name };
    }
    if (!item.free && !item.paid) throw invalid(t('catalogMissingSkill'));
    if (!item.prices || typeof item.prices !== 'object' || Array.isArray(item.prices)) throw invalid(t('catalogInvalidPrice'));
    return item;
  });
}

export const catalogNames = (catalog) => catalog.flatMap((p) => [p.free?.skill, p.paid?.skill].filter(Boolean));
export const findSkill = (catalog, name) => {
  const product = catalog.find((p) => p.free?.skill === name || p.paid?.skill === name);
  if (!product) throw new CliError(t('unknownSkill', { name: skillLabel(name) }), 2, 'unknown_skill');
  return { product, paid: product.paid?.skill === name };
};

export const DEFAULT_API = 'https://ui.oiloil.org';
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 86_400_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function downloadTimeoutMs(env = process.env) {
  const raw = env.OIL_DOWNLOAD_TIMEOUT;
  if (raw === undefined || !raw.trim()) return DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const match = /^([1-9]\d*)(ms|s)?$/i.exec(raw.trim());
  if (!match) throw new CliError(t('invalidDownloadTimeout'), 2, 'usage');
  const value = Number(match[1]);
  const ms = match[2]?.toLowerCase() === 'ms' ? value : value * 1000;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_DOWNLOAD_TIMEOUT_MS) throw new CliError(t('invalidDownloadTimeout'), 2, 'usage');
  return ms;
}

export function validateDownloadTarget(location, baseAddress) {
  if (!location) return null;
  try {
    const base = new URL(baseAddress);
    const target = new URL(location, base);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    if (base.protocol === 'https:' && target.protocol !== 'https:') return null;
    if (target.protocol === 'http:' && !LOCAL_HOSTS.has(target.hostname)) return null;
    return target;
  } catch {
    return null;
  }
}

// 接口地址：只允许 HTTPS，HTTP 只留给本机调试，免得令牌明文发出去
export function apiBase(env = process.env) {
  let url;
  try {
    url = new URL(env.OIL_API || DEFAULT_API);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new CliError(t('invalidApi'), 2, 'invalid_api'); }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) throw new CliError(t('insecureApi'), 2, 'invalid_api');
  return url.href.replace(/\/$/, '');
}

export class Client {
  constructor(signal = new AbortController().signal) {
    this.base = apiBase();
    this.signal = signal;
    this.lang = language().lang;
    this.explicitLanguage = language().explicit;
  }
  url(route) { return `${this.base}${route}`; }
  subscriptionUrl(skill, product) {
    const page = typeof product?.page === 'string' && /^\/(?!\/)/.test(product.page) ? product.page : `/store/${encodeURIComponent(skill)}/`;
    return this.url(page);
  }
  async request(route, { token, method = 'GET', body, download = false, skill, product, timeoutMs = 30_000 } = {}) {
    if (token && /[\r\n\0]/.test(token)) throw new CliError(t('invalidToken'), 3, 'unauthorized');
    const budgetMs = download ? downloadTimeoutMs() : timeoutMs;
    const explicitDownloadTimeout = download && Boolean(process.env.OIL_DOWNLOAD_TIMEOUT?.trim());
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let activeTimeoutMs = budgetMs;
    const abort = () => controller.abort();
    if (this.signal.aborted) abort();
    this.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; activeTimeoutMs = budgetMs; abort(); }, budgetMs);
    const hopCleanups = [];
    const dispose = () => {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
      while (hopCleanups.length) hopCleanups.pop()();
    };
    const fetchHop = async (hopUrl, hopInit) => {
      const hopController = new AbortController();
      const onAbort = () => hopController.abort();
      if (controller.signal.aborted) hopController.abort();
      else {
        controller.signal.addEventListener('abort', onAbort, { once: true });
        hopCleanups.push(() => controller.signal.removeEventListener('abort', onAbort));
      }
      const hopBudget = download
        ? Math.min(explicitDownloadTimeout ? budgetMs : 120_000, Math.max(1, budgetMs - (Date.now() - startedAt)))
        : timeoutMs;
      const hopTimer = setTimeout(() => { timedOut = true; activeTimeoutMs = hopBudget; hopController.abort(); }, hopBudget);
      try {
        return await fetch(hopUrl, { ...hopInit, signal: hopController.signal });
      } finally {
        clearTimeout(hopTimer);
      }
    };
    const followDownloadRedirects = async (firstResponse, firstUrl, hopHeaders, initialStage = 'cdn_redirect') => {
      let current = firstResponse;
      let currentUrl = firstUrl;
      let stage = initialStage;
      for (let hops = 0; hops < 5; hops += 1) {
        const location = current.headers.get('location');
        await current.body?.cancel().catch(() => {});
        const target = validateDownloadTarget(location, currentUrl);
        if (!target) throw new CliError(t('downloadFailed'), 1, 'download', { stage });
        currentUrl = target.href;
        current = await fetchHop(currentUrl, { method: 'GET', headers: hopHeaders, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(current.status)) {
          return current;
        }
        stage = 'cdn_redirect';
      }
      await current.body?.cancel().catch(() => {});
      throw new CliError(t('downloadFailed'), 1, 'download', { stage: 'cdn_redirect' });
    };
    let handedOff = false;
    try {
      const address = /^https?:\/\//.test(route) ? route : this.url(route);
      const requestHeaders = {
        'Accept-Language': this.lang,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      // API 请求不允许跳转；下载请求统一手动校验每一跳 Location 后再发起下一跳请求。
      const response = download
        ? await fetchHop(address, { method, headers: requestHeaders, redirect: 'manual' })
        : await fetch(address, {
          method,
          headers: requestHeaders,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
          redirect: 'error',
        });
      if (download && [301, 302, 303, 307, 308].includes(response.status)) {
        const metadata = new Headers(response.headers);
        const cdnResponse = await followDownloadRedirects(
          response,
          address,
          { Accept: 'application/octet-stream', 'Accept-Language': this.lang },
          token ? 'redirect' : 'cdn_redirect',
        );
        if (!cdnResponse.ok || !cdnResponse.body) {
          await cdnResponse.body?.cancel().catch(() => {});
          throw new CliError(t('downloadFailedCode', { code: `HTTP ${cdnResponse.status}` }), 1, 'download', { http_status: cdnResponse.status, stage: 'cdn_download' });
        }
        handedOff = true;
        return { response: cdnResponse, metadata, dispose, abort, signal: controller.signal, budgetMs, isTimedOut: () => timedOut };
      }
      if (download && response.ok) {
        if (!response.body) throw new CliError(t('downloadFailed'), 1, 'download', { stage: 'transfer' });
        handedOff = true;
        return { response, metadata: new Headers(response.headers), dispose, abort, signal: controller.signal, budgetMs, isTimedOut: () => timedOut };
      }
      let data;
      try { data = await response.json(); }
      catch { if (![401, 402].includes(response.status)) throw invalid(t('invalidJson')); }
      if (!response.ok) {
        const details = { http_status: response.status };
        let message = typeof data?.message === 'string' ? data.message : t('httpError', { status: response.status });
        if (response.status === 401) message = t('unauthorized');
        if (response.status === 402) {
          details.subscribe_command = command('subscribe', skill || '<skill>');
          details.subscription_url = this.subscriptionUrl(skill || '<skill>', product);
          message = t('inactive', { name: skillLabel(skill || t('thisSkill')), next: details.subscribe_command, url: details.subscription_url });
        }
        throw new CliError(message, [401, 402].includes(response.status) ? 3 : 1,
          response.status === 401 ? 'unauthorized' : response.status === 402 ? 'inactive' : typeof data?.error === 'string' ? data.error : 'http_error', details);
      }
      return data;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (this.signal.aborted) throw new CliError(t('canceled'), 1, 'cancelled');
      if (download && timedOut) throw new CliError(t('downloadTimeout'), 1, 'download_timeout', { reason: 'timeout', timeout_ms: activeTimeoutMs });
      throw new CliError(t('network'), 1, 'network');
    } finally {
      if (!handedOff) dispose();
    }
  }
  async catalog() { return normalizeCatalog(await this.request('/api/store/catalog')); }
  async versions(catalog, requiredNames = catalogNames(catalog)) {
    const data = await this.request('/api/store/versions');
    const skills = data?.skills ?? data;
    const names = catalogNames(catalog);
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) throw invalid(t('invalidVersions', { name: skillLabel(names[0] || t('thisSkill')) }));
    const required = new Set(requiredNames);
    for (const name of names) {
      if (!Object.hasOwn(skills, name)) {
        if (required.has(name)) throw invalid(t('invalidVersions', { name: skillLabel(name) }));
        continue;
      }
      const release = skills[name];
      if (!release || !isVersion(release.latest) || !Array.isArray(release.history)) throw invalid(t('invalidVersions', { name: skillLabel(name) }));
    }
    for (const name of required) if (!names.includes(name)) throw invalid(t('invalidVersions', { name: skillLabel(name) }));
    return skills;
  }
  async me(token, options = {}) {
    const data = await this.request('/api/auth/me', { token, ...options });
    if (typeof data?.email !== 'string' || !data.email || !Array.isArray(data.subscriptions)) throw invalid(t('invalidAccount'));
    return data;
  }
  async checkoutStatus(id, token, options = {}) {
    const data = await this.request(`/api/store/checkout/status?id=${encodeURIComponent(id)}`, { token, ...options });
    if (!['open', 'complete', 'expired'].includes(data?.status) || typeof data.paid !== 'boolean' || typeof data.entitled !== 'boolean') throw invalid(t('invalidCheckoutStatus'));
    return data;
  }
}
