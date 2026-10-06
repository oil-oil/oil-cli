import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, access, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture, writeSkill, snapshot, TOKEN, INVALID, INACTIVE, configMode, linkDirectory, pack, prependArchiveLink } from './fixture.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const absent = async (file) => assert.rejects(access(file), { code: 'ENOENT' });

test('默认 status 找全七处目录，按 SKILL name 识别，按语义版本列出每版说明', async (t) => {
  const f = await fixture(t);
  const roots = [
    ...['claude', 'codex', 'agents', 'cursor'].map((agent) => path.join(f.home, `.${agent}`, 'skills')),
    ...['claude', 'agents', 'codex'].map((agent) => path.join(f.cwd, `.${agent}`, 'skills')),
  ];
  for (const [index, root] of roots.entries()) await writeSkill(root, 'oil-ui', index === 0 ? '0.8.0' : '0.10.0', `${index === 0 ? '.oil-ui-' : ''}custom-${index}`);
  await writeSkill(roots[0], 'other', '0.1.0');
  const result = await f.run(['--json']);
  assert.equal(result.code, 0);
  const value = data(result);
  assert.equal(value.command, 'status');
  assert.equal(value.installations.length, 7);
  const old = value.installations.find((i) => i.current === '0.8.0');
  assert.equal(old.latest, '0.10.0');
  assert.equal(old.update_available, true);
  assert.deepEqual(old.updates.map((i) => i.version), ['0.9.0', '0.10.0']);
  assert.match(old.updates[0].notes, /改善布局和交互/);
  assert(value.installations.filter((i) => i.current === '0.10.0').every((i) => !i.update_available && !i.updates.length));
  const human = await f.run(['status']);
  assert.match(human.stdout, /0\.9\.0 更新说明：[\s\S]*0\.10\.0 更新说明/);
});

test('免费安装到多个目标，能保留不认识的目录', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const other = await writeSkill(root, 'other', '1.0.0');
  const before = await snapshot(other);
  const result = await f.run(['install', 'oil-ui', '--to', 'codex', '--to', 'agents', '--to', 'codex', '--yes', '--json']);
  assert.equal(result.code, 0);
  const value = data(result);
  assert.equal(value.installations.length, 1);
  assert(value.installations.every((i) => i.name === 'oil-ui' && i.version === '0.10.0'));
  assert.deepEqual(value.links.map((i) => [i.path, i.target]), [[path.join(f.home, '.agents', 'skills', 'oil-ui'), path.join(root, 'oil-ui')]]);
  assert.deepEqual(await snapshot(other), before);
  assert.match(await readFile(path.join(root, 'oil-ui', 'SKILL.md'), 'utf8'), /0\.10\.0/);
  assert.equal(f.state.requests.find((req) => req.path.startsWith('/releases')).key, undefined);
});

test('未知目录占用 oil-ui 时拒绝替换，已完成的其他目标也回滚', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.agents', 'skills');
  const unknown = await writeSkill(root, 'other', '1.0.0', 'oil-ui');
  const before = await snapshot(unknown);
  const result = await f.run(['install', 'oil-ui', '--to', 'codex', '--to', 'agents', '--yes', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'occupied');
  assert.deepEqual(await snapshot(unknown), before);
  await absent(path.join(f.home, '.codex', 'skills', 'oil-ui'));
  assert.deepEqual(await readdir(path.join(f.home, '.codex', 'skills')), []);
});

test('付费安装自动移除按 name 找到的免费版，保护其他目录', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0', 'free-custom');
  const other = await writeSkill(root, 'other', '1.0.0');
  const before = await snapshot(other);
  const result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  const value = data(result);
  assert.equal(value.installations[0].name, 'oil-ui-pro');
  assert.deepEqual(value.removed, [free]);
  await absent(free);
  assert.deepEqual(await snapshot(other), before);
  assert.equal(f.state.requests.find((req) => req.path === '/api/store/download/oil-ui-pro').token, TOKEN);
  assert.equal(f.state.requests.find((req) => req.path === '/api/store/download/oil-ui-pro').query.get('version'), '0.10.0');
});

test('Pro 登录失效或 CI 未购买时退出码 3，旧目录完整保留，错误脱敏', async (t) => {
  const f = await fixture(t);
  const directory = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  const before = await snapshot(directory);
  for (const [key, error] of [[INVALID, 'unauthorized'], [INACTIVE, 'payment_pending']]) {
    const result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--yes', '--json'], { OIL_TOKEN: key, CI: 'true' });
    assert.equal(result.code, 3);
    assert.equal(data(result).error, error);
    assert(!result.stdout.includes(key));
    assert.deepEqual(await snapshot(directory), before);
  }
});

test('免费版目录恰好叫 oil-ui-pro 时，按真实 Skill name 安全替换为 Pro', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const original = await writeSkill(root, 'oil-ui', '0.8.0', 'oil-ui-pro');
  const result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--yes', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.deepEqual(data(result).removed, [original]);
  assert.match(await readFile(path.join(original, 'SKILL.md'), 'utf8'), /name: oil-ui-pro/);
});

test('update 更新所有旧安装（含改过的目录名），不降级或删除无关目录', async (t) => {
  const f = await fixture(t);
  const codex = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(codex, 'oil-ui', '0.8.0', 'renamed-free');
  const pro = await writeSkill(path.join(f.cwd, '.agents', 'skills'), 'oil-ui-pro', '0.9.0', 'renamed-pro');
  const newer = await writeSkill(path.join(f.home, '.cursor', 'skills'), 'oil-ui', '0.11.0');
  const other = await writeSkill(codex, 'other', '1.0.0');
  const snapshots = await Promise.all([snapshot(newer), snapshot(other)]);
  const result = await f.run(['update', '--yes', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(data(result).installations.length, 2);
  for (const directory of [free, pro]) assert.match(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), /0\.10\.0/);
  assert.deepEqual(await snapshot(newer), snapshots[0]);
  assert.deepEqual(await snapshot(other), snapshots[1]);
  const noop = await f.run(['update', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(noop.code, 0);
  assert.equal(data(noop).installations.length, 0);
});

test('update 的 Pro 授权失败时免费版也不发生变化', async (t) => {
  const f = await fixture(t);
  const free = await writeSkill(path.join(f.home, '.claude', 'skills'), 'oil-ui', '0.8.0');
  const pro = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  const before = await Promise.all([snapshot(free), snapshot(pro)]);
  for (const key of ['', INACTIVE]) {
    const result = await f.run(['update', '--yes', '--json'], { OIL_TOKEN: key, CI: key ? '' : 'true' });
    assert.equal(result.code, 3);
    assert.deepEqual(await snapshot(free), before[0]);
    assert.deepEqual(await snapshot(pro), before[1]);
  }
});

test('login --token 校验后保存权限 600；无效令牌不覆盖配置，所有输出最多前 8 字符', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['login', '--token', TOKEN, '--json']);
  assert.equal(result.code, 0);
  const value = data(result);
  assert.equal(value.token_prefix, `${TOKEN.slice(0, 8)}…`);
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { token: TOKEN, email: 'test@example.com', api: f.base });
  const invalid = await f.run(['login', '--token', INVALID]);
  assert.equal(invalid.code, 3);
  assert(!invalid.stderr.includes(INVALID));
  assert.match(invalid.stderr, /登录已失效，请重新运行 npx github:oil-oil\/oil-cli login/);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { token: TOKEN, email: 'test@example.com', api: f.base });
  const status = await f.run(['status', '--json']);
  assert.equal(status.code, 0);
  assert.equal(data(status).account.subscriptions[0].status, 'lifetime');
  assert(!status.stdout.includes(TOKEN));
});

test('两个版本同 Agent 时 status 和免费安装提示冲突，update 清理后不再警告', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.10.0');
  const pro = await writeSkill(root, 'oil-ui-pro', '0.10.0');
  const before = await snapshot(pro);
  for (const args of [['status', '--json'], ['install', 'oil-ui', '--to', 'codex', '--yes', '--json']]) {
    const result = await f.run(args);
    assert.equal(result.code, 0);
    assert.match(data(result).warnings[0], /两个版本同时装会抢着接同一类请求/);
  }
  const updated = await f.run(['update', '--json']);
  assert.equal(updated.code, 0);
  assert.deepEqual(data(updated).removed, [free]);
  assert.deepEqual(data(updated).warnings, []);
  await absent(free);
  assert.deepEqual(await snapshot(pro), before);
});

test('下载摘要失败（免费版/Pro）以及摘要缺失时，原目录逐字节不变', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  const pro = await writeSkill(root, 'oil-ui-pro', '0.8.0');
  const before = await snapshot(root);
  f.state.badChecksum = true;
  let result = await f.run(['update', 'oil-ui', '--yes', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'checksum_mismatch');
  assert.deepEqual(await snapshot(root), before);
  f.state.badChecksum = false;
  f.state.proBadChecksum = true;
  result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--yes', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'checksum_mismatch');
  assert.deepEqual(await snapshot(root), before); // 免费版还未移除。
  f.state.missingChecksum = true;
  result = await f.run(['install', 'oil-ui', '--to', 'codex', '--yes', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'missing_checksum');
  assert.deepEqual(await snapshot(root), before);
  assert(free && pro);
});

test('压缩包 SKILL 名不符、额外顶层目录和软链接均拒绝，目标不变', async (t) => {
  const f = await fixture(t);
  const installed = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui', '0.8.0');
  const before = await snapshot(installed);
  const artifact = f.releases['oil-ui:0.10.0'];
  const original = await readFile(path.join(artifact.source, 'oil-ui', 'SKILL.md'), 'utf8');
  const repack = async (entries) => {
    await pack(artifact.file, artifact.source, entries);
    artifact.body = await readFile(artifact.file);
    artifact.sha256 = createHash('sha256').update(artifact.body).digest('hex');
  };
  await writeFile(path.join(artifact.source, 'oil-ui', 'SKILL.md'), original.replace('name: oil-ui', 'name: unrelated'));
  await repack(['oil-ui']);
  let result = await f.run(['install', 'oil-ui', '--to', 'codex', '--yes', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'skill_mismatch');
  assert.deepEqual(await snapshot(installed), before);
  await writeFile(path.join(artifact.source, 'oil-ui', 'SKILL.md'), original);
  await mkdir(path.join(artifact.source, 'unrelated'));
  await repack(['oil-ui', 'unrelated']);
  result = await f.run(['install', 'oil-ui', '--to', 'codex', '--yes', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'invalid_archive');
  assert.deepEqual(await snapshot(installed), before);
  await repack(['oil-ui']);
  await prependArchiveLink(artifact.file, 'oil-ui/escape', '../..');
  artifact.body = await readFile(artifact.file);
  artifact.sha256 = createHash('sha256').update(artifact.body).digest('hex');
  result = await f.run(['install', 'oil-ui', '--to', 'codex', '--yes', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'invalid_archive');
  assert.deepEqual(await snapshot(installed), before);
});

test('环境变量令牌优先于配置；manage 浏览器失败返回链接；logout 撤销并删配置', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN, '--json']);
  const invalidStatus = await f.run(['status', '--json'], { OIL_TOKEN: INVALID });
  assert.equal(invalidStatus.code, 3);
  assert.equal(data(invalidStatus).error, 'unauthorized');
  const portal = await f.run(['manage', '--json']);
  assert.equal(portal.code, 0);
  assert.equal(data(portal).url, `${f.base}/portal`);
  assert.equal(data(portal).opened, false);
  const result = await f.run(['logout', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(data(result).logged_out, true);
  assert(f.state.revoked.has(TOKEN));
  assert.match(data(result).warnings[0], /OIL_TOKEN 仍在环境里/);
  await absent(f.configFile);
});

test('非交互缺参数退出 2、不提问；CI 未登录 Pro 退出 3；help/version 支持 JSON', async (t) => {
  const f = await fixture(t);
  for (const [args, error, hint] of [
    [['install', 'oil-ui', '--yes', '--json'], 'missing_target', '--to'],
    [['login', '--token', '--json'], 'missing_argument', '--token'],
    [['install', 'oil-ui', '--to', '--json'], 'missing_argument', '--to'],
  ]) {
    const result = await f.run(args);
    assert.equal(result.code, 2);
    assert.equal(data(result).error, error);
    assert(data(result).message.includes(hint));
  }
  const pro = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--yes', '--json'], { CI: 'true' });
  assert.equal(pro.code, 3);
  assert.equal(data(pro).error, 'unauthorized');
  for (const args of [['help', '--json'], ['--version', '--json']]) {
    const result = await f.run(args);
    assert.equal(result.code, 0);
    assert.equal(data(result).ok, true);
  }
  for (const args of [['unknown', '--json'], ['status', '--to', 'codex', '--json'], ['update', '--token', TOKEN, '--json']]) {
    const result = await f.run(args);
    assert.equal(result.code, 2);
    assert.equal(data(result).ok, false);
    assert(!result.stdout.includes(TOKEN));
  }
});

test('目录增加另一条产品线后能检测、列价、安装、单独更新，不认识的 Skill 保留', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.cursor', 'skills');
  const doc = await writeSkill(root, 'oil-doc', '0.8.0', 'renamed-doc');
  const ui = await writeSkill(root, 'oil-ui', '0.8.0');
  const other = await writeSkill(root, 'other', '1.0.0');
  const before = await snapshot(other);
  const status = data(await f.run(['status', '--json']));
  assert.deepEqual(status.installations.map((s) => s.name).sort(), ['oil-doc', 'oil-ui']);
  const listing = data(await f.run(['list', '--json', '--yes']));
  assert.equal(listing.skills.length, 4);
  assert.equal(listing.skills.find((s) => s.skill === 'oil-doc-pro').prices.yearly.amount, 9900);
  assert.match((await f.run(['list'])).stdout, /oil-doc-pro：付费（99 元，每年）/);
  const update = await f.run(['update', 'oil-doc', '--yes', '--json']);
  assert.equal(update.code, 0);
  assert.equal(data(update).installations.length, 1);
  assert.match(await readFile(path.join(doc, 'SKILL.md'), 'utf8'), /0\.10\.0/);
  assert.match(await readFile(path.join(ui, 'SKILL.md'), 'utf8'), /0\.8\.0/);
  const install = await f.run(['install', 'oil-doc-pro', '--to', 'cursor', '--yes', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(install.code, 0);
  assert.deepEqual(data(install).removed, [doc]);
  assert.deepEqual(await snapshot(other), before);
  f.state.catalog = f.state.catalog.filter((p) => p.id !== 'oil-ui');
  assert(data(await f.run(['status', '--json'])).installations.every((i) => i.name !== 'oil-ui'));
  const beforeUi = await snapshot(ui);
  assert.equal((await f.run(['update', '--yes', '--json'], { OIL_TOKEN: TOKEN })).code, 0);
  assert.deepEqual(await snapshot(ui), beforeUi);
});

test('设备码 pending、slow_down、成功按 interval 轮询；JSON Lines 不泄漏设备密钥或令牌', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['authorization_pending', 'slow_down', 'authorization_pending', 'slow_down', 'success'];
  const result = await f.run(['login', '--json', '--yes']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.trace.delays, [5000, 5000, 10000, 10000, 15000]);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(events[0].verification_uri, `${f.base}/device/`);
  assert.equal(events[0].user_code, 'KDQW-7RTF');
  assert.equal(events[1].token_prefix, `${TOKEN.slice(0, 8)}…`);
  assert(!result.stdout.includes('device_secret_0123456789'));
  assert(!result.stdout.includes(TOKEN));
  const request = f.state.requests.find((r) => r.path === '/api/cli/device');
  assert.equal(typeof request.body.client_name, 'string');
  assert.equal(request.body.platform, process.platform);
  assert.equal(request.token, undefined);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { token: TOKEN, email: 'test@example.com', api: f.base });
});

test('登录轮询遇到服务端 5xx 继续等待，不中断', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['upstream', 'authorization_pending', 'upstream', 'success'];
  const result = await f.run(['login', '--json', '--yes']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(f.state.devicePolls, 4);
});

test('新设备码拒绝或过期保留旧令牌；交互终端等满 10 分钟，服务端到期时间优先', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN]);
  const before = await readFile(f.configFile, 'utf8');
  for (const error of ['access_denied', 'expired_token']) {
    f.state.deviceStatuses = [error];
    const result = await f.run(['login', '--json']);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).error, error);
    assert.deepEqual(await readFile(f.configFile, 'utf8'), before);
  }
  f.state.deviceStatuses = ['authorization_pending'];
  f.state.expiresIn = 3600;
  f.state.interval = 120;
  let result = await f.run(['login', '--json'], {}, { terminal: true });
  assert.equal(result.code, 3);
  assert.deepEqual(result.trace.delays, [120000, 120000, 120000, 120000, 120000]);
  assert.equal(f.state.devicePolls, 4);
  const pending = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(pending.token, TOKEN);
  assert.equal(pending.pending_device.expires_at, 3600000);
  await f.run(['login', '--token', TOKEN]);
  f.state.expiresIn = 12;
  f.state.interval = 5;
  result = await f.run(['login', '--json'], {}, { terminal: true });
  assert.equal(result.code, 1);
  assert.deepEqual(result.trace.delays, [5000, 5000, 2000]);
  assert.equal(f.state.devicePolls, 2);
  assert.deepEqual(await readFile(f.configFile, 'utf8'), before);
});

test('显式设备码登录可非交互运行，真实 interval 和模拟浏览器确认完成登录', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const started = Date.now();
  const result = await f.run(['login'], { OIL_TEST_BROWSER: 'approve' }, { real: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /KDQW-7RTF/);
  assert.match(result.stdout, /已登录：test@example.com/);
  assert(Date.now() - started >= 5000);
  assert(f.state.deviceApproved);
  assert.equal(f.state.devicePolls, 1);
});

test('付费 install/update、subscribe/manage 缺令牌时，交互终端内联登录后继续', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['success'];
  await writeSkill(path.join(f.home, '.agents', 'skills'), 'oil-doc-pro', '0.8.0');
  for (const args of [
    ['install', 'oil-ui-pro', '--to', 'codex', '--yes', '--json'],
    ['update', 'oil-doc-pro', '--yes', '--json'],
    ['subscribe', 'oil-doc-pro', '--plan', 'yearly', '--yes', '--json'],
    ['manage', '--json'],
  ]) {
    await f.run(['logout']);
    f.state.revoked.delete(TOKEN);
    const result = await f.run(args, {}, { terminal: true });
    assert.equal(result.code, 0, result.stdout);
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events[0].event, 'device');
    assert.equal(events[1].event, 'login');
    assert(result.trace.questions.length === 0);
    assert(events.length >= 3);
  }
});

test('CI 里需要登录的四类命令退出 3 并提示 OIL_TOKEN，不启动浏览器', async (t) => {
  const f = await fixture(t);
  await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  for (const args of [
    ['install', 'oil-ui-pro', '--to', 'codex'], ['update'], ['subscribe', 'oil-ui-pro'], ['manage'],
  ]) {
    const result = await f.run([...args, '--yes', '--json'], { CI: 'true' });
    assert.equal(result.code, 3);
    assert.match(data(result).message, /OIL_TOKEN/);
    assert.equal(result.trace.questions.length, 0);
  }
  assert.equal(f.state.requests.filter((r) => r.path === '/api/cli/device').length, 0);
});

test('update 401 提示重新登录、402 给出产品购买命令和网页链接，付费旧目录不变', async (t) => {
  const f = await fixture(t);
  const directory = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-doc-pro', '0.8.0');
  const before = await snapshot(directory);
  let result = await f.run(['update', '--yes'], { OIL_TOKEN: INVALID });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /登录已失效，请重新运行 npx github:oil-oil\/oil-cli login/);
  result = await f.run(['update', 'oil-doc-pro', '--yes', '--json'], { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 3);
  assert.equal(data(result).subscribe_command, 'npx github:oil-oil/oil-cli subscribe oil-doc-pro');
  assert.equal(data(result).subscription_url, `${f.base}/store/oil-doc-pro/`);
  assert.deepEqual(await snapshot(directory), before);
});

test('subscribe 每 3 秒轮询账号，生效后非交互自动安装；传 plan、没有凭据 URL', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.claude'));
  const result = await f.run(['subscribe', 'oil-ui-pro', '--plan', 'lifetime', '--yes', '--json'], { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.trace.delays, [3000, 3000]);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.slice(0, 2).map((e) => e.event), ['checkout', 'subscribed']);
  assert.equal(events[2].installations[0].path, path.join(f.home, '.claude', 'skills', 'oil-ui-pro'));
  assert.equal(result.trace.questions.length, 0);
  const request = f.state.requests.find((r) => r.path === '/api/store/checkout');
  assert.deepEqual(request.body, { skill: 'oil-ui-pro', plan: 'lifetime' });
  assert.equal(request.token, INACTIVE);
  assert(f.state.requests.filter((r) => r.path === '/api/auth/me').every((r) => r.token === INACTIVE));
  assert(f.state.requests.every((r) => !r.query.has('token')));
});

test('subscribe 交互询问并安装；已解锁 409 可继续，免费和未知 plan 是用法错误', async (t) => {
  const f = await fixture(t);
  let result = await f.run(['subscribe', 'oil-ui-pro'], { OIL_TOKEN: INACTIVE }, { terminal: true, interactive: true, answers: [true, 'codex', true] });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已安装 Oil UI Pro/);
  assert.equal(result.trace.questions.length, 3);
  f.state.checkoutAlreadyActive = true;
  f.state.grants.set(INACTIVE, []);
  f.state.checkoutToken = null;
  result = await f.run(['subscribe', 'oil-ui-pro', '--json'], { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 0);
  assert(!result.stdout.includes('checkout'));
  for (const args of [['subscribe', 'oil-ui'], ['subscribe', 'oil-ui-pro', '--plan', 'yearly']]) {
    assert.equal((await f.run([...args, '--json'], { OIL_TOKEN: TOKEN })).code, 2);
  }
});

test('subscribe 15 分钟超时不安装、不修改已有文件', async (t) => {
  const f = await fixture(t);
  f.state.checkoutActiveAfter = Infinity;
  const directory = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  const before = await snapshot(directory);
  const result = await f.run(['subscribe', 'oil-ui-pro', '--json'], { OIL_TOKEN: INACTIVE }, { terminal: true });
  assert.equal(result.code, 3);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).error, 'payment_pending');
  assert.equal(result.trace.delays.reduce((sum, ms) => sum + ms, 0), 900000);
  assert.equal(f.state.checkoutPolls, 299);
  assert.deepEqual(await snapshot(directory), before);
});

test('logout 撤销有效令牌；服务故障和坏配置仍删除配置并提示', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN]);
  let result = await f.run(['logout', '--json']);
  assert.equal(result.code, 0);
  assert(data(result).revoked);
  assert(f.state.revoked.has(TOKEN));
  await absent(f.configFile);
  assert.equal((await f.run(['status', '--json'], { OIL_TOKEN: TOKEN })).code, 3);
  f.state.revoked.delete(TOKEN);
  await f.run(['login', '--token', TOKEN]);
  f.state.logoutFailure = true;
  result = await f.run(['logout', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).revoked, false);
  assert.match(data(result).warnings[0], /未能撤销服务端令牌/);
  await absent(f.configFile);
  await writeFile(f.configFile, '{broken');
  result = await f.run(['logout', '--json']);
  assert.equal(result.code, 0);
  await absent(f.configFile);
});

test('付费下载摘要缺失或版本不一致均拒绝，目录和免费版完整保留', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  await writeSkill(root, 'oil-ui', '0.8.0');
  await writeSkill(root, 'oil-ui-pro', '0.8.0');
  const before = await snapshot(root);
  for (const [flag, error] of [['paidMissingChecksum', 'missing_checksum'], ['badVersion', 'version_mismatch']]) {
    f.state[flag] = true;
    const result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--yes', '--json'], { OIL_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.equal(data(result).error, error);
    assert.deepEqual(await snapshot(root), before);
    f.state[flag] = false;
  }
});

test('免费 list/install/update 不依赖账号配置；令牌登录可修复坏配置并不泄漏凭据', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.configFile), { recursive: true });
  await writeFile(f.configFile, '{broken');
  for (const args of [['list', '--json'], ['install', 'oil-doc', '--to', 'agents', '--yes', '--json']]) {
    assert.equal((await f.run(args)).code, 0);
  }
  f.state.latest = '0.11.0';
  assert.equal((await f.run(['update', '--yes', '--json'])).code, 0);
  assert.equal(await readFile(f.configFile, 'utf8'), '{broken');
  const result = await f.run(['login', '--token', TOKEN, '--json']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { token: TOKEN, email: 'test@example.com', api: f.base });
  assert(!result.stdout.includes(TOKEN));
  assert(f.state.requests.filter((r) => r.path.startsWith('/api/store/download/')).every((r) => r.token === undefined));
});

test('同一安装经由两个路径（符号链接）被扫到时，status 只列一次', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.claude', 'skills');
  await writeSkill(root, 'oil-ui', '0.10.0');
  await mkdir(path.join(f.cwd, '.claude'), { recursive: true });
  await linkDirectory(root, path.join(f.cwd, '.claude', 'skills'));
  const value = data(await f.run(['status', '--json']));
  assert.equal(value.installations.length, 1);
});
