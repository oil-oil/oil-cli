import { CliError } from './io.js';
import { isSkillName, isVersion } from './skills.js';

const invalid = (message) => new CliError(message, 1, 'invalid_response');

// store.md 规定了字段，但尚未规定目录的 JSON 外层和免费/付费字段的形状。
export function normalizeCatalog(data) {
  const products = Array.isArray(data) ? data : data?.products ?? data?.catalog;
  if (!Array.isArray(products)) throw invalid('商品目录的数据不完整。');
  const names = new Set(), ids = new Set();
  return products.map((product) => {
    if (!product || typeof product.id !== 'string' || !product.id || ids.has(product.id) || typeof product.name !== 'string' || !product.name) throw invalid('商品目录的数据不完整或产品编号重复。');
    ids.add(product.id);
    const item = { ...product, prices: product.prices ?? {} };
    for (const type of ['free', 'paid']) {
      const variant = product[type];
      if (variant == null) { item[type] = null; continue; }
      const name = typeof variant === 'string' ? variant : variant.skill;
      if (!isSkillName(name) || names.has(name)) throw invalid('商品目录的 Skill 名无效或重复。');
      names.add(name);
      item[type] = { skill: name };
    }
    if (!item.free && !item.paid) throw invalid('商品目录缺少 Skill 名。');
    if (!item.prices || typeof item.prices !== 'object' || Array.isArray(item.prices)) throw invalid('商品目录的价格数据无效。');
    return item;
  });
}

export const catalogNames = (catalog) => catalog.flatMap((p) => [p.free?.skill, p.paid?.skill].filter(Boolean));
export const findSkill = (catalog, name) => {
  const product = catalog.find((p) => p.free?.skill === name || p.paid?.skill === name);
  if (!product) throw new CliError(`商品目录里没有 ${name}，请运行 oil list。`, 2, 'unknown_skill');
  return { product, paid: product.paid?.skill === name };
};

export class Client {
  constructor(signal = new AbortController().signal) {
    const base = process.env.OIL_API || 'https://ui.oiloil.org';
    try {
      const url = new URL(base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      this.base = url.href.replace(/\/$/, '');
    } catch { throw new CliError('OIL_API 必须是 HTTP 或 HTTPS 基础地址。', 2, 'invalid_api'); }
    this.signal = signal;
  }
  url(route) { return `${this.base}${route}`; }
  subscriptionUrl(skill, product) {
    const page = typeof product?.page === 'string' && /^\/(?!\/)/.test(product.page) ? product.page : `/store/${encodeURIComponent(skill)}/`;
    return this.url(page);
  }
  async request(route, { token, method = 'GET', body, download = false, skill, product, timeoutMs = 30_000 } = {}) {
    if (token && /[\r\n\0]/.test(token)) throw new CliError('令牌格式无效，请重新运行 oil login。', 3, 'unauthorized');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.signal.aborted) abort();
    this.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, download ? 120_000 : timeoutMs);
    const dispose = () => { clearTimeout(timer); this.signal.removeEventListener('abort', abort); };
    let handedOff = false;
    try {
      const address = /^https?:\/\//.test(route) ? route : this.url(route);
      // API 不得重定向；免费发布物可以跳到公开附件，且不携带令牌。
      const response = await fetch(address, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
        redirect: download && !token ? 'follow' : 'error',
      });
      if (download && response.ok) { handedOff = true; return { response, dispose }; }
      let data;
      try { data = await response.json(); }
      catch { if (![401, 402].includes(response.status)) throw invalid('服务返回的 JSON 无法读取。'); }
      if (!response.ok) {
        const details = { http_status: response.status };
        let message = typeof data?.message === 'string' ? data.message : `请求失败（${response.status}）。`;
        if (response.status === 401) message = '登录已失效，重新运行 oil login（npx github:oil-oil/oil-cli login）。';
        if (response.status === 402) {
          details.subscribe_command = `oil subscribe ${skill || '<skill>'}`;
          details.subscription_url = this.subscriptionUrl(skill || '<skill>', product);
          message = `没有订阅 ${skill || '这个 Skill'}。请运行 ${details.subscribe_command}，或打开 ${details.subscription_url}`;
        }
        throw new CliError(message, [401, 402].includes(response.status) ? 3 : 1,
          response.status === 401 ? 'unauthorized' : response.status === 402 ? 'inactive' : typeof data?.error === 'string' ? data.error : 'http_error', details);
      }
      return data;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(this.signal.aborted ? '操作已取消。' : '请求失败，请检查网络或 OIL_API。', 1, this.signal.aborted ? 'cancelled' : 'network');
    } finally {
      if (!handedOff) dispose();
    }
  }
  async catalog() { return normalizeCatalog(await this.request('/api/store/catalog')); }
  async versions(catalog) {
    const data = await this.request('/api/store/versions');
    const skills = data?.skills ?? data;
    for (const name of catalogNames(catalog)) {
      const release = skills?.[name];
      if (!release || !isVersion(release.latest) || !Array.isArray(release.history)) throw invalid(`版本接口缺少 ${name} 的有效版本或更新说明。`);
    }
    return skills;
  }
  async me(token, options = {}) {
    const data = await this.request('/api/auth/me', { token, ...options });
    if (typeof data?.email !== 'string' || !data.email || !Array.isArray(data.subscriptions)) throw invalid('账号接口的数据不完整。');
    return data;
  }
}
