import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const CLI = fileURLToPath(new URL('../bin/oil.js', import.meta.url));
const DRIVER = fileURLToPath(new URL('./driver.js', import.meta.url));
export const TOKEN = 'oil_Abcd0123456789abcdefghijklmnopqrstuvXYZ';
export const INACTIVE = 'oil_Empty0123456789abcdefghijklmnopqrstuvXYZ';
export const INVALID = 'oil_Bad0123456789abcdefghijklmnopqrstuvXYZ';
export const EMAIL = 'test@example.com';
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
  await exec('tar', ['-czf', file, '-C', source, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const body = await readFile(file);
  return { body, sha256: createHash('sha256').update(body).digest('hex'), file, source };
}

export async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'oil-test-'));
  const home = path.join(temporary, 'home'), cwd = path.join(temporary, 'project'), config = path.join(temporary, 'config'), mockBin = path.join(temporary, 'bin');
  for (const directory of [home, cwd, config, mockBin]) await mkdir(directory);
  // 完全替代系统浏览器命令；手动验收时这个脚本向假服务模拟浏览器允许。
  for (const name of ['open', 'xdg-open', 'cmd.exe']) {
    await writeFile(path.join(mockBin, name), `#!${process.execPath}\nif (process.env.OIL_TEST_BROWSER !== 'approve') process.exit(1);\nconst url = new URL(process.argv.at(-1));\nif (url.pathname === '/device/') {\nconst response = await fetch(new URL('/api/cli/device/approve', url), {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: 'oil_session=fake'}, body: JSON.stringify({user_code: url.searchParams.get('code'), approve: true})});\nif (!response.ok) process.exit(1);\n}\n`, { mode: 0o755 });
    // 浏览器脚本没有 .mjs 后缀，使用异步函数兼容 Node 18 的 CommonJS 入口。
    const file = path.join(mockBin, name);
    const script = await readFile(file, 'utf8');
    await writeFile(file, script.replace("if (process.env", "(async () => {\nif (process.env") + '\n})().catch(() => process.exit(1));\n');
  }
  const releases = {};
  for (const name of ['oil-ui', 'oil-ui-pro', 'oil-doc', 'oil-doc-pro']) {
    for (const version of ['0.10.0', '0.11.0']) releases[`${name}:${version}`] = await release(temporary, name, version);
  }
  const state = { catalog: structuredClone(CATALOG), latest: '0.10.0', badChecksum: false, missingChecksum: false, proBadChecksum: false, paidMissingChecksum: false,
    deviceStatuses: ['authorization_pending', 'success'], devicePolls: 0, deviceRequests: 0, interval: 5, expiresIn: 600, deviceApproved: false, requireApproval: false,
    checkoutPolls: 0, checkoutRequests: 0, checkoutActiveAfter: 2, checkoutAlreadyActive: false, downloadInactiveCount: 0,
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
      state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, token, body });
      const valid = [TOKEN, INACTIVE].includes(token) && !state.revoked.has(token);
      const authenticate = () => { if (!valid) { error(res, 401, 'unauthorized', `令牌无效：${token || ''}`); return false; } return true; };
      if (req.method === 'GET' && url.pathname === '/api/store/catalog') return json(res, 200, { products: state.catalog });
      if (req.method === 'GET' && url.pathname === '/api/store/versions') {
        const history = [state.latest, ...(state.latest === '0.11.0' ? ['0.10.0'] : []), '0.9.0', '0.8.0'].map((version) => ({ version, published_at: '2026-10-02T08:00:00Z', notes: `${version}：改善布局和交互。` }));
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
        return json(res, 200, { device_code: state.deviceCode, user_code: state.userCode, verification_uri: `${base}/device/`, verification_uri_complete: `${base}/device/?code=${state.userCode}`, expires_in: state.expiresIn, interval: state.interval });
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
        state.checkoutPolls = 0;
        return json(res, 200, { url: state.checkoutUrl ?? `${base}/checkout?session=${state.checkoutRequests}` });
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
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, APPDATA: config, OIL_API: base, OIL_TOKEN: '', CI: '', OIL_TEST_BROWSER: '', PATH: `${mockBin}${path.delimiter}${process.env.PATH || ''}` };
  const configFile = path.join(config, 'oil', 'config.json');
  let runNumber = 0;
  const run = (args, extraEnv = {}, runtime = {}) => new Promise((resolve, reject) => {
    const traceFile = path.join(temporary, `trace-${runNumber++}.json`);
    const child = spawn(process.execPath, [runtime.real ? CLI : DRIVER, ...args], { cwd, env: { ...env, ...extraEnv, OIL_TEST_RUNTIME: JSON.stringify(runtime), OIL_TEST_TRACE: traceFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (runtime.killOnDevice && (stdout.includes('授权码：') || stdout.includes('"event":"device"'))) child.kill('SIGKILL');
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
