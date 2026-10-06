import { t, withLanguage, resolveLanguage, command, helpLines, skillLabel, planLabel, priceLabel as formatPrice } from './i18n.js';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Output, CliError, ask, canPrompt, confirm } from './io.js';
import { readAuth, logout as deleteConfig } from './config.js';
import { Client, catalogNames, findSkill } from './client.js';
import { openBrowser } from './browser.js';
import { isSkillName, scan, inspectSkill, isDevelopmentDirectory, installationRoots, uniqueDirectories, canonicalDirectory, resolveDirectory, targetRoot, sameAgentRoots, freeReplacements, compare, updates, conflicts, duplicateCopies } from './skills.js';
import { prepare, replaceAll } from './install.js';
import { login, loadAuth, requireLogin } from './auth.js';
import { requirePurchase } from './purchase.js';
import { directoryKey, sameDirectory } from './platform.js';

export function parseArgs(argv) {
  const options = { command: null, json: false, yes: false, to: [], token: null, plan: null, path: null, skill: null, lang: null };
  const positions = [];
  let version = false, helpFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--version') version = true;
    else if (['--help', '-h'].includes(arg)) helpFlag = true;
    else if (/^--(to|token|plan|path|lang)(=|$)/.test(arg)) {
      const flag = arg.split('=')[0], field = flag.slice(2);
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('-')) throw new CliError(t('missingArgument', { flag }), 2, 'missing_argument');
      if (field === 'to') options.to.push(value);
      else {
        if (options[field] !== null) throw new CliError(t('duplicateArgument', { flag }), 2, 'usage');
        options[field] = value;
      }
    } else if (arg.startsWith('-')) throw new CliError(t('unknownArgument'), 2, 'usage');
    else positions.push(arg);
  }
  options.command = positions.shift() || 'status';
  if (version) {
    if (positions.length || options.command !== 'status' || options.to.length || options.token || options.plan || options.path || helpFlag || argv.includes('status')) throw new CliError(t('versionUsage'), 2, 'usage');
    options.command = 'version';
  } else if (helpFlag) { options.command = 'help'; positions.length = 0; }
  if (!['status', 'list', 'install', 'update', 'login', 'logout', 'subscribe', 'manage', 'help', 'version'].includes(options.command)) throw new CliError(t('unknownCommand'), 2, 'usage');
  if (['install', 'update', 'subscribe'].includes(options.command)) {
    options.skill = positions.shift() || null;
    if (!options.skill && options.command !== 'update') throw new CliError(t('missingSkill', { action: command(options.command) }), 2, 'missing_skill');
    if (options.skill && !isSkillName(options.skill)) throw new CliError(t('invalidSkill'), 2, 'usage');
  }
  if (positions.length || (options.to.length && options.command !== 'install') || (options.token !== null && options.command !== 'login') || (options.plan !== null && options.command !== 'subscribe') || (options.path !== null && options.command !== 'update')) throw new CliError(t('wrongArgument'), 2, 'usage');
  return options;
}

function installationLines(installed) {
  return installed.flatMap((item) => {
    const key = item.development ? 'versionSkipped' : item.current === item.latest ? 'versionCurrent' : item.current && compare(item.current, item.latest) > 0 ? 'versionNewer' : 'versionUpdate';
    return [t(key, { name: skillLabel(item.name), version: item.current || t('unknownVersion'), latest: item.latest }),
      t('location', { path: item.path }), ...item.updates.flatMap((entry) => [t('releaseNotes', { version: entry.version }), entry.notes || t('noReleaseNotes')])];
  });
}
const subscriptionLabel = (status) => ['active', 'canceling', 'past_due', 'lifetime', 'trialing'].includes(status) ? t(status) : status;
function localDate(seconds) {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return t('unknownDate');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const subscriptionLines = (subscriptions) => subscriptions.length ? subscriptions.map((s) =>
  t(s.status === 'lifetime' || s.plan === 'lifetime' ? 'purchaseStatus' : 'subscription', {
    name: s.name || skillLabel(s.skill), status: subscriptionLabel(s.status), plan: planLabel(s.plan),
  }) + (s.renews != null ? t('renews', { date: localDate(s.renews) }) : '') + (s.ends != null ? t('ends', { date: localDate(s.ends) }) : '')) : [t('noPurchases')];
const skippedInstallation = (item) => ({ name: item.name, path: item.path, reason: 'development_directory' });
const skippedLines = (skipped) => skipped.map((item) => t(({ symbolic_link: 'skippedSymbolicLink', unrecognized_skill: 'skippedUnrecognizedSkill' })[item.reason] || 'skipped', { name: skillLabel(item.name), path: item.path }));
const removedActions = (actions) => actions.filter((action) => action.remove || action.replacesFree);
const removedLines = (actions) => removedActions(actions).map((action) => t('removedFree', { name: skillLabel(action.previousName), path: action.path }));
const linkedLines = (links) => links.map((item) => t('linked', { name: skillLabel(item.name), path: item.path, target: item.target }));
const duplicateLines = (copies) => copies.map((item) => t('duplicateCopies', { name: skillLabel(item.name), count: item.paths.length, next: command('install', item.name) }));
async function lstatOrNull(file) {
  try { return await lstat(file); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}
// 安装本身是链接时，更新它指向的真实目录，不把链接换成一份独立副本。
const realInstallation = async (item) => (await lstatOrNull(item.path))?.isSymbolicLink() ? item.real_path : item.path;

async function status(ctx) {
  await loadAuth(ctx);
  const found = await scan(ctx.names);
  const versions = await ctx.client.versions(ctx.catalog);
  const installations = found.map((item) => ({ name: item.name, path: item.path, current: item.version, latest: versions[item.name].latest, development: item.development, real_path: item.real_path,
    update_available: !item.development && (!item.version || compare(item.version, versions[item.name].latest) < 0), updates: updates(item.version, versions[item.name]) }));
  const warnings = await conflicts(found, ctx.catalog);
  warnings.push(...duplicateLines(duplicateCopies(found)));
  for (const item of found) {
    const history = versions[item.name].history;
    const oldest = history.filter((entry) => /^\d+\.\d+\.\d+$/.test(entry.version)).sort((a, b) => compare(a.version, b.version))[0];
    if (history.length >= 20 && item.version && oldest && compare(item.version, oldest.version) < 0) warnings.push(t('historyWarning', { path: item.path }));
  }
  const lines = installations.length ? installationLines(installations) : [t('noInstallations')];
  let account = null;
  if (ctx.token) {
    try {
      account = { ...await ctx.client.me(ctx.token), token_prefix: ctx.token };
      lines.push(t('account', { email: account.email }), ...subscriptionLines(account.subscriptions));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      ctx.output.write({ installations, warnings, account: null, error: error.error, message: error.message, ...error.details }, [...lines, ...warnings, error.message], false);
      return error.code;
    }
  }
  ctx.output.write({ installations, warnings, account }, [...lines, ...warnings, ...(!ctx.token ? [t('notLoggedIn')] : [])]);
  return 0;
}

function priceLabel(prices) {
  return Object.entries(prices).map(([plan, price]) => t('pricePlan', { price: formatPrice(price), plan: planLabel(plan) })).join('; ') || t('priceUnavailable');
}
async function list(ctx) {
  const skills = ctx.catalog.flatMap((product) => ['free', 'paid'].filter((type) => product[type]).map((type) => ({
    skill: product[type].skill, name: product.name, summary: product.summary || '', type, prices: type === 'paid' ? product.prices : {}, page: ctx.client.subscriptionUrl(product[type].skill, product),
  })));
  ctx.output.write({ skills }, skills.length ? skills.map((s) => t('catalogLine', { name: skillLabel(s.skill), type: s.type === 'free' ? t('free') : t('paid', { price: priceLabel(s.prices) }), summary: s.summary ? t('summary', { summary: s.summary }) : '' })) : [t('emptyCatalog')]);
  return 0;
}

async function apply(ctx, actions, versions, { purchaseOnInactive = false } = {}) {
  const prepared = new Map();
  try {
    for (const name of new Set(actions.filter((action) => !action.remove && !action.link).map((action) => action.name))) {
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
    return await replaceAll(actions.map((action) => ({ ...action, source: action.remove || action.link ? undefined : prepared.get(action.name).source })), { signal: ctx.signal, names: ctx.names });
  } finally {
    for (const item of prepared.values()) await item.cleanup().catch(() => {});
  }
}

// 清理动作与安装/更新共用 replaceAll 的备份和整批回滚，不单独删除。
async function addFreeReplacements(ctx, actions, targets = actions) {
  const groups = new Map(), skipped = [];
  for (const target of targets) {
    const { product, paid } = findSkill(ctx.catalog, target.name);
    if (!paid || !product.free) continue;
    const root = path.dirname(target.path);
    const roots = target.name === 'oil-ui-pro' ? await sameAgentRoots(root) : [root];
    const key = [product.free.skill, ...[...new Set(await Promise.all(roots.map(async (root) => directoryKey(await canonicalDirectory(root)))))].sort()].join('\0');
    const group = groups.get(key) || { name: product.free.skill, paid: target.name, roots: [], targets: [] };
    group.roots.push(...roots);
    group.targets.push(target);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const { name } = group;
    const found = await freeReplacements(name, group.roots);
    skipped.push(...found.skipped);
    for (const item of found.skipped) {
      const index = actions.findIndex((action) => sameDirectory(action.path, item.path));
      if (index >= 0) actions.splice(index, 1);
    }
    if (group.targets.every((target) => found.skipped.some((item) => sameDirectory(item.path, target.path)))) continue;
    for (const item of found.removable) {
      const index = actions.findIndex((action) => sameDirectory(action.path, item.path));
      const replacement = actions[index];
      if (replacement?.name === group.paid) {
        replacement.previousName = name;
        replacement.replacesFree = true;
        replacement.protectSymlinks = true;
      } else {
        if (index >= 0) actions.splice(index, 1);
        actions.push({ name, path: item.path, previousName: name, remove: true, protectSymlinks: true });
      }
    }
  }
  return { skipped, roots: [...groups.values()].flatMap((group) => group.roots) };
}

async function install(ctx, name = ctx.options.skill) {
  const { paid } = findSkill(ctx.catalog, name);
  let roots = ctx.options.to.length ? [...new Set(ctx.options.to.map((value) => targetRoot(value)))] : await installationRoots();
  if (!roots.length) {
    const next = ctx.options.command === 'install' ? `${ctx.nextCommand} --to codex` : command('install', name, '--to', 'codex',
      ...(ctx.options.json ? ['--json'] : []), ...(ctx.options.lang ? ['--lang', ctx.options.lang] : []));
    const details = { recommended_path: targetRoot('codex'), recommended_command: next, next_command: next };
    if (!ctx.interactive) throw new CliError(t('missingTarget', { next }), 2, 'missing_target', details);
    const answer = await ctx.ask(t('askTarget'), ctx.signal);
    if (!answer) throw new CliError(t('noTarget', { next }), 2, 'missing_target', details);
    roots = [targetRoot(answer)];
  }
  roots = await uniqueDirectories(roots);
  const found = (await scan(ctx.names, roots)).filter((item) => item.name === name);
  // 第一个能放下这个 Skill 的目录放真实的一份，其余 Agent 用链接共享，更新一次全部生效。
  // 同名位置被别的东西占着（例如受保护的链接）时顺延，不让其他 Agent 链到错误的内容上。
  let primaryIndex = 0;
  for (let i = 0; i < roots.length; i++) {
    const directory = path.join(roots[i], name);
    if (found.some((item) => sameDirectory(item.root, roots[i])) || !await lstatOrNull(directory) || (await inspectSkill(directory, ctx.names))?.name === name) { primaryIndex = i; break; }
  }
  const primaryRoot = roots[primaryIndex], linkRoots = roots.filter((root, index) => index !== primaryIndex);
  if (ctx.interactive) ctx.output.write({ event: 'targets', paths: roots, primary: primaryRoot, links: linkRoots },
    [t('targets'), primaryRoot, ...linkRoots.map((root) => t('targetLink', { path: root }))]);
  if (!await ctx.confirm(t('confirmInstall', { name: skillLabel(name) }), ctx.options.yes, ctx.interactive, ctx.signal, true)) {
    ctx.output.write({ cancelled: true }, [t('installCanceled')]); return 0;
  }
  const actions = [], skipped = [], links = [];
  const primaries = found.filter((item) => sameDirectory(item.root, primaryRoot));
  const candidates = primaries.length ? primaries : [{ name, path: path.join(primaryRoot, name), version: null }];
  const target = path.resolve((candidates.find((item) => path.basename(item.path) === name) || candidates[0]).path);
  for (const item of candidates) {
    if (await isDevelopmentDirectory(item.path)) { skipped.push(skippedInstallation(item)); continue; }
    actions.push({ name, path: primaries.length ? await realInstallation(item) : item.path, previousName: primaries.length ? name : null, previousVersion: item.version });
  }
  const targetKey = directoryKey(await canonicalDirectory(target));
  for (const root of linkRoots) {
    // 同名文件夹之外，别的文件夹名里装着同一个 Skill 的独立副本也换成链接。
    const directories = [...new Set([path.join(root, name), ...found.filter((item) => sameDirectory(item.root, root)).map((item) => item.path)])];
    for (const directory of directories) {
      const info = await lstatOrNull(directory);
      if (info && directoryKey(await canonicalDirectory(directory)) === targetKey) { links.push({ name, path: directory, target, existing: true }); continue; }
      if (info && await isDevelopmentDirectory(directory)) { skipped.push(skippedInstallation({ name, path: directory })); continue; }
      const current = info ? await inspectSkill(directory, ctx.names) : null;
      actions.push({ name, path: directory, link: target, previousName: current?.name === name ? name : null, previousVersion: current?.version || null });
    }
  }
  if (!actions.length) {
    ctx.output.write({ installations: [], links, removed: [], skipped, warnings: [] }, [...linkedLines(links), ...skippedLines(skipped)]); return 0;
  }
  const downloads = actions.some((action) => !action.link);
  if (paid && downloads) { await requireLogin(ctx); await requirePurchase(ctx, name); }
  const cleanup = await addFreeReplacements(ctx, actions);
  skipped.push(...cleanup.skipped.filter((item) => !skipped.some((existing) => sameDirectory(existing.path, item.path))));
  const versions = await ctx.client.versions(ctx.catalog);
  const warnings = await apply(ctx, actions, versions, { purchaseOnInactive: true });
  const installed = await scan(ctx.names, [...roots, ...cleanup.roots]);
  warnings.push(...await conflicts(installed, ctx.catalog));
  const installations = actions.filter((action) => !action.remove && !action.link).map((action) => ({ name, path: action.path,
    previous: action.previousName === name ? action.previousVersion : null, version: versions[name].latest }));
  links.push(...actions.filter((action) => action.link).map((action) => ({ name, path: action.path, target: action.link, existing: false, replaced_copy: action.previousName === name })));
  const removed = removedActions(actions).map((action) => action.path);
  let proHint = null;
  if (name === 'oil-ui' && actions.some((action) => !action.previousName) && !installed.some((item) => item.name === 'oil-ui-pro')) {
    // 介绍是可选的；其他宿主目录不可读时不影响已完成的安装，也不猜测是否装过 Pro。
    try {
      if (!(await scan(ctx.names)).some((item) => item.name === 'oil-ui-pro')) {
        proHint = { name: 'Oil UI Pro', skill: 'oil-ui-pro', url: 'https://ui.oiloil.org/pro/', message: t('proHint', { url: 'https://ui.oiloil.org/pro/' }) };
      }
    } catch (error) { if (!(error instanceof CliError) || error.error !== 'skill_read') throw error; }
  }
  ctx.output.write({ installations, links, removed, skipped, warnings, ...(proHint ? { pro_hint: proHint } : {}) }, [...installations.map((item) => item.previous && item.previous !== item.version
    ? t('updated', { name: skillLabel(item.name), previous: item.previous, version: item.version, path: item.path })
    : t('installed', { name: skillLabel(item.name), version: item.version, path: item.path })), ...linkedLines(links), ...removedLines(actions), ...skippedLines(skipped), ...warnings, proHint?.message]);
  return 0;
}

async function update(ctx) {
  if (ctx.options.skill) findSkill(ctx.catalog, ctx.options.skill);
  let all;
  if (ctx.options.path) {
    const directory = resolveDirectory(ctx.options.path);
    const item = await inspectSkill(directory, ctx.names);
    if (!item) throw new CliError(t('unknownInstallation', { path: directory }), 2, 'unknown_installation');
    if (ctx.options.skill && item.name !== ctx.options.skill) throw new CliError(t('installationMismatch', { name: skillLabel(item.name), expected: skillLabel(ctx.options.skill) }), 2, 'skill_mismatch');
    all = [item];
  } else all = await scan(ctx.names);
  const found = all.filter((item) => !ctx.options.skill || item.name === ctx.options.skill);
  const skipped = found.filter((item) => item.development).map(skippedInstallation);
  const seen = new Set();
  const eligible = found.filter((item) => {
    if (item.development || seen.has(directoryKey(item.real_path))) return false;
    seen.add(directoryKey(item.real_path)); return true;
  });
  const counts = { found_count: found.length, eligible_count: eligible.length, updated_count: 0 };
  if (!eligible.length) {
    const warnings = await conflicts(all, ctx.catalog);
    ctx.output.write({ installations: [], removed: [], skipped, warnings, ...counts, status: found.length ? 'skipped' : 'no_installations' }, [...(found.length ? [] : [t('noInstallations')]), ...skippedLines(skipped), ...warnings]); return 0;
  }
  const versions = await ctx.client.versions(ctx.catalog);
  const pending = eligible.filter((item) => !item.version || compare(item.version, versions[item.name].latest) < 0);
  const actions = await Promise.all(pending.map(async (item) => ({ name: item.name, path: await realInstallation(item), previousName: item.name, previousVersion: item.version })));
  const cleanup = await addFreeReplacements(ctx, actions, eligible.filter((item) => item.name === 'oil-ui-pro'));
  skipped.push(...cleanup.skipped.filter((item) => !skipped.some((existing) => sameDirectory(existing.path, item.path))));
  const replacements = actions.filter((action) => !action.remove);
  if (replacements.some((item) => findSkill(ctx.catalog, item.name).paid)) await requireLogin(ctx);
  if (replacements.length && !await ctx.confirm(t('confirmUpdate', { count: replacements.length }), ctx.options.yes, ctx.interactive, ctx.signal, true)) {
    ctx.output.write({ cancelled: true, removed: [], skipped, ...counts, status: 'cancelled' }, [t('updateCanceled'), ...skippedLines(skipped)]); return 0;
  }
  const warnings = await apply(ctx, actions, versions);
  const after = await scan(ctx.names, [...all.map((item) => item.root), ...cleanup.roots]);
  warnings.push(...await conflicts(after, ctx.catalog));
  if (!ctx.options.path) warnings.push(...duplicateLines(duplicateCopies(after.filter((item) => !ctx.options.skill || item.name === ctx.options.skill))));
  const installations = actions.filter((action) => !action.remove).map((item) => ({ name: item.name, path: item.path, previous: item.previousVersion, version: versions[item.name].latest }));
  const removed = removedActions(actions).map((action) => action.path);
  ctx.output.write({ installations, removed, skipped, warnings, ...counts, updated_count: installations.length, status: installations.length ? 'updated' : 'up_to_date' }, [...(installations.length ? installations.map((item) => t('updated', { name: skillLabel(item.name), previous: item.previous || t('unknownVersion'), version: item.version, path: item.path })) : [t('upToDate')]), ...removedLines(actions), ...skippedLines(skipped), ...warnings]);
  return 0;
}

async function subscribe(ctx) {
  const name = ctx.options.skill;
  const { product, paid } = findSkill(ctx.catalog, name);
  if (!paid) throw new CliError(t('freePurchase', { name: skillLabel(name) }), 2, 'usage');
  if (ctx.options.plan && !Object.hasOwn(product.prices, ctx.options.plan)) throw new CliError(t('unknownPlan', { plan: ctx.options.plan }), 2, 'usage');
  await requireLogin(ctx);
  await requirePurchase(ctx, name, { plan: ctx.options.plan });
  if (await ctx.confirm(t('installNow', { name: skillLabel(name) }), ctx.options.yes, ctx.interactive, ctx.signal, true)) return await install(ctx, name);
  ctx.output.write({ event: 'install_hint', install_command: command('install', name) }, [t('installLater', { next: command('install', name) })]);
  return 0;
}

async function logout(ctx) {
  const warnings = [];
  let revoked = false, token;
  try {
    token = (await readAuth(ctx.client.base))?.token;
    ctx.output.remember(token);
    if (token) { await ctx.client.request('/api/cli/logout', { method: 'POST', token }); revoked = true; }
  } catch (error) {
    // 失效令牌已经无法使用；网络和其他错误仍要清除本机配置。
    if (error instanceof CliError && error.details.http_status === 401) revoked = true;
    else warnings.push(t('revokeWarning', { message: error.message, url: ctx.client.url('/account/') }));
  } finally { await deleteConfig(); }
  if (process.env.OIL_TOKEN) warnings.push(t('tokenEnvWarning'));
  ctx.output.write({ logged_out: true, revoked, warnings }, [revoked ? t('revoked') : t('configRemoved'), ...warnings]);
  return 0;
}

// runtime 用于测试时注入时钟和终端交互；可执行入口不传测试选项。
export const run = (argv, runtime = {}) => withLanguage(resolveLanguage(argv), () => runCommand(argv, runtime));

async function runCommand(argv, runtime) {
  const tokenValues = argv.flatMap((arg, i) => arg === '--token' ? [argv[i + 1]] : arg.startsWith('--token=') ? [arg.slice(8)] : []);
  const output = new Output(argv.includes('--json'), 'unknown', [process.env.OIL_TOKEN, ...tokenValues]);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const options = parseArgs(argv);
    output.command = options.command;
    if (options.command === 'help') { const help = helpLines(); output.write({ usage: help }, help); return 0; }
    if (options.command === 'version') {
      const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      output.write({ version }, [`oil ${version}`]); return 0;
    }
    const ctx = { options, output, token: null, interactive: runtime.interactive ?? canPrompt(options.json),
      terminal: runtime.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      nextCommand: command(...argv), signal: controller.signal,
      client: new Client(controller.signal), sleep: runtime.sleep || delay, now: runtime.now || Date.now,
      openBrowser: runtime.openBrowser || ((url, timeoutMs) => openBrowser(url, undefined, undefined, timeoutMs)), confirm: runtime.confirm || confirm, ask: runtime.ask || ask };
    if (options.command === 'logout') return await logout(ctx);
    if (options.command === 'login') return await login(ctx, options.token);
    // 账号配置只在 status 或确实需要登录时读取。
    if (options.command === 'manage') {
      await requireLogin(ctx);
      const portal = await ctx.client.request('/api/account/portal', { method: 'POST', token: ctx.token });
      const opened = await ctx.openBrowser(portal?.url);
      output.write({ url: portal.url, opened }, [opened ? t('portalOpened', { url: portal.url }) : t('browserManual', { url: portal.url })]);
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
    if (controller.signal.aborted) return output.fail(new CliError(t('canceled'), 1, 'cancelled'));
    return output.fail(error);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
