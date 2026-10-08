import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { fixture, writeSkill, snapshot, TOKEN, INACTIVE, EMAIL, configMode } from './fixture.js';

const events = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
};
const absent = async (file) => assert.rejects(access(file), { code: 'ENOENT' });
const installArgs = ['install', 'oil-ui-pro', '--json'];
const totalWait = (result) => result.trace.delays.reduce((sum, ms) => sum + ms, 0);

test('同一条安装命令完成登录 → 未买目标 Skill → 打开付款页 → 轮询解锁 → 安装', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  f.state.requireApproval = true;
  f.state.deviceToken = INACTIVE;
  f.state.grants.set(INACTIVE, ['oil-doc-pro']);
  const result = await f.run(installArgs, { OIL_TEST_BROWSER: 'approve' });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.deepEqual(output.map((e) => e.event), ['device', 'login', 'checkout', 'subscribed', undefined]);
  assert.equal(output[2].opened, true);
  assert.equal(output[2].max_wait_seconds, 60);
  assert.equal(output[3].subscription.plan, 'lifetime');
  assert.equal(output[3].subscription.status, 'lifetime');
  assert.deepEqual(result.trace.browserUrls, [output[0].verification_uri_complete, output[2].url]);
  assert.deepEqual(result.trace.delays, [5000, 3000, 3000]);
  assert.equal(result.trace.questions.length, 0);
  assert.equal(f.state.checkoutPolls, 2);
  const checkout = f.state.requests.find((r) => r.path === '/api/store/checkout');
  assert.deepEqual(checkout.body, { skill: 'oil-ui-pro' });
  assert.equal(checkout.token, INACTIVE);
  assert(f.state.requests.every((r) => !r.query.has('token')));
  assert(!result.stdout.includes(INACTIVE));
  assert(!result.stdout.includes('device_secret_0123456789'));
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { token: INACTIVE, email: EMAIL, api: f.base });
  assert.match(await readFile(path.join(root, 'oil-ui-pro', 'SKILL.md'), 'utf8'), /version: "0\.10\.0"/);
  assert.deepEqual(output.at(-1).removed, [free]);
  await absent(free);
});

test('非交互付款最多等 60 秒，退出 3，JSON 给出付款链接与原命令，旧安装保持完整', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  const root = path.join(f.home, '.codex', 'skills');
  await writeSkill(root, 'oil-ui', '0.8.0');
  await writeSkill(root, 'oil-ui-pro', '0.8.0');
  const before = await snapshot(root);
  const args = ['install', 'oil-ui-pro', '--to', 'codex', '--yes', '--json'];
  const result = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 3);
  const [checkout, pending] = events(result);
  assert.equal(checkout.event, 'checkout');
  assert.equal(checkout.opened, false);
  assert(checkout.warnings.some((warning) => warning.includes('没能自动打开浏览器')));
  assert.equal(pending.error, 'payment_pending');
  assert.equal(pending.skill, 'oil-ui-pro');
  assert.equal(pending.url, checkout.url);
  assert.equal(pending.purchase_url, checkout.url);
  assert.equal(pending.message, `请用户在浏览器打开 ${checkout.url} 完成付款，付完后再运行一次刚才的命令。重新运行会沿用这个付款页面，不会重复收费。`);
  assert.equal(pending.next_command, 'npx github:oil-oil/oil-cli install oil-ui-pro --to codex --yes --json');
  assert.equal(totalWait(result), 60000);
  assert.deepEqual(result.trace.delays, Array(20).fill(3000));
  assert.equal(f.state.checkoutPolls, 19);
  assert(!f.state.requests.some((r) => r.path.startsWith('/api/store/download/')));
  assert.deepEqual(await snapshot(root), before);
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(saved.pending_checkout.id, checkout.id);
  assert.equal(saved.pending_checkout.url, checkout.url);
  assert.equal(saved.token, undefined);
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
});

test('非交互付款超时的普通输出包含付款链接和指定重跑提示', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  await mkdir(path.join(f.home, '.codex'));
  const result = await f.run(['install', 'oil-ui-pro'], { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 3);
  const url = `${f.base}/checkout?session=1`;
  assert(result.stdout.includes(`付款页面：${url}`));
  assert.match(result.stdout, /最长等待 60 秒/);
  assert.equal(result.stderr.trim(), `请用户在浏览器打开 ${url} 完成付款，付完后再运行一次刚才的命令。重新运行会沿用这个付款页面，不会重复收费。`);
  assert.equal(totalWait(result), 60000);
});

test('商店给出购买前提醒时，付款页前输出转告用户的一行并附开源版安装命令，JSON 和超时错误也带上', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  f.state.checkoutNotice = 'Oil UI Pro 提供的是设计方法。';
  await mkdir(path.join(f.home, '.codex'));
  let result = await f.run(['install', 'oil-ui-pro'], { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 3);
  const line = '付款前请转告用户：Oil UI Pro 提供的是设计方法。开源版的安装命令：npx github:oil-oil/oil-cli install oil-ui';
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[lines.indexOf(line) + 1], `付款页面：${f.base}/checkout?session=1`);
  result = await f.run(installArgs, { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 3);
  const [checkout, error] = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(checkout.event, 'checkout'); assert.equal(checkout.notice, line);
  assert.equal(error.error, 'payment_pending'); assert.equal(error.notice, line);
});

test('超时后付款，第二次运行同一命令直接安装，不创建付款会话或打开浏览器', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  f.state.deviceToken = INACTIVE;
  await mkdir(path.join(f.home, '.codex'));
  const first = await f.run(installArgs);
  assert.equal(first.code, 3);
  assert.equal(events(first).at(-1).error, 'payment_pending');
  f.state.grants.set(INACTIVE, ['oil-ui-pro']);
  const offset = f.state.requests.length;
  const second = await f.run(installArgs);
  assert.equal(second.code, 0, second.stdout);
  assert.equal(events(second).length, 1);
  assert.equal(events(second)[0].installations[0].name, 'oil-ui-pro');
  assert.equal(f.state.deviceRequests, 1);
  assert.equal(f.state.checkoutRequests, 1);
  assert.deepEqual(second.trace.browserUrls, []);
  assert.deepEqual(second.trace.delays, []);
  assert(f.state.requests.slice(offset).some((r) => r.path === '/api/auth/me'));
  assert(!f.state.requests.slice(offset).some((r) => r.path === '/api/store/checkout'));
});

test('超时后仍未付款，保存并复用付款会话，重跑不创建新链接', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  await mkdir(path.join(f.home, '.codex'));
  const first = await f.run(installArgs, { OIL_TOKEN: INACTIVE });
  const second = await f.run(installArgs, { OIL_TOKEN: INACTIVE });
  assert.equal(first.code, 3);
  assert.equal(second.code, 3);
  assert.equal(events(first).at(-1).url, events(second).at(-1).url);
  assert.equal(events(second)[0].reused, true);
  assert.equal(events(second)[0].resumed, true);
  assert.equal(f.state.checkoutRequests, 2);
  assert.equal(f.state.checkoutCreated, 1);
  assert.equal(totalWait(second), 60000);
  assert.deepEqual(second.trace.browserUrls, [events(second)[0].url]);
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(saved.pending_checkout.id, events(first)[0].id);
  assert.equal(saved.pending_checkout.url, events(first)[0].url);
  assert.equal(saved.token, undefined);
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  await absent(path.join(f.home, '.codex', 'skills', 'oil-ui-pro'));
});

test('checkout 409 already_active 当作已解锁，me 仍未列出授权也直接继续安装', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.codex'));
  f.state.checkoutAlreadyActive = true;
  f.state.meSubscriptions = [];
  const result = await f.run(installArgs, { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.equal(output[0].already_active, true);
  assert.equal(output.at(-1).installations[0].name, 'oil-ui-pro');
  assert.equal(f.state.requests.filter((r) => r.path === '/api/auth/me').length, 1);
  assert.equal(f.state.checkoutRequests, 1);
  assert.deepEqual(result.trace.browserUrls, []);
  assert.deepEqual(result.trace.delays, []);
});

test('me 已解锁但下载返回 402 时购买，轮询解锁后重试下载并安装', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  f.state.downloadInactiveCount = 1;
  const result = await f.run(installArgs, { OIL_TOKEN: TOKEN, OIL_TEST_BROWSER: 'approve' });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.equal(output[0].event, 'checkout');
  assert.equal(output[0].opened, true);
  const paths = f.state.requests.map((r) => r.path);
  const downloads = paths.flatMap((route, index) => route === '/api/store/download/oil-ui-pro' ? [index] : []);
  assert.equal(downloads.length, 2);
  assert(downloads[0] < paths.indexOf('/api/store/checkout'));
  assert(downloads[1] > paths.lastIndexOf('/api/auth/me'));
  assert.equal(f.state.checkoutRequests, 1);
  assert.deepEqual(result.trace.delays, [3000, 3000]);
  assert.match(await readFile(path.join(root, 'oil-ui-pro', 'SKILL.md'), 'utf8'), /name: oil-ui-pro/);
  await absent(free);
});

test('CI 真值下 install 和 subscribe 未买直接退出 3，给出网页地址，不创建会话、不打开浏览器', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.codex'));
  for (const CI of ['true', '1', 'TRUE']) {
    for (const args of [installArgs, ['subscribe', 'oil-doc-pro', '--plan', 'yearly', '--json']]) {
      const result = await f.run(args, { CI, OIL_TOKEN: INACTIVE });
      assert.equal(result.code, 3);
      const output = events(result);
      assert.equal(output.length, 1);
      const pending = output[0];
      const query = args[0] === 'install' ? 'skill=oil-ui-pro' : 'skill=oil-doc-pro&plan=yearly';
      assert.equal(pending.purchase_url, `${f.base}/api/store/checkout?${query}`);
      assert.equal(pending.error, 'payment_pending');
      assert.equal(pending.ci, true);
      assert.equal(pending.opened, false);
      assert.equal(pending.next_command, `npx github:oil-oil/oil-cli ${args.join(' ')}`);
      assert.deepEqual(result.trace.browserUrls, []);
      assert.deepEqual(result.trace.delays, []);
    }
  }
  assert.equal(f.state.checkoutRequests, 0);
  assert(!f.state.requests.some((r) => r.path.startsWith('/api/store/download/')));
  await absent(path.join(f.home, '.codex', 'skills', 'oil-ui-pro'));
});

test('CI 中 me 已解锁但下载 402 时仍不给浏览器或付款会话，直接退出 3', async (t) => {
  const f = await fixture(t);
  const directory = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  const before = await snapshot(directory);
  f.state.downloadInactiveCount = 1;
  const result = await f.run(installArgs, { CI: 'true', OIL_TOKEN: TOKEN });
  assert.equal(result.code, 3);
  assert.equal(events(result).at(-1).purchase_url, `${f.base}/api/store/checkout?skill=oil-ui-pro`);
  assert.equal(f.state.checkoutRequests, 0);
  assert.deepEqual(result.trace.browserUrls, []);
  assert.deepEqual(result.trace.delays, []);
  assert.deepEqual(await snapshot(directory), before);
});

test('subscribe 省略 plan 使用在售方案，非交互也在 60 秒超时退出 3', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  const args = ['subscribe', 'oil-ui-pro', '--json'];
  const result = await f.run(args, { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 3);
  assert.equal(totalWait(result), 60000);
  const checkout = f.state.requests.find((r) => r.path === '/api/store/checkout');
  assert.deepEqual(checkout.body, { skill: 'oil-ui-pro' });
  assert.equal(events(result).at(-1).next_command, 'npx github:oil-oil/oil-cli subscribe oil-ui-pro --json');
});

test('打开付款浏览器也计入非交互 60 秒预算，轮询 5xx 可恢复', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.codex'));
  f.state.checkoutActiveAfter = Infinity;
  const timedOut = await f.run(installArgs, { OIL_TOKEN: INACTIVE }, { browserDelay: 10000 });
  assert.equal(timedOut.code, 3);
  assert.deepEqual(timedOut.trace.browserTimeouts, [5000]);
  assert.equal(totalWait(timedOut) + timedOut.trace.browserTimeouts[0], 60000);
  f.state.checkoutPolls = 0;
  f.state.checkoutActiveAfter = 4;
  f.state.checkoutPollErrors = [false, true, false, false];
  const result = await f.run(installArgs, { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.trace.delays, [3000, 3000, 3000]);
  assert.equal(f.state.checkoutPolls, 4);
});

test('付款响应币种优先于目录和CLI语言，美元显示$9.99，恢复后仍用实际金额', async (t) => {
  const f = await fixture(t); f.state.checkoutActiveAfter = Infinity;
  await mkdir(path.join(f.home, '.codex'));
  f.state.checkoutPrice = { amount: 999, currency: 'usd' };
  const first = await f.run(installArgs, { OIL_TOKEN: INACTIVE });
  const [checkout] = events(first);
  assert.equal(checkout.amount, 999); assert.equal(checkout.currency, 'usd'); assert.equal(checkout.price_label, '$9.99');
  assert.match(checkout.message, /\$9\.99/); assert.doesNotMatch(checkout.message, /69 元/);
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(saved.pending_checkout.amount, 999); assert.equal(saved.pending_checkout.currency, 'usd');
  const second = await f.run(installArgs, { OIL_TOKEN: INACTIVE });
  assert.equal(events(second)[0].price_label, '$9.99'); assert.equal(events(second)[0].id, checkout.id);
});

test('恢复未付会话时按本次语言向商店核对，币种变化使用新链接', async (t) => {
  const f = await fixture(t); f.state.checkoutActiveAfter = Infinity;
  await mkdir(path.join(f.home, '.codex'));
  f.state.checkoutPrices = { zh: { amount: 6900, currency: 'cny' }, en: { amount: 999, currency: 'usd' } };
  const first = await f.run([...installArgs, '--lang', 'zh'], { OIL_TOKEN: INACTIVE });
  const second = await f.run([...installArgs, '--lang', 'en'], { OIL_TOKEN: INACTIVE });
  const a = events(first)[0], b = events(second)[0];
  assert.notEqual(a.id, b.id); assert.notEqual(a.url, b.url); assert.equal(b.currency, 'usd'); assert.equal(b.amount, 999);
  assert.equal(b.price_label, '$9.99'); assert.match(b.message, /\$9\.99, one-time purchase/);
  assert.equal(b.resumed, false); assert.equal(b.reused, false); assert.equal(f.state.checkoutCreated, 2);
});

test('list使用目录价格，英文美元显示$9.99', async (t) => {
  const f = await fixture(t); f.state.catalog[0].prices.lifetime = { amount: 999, currency: 'usd', interval: null };
  const result = await f.run(['list', '--lang', 'en']); assert.equal(result.code, 0);
  const productLine = result.stdout.split('\n').find(line => /^(Oil UI Pro|oil-ui-pro):/.test(line));
  assert.ok(productLine); assert.match(productLine, /\$9\.99/); assert.doesNotMatch(productLine, /69|CNY/);
  const listing = events(await f.run(['list', '--lang', 'en', '--json']))[0];
  assert.equal(listing.skills.find((s) => s.skill === 'oil-ui-pro').prices.lifetime.currency, 'usd');
  assert.equal(listing.skills.find((s) => s.skill === 'oil-ui-pro').prices.lifetime.amount, 999);
});

test('恢复时status暂时失败仍由商店核对币种，不打开旧人民币页面', async (t) => {
  const f = await fixture(t); await mkdir(path.join(f.home, '.codex')); f.state.checkoutActiveAfter = Infinity;
  f.state.checkoutPrices = { zh: { amount: 6900, currency: 'cny' }, en: { amount: 999, currency: 'usd' } };
  const first = await f.run([...installArgs, '--lang', 'zh'], { OIL_TOKEN: INACTIVE });
  f.state.checkoutStatusErrors = [];
  f.state.checkoutStatusErrors[f.state.checkoutStatusPolls] = true;
  const second = await f.run([...installArgs, '--lang', 'en'], { OIL_TOKEN: INACTIVE });
  assert.equal(second.code, 3); assert.equal(events(second)[0].currency, 'usd');
  assert.notEqual(events(second)[0].id, events(first)[0].id); assert.equal(f.state.checkoutRequests, 2);
  assert.deepEqual(second.trace.browserUrls, [events(second)[0].url]);
});

test('CI恢复时保留本地记录，给本次显式语言的网页入口', async (t) => {
  const f = await fixture(t); await mkdir(path.join(f.home, '.codex')); f.state.checkoutActiveAfter = Infinity;
  const first = await f.run([...installArgs, '--lang', 'zh'], { OIL_TOKEN: INACTIVE });
  const second = await f.run([...installArgs, '--lang', 'en'], { OIL_TOKEN: INACTIVE, CI: 'true' });
  const result = events(second)[0];
  assert.equal(result.purchase_url, `${f.base}/api/store/checkout?skill=oil-ui-pro&lang=en`);
  assert.equal(result.id, undefined); assert.equal(f.state.checkoutRequests, 1);
  assert.deepEqual(second.trace.browserUrls, []);
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).pending_checkout.id, events(first)[0].id);
});
