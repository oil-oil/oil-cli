import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat, readlink, symlink, link, copyFile, realpath } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tarInvocation } from '../src/platform.js';

const exec = promisify(execFile);
export const CLI = fileURLToPath(new URL('../bin/oil.js', import.meta.url));
const DRIVER = fileURLToPath(new URL('./driver.js', import.meta.url));
export const TOKEN = 'oil_Abcd0123456789abcdefghijklmnopqrstuvXYZ';
export const INACTIVE = 'oil_Empty0123456789abcdefghijklmnopqrstuvXYZ';
export const INVALID = 'oil_Bad0123456789abcdefghijklmnopqrstuvXYZ';
export const EMAIL = 'test@example.com';
// Windows 的模式位不区分 owner/group/others；用户隔离由目录 ACL 提供。
export const configMode = process.platform === 'win32' ? 0o666 : 0o600;
export const linkDirectory = (target, directory) => symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
export const readDirectoryLink = async (directory) => {
  const target = await readlink(directory);
  return process.platform === 'win32' ? target.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '') : target;
};
export async function pack(file, source, names) {
  const tar = tarInvocation(file, source);
  await exec(tar.command, ['-czf', path.basename(file), '-C', source, ...names], { cwd: tar.cwd, timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: '1' } });
}
// 直接编码恶意链接条目，不能让 Windows tar 跟随 junction 打包它的祖先。
export async function prependArchiveLink(file, name, target) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  for (const [offset, length, value] of [[100, 8, 0o777], [108, 8, 0], [116, 8, 0], [124, 12, 0], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  header.fill(32, 148, 156);
  header.write('2', 156, 1);
  header.write(target, 157, 100);
  header.write('ustar\0', 257);
  header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  await writeFile(file, gzipSync(Buffer.concat([header, gunzipSync(await readFile(file))])));
}
export const CATALOG = [
  { id: 'oil-ui', name: 'Oil UI Pro', summary: '帮你做好界面。', features: [], free: { skill: 'oil-ui' }, paid: { skill: 'oil-ui-pro' }, offer: ['lifetime'], prices: { lifetime: { amount: 6900, currency: 'cny', interval: null } }, page: '/pro/' },
  { id: 'oil-doc', name: 'Oil Doc Pro', summary: '整理文档。', features: [], free: { skill: 'oil-doc' }, paid: { skill: 'oil-doc-pro' }, offer: ['yearly'], prices: { yearly: { amount: 9900, currency: 'cny', interval: 'year' } }, page: '/store/oil-doc-pro/' },
];

export async function writeSkill(root, name, version, folder = name) {
  const directory = path.join(root, folder);
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试 Skill\nmetadata:\n  version: "${version}"\n---\n\n# 测试\n`);
  await writeFile(path.join(directory, 'assets', 'example.txt'), `${name} ${version}\n`);
  return directory;
}

export async function release(directory, name, version) {
  const source = path.join(directory, `source-${name}-${version}`);
  await writeSkill(source, name, version);
  const file = path.join(directory, `${name}-${version}.tar.gz`);
  await pack(file, source, [name]);
  const body = await readFile(file);
  return { body, sha256: createHash('sha256').update(body).digest('hex'), file, source };
}

const browserScript = `(async () => {\nif (process.env.OIL_TEST_BROWSER !== 'approve') process.exit(1);\nconst url = new URL(process.env.OIL_BROWSER_URL || process.argv.at(-1));\nif (url.pathname.endsWith('/device/')) {\nconst response = await fetch(new URL('/api/cli/device/approve', url), {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: 'oil_session=fake'}, body: JSON.stringify({user_code: url.searchParams.get('code'), approve: true})});\nif (!response.ok) process.exit(1);\n}\nprocess.exit(0);\n})().catch(() => process.exit(1));\n`;
export async function mockCommandProcessor(directory) {
  const helper = path.join(directory, 'browser-helper.cjs');
  // 异步授权完成前不能让 Node 把 cmd 的 /d 当作主脚本加载。
  await writeFile(helper, `if (process.argv.includes('/v:off') && process.env.OIL_BROWSER_URL) {\nrequire('node:module').runMain = () => {};\n${browserScript}}\n`);
  const executable = path.join(directory, 'cmd.exe');
  try { await link(process.execPath, executable); }
  catch { await copyFile(process.execPath, executable); }
  return { executable, nodeOptions: `--require "${helper.replaceAll('\\', '/')}"` };
}

export async function fixture(t) {
  let temporary = await mkdtemp(path.join(tmpdir(), 'oil-test-'));
  if (process.platform === 'win32') temporary = await realpath(temporary);
  const home = path.join(temporary, 'home'), cwd = path.join(temporary, 'project'), config = path.join(temporary, 'config'), mockBin = path.join(temporary, 'bin');
  for (const directory of [home, cwd, config, mockBin]) await mkdir(directory);
  // 真 CLI 也使用假浏览器。Windows 不能执行 shebang，使用 Node 的 exe 和预加载脚本。
  let nodeOptions = process.env.NODE_OPTIONS || '';
  let commandProcessor = process.env.ComSpec;
  if (process.platform === 'win32') {
    const mock = await mockCommandProcessor(mockBin);
    // Windows 在 PATH 之前搜索系统目录；用 ComSpec 显式指定模拟程序。
    commandProcessor = mock.executable;
    nodeOptions += ` ${mock.nodeOptions}`;
  } else {
    for (const name of ['open', 'xdg-open']) await writeFile(path.join(mockBin, name), `#!${process.execPath}\n${browserScript}`, { mode: 0o755 });
  }
  const releases = {};
  for (const name of ['oil-ui', 'oil-ui-pro', 'oil-doc', 'oil-doc-pro']) {
    for (const version of ['0.10.0', '0.11.0']) releases[`${name}:${version}`] = await release(temporary, name, version);
  }
  const state = { catalog: structuredClone(CATALOG), latest: '0.10.0', badChecksum: false, missingChecksum: false, proBadChecksum: false, paidMissingChecksum: false,
    deviceStatuses: ['authorization_pending', 'success'], devicePolls: 0, deviceRequests: 0, interval: 5, expiresIn: 600, deviceApproved: false, requireApproval: false,
    checkoutPolls: 0, checkoutRequests: 0, checkoutActiveAfter: 2, checkoutAlreadyActive: false, downloadInactiveCount: 0,
    checkoutStatusPolls: 0, checkoutStatusActiveAfter: Infinity, checkoutCreated: 0, sessions: new Map(),
    logoutFailure: false, requests: [], revoked: new Set(), grants: new Map() };
  let base;
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const error = (res, status, code, message) => json(res, status, { error: code, message });
  const subscriptions = (token) => {
    if (state.subscriptions) return state.subscriptions;
    const names = state.grants.get(token) || (token === TOKEN ? ['oil-ui-pro', 'oil-doc-pro'] : []);
    return names.map((skill) => {
      const product = state.catalog.find((p) => p.paid?.skill === skill);
      const plan = product?.offer?.[0] || 'lifetime';
      return { skill, name: product?.name || skill, plan, status: plan === 'lifetime' ? 'lifetime' : 'active', renews: plan === 'lifetime' ? null : 1793664000, ends: null };
    });
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : null;
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const english = req.headers['accept-language'] === 'en';
      state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, token, body, headers: req.headers });
      const valid = [TOKEN, INACTIVE].includes(token) && !state.revoked.has(token);
      const authenticate = () => { if (!valid) { error(res, 401, 'unauthorized', `令牌无效：${token || ''}`); return false; } return true; };
      if (req.method === 'GET' && url.pathname === '/api/store/catalog') return json(res, 200, { products: state.catalog.map((p) => ({ ...p, summary: english ? 'Help with your work.' : p.summary })) });
      if (req.method === 'GET' && url.pathname === '/api/store/versions') {
        const history = [state.latest, ...(state.latest === '0.11.0' ? ['0.10.0'] : []), '0.9.0', '0.8.0'].map((version) => ({ version, published_at: '2026-10-02T08:00:00Z', notes: english ? `${version}: Improve layout and interactions.` : `${version}：改善布局和交互。` }));
        const skills = {};
        for (const product of state.catalog) for (const type of ['free', 'paid']) {
          const name = typeof product[type] === 'string' ? product[type] : product[type]?.skill;
          if (!name) continue;
          const archive = releases[`${name}:${state.latest}`];
          skills[name] = { latest: state.latest, published_at: '2026-10-02T08:00:00Z', history,
            ...(type === 'free' ? { download_url: `${base}/releases/${name}-${state.latest}.tar.gz`, sha256: state.missingChecksum ? null : state.badChecksum ? '0'.repeat(64) : archive?.sha256 } : {}) };
        }
        return json(res, 200, { skills });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/releases/')) {
        const [, name, version] = url.pathname.match(/^\/releases\/(.+)-(\d+\.\d+\.\d+)\.tar\.gz$/) || [];
        const archive = releases[`${name}:${version}`];
        if (!archive) return error(res, 404, 'not_found', '没有该版本。');
        res.writeHead(200, { 'Content-Type': 'application/gzip' }); return res.end(archive.body);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/store/download/')) {
        const name = decodeURIComponent(url.pathname.split('/').at(-1));
        const product = state.catalog.find((p) => p.free?.skill === name || p.paid?.skill === name);
        if (!product) return error(res, 404, 'not_found', '没有这个 Skill。');
        const version = url.searchParams.get('version') === 'latest' ? state.latest : url.searchParams.get('version');
        const archive = releases[`${name}:${version}`];
        if (!archive) return error(res, 404, 'not_found', '没有该版本。');
        if (product.free?.skill === name) { res.writeHead(302, { Location: `${base}/releases/${name}-${version}.tar.gz` }); return res.end(); }
        if (!authenticate()) return;
        if (state.downloadInactiveCount > 0) {
          state.downloadInactiveCount--;
          state.grants.set(token, []);
        }
        if (!subscriptions(token).some((s) => s.skill === name)) return error(res, 402, 'inactive', '尚未购买。');
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}-${version}.tar.gz"`,
          ...(state.paidMissingChecksum ? {} : { 'X-Content-SHA256': state.proBadChecksum ? 'f'.repeat(64) : archive.sha256 }), 'X-Skill-Version': state.badVersion ? '9.9.9' : version });
        return res.end(archive.body);
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/device') {
        state.deviceRequests++;
        state.devicePolls = 0;
        state.deviceApproved = false;
        const suffix = state.deviceRequests === 1 ? '' : `_${state.deviceRequests}`;
        state.deviceCode = `device_secret_0123456789${suffix}`;
        state.userCode = `KDQW-7RTF${suffix}`;
        const devicePath = body.lang ? `/${body.lang}/device/` : '/device/';
        return json(res, 200, { device_code: state.deviceCode, user_code: state.userCode, verification_uri: `${base}${devicePath}`, verification_uri_complete: `${base}${devicePath}?code=${state.userCode}`, expires_in: state.expiresIn, interval: state.interval });
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/device/approve') {
        if (req.headers.cookie !== 'oil_session=fake' || body.user_code !== state.userCode) return error(res, 403, 'forbidden', '确认失败。');
        state.deviceApproved = body.approve;
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/token') {
        if (body.device_code !== state.deviceCode) return error(res, 400, 'expired_token', '设备码不存在。');
        const statuses = state.deviceStatusesByRequest?.[state.deviceRequests - 1] ?? state.deviceStatuses;
        const status = state.requireApproval ? state.deviceApproved ? 'success' : 'authorization_pending' : statuses[Math.min(state.devicePolls, statuses.length - 1)];
        state.devicePolls++;
        if (status === 'upstream') return error(res, 502, 'upstream', '服务连接失败');
        if (status !== 'success') return error(res, 400, status, state.deviceErrorMessage ?? status);
        return json(res, 200, { token: state.deviceToken ?? TOKEN, email: EMAIL });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        if (!authenticate()) return;
        if (state.checkoutToken === token) {
          state.checkoutPolls++;
          const pollError = state.checkoutPollErrors?.[state.checkoutPolls - 1];
          if (pollError) return error(res, 502, 'upstream', '服务连接失败');
          if (state.checkoutPolls >= state.checkoutActiveAfter) state.grants.set(token, [state.checkoutSkill]);
        }
        return json(res, 200, { email: EMAIL, github_login: null, subscriptions: state.meSubscriptions ?? subscriptions(token) });
      }
      if (req.method === 'POST' && url.pathname === '/api/store/checkout') {
        if (!authenticate()) return;
        state.checkoutRequests++;
        if (state.checkoutAlreadyActive) {
          state.grants.set(token, [body.skill]);
          return error(res, 409, 'already_active', '已经解锁。');
        }
        state.checkoutToken = token;
        state.checkoutSkill = body.skill;
        const plan = body.plan || state.catalog.find((p) => p.paid?.skill === body.skill)?.offer?.[0] || 'lifetime';
        const price = state.checkoutPrices?.[body.lang || (english ? 'en' : 'zh')] || state.checkoutPrice || state.catalog.find((p) => p.paid?.skill === body.skill)?.prices[plan];
        const own = [...state.sessions.values()].filter((s) => s.token === token && s.skill === body.skill);
        if (own.some((s) => s.paid)) {
          state.grants.set(token, [...new Set([...(state.grants.get(token) || []), body.skill])]);
          for (const s of own) if (s.status === 'open' && !s.paid) s.status = 'expired';
          return error(res, 409, 'already_active', english ? 'Already purchased.' : '已经解锁。');
        }
        const reused = own.find((s) => s.status === 'open' && s.plan === plan && s.currency === price?.currency);
        if (reused) return json(res, 200, { id: reused.id, url: reused.url, reused: true, amount: reused.amount, currency: reused.currency });
        state.checkoutPolls = 0;
        const id = `cs_test_${++state.checkoutCreated}`;
        const session = { id, url: state.checkoutUrl ?? `${base}/checkout?session=${state.checkoutCreated}`, token, skill: body.skill, plan, amount: price?.amount, currency: price?.currency, status: 'open', paid: false };
        state.sessions.set(id, session);
        return json(res, 200, state.checkoutResponse ?? { id, url: session.url, reused: false, amount: session.amount, currency: session.currency });
      }
      if (req.method === 'GET' && url.pathname === '/api/store/checkout/status') {
        if (!authenticate()) return;
        const session = state.sessions.get(url.searchParams.get('id'));
        if (!session) return error(res, 404, 'not_found', english ? 'Session not found.' : '没有这个会话。');
        if (session.token !== token) return error(res, 403, 'access_denied', english ? 'Access denied.' : '无权查询。');
        state.checkoutStatusPolls++;
        if (state.checkoutStatusErrors?.[state.checkoutStatusPolls - 1]) return error(res, 502, 'upstream', english ? 'Service unavailable.' : '服务连接失败');
        if (state.checkoutStatusPolls >= state.checkoutStatusActiveAfter && session.status === 'open') { session.paid = true; session.status = 'complete'; }
        if (session.paid && !state.fulfillmentPending) {
          state.grants.set(token, [...new Set([...(state.grants.get(token) || []), session.skill])]);
          for (const other of state.sessions.values()) if (other.id !== session.id && other.token === token && other.skill === session.skill && other.status === 'open') other.status = 'expired';
        }
        return json(res, 200, state.checkoutStatusResponse ?? { status: session.status, paid: session.paid, entitled: subscriptions(token).some((s) => s.skill === session.skill) });
      }
      if (req.method === 'POST' && url.pathname === '/api/account/portal') {
        if (!authenticate()) return;
        return json(res, 200, { url: `${base}/portal` });
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/logout') {
        if (state.logoutFailure) return error(res, 503, 'unavailable', '模拟网络失败。');
        if (!authenticate()) return;
        state.revoked.add(token);
        return json(res, 200, { ok: true });
      }
      return error(res, 404, 'not_found', '未知接口。');
    } catch (err) { error(res, 500, 'fixture_error', err.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, APPDATA: config, CODEX_HOME: '', OIL_LANG: '', LC_ALL: 'C', LC_MESSAGES: '', LANG: '', OIL_API: base, OIL_TOKEN: '', CI: '', OIL_TEST_BROWSER: '', NODE_OPTIONS: nodeOptions, PATH: `${mockBin}${path.delimiter}${process.env.PATH || ''}`, ...(commandProcessor ? { ComSpec: commandProcessor } : {}) };
  for (const key of Object.keys(env)) if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
  for (const key of Object.keys(env)) if (key !== 'ComSpec' && key.toLowerCase() === 'comspec') delete env[key];
  const configFile = path.join(config, 'oil', 'config.json');
  let runNumber = 0;
  const run = (args, extraEnv = {}, runtime = {}) => new Promise((resolve, reject) => {
    const traceFile = path.join(temporary, `trace-${runNumber++}.json`);
    const child = spawn(process.execPath, [runtime.real ? CLI : DRIVER, ...args], { cwd, env: { ...env, ...extraEnv, OIL_TEST_RUNTIME: JSON.stringify(runtime), OIL_TEST_TRACE: traceFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (runtime.killOnDevice && (stdout.includes('授权码：') || stdout.includes('"event":"device"'))) child.kill('SIGKILL');
      if (runtime.killOnCheckout && (stdout.includes('付款页面：') || stdout.includes('"event":"checkout"'))) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      let trace = null;
      try { trace = JSON.parse(await readFile(traceFile, 'utf8')); } catch {}
      resolve({ code, signal, stdout, stderr, trace });
    });
  });
  const close = async () => {
    await new Promise((resolve, reject) => { server.close((err) => err ? reject(err) : resolve()); server.closeAllConnections(); });
    await rm(temporary, { recursive: true, force: true });
  };
  t?.after(close);
  return { temporary, home, cwd, config, configFile, mockBin, env, base, state, releases, run, close };
}

export async function snapshot(directory) {
  const result = [];
  async function walk(current, relative = '') {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name), key = path.join(relative, name), info = await lstat(file);
      if (info.isSymbolicLink()) result.push([key, 'symlink', await readlink(file), info.mode]);
      else if (info.isDirectory()) { result.push([key, 'directory', info.mode]); await walk(file, key); }
      else result.push([key, (await readFile(file)).toString('base64'), info.mode]);
    }
  }
  await walk(directory);
  return result;
}
