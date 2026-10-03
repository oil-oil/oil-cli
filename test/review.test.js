import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { resolveLanguage, dictionary } from '../src/i18n.js';
import { fixture, writeSkill, TOKEN, INACTIVE, INVALID, configMode } from './fixture.js';

const events = (result) => {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
};
const data = (result) => events(result).at(-1);
const pending = async (f) => JSON.parse(await readFile(f.configFile, 'utf8')).pending_checkout;
const args = ['install', 'oil-ui-pro', '--to', 'codex', '--json'];

test('语言优先级、C/POSIX 默认和显式语言来源', () => {
  for (const [argv, env, expected] of [
    [[], {}, ['zh', false]], [[], { LANG: 'C' }, ['zh', false]], [[], { LC_ALL: 'POSIX', LANG: 'en_US' }, ['zh', false]],
    [[], { LANG: 'C.UTF-8' }, ['zh', false]], [[], { LANG: 'zh_TW.UTF-8' }, ['zh', false]],
    [[], { LANG: 'fr_FR.UTF-8' }, ['en', false]], [[], { LC_MESSAGES: 'en_US', LANG: 'zh_CN' }, ['en', false]],
    [[], { LC_ALL: 'zh_CN', LC_MESSAGES: 'en_US' }, ['zh', false]],
    [['--lang', 'en'], { LC_ALL: 'zh_CN' }, ['en', true]],
    [['--lang=zh'], { LANG: 'en_US' }, ['zh', true]],
    [['--lang', 'en'], { OIL_LANG: 'zh_CN', LC_ALL: 'en_US' }, ['en', true]],
    [['--lang', 'zh'], { OIL_LANG: 'en', LC_ALL: 'zh_CN' }, ['zh', true]],
    [[], { OIL_LANG: 'POSIX', LANG: 'en_US' }, ['zh', true]],
    [[], { OIL_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'en_US' }, ['en', false]],
  ]) {
    assert.deepEqual(resolveLanguage(argv, env), { lang: expected[0], explicit: expected[1] });
  }
  for (const [key, pair] of Object.entries(dictionary)) {
    assert.equal(pair.length, 2, key);
    assert(pair.every((value) => typeof value === 'string' && value), key);
    assert(!/\p{Script=Han}/u.test(pair[1]), key);
  }
});

test('英文帮助、参数错误、令牌错误、下载错误和警告都可读；命令使用完整 npx 形式', async (t) => {
  const f = await fixture(t);
  const english = { OIL_LANG: 'en' };
  const help = await f.run(['help', '--json'], english);
  assert.equal(help.code, 0);
  assert(data(help).usage.some((line) => line.includes('npx github:oil-oil/oil-cli login')));
  assert(data(help).usage.some((line) => line.includes('--lang zh|en')));
  assert(!/\p{Script=Han}/u.test(help.stdout));
  for (const argv of [['bogus', '--json'], ['install', '--json'], ['help', '--bogus', '--json'], ['help', '--lang', '--json'], ['help', '--lang=en', '--lang=zh', '--json']]) {
    const result = await f.run(argv, english);
    assert.equal(result.code, 2);
    assert(!/\p{Script=Han}/u.test(data(result).message), result.stdout);
  }
  const invalid = await f.run(['login', '--token', INVALID, '--json'], english);
  assert.equal(invalid.code, 3);
  assert.equal(data(invalid).error, 'unauthorized');
  assert.equal(data(invalid).http_status, 401);
  assert.match(data(invalid).message, /npx github:oil-oil\/oil-cli login/);
  assert(!invalid.stdout.includes(INVALID));
  await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  const unpaid = await f.run(['update', '--json'], { ...english, OIL_TOKEN: INACTIVE });
  assert.equal(data(unpaid).error, 'inactive');
  assert.equal(data(unpaid).http_status, 402);
  assert.equal(data(unpaid).subscribe_command, 'npx github:oil-oil/oil-cli subscribe oil-ui-pro');
  assert(!/\p{Script=Han}/u.test(data(unpaid).message));
  f.state.badChecksum = true;
  const checksum = await f.run(['install', 'oil-ui', '--to', 'codex', '--json'], english);
  assert.equal(data(checksum).error, 'checksum_mismatch');
  assert.match(data(checksum).message, /Package verification failed/);
  const unknownPath = await f.run(['update', '--path', f.home, '--json'], english);
  assert.match(data(unknownPath).message, /No recognized skill/);
  const device = await f.run(['login', '--json'], english);
  assert.equal(device.code, 0);
  assert.match(events(device)[0].warnings[0], /Could not open the browser/);
  assert(!/\p{Script=Han}/u.test(device.stdout));
  const logout = await f.run(['logout', '--json'], { ...english, OIL_TOKEN: TOKEN });
  assert.match(data(logout).warnings[0], /OIL_TOKEN/);
  assert(!/\p{Script=Han}/u.test(logout.stdout));
});

test('显式英文贯穿设备授权、付款、安装、状态、列表和请求头', async (t) => {
  const f = await fixture(t);
  f.state.deviceToken = INACTIVE;
  const result = await f.run([...args, '--lang', 'en'], { OIL_TEST_BROWSER: 'approve' });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.equal(output[0].verification_uri, `${f.base}/en/device/`);
  assert.equal(output[1].token, undefined);
  assert.equal(output[1].token_prefix, `${INACTIVE.slice(0, 8)}…`);
  const checkout = output.find((event) => event.event === 'checkout');
  assert.equal(checkout.amount, 6900);
  assert.equal(checkout.currency, 'cny');
  assert.equal(checkout.plan, 'lifetime');
  assert.equal(checkout.purchase_type, 'one_time');
  assert.equal(checkout.purchase_description, 'one-time purchase, lifetime updates');
  assert.equal(checkout.message, 'Oil UI Pro: ¥69 (CNY), one-time purchase, lifetime updates');
  assert.equal(f.state.requests.find((r) => r.path === '/api/cli/device').body.lang, 'en');
  assert.equal(f.state.requests.find((r) => r.path === '/api/store/checkout').body.lang, 'en');
  assert(!/\p{Script=Han}/u.test(result.stdout));
  const status = await f.run(['status', '--lang=en']);
  assert.match(status.stdout, /Oil UI Pro: 0\.10\.0 \(latest\)/);
  assert.match(status.stdout, /Purchased · Lifetime updates/);
  assert(!status.stdout.includes('→'));
  const account = data(await f.run(['status', '--json', '--lang=en'])).account;
  assert.equal(account.token, undefined);
  assert.equal(account.token_prefix, `${INACTIVE.slice(0, 8)}…`);
  const list = await f.run(['list', '--lang=en']);
  assert.match(list.stdout, /Oil UI \(open source\)/);
  assert.match(list.stdout, /¥69 \(CNY\)/);
  assert(!/\p{Script=Han}/u.test(list.stdout));
  assert(f.state.requests.filter((r) => r.path !== '/api/cli/device/approve').every((r) => r.headers['accept-language'] === 'en'));
  assert(f.state.requests.some((r) => r.path === '/api/store/checkout/status' && r.query.get('id') === checkout.id && r.token === INACTIVE));
});

test('系统英文只传 Accept-Language；--lang 优先于 OIL_LANG 并传规范语言', async (t) => {
  for (const [env, flags, expected, explicit] of [
    [{ LC_ALL: 'en_US.UTF-8' }, [], 'en', false],
    [{ OIL_LANG: 'zh_CN', LC_ALL: 'en_US' }, ['--lang', 'en'], 'en', true],
    [{ OIL_LANG: 'en_US', LC_ALL: 'zh_CN' }, ['--lang', 'zh'], 'zh', true],
  ]) {
    await t.test(`${expected} / explicit=${explicit}`, async (t) => {
      const f = await fixture(t);
      f.state.deviceToken = INACTIVE;
      const result = await f.run([...args, ...flags], env);
      assert.equal(result.code, 0, result.stdout);
      for (const route of ['/api/cli/device', '/api/store/checkout']) {
        const request = f.state.requests.find((r) => r.path === route);
        assert.equal(request.body.lang, explicit ? expected : undefined);
      }
      assert(f.state.requests.every((r) => r.headers['accept-language'] === expected));
      assert.equal(events(result)[0].verification_uri, `${f.base}${explicit ? `/${expected}` : ''}/device/`);
    });
  }
});

test('付款确认接口可在 me 落后时履约；每轮同时轮询两个接口', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  f.state.checkoutStatusActiveAfter = 2;
  f.state.meSubscriptions = [];
  const result = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.trace.delays, [3000, 3000]);
  assert.equal(f.state.checkoutStatusPolls, 2);
  assert.equal(f.state.checkoutPolls, 2);
  assert.equal(data(result).installations[0].name, 'oil-ui-pro');
  await assert.rejects(access(f.configFile), { code: 'ENOENT' });
});

test('付款超时后已付款、me 仍落后：先查原会话，直接安装，不再打开付款页', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  f.state.meSubscriptions = [];
  const first = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(first.code, 3);
  const saved = await pending(f);
  const session = f.state.sessions.get(saved.id);
  session.paid = true;
  session.status = 'complete';
  const offset = f.state.requests.length;
  const second = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(second.code, 0, second.stdout);
  assert.equal(f.state.checkoutRequests, 1);
  assert.deepEqual(second.trace.browserUrls, []);
  assert.deepEqual(second.trace.delays, []);
  const requests = f.state.requests.slice(offset).filter((r) => ['/api/store/checkout/status', '/api/auth/me', '/api/store/checkout'].includes(r.path));
  assert.equal(requests[0].path, '/api/store/checkout/status');
  assert.equal(requests[0].query.get('id'), saved.id);
  await assert.rejects(access(f.configFile), { code: 'ENOENT' });
});

test('已完成但仍确认中的会话不会再建付款；到期未付款的会话才换新', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  assert.equal((await f.run(args, { OIL_TOKEN: INACTIVE })).code, 3);
  const saved = await pending(f);
  const session = f.state.sessions.get(saved.id);
  session.status = 'complete';
  const processing = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(processing.code, 3);
  assert.deepEqual(processing.trace.browserUrls, []);
  assert.equal(f.state.checkoutRequests, 1);
  assert.match(data(processing).message, /付款结果还在确认中/);
  session.status = 'expired';
  const expired = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(expired.code, 3);
  assert.equal(f.state.checkoutRequests, 2);
  assert.notEqual(data(expired).id, saved.id);
});

test('原会话查询遇到 5xx 仍复用；等待时接口暂时失败可恢复', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  assert.equal((await f.run(args, { OIL_TOKEN: INACTIVE })).code, 3);
  const saved = await pending(f);
  f.state.checkoutStatusPolls = 0;
  f.state.checkoutStatusErrors = [true, true, false];
  f.state.checkoutStatusActiveAfter = 3;
  const result = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(events(result)[0].id, saved.id);
  assert.equal(f.state.checkoutRequests, 2);
  assert.deepEqual(result.trace.delays, [3000, 3000]);
});

test('待付款记录绑定服务器和令牌，其他账号不会查询或打开原会话', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  assert.equal((await f.run(args, { OIL_TOKEN: INACTIVE })).code, 3);
  const text = await readFile(f.configFile, 'utf8');
  assert(!text.includes(INACTIVE));
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  const other = await fixture(t);
  other.state.checkoutActiveAfter = Infinity;
  const originalRequests = f.state.requests.length;
  const result = await other.run(args, { OIL_TOKEN: INACTIVE, XDG_CONFIG_HOME: f.config, APPDATA: f.config });
  assert.equal(result.code, 3);
  const createdAt = other.state.requests.findIndex((r) => r.path === '/api/store/checkout');
  assert(createdAt >= 0);
  assert(!other.state.requests.slice(0, createdAt).some((r) => r.path === '/api/store/checkout/status'));
  assert.equal(f.state.requests.length, originalRequests);
  assert.equal(other.state.checkoutRequests, 1);
  assert.equal(events(result)[0].url.startsWith(other.base), true);
  const offset = other.state.requests.length;
  const active = await other.run(args, { OIL_TOKEN: TOKEN, XDG_CONFIG_HOME: f.config, APPDATA: f.config });
  assert.equal(active.code, 0, active.stdout);
  assert(!other.state.requests.slice(offset).some((r) => r.path === '/api/store/checkout/status'));
  const denied = await fetch(`${f.base}/api/store/checkout/status?id=cs_test_1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(denied.status, 403);
});

test('本地付款记录丢失时仍接受服务器复用；价格取目录金额和币种', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  f.state.catalog[0].prices.lifetime = { amount: 1250, currency: 'usd' };
  const first = await f.run(args, { OIL_TOKEN: INACTIVE, OIL_LANG: 'en' });
  assert.equal(first.code, 3);
  await rm(f.configFile);
  const second = await f.run(args, { OIL_TOKEN: INACTIVE, OIL_LANG: 'en' });
  assert.equal(second.code, 3);
  assert.equal(events(second)[0].reused, true);
  assert.equal(events(second)[0].resumed, false);
  assert.equal(events(second)[0].amount, 1250);
  assert.equal(events(second)[0].currency, 'usd');
  assert.match(events(second)[0].message, /\$12\.50/);
  assert.equal(data(second).id, data(first).id);
  assert.equal(f.state.checkoutRequests, 2);
  assert.equal(f.state.checkoutCreated, 1);
  assert.match(data(second).message, /will not charge twice/);
});

test('CODEX_HOME 用于默认检测、codex 别名、status 和 update，并保留项目扫描', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.home, 'custom codex');
  await mkdir(custom);
  const ignored = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui', '0.8.0');
  const env = { CODEX_HOME: custom };
  const installed = await f.run(['install', 'oil-ui', '--json'], env);
  assert.equal(installed.code, 0, installed.stdout);
  assert.equal(data(installed).installations[0].path, path.join(custom, 'skills', 'oil-ui'));
  const aliased = await f.run(['install', 'oil-doc', '--to', 'codex', '--json'], env);
  assert.equal(aliased.code, 0, aliased.stdout);
  assert.equal(data(aliased).installations[0].path, path.join(custom, 'skills', 'oil-doc'));
  await writeSkill(path.join(f.cwd, '.codex', 'skills'), 'oil-ui', '0.10.0');
  const status = data(await f.run(['status', '--json'], env));
  assert.equal(status.installations.length, 3);
  assert(!status.installations.some((i) => i.path === ignored));
  f.state.latest = '0.11.0';
  const updated = data(await f.run(['update', '--json'], env));
  assert.equal(updated.status, 'updated');
  assert.equal(updated.updated_count, 3);
  assert.match(await readFile(path.join(custom, 'skills', 'oil-ui', 'SKILL.md'), 'utf8'), /0\.11\.0/);
  assert.match(await readFile(path.join(ignored, 'SKILL.md'), 'utf8'), /0\.8\.0/);
});

test('找不到目标的 JSON 给出 CODEX_HOME 推荐路径和可直接重跑的命令', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.home, 'new codex');
  const env = { CODEX_HOME: custom };
  const result = await f.run(['install', 'oil-ui', '--lang', 'en', '--json'], env);
  assert.equal(result.code, 2);
  const value = data(result);
  assert.equal(value.recommended_path, path.join(custom, 'skills'));
  assert.equal(value.next_command, 'npx github:oil-oil/oil-cli install oil-ui --lang en --json --to codex');
  assert.equal(value.recommended_command, value.next_command);
  const retry = await f.run(['install', 'oil-ui', '--lang', 'en', '--json', '--to', 'codex'], env);
  assert.equal(retry.code, 0, retry.stdout);
  assert.equal(data(retry).installations[0].path, path.join(custom, 'skills', 'oil-ui'));
});

test('update JSON 区分未安装、全部跳过、最新和更新；旧字段保留', async (t) => {
  const f = await fixture(t);
  let result = data(await f.run(['update', '--json']));
  assert.equal(result.status, 'no_installations');
  assert.equal(result.found_count, 0);
  const directory = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui', '0.10.0');
  result = data(await f.run(['update', '--json']));
  assert.equal(result.status, 'up_to_date');
  assert.equal(result.found_count, 1);
  assert.equal(result.eligible_count, 1);
  assert.equal(result.updated_count, 0);
  await mkdir(path.join(directory, '.git'));
  result = data(await f.run(['update', '--json']));
  assert.equal(result.status, 'skipped');
  assert.equal(result.eligible_count, 0);
  assert.equal(result.skipped.length, 1);
  await rm(path.join(directory, '.git'), { recursive: true });
  f.state.latest = '0.11.0';
  result = data(await f.run(['update', '--json']));
  assert.equal(result.status, 'updated');
  assert.equal(result.updated_count, 1);
  for (const field of ['installations', 'skipped', 'warnings']) assert(Array.isArray(result[field]));
});

test('首次开源版安装显示 Pro 链接；重复安装或任一宿主已装 Pro 时省略', async (t) => {
  const f = await fixture(t);
  const first = data(await f.run(['install', 'oil-ui', '--to', 'codex', '--json']));
  assert.equal(first.pro_hint.name, 'Oil UI Pro');
  assert.equal(first.pro_hint.url, 'https://ui.oiloil.org/pro/');
  const repeated = data(await f.run(['install', 'oil-ui', '--to', 'codex', '--json']));
  assert.equal(repeated.pro_hint, undefined);
  await writeSkill(path.join(f.home, '.claude', 'skills'), 'oil-ui-pro', '0.10.0');
  const pro = data(await f.run(['install', 'oil-ui', '--to', 'agents', '--json']));
  assert.equal(pro.pro_hint, undefined);
});

test('真实入口被中断后付款，下一进程读取已保存的会话并安装', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(args, { OIL_TOKEN: INACTIVE }, { real: true, killOnCheckout: true });
  assert.equal(first.signal, 'SIGKILL');
  assert.notEqual(first.code, 0);
  const saved = await pending(f);
  const session = f.state.sessions.get(saved.id);
  session.status = 'complete';
  session.paid = true;
  const second = await f.run(args, { OIL_TOKEN: INACTIVE }, { real: true });
  assert.equal(second.code, 0, second.stdout);
  assert.equal(data(second).installations[0].name, 'oil-ui-pro');
  assert.equal(f.state.checkoutRequests, 1);
  await assert.rejects(access(f.configFile), { code: 'ENOENT' });
});

test('付款接口缺少 id、reused 或状态字段时拒绝继续，保留原安装', async (t) => {
  const f = await fixture(t);
  const old = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  const original = await readFile(path.join(old, 'SKILL.md'), 'utf8');
  for (const response of [
    { url: `${f.base}/checkout`, reused: false },
    { id: 'cs_invalid', url: `${f.base}/checkout` },
    { id: 'cs_invalid', url: 'file:///tmp/checkout', reused: false },
  ]) {
    f.state.sessions.clear();
    f.state.checkoutResponse = response;
    const result = await f.run(args, { OIL_TOKEN: INACTIVE, OIL_LANG: 'en' });
    assert.equal(result.code, 1);
    assert.equal(data(result).error, 'invalid_response');
    assert.match(data(result).message, /Payment details are incomplete/);
    assert.equal(await readFile(path.join(old, 'SKILL.md'), 'utf8'), original);
    await assert.rejects(access(f.configFile), { code: 'ENOENT' });
  }
  f.state.checkoutResponse = null;
  f.state.sessions.clear();
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(first.code, 3);
  const saved = await pending(f);
  f.state.checkoutStatusResponse = { status: 'complete', paid: true };
  const malformed = await f.run(args, { OIL_TOKEN: INACTIVE, OIL_LANG: 'en' });
  assert.equal(malformed.code, 1);
  assert.equal(data(malformed).error, 'invalid_response');
  assert.equal((await pending(f)).id, saved.id);
  assert.equal(await readFile(path.join(old, 'SKILL.md'), 'utf8'), original);
});

test('同一令牌重新登录保留付款记录；英文授权超时、拒绝和过期保留原错误码', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  assert.equal((await f.run(args, { OIL_TOKEN: INACTIVE })).code, 3);
  const saved = await pending(f);
  const loggedIn = await f.run(['login', '--token', INACTIVE, '--json']);
  assert.equal(loggedIn.code, 0);
  assert.equal((await pending(f)).id, saved.id);
  const retried = await f.run(args);
  assert.equal(retried.code, 3);
  assert.equal(f.state.checkoutRequests, 2);
  const g = await fixture(t);
  g.state.deviceStatuses = ['authorization_pending'];
  const timeout = await g.run(['login', '--json'], { OIL_LANG: 'en' });
  assert.equal(timeout.code, 3);
  assert.equal(data(timeout).error, 'authorization_pending');
  assert.match(data(timeout).message, /check the device code.*click Allow/);
  assert(!/\p{Script=Han}/u.test(timeout.stdout));
  for (const code of ['access_denied', 'expired_token']) {
    await rm(g.configFile, { force: true });
    g.state.deviceStatuses = [code];
    const failure = await g.run(['login', '--json'], { OIL_LANG: 'en' });
    assert.equal(failure.code, 1);
    assert.equal(data(failure).error, code);
    assert.match(data(failure).message, /npx github:oil-oil\/oil-cli login/);
    assert(!/\p{Script=Han}/u.test(failure.stdout));
  }
});
