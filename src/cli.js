import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Output, CliError, ask, canPrompt, confirm } from './io.js';
import { readAuth, logout as deleteConfig } from './config.js';
import { Client, catalogNames, findSkill } from './client.js';
import { openBrowser } from './browser.js';
import { isSkillName, scan, inspectSkill, isDevelopmentDirectory, installationRoots, uniqueDirectories, resolveDirectory, targetRoot, compare, updates, conflicts } from './skills.js';
import { prepare, replaceAll } from './install.js';
import { login, loadAuth, requireLogin } from './auth.js';
import { requirePurchase } from './purchase.js';

const help = [
  'oil：安装、更新和管理 oiloil 商店里的 Skill。',
  '用法：npx github:oil-oil/oil-cli <命令> [--json] [--yes]',
  'status（默认）                 查看账号、购买状态、安装版本和更新说明',
  'list                          查看免费和付费 Skill、价格',
  'install <skill> [--to <claude|codex|agents|cursor|路径>] [--to …]',
  'update [<skill>] [--path <目录>]  更新全部、一个 Skill 或指定目录',
  'login [--token <令牌>]         设备码登录，或校验并保存令牌',
  'logout                        撤销令牌并删除本机配置',
  'subscribe <skill> [--plan <在售方案>]  打开付款页面，购买后自动安装',
  'manage                        打开购买管理页面',
  'help / --version              查看帮助 / CLI 版本',
  '--to 路径指向 skills 根目录；--yes 确认替换，并在装付费版时移除同位置免费版。',
  '省略 --to 时自动检测本机 Agent；非交互安装、更新无需 --yes。',
  '含 .git 的开发目录会跳过；CI 需要 OIL_TOKEN，其他环境可内联设备码登录。',
  '付费安装会内联登录、购买；购买等待：终端最多 15 分钟，非交互最多 60 秒。',
  'CI 不打开付款页；未购买时退出 3，给出网页购买地址。',
  '--json 输出 JSON；设备码登录和购买等待使用 JSON Lines。',
];

export function parseArgs(argv) {
  const options = { command: null, json: false, yes: false, to: [], token: null, plan: null, path: null, skill: null };
  const positions = [];
  let version = false, helpFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--version') version = true;
    else if (['--help', '-h'].includes(arg)) helpFlag = true;
    else if (/^--(to|token|plan|path)(=|$)/.test(arg)) {
      const flag = arg.split('=')[0], field = flag.slice(2);
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('-')) throw new CliError(`${flag} 缺少值。`, 2, 'missing_argument');
      if (field === 'to') options.to.push(value);
      else {
        if (options[field] !== null) throw new CliError(`${flag} 只能写一次。`, 2, 'usage');
        options[field] = value;
      }
    } else if (arg.startsWith('-')) throw new CliError('存在未知参数，请运行 oil help。', 2, 'usage');
    else positions.push(arg);
  }
  options.command = positions.shift() || 'status';
  if (version) {
    if (positions.length || options.command !== 'status' || options.to.length || options.token || options.plan || options.path || helpFlag || argv.includes('status')) throw new CliError('--version 请单独使用，可加 --json 和 --yes。', 2, 'usage');
    options.command = 'version';
  } else if (helpFlag) { options.command = 'help'; positions.length = 0; }
  if (!['status', 'list', 'install', 'update', 'login', 'logout', 'subscribe', 'manage', 'help', 'version'].includes(options.command)) throw new CliError('未知命令，请运行 oil help。', 2, 'usage');
  if (['install', 'update', 'subscribe'].includes(options.command)) {
    options.skill = positions.shift() || null;
    if (!options.skill && options.command !== 'update') throw new CliError(`${options.command} 需要 Skill 名，请运行 oil list。`, 2, 'missing_skill');
    if (options.skill && !isSkillName(options.skill)) throw new CliError('Skill 名无效，请运行 oil list。', 2, 'usage');
  }
  if (positions.length || (options.to.length && options.command !== 'install') || (options.token !== null && options.command !== 'login') || (options.plan !== null && options.command !== 'subscribe') || (options.path !== null && options.command !== 'update')) throw new CliError('参数不适用于此命令，请运行 oil help。', 2, 'usage');
  return options;
}

function installationLines(installed) {
  return installed.flatMap((item) => [
    `${item.name}：${item.current || '版本未知'} → 最新 ${item.latest}${item.development ? '（开发目录，跳过）' : item.update_available ? '（可更新）' : ''}`,
    `位置：${item.path}`,
    ...item.updates.flatMap((entry) => [`${entry.version} 更新说明：`, entry.notes || '未提供更新说明。']),
  ]);
}
const subscriptionLabel = (status) => ({ active: '有效', canceling: '已取消，到期前可用', past_due: '扣款失败，仍可用', lifetime: '永久解锁', trialing: '试用中' })[status] || status;
const planLabel = (plan) => ({ monthly: '每月', yearly: '每年', lifetime: '永久', month: '每月', year: '每年' })[plan] || plan;
function localDate(seconds) {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const subscriptionLines = (subscriptions) => subscriptions.length ? subscriptions.map((s) =>
  `${s.name || s.skill}：${subscriptionLabel(s.status)}（${planLabel(s.plan)}）${s.renews != null ? `，续费 ${localDate(s.renews)}` : ''}${s.ends != null ? `，到期 ${localDate(s.ends)}` : ''}`) : ['尚未购买付费 Skill。'];
const skippedInstallation = (item) => ({ name: item.name, path: item.path, reason: 'development_directory' });
const skippedLines = (skipped) => skipped.map((item) => `${item.name}：开发目录，跳过（${item.path}）`);

async function status(ctx) {
  await loadAuth(ctx);
  const found = await scan(ctx.names);
  const versions = await ctx.client.versions(ctx.catalog);
  const installations = found.map((item) => ({ name: item.name, path: item.path, current: item.version, latest: versions[item.name].latest, development: item.development, real_path: item.real_path,
    update_available: !item.development && (!item.version || compare(item.version, versions[item.name].latest) < 0), updates: updates(item.version, versions[item.name]) }));
  const warnings = conflicts(found, ctx.catalog);
  for (const item of found) {
    const history = versions[item.name].history;
    const oldest = history.filter((entry) => /^\d+\.\d+\.\d+$/.test(entry.version)).sort((a, b) => compare(a.version, b.version))[0];
    if (history.length >= 20 && item.version && oldest && compare(item.version, oldest.version) < 0) warnings.push(`${item.path}：接口只提供最近 20 条更新说明，可能缺少更早版本。`);
  }
  const lines = installations.length ? installationLines(installations) : ['未发现已安装的商店 Skill。'];
  let account = null;
  if (ctx.token) {
    try {
      account = { ...await ctx.client.me(ctx.token), token: ctx.token };
      lines.push(`账号：${account.email}`, `令牌：${ctx.token}`, ...subscriptionLines(account.subscriptions));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      ctx.output.write({ installations, warnings, account: null, error: error.error, message: error.message, ...error.details }, [...lines, ...warnings, error.message], false);
      return error.code;
    }
  }
  ctx.output.write({ installations, warnings, account }, [...lines, ...warnings, ...(!ctx.token ? ['尚未登录，免费 Skill 可以直接安装。'] : [])]);
  return 0;
}

function priceLabel(prices) {
  return Object.entries(prices).map(([plan, price]) => {
    if (!price || typeof price !== 'object') return `${planLabel(plan)}：价格暂不可用`;
    const amount = price.amount ?? price.unit_amount;
    return typeof amount === 'number' ? `${planLabel(plan)} ${amount / 100} ${String(price.currency || '').toUpperCase()}` : `${planLabel(plan)}：价格暂不可用`;
  }).join('，') || '价格暂不可用';
}
async function list(ctx) {
  const skills = ctx.catalog.flatMap((product) => ['free', 'paid'].filter((type) => product[type]).map((type) => ({
    skill: product[type].skill, name: product.name, summary: product.summary || '', type, prices: type === 'paid' ? product.prices : {}, page: ctx.client.subscriptionUrl(product[type].skill, product),
  })));
  ctx.output.write({ skills }, skills.length ? skills.map((s) => `${s.skill}：${s.type === 'free' ? '免费' : `付费（${priceLabel(s.prices)}）`}${s.summary ? `，${s.summary}` : ''}`) : ['商店里还没有 Skill。']);
  return 0;
}

async function apply(ctx, actions, versions, { purchaseOnInactive = false } = {}) {
  const prepared = new Map();
  try {
    for (const name of new Set(actions.filter((action) => !action.remove).map((action) => action.name))) {
      const { product, paid } = findSkill(ctx.catalog, name);
      let item;
      try { item = await prepare(ctx.client, name, versions[name], ctx.token, paid, product, ctx.signal); }
      catch (error) {
        if (!purchaseOnInactive || !paid || !(error instanceof CliError) || error.details.http_status !== 402) throw error;
        await requirePurchase(ctx, name, { force: true, plan: ctx.options.plan });
        item = await prepare(ctx.client, name, versions[name], ctx.token, paid, product, ctx.signal);
      }
      prepared.set(name, item);
    }
    return await replaceAll(actions.map((action) => ({ ...action, source: action.remove ? undefined : prepared.get(action.name).source })), { signal: ctx.signal, names: ctx.names });
  } finally {
    for (const item of prepared.values()) await item.cleanup().catch(() => {});
  }
}

async function install(ctx, name = ctx.options.skill) {
  const { product, paid } = findSkill(ctx.catalog, name);
  let roots = ctx.options.to.length ? [...new Set(ctx.options.to.map(targetRoot))] : await installationRoots();
  if (!roots.length) {
    if (!ctx.interactive) throw new CliError('未检测到 Agent 目录，请加 --to <claude|codex|agents|cursor|路径> 指定安装位置。', 2, 'missing_target');
    const answer = await ctx.ask('安装到哪个 skills 目录？请输入 claude、codex、agents、cursor 或路径：', ctx.signal);
    if (!answer) throw new CliError('未指定目标，请加 --to <claude|codex|agents|cursor|路径>。', 2, 'missing_target');
    roots = [targetRoot(answer)];
  }
  roots = await uniqueDirectories(roots);
  if (ctx.interactive) ctx.output.write({ event: 'targets', paths: roots }, ['安装位置：', ...roots]);
  if (!await ctx.confirm(`安装 ${name} 到这些位置？`, ctx.options.yes, ctx.interactive, ctx.signal, true)) {
    ctx.output.write({ cancelled: true }, ['已取消安装。']); return 0;
  }
  const found = await scan(ctx.names, roots);
  const actions = [], skipped = [];
  for (const root of roots) {
    const matching = found.filter((item) => item.root === root && item.name === name);
    const candidates = matching.length ? matching : [{ name, path: path.join(root, name), version: null }];
    for (const item of candidates) {
      if (await isDevelopmentDirectory(item.path)) { skipped.push(skippedInstallation(item)); continue; }
      actions.push({ name, path: item.path, previousName: matching.length ? name : null, previousVersion: item.version });
    }
  }
  if (!actions.length) { ctx.output.write({ installations: [], removed: [], skipped, warnings: [] }, skippedLines(skipped)); return 0; }
  if (paid) { await requireLogin(ctx); await requirePurchase(ctx, name); }
  const activeRoots = new Set(actions.map((action) => path.dirname(action.path)));
  const free = paid && product.free ? found.filter((item) => item.name === product.free.skill && activeRoots.has(item.root)) : [];
  const removable = free.filter((item) => !item.development);
  skipped.push(...free.filter((item) => item.development).map(skippedInstallation));
  if (removable.length) {
    if (ctx.interactive) ctx.output.write({ event: 'conflict' }, [`${product.free.skill} 和 ${name} 两个版本同时装会抢着接同一类请求`]);
    if (await ctx.confirm('是否移除同位置的免费版？', ctx.options.yes, ctx.interactive, ctx.signal, true)) {
      for (const item of removable) {
        const replacement = actions.find((action) => action.path === item.path);
        if (replacement) { replacement.previousName = item.name; replacement.replacesFree = true; }
        else actions.push({ name: item.name, path: item.path, previousName: item.name, remove: true });
      }
    }
  }
  const versions = await ctx.client.versions(ctx.catalog);
  const warnings = await apply(ctx, actions, versions, { purchaseOnInactive: true });
  warnings.push(...conflicts(await scan(ctx.names, roots), ctx.catalog));
  const installations = actions.filter((action) => !action.remove).map((action) => ({ name, path: action.path,
    previous: action.previousName === name ? action.previousVersion : null, version: versions[name].latest }));
  const removed = actions.filter((action) => action.remove || action.replacesFree).map((action) => action.path);
  ctx.output.write({ installations, removed, skipped, warnings }, [...installations.map((item) => item.previous && item.previous !== item.version
    ? `已更新 ${item.name}：${item.previous} → ${item.version}（${item.path}）`
    : `已安装 ${item.name} ${item.version}：${item.path}`), ...removed.map((p) => `已移除同位置的免费版：${p}`), ...skippedLines(skipped), ...warnings]);
  return 0;
}

async function update(ctx) {
  if (ctx.options.skill) findSkill(ctx.catalog, ctx.options.skill);
  let all;
  if (ctx.options.path) {
    const directory = resolveDirectory(ctx.options.path);
    const item = await inspectSkill(directory, ctx.names);
    if (!item) throw new CliError(`这个目录不是商品目录里认识的 Skill 安装：${directory}`, 2, 'unknown_installation');
    if (ctx.options.skill && item.name !== ctx.options.skill) throw new CliError(`指定目录里安装的是 ${item.name}，与 ${ctx.options.skill} 不符。`, 2, 'skill_mismatch');
    all = [item];
  } else all = await scan(ctx.names);
  const found = all.filter((item) => !ctx.options.skill || item.name === ctx.options.skill);
  const skipped = found.filter((item) => item.development).map(skippedInstallation);
  const seen = new Set();
  const eligible = found.filter((item) => {
    if (item.development || seen.has(item.real_path)) return false;
    seen.add(item.real_path); return true;
  });
  const warnings = conflicts(all, ctx.catalog);
  if (!eligible.length) {
    ctx.output.write({ installations: [], skipped, warnings }, [...(found.length ? [] : ['未发现已安装的商店 Skill。']), ...skippedLines(skipped), ...warnings]); return 0;
  }
  const versions = await ctx.client.versions(ctx.catalog);
  const pending = eligible.filter((item) => !item.version || compare(item.version, versions[item.name].latest) < 0);
  if (!pending.length) { ctx.output.write({ installations: [], skipped, warnings }, ['所有可更新的安装都已是最新版或更高版本。', ...skippedLines(skipped), ...warnings]); return 0; }
  if (pending.some((item) => findSkill(ctx.catalog, item.name).paid)) await requireLogin(ctx);
  if (!await ctx.confirm(`更新 ${pending.length} 处安装？`, ctx.options.yes, ctx.interactive, ctx.signal, true)) {
    ctx.output.write({ cancelled: true, skipped }, ['已取消更新。', ...skippedLines(skipped)]); return 0;
  }
  warnings.push(...await apply(ctx, pending.map((item) => ({ name: item.name, path: item.path, previousName: item.name })), versions));
  const installations = pending.map((item) => ({ name: item.name, path: item.path, previous: item.version, version: versions[item.name].latest }));
  ctx.output.write({ installations, skipped, warnings }, [...installations.map((item) => `已更新 ${item.name}：${item.previous || '版本未知'} → ${item.version}（${item.path}）`), ...skippedLines(skipped), ...warnings]);
  return 0;
}

async function subscribe(ctx) {
  const name = ctx.options.skill;
  const { product, paid } = findSkill(ctx.catalog, name);
  if (!paid) throw new CliError(`${name} 是免费 Skill，无需购买。`, 2, 'usage');
  if (ctx.options.plan && !Object.hasOwn(product.prices, ctx.options.plan)) throw new CliError(`这个产品没有 ${ctx.options.plan} 方案。`, 2, 'usage');
  await requireLogin(ctx);
  await requirePurchase(ctx, name, { plan: ctx.options.plan });
  if (await ctx.confirm(`现在安装 ${name}？`, ctx.options.yes, ctx.interactive, ctx.signal, true)) return await install(ctx, name);
  ctx.output.write({ event: 'install_hint', install_command: `oil install ${name}` }, [`以后安装：oil install ${name}`]);
  return 0;
}

async function logout(ctx) {
  const warnings = [];
  let revoked = false, token;
  try {
    token = (await readAuth())?.token;
    ctx.output.remember(token);
    if (token) { await ctx.client.request('/api/cli/logout', { method: 'POST', token }); revoked = true; }
  } catch (error) {
    // 失效令牌已经无法使用；网络和其他错误仍要清除本机配置。
    if (error instanceof CliError && error.details.http_status === 401) revoked = true;
    else warnings.push(`未能撤销服务端令牌：${error.message} 可到 ${ctx.client.url('/account/')} 撤销。`);
  } finally { await deleteConfig(); }
  if (process.env.OIL_TOKEN) warnings.push('OIL_TOKEN 仍在环境里，请取消该环境变量。');
  ctx.output.write({ logged_out: true, revoked, warnings }, [revoked ? '已撤销令牌，并删除本机配置。' : '已删除本机配置。', ...warnings]);
  return 0;
}

// runtime 用于测试时注入时钟和终端交互；可执行入口不传测试选项。
export async function run(argv, runtime = {}) {
  const tokenValues = argv.flatMap((arg, i) => arg === '--token' ? [argv[i + 1]] : arg.startsWith('--token=') ? [arg.slice(8)] : []);
  const output = new Output(argv.includes('--json'), 'unknown', [process.env.OIL_TOKEN, ...tokenValues]);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const options = parseArgs(argv);
    output.command = options.command;
    if (options.command === 'help') { output.write({ usage: help }, help); return 0; }
    if (options.command === 'version') {
      const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      output.write({ version }, [`oil ${version}`]); return 0;
    }
    const quote = (value) => /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
    const ctx = { options, output, token: null, interactive: runtime.interactive ?? canPrompt(options.json),
      terminal: runtime.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      nextCommand: ['npx', 'github:oil-oil/oil-cli', ...argv].map(quote).join(' '), signal: controller.signal,
      client: new Client(controller.signal), sleep: runtime.sleep || delay, now: runtime.now || Date.now,
      openBrowser: runtime.openBrowser || ((url, timeoutMs) => openBrowser(url, undefined, undefined, timeoutMs)), confirm: runtime.confirm || confirm, ask: runtime.ask || ask };
    if (options.command === 'logout') return await logout(ctx);
    if (options.command === 'login') return await login(ctx, options.token);
    // 账号配置只在 status 或确实需要登录时读取。
    if (options.command === 'manage') {
      await requireLogin(ctx);
      const portal = await ctx.client.request('/api/account/portal', { method: 'POST', token: ctx.token });
      const opened = await ctx.openBrowser(portal?.url);
      output.write({ url: portal.url, opened }, [opened ? `已打开购买管理：${portal.url}` : `无法打开浏览器，请打开：${portal.url}`]);
      return 0;
    }
    ctx.catalog = await ctx.client.catalog();
    ctx.names = catalogNames(ctx.catalog);
    if (options.command === 'status') return await status(ctx);
    if (options.command === 'list') return await list(ctx);
    if (options.command === 'install') return await install(ctx);
    if (options.command === 'update') return await update(ctx);
    return await subscribe(ctx);
  } catch (error) {
    if (controller.signal.aborted) return output.fail(new CliError('操作已取消。', 1, 'cancelled'));
    return output.fail(error);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
