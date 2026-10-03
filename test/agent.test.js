import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, lstat, readlink, access, symlink, realpath } from 'node:fs/promises';
import { fixture, writeSkill, snapshot, TOKEN, INACTIVE } from './fixture.js';

const events = (result) => {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
};
const data = (result) => events(result).at(-1);
const absent = (file) => assert.rejects(access(file), { code: 'ENOENT' });

test('无 --to、无 --yes，自动安装到所有本机 Agent；.agents 必须已有 skills', async (t) => {
  const f = await fixture(t);
  for (const agent of ['claude', 'codex', 'cursor', 'agents']) await mkdir(path.join(f.home, `.${agent}`));
  await mkdir(path.join(f.cwd, '.claude', 'skills'), { recursive: true });
  let result = await f.run(['install', 'oil-ui', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).installations.map((i) => i.path), ['claude', 'codex', 'cursor'].map((agent) => path.join(f.home, `.${agent}`, 'skills', 'oil-ui')));
  assert.equal(result.trace.questions.length, 0);
  await absent(path.join(f.home, '.agents', 'skills'));
  await absent(path.join(f.cwd, '.claude', 'skills', 'oil-ui'));
  await mkdir(path.join(f.home, '.agents', 'skills'));
  result = await f.run(['install', 'oil-ui', '--json']);
  assert.equal(data(result).installations.length, 4);
});

test('自动检测只接受目录，允许 Agent 目录软链接；显式 --to 覆盖自动检测', async (t) => {
  const f = await fixture(t);
  const agent = path.join(f.temporary, 'agent');
  await mkdir(agent);
  await symlink(agent, path.join(f.home, '.codex'), 'dir');
  await writeFile(path.join(f.home, '.claude'), '不是目录');
  let result = await f.run(['install', 'oil-doc', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).installations.length, 1);
  assert.match(await readFile(path.join(agent, 'skills', 'oil-doc', 'SKILL.md'), 'utf8'), /name: oil-doc/);
  result = await f.run(['install', 'oil-ui', '--to', 'agents', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).installations.length, 1);
  assert.equal(data(result).installations[0].path, path.join(f.home, '.agents', 'skills', 'oil-ui'));
  await absent(path.join(agent, 'skills', 'oil-ui'));
});

test('交互终端列出自动检测的安装位置，回车默认确认，也能拒绝', async (t) => {
  const f = await fixture(t);
  for (const agent of ['claude', 'codex']) await mkdir(path.join(f.home, `.${agent}`));
  const result = await f.run(['install', 'oil-ui'], {}, { interactive: true, answers: [''] });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /安装位置：/);
  assert(result.stdout.includes(path.join(f.home, '.claude', 'skills')));
  assert(result.stdout.includes(path.join(f.home, '.codex', 'skills')));
  assert.equal(result.trace.questions.length, 1);
  assert.match(result.trace.questions[0], /\[Y\/n\]/);
  const refused = await f.run(['install', 'oil-doc'], {}, { interactive: true, answers: ['n'] });
  assert.equal(refused.code, 0);
  assert.match(refused.stdout, /已取消安装/);
  await absent(path.join(f.home, '.codex', 'skills', 'oil-doc'));
});

test('检测不到 Agent：非交互退出 2 并提示 --to，交互询问后回车确认', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'oil-ui', '--json']);
  assert.equal(result.code, 2);
  assert.match(data(result).message, /未检测到 Agent 目录.*--to/);
  assert.equal(result.trace.questions.length, 0);
  const custom = path.join(f.temporary, 'custom skills');
  const prompted = await f.run(['install', 'oil-ui'], {}, { interactive: true, answers: [custom, ''] });
  assert.equal(prompted.code, 0);
  assert.equal(prompted.trace.questions.length, 2);
  assert.match(await readFile(path.join(custom, 'oil-ui', 'SKILL.md'), 'utf8'), /name: oil-ui/);
});

test('非交互付费安装默认移除免费版并说明；update 不需要 --yes', async (t) => {
  const f = await fixture(t);
  const free = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui', '0.8.0', 'custom-free');
  let result = await f.run(['install', 'oil-ui-pro'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /已移除同位置的开源版：/);
  await absent(free);
  f.state.latest = '0.11.0';
  result = await f.run(['update', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(data(result).installations[0].version, '0.11.0');
  assert.equal(result.trace.questions.length, 0);
});

test('交互移除免费版默认是，用户可选择保留；--yes 跳过确认', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  let result = await f.run(['install', 'oil-ui-pro'], { OIL_TOKEN: TOKEN }, { interactive: true, answers: ['', 'n'] });
  assert.equal(result.code, 0);
  await access(free);
  assert.equal(result.trace.questions.length, 2);
  assert.match(result.trace.questions[1], /开源版.*\[Y\/n\]/);
  result = await f.run(['install', 'oil-ui-pro'], { OIL_TOKEN: TOKEN }, { interactive: true, answers: ['', ''] });
  assert.equal(result.code, 0);
  await absent(free);
  await writeSkill(root, 'oil-ui', '0.8.0');
  result = await f.run(['install', 'oil-ui-pro', '--yes'], { OIL_TOKEN: TOKEN }, { interactive: true });
  assert.equal(result.code, 0);
  assert.equal(result.trace.questions.length, 0);
});

test('非交互四类命令缺令牌时直接设备码登录并继续，不需要 --yes', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['success'];
  await writeSkill(path.join(f.home, '.agents', 'skills'), 'oil-doc-pro', '0.8.0');
  for (const args of [
    ['install', 'oil-ui-pro', '--json'], ['update', 'oil-doc-pro', '--json'],
    ['subscribe', 'oil-doc-pro', '--plan', 'yearly', '--json'], ['manage', '--json'],
  ]) {
    await f.run(['logout']);
    f.state.revoked.delete(TOKEN);
    const result = await f.run(args);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(events(result).slice(0, 2).map((e) => e.event), ['device', 'login']);
    assert.equal(result.trace.questions.length, 0);
    assert(events(result).length >= 3);
  }
});

test('CI 真值禁止设备码登录，false/0 允许；CI 配置令牌后可直接安装', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.codex'));
  f.state.deviceStatuses = ['success'];
  for (const CI of ['true', '1', 'TRUE']) {
    const result = await f.run(['install', 'oil-ui-pro', '--json'], { CI });
    assert.equal(result.code, 3);
    assert.match(data(result).message, /OIL_TOKEN/);
  }
  assert.equal(f.state.devicePolls, 0);
  for (const CI of ['false', '0']) {
    const result = await f.run(['install', 'oil-ui-pro', '--json'], { CI });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(events(result)[0].event, 'device');
    await f.run(['logout']);
    f.state.revoked.delete(TOKEN);
  }
  const result = await f.run(['install', 'oil-ui-pro', '--json'], { CI: 'true', OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(events(result).length, 1);
});

test('非交互订阅生效后自动装到所有检测位置；交互回车默认安装', async (t) => {
  const f = await fixture(t);
  for (const agent of ['codex', 'cursor']) await mkdir(path.join(f.home, `.${agent}`));
  let result = await f.run(['subscribe', 'oil-ui-pro', '--json'], { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(data(result).installations.length, 2);
  assert.equal(result.trace.questions.length, 0);
  result = await f.run(['subscribe', 'oil-doc-pro'], { OIL_TOKEN: TOKEN }, { interactive: true, answers: ['', ''] });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /已安装 oil-doc-pro/);
  assert.equal(result.trace.questions.length, 2);
  assert.match(result.trace.questions[0], /现在安装.*\[Y\/n\]/);
});

test('交互订阅可以拒绝安装；无 Agent 的非交互订阅生效后提示 --to', async (t) => {
  const f = await fixture(t);
  let result = await f.run(['subscribe', 'oil-ui-pro'], { OIL_TOKEN: INACTIVE }, { interactive: true, answers: ['n'] });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /以后安装：npx github:oil-oil\/oil-cli install oil-ui-pro/);
  await absent(path.join(f.home, '.codex'));
  result = await f.run(['subscribe', 'oil-doc-pro', '--json'], { OIL_TOKEN: INACTIVE });
  assert.equal(result.code, 2);
  assert.match(data(result).message, /--to/);
  assert.equal(events(result)[1].event, 'subscribed');
});

test('开发目录：status 标记；install、update 跳过，不下载、不登录、旧文件保留', async (t) => {
  const f = await fixture(t);
  const repository = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui-pro', '0.8.0');
  await mkdir(path.join(repository, '.git'));
  await writeFile(path.join(repository, '.git', 'config'), '开发仓库');
  const before = await snapshot(repository);
  const status = await f.run(['status', '--json']);
  const item = data(status).installations[0];
  assert.equal(item.development, true);
  assert.equal(item.update_available, false);
  assert.match((await f.run(['status'])).stdout, /开发目录，跳过/);
  for (const args of [['install', 'oil-ui-pro'], ['install', 'oil-ui-pro', '--yes'], ['update'], ['update', '--yes'], ['update', '--path', repository]]) {
    const result = await f.run([...args, '--json'], { CI: 'true' });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(data(result).skipped, [{ name: 'oil-ui-pro', path: repository, reason: 'development_directory' }]);
    assert.deepEqual(await snapshot(repository), before);
  }
  assert.equal(f.state.requests.filter((r) => r.path.startsWith('/api/store/download/') || r.path === '/api/cli/device').length, 0);
});

test('先解析 Skill 软链接和父目录软链接：开发仓库和链接完整保留，其他安装仍更新', async (t) => {
  const f = await fixture(t);
  const repository = await writeSkill(path.join(f.temporary, 'repositories'), 'oil-ui-pro', '0.8.0');
  await writeFile(path.join(repository, '.git'), 'gitdir: ../worktree');
  const root = path.join(f.home, '.codex', 'skills');
  await mkdir(root, { recursive: true });
  const linked = path.join(root, 'oil-ui-pro');
  await symlink(repository, linked, 'dir');
  const plain = await writeSkill(root, 'oil-ui', '0.8.0');
  const alias = path.join(f.temporary, 'root-alias');
  await symlink(root, alias, 'dir');
  const before = await snapshot(repository);
  const status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.find((i) => i.name === 'oil-ui-pro').development, true);
  for (const args of [['install', 'oil-ui-pro', '--to', alias], ['update'], ['update', '--path', linked]]) {
    const result = await f.run([...args, '--json']);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(data(result).skipped.length, 1);
    assert.equal(await readlink(linked), repository);
    assert((await lstat(linked)).isSymbolicLink());
    assert.deepEqual(await snapshot(repository), before);
  }
  assert.match(await readFile(path.join(plain, 'SKILL.md'), 'utf8'), /0\.10\.0/);
});

test('免费版开发目录不会因付费安装被移除；被占用的未知开发目录也受保护', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  await mkdir(path.join(free, 'nested', '.git'), { recursive: true });
  const before = await snapshot(free);
  let result = await f.run(['install', 'oil-ui-pro', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(data(result).removed.length, 0);
  assert.equal(data(result).skipped[0].name, 'oil-ui');
  assert.deepEqual(await snapshot(free), before);
  const occupied = await writeSkill(root, 'other', '1.0.0', 'oil-doc');
  await mkdir(path.join(occupied, '.git'));
  const unknownBefore = await snapshot(occupied);
  result = await f.run(['install', 'oil-doc', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).skipped.length, 1);
  assert.deepEqual(await snapshot(occupied), unknownBefore);
});

test('update --path 只更新给定安装，支持相对目录、~、自定义路径和改名目录', async (t) => {
  const f = await fixture(t);
  const custom = await writeSkill(path.join(f.cwd, 'custom skills'), 'oil-ui', '0.8.0', 'renamed');
  const other = await writeSkill(path.join(f.home, '.claude', 'skills'), 'oil-ui', '0.8.0');
  const before = await snapshot(other);
  let result = await f.run(['update', '--path', path.relative(f.cwd, custom), '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).installations.length, 1);
  assert.equal(await realpath(data(result).installations[0].path), await realpath(custom));
  assert.deepEqual(await snapshot(other), before);
  result = await f.run(['update', 'oil-ui', '--path=~/.claude/skills/oil-ui', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).installations[0].path, other);
});

test('update --path 拒绝未知/缺失安装和 Skill 不匹配，参数只能用于 update', async (t) => {
  const f = await fixture(t);
  const unknown = await writeSkill(path.join(f.temporary, 'unknown'), 'other', '0.8.0');
  const known = await writeSkill(path.join(f.temporary, 'known'), 'oil-ui', '0.8.0');
  const before = await snapshot(known);
  for (const args of [
    ['update', '--path', unknown], ['update', '--path', path.join(f.temporary, 'absent')],
    ['update', 'oil-doc', '--path', known], ['install', 'oil-ui', '--path', known],
    ['update', '--path'], ['update', '--path', known, '--path', known],
  ]) {
    const result = await f.run([...args, '--json']);
    assert.equal(result.code, 2, result.stdout);
  }
  assert.deepEqual(await snapshot(known), before);
});

test('订阅 plan 用中文、日期用本地 YYYY-MM-DD；JSON 保留服务端原字段', async (t) => {
  const f = await fixture(t);
  f.state.subscriptions = [
    { skill: 'oil-ui-pro', name: '月费', plan: 'monthly', status: 'active', renews: Date.parse('2026-11-03T00:30:00Z') / 1000, ends: null },
    { skill: 'oil-doc-pro', name: '年费', plan: 'yearly', status: 'canceling', renews: null, ends: Date.parse('2026-11-03T00:30:00Z') / 1000 },
    { skill: 'other-pro', name: '买断', plan: 'lifetime', status: 'lifetime', renews: null, ends: null },
  ];
  const result = await f.run(['status'], { OIL_TOKEN: TOKEN, TZ: 'America/Los_Angeles' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /月费：有效（每月），续费 2026-11-02/);
  assert.match(result.stdout, /年费：已取消，到期前可用（每年），到期 2026-11-02/);
  assert.match(result.stdout, /买断：已买断，永久更新/);
  assert(!result.stdout.includes('T00:30:00'));
  const json = data(await f.run(['status', '--json'], { OIL_TOKEN: TOKEN }));
  assert.equal(json.account.subscriptions[0].plan, 'monthly');
  assert.equal(json.account.subscriptions[0].renews, f.state.subscriptions[0].renews);
});

test('install 覆盖旧版本显示已更新和前后版本，JSON 带 previous', async (t) => {
  const f = await fixture(t);
  await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui', '0.8.0');
  let result = await f.run(['install', 'oil-ui']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /已更新 Oil UI 开源版：0\.8\.0 → 0\.10\.0/);
  f.state.latest = '0.11.0';
  result = await f.run(['install', 'oil-ui', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).installations[0].previous, '0.10.0');
  assert.equal(data(result).installations[0].version, '0.11.0');
});

test('多个 Agent 共享软链接 skills 目录时，只安装和更新同一实体一次', async (t) => {
  const f = await fixture(t);
  const shared = path.join(f.temporary, 'shared');
  await mkdir(shared);
  for (const agent of ['claude', 'codex']) {
    const root = path.join(f.home, `.${agent}`);
    await mkdir(root);
    await symlink(shared, path.join(root, 'skills'), 'dir');
  }
  let result = await f.run(['install', 'oil-ui', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(data(result).installations.length, 1);
  f.state.latest = '0.11.0';
  result = await f.run(['update', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(data(result).installations.length, 1);
  assert.match(await readFile(path.join(shared, 'oil-ui', 'SKILL.md'), 'utf8'), /0\.11\.0/);
});

test('一句安装命令的真实入口：非交互设备码登录后自动安装，并移除免费版', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  const result = await f.run(['install', 'oil-ui-pro'], { OIL_TEST_BROWSER: 'approve' }, { real: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /授权码：KDQW-7RTF/);
  assert.match(result.stdout, /已登录：test@example.com/);
  assert.match(result.stdout, /已安装 Oil UI Pro/);
  assert.match(result.stdout, /已移除同位置的开源版/);
  assert(f.state.deviceApproved);
  await absent(free);
  assert.match(await readFile(path.join(root, 'oil-ui-pro', 'SKILL.md'), 'utf8'), /0\.10\.0/);
});
