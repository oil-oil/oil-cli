import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { discoveryRoots, targetRoot } from '../src/skills.js';
import { fixture as createFixture, writeSkill, snapshot, TOKEN, linkDirectory, readDirectoryLink } from './fixture.js';

const fixture = async (t) => {
  const f = await createFixture(t);
  f.cwd = await realpath(f.cwd);
  return f;
};
const data = (result) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};
const absent = (file) => assert.rejects(access(file), { code: 'ENOENT' });
const root = (base, agent = 'dsh') => path.join(base, `.${agent}`, 'skills');
const sorted = (paths) => [...paths].sort();

test('dsh 别名解析到用户目录，显式相对路径仍相对 cwd，扫描包含用户和项目目录', () => {
  const env = { HOME: '/tmp/home', CODEX_HOME: '/tmp/custom-codex' };
  assert.equal(targetRoot('dsh', env, 'linux', '/tmp/project'), '/tmp/home/.dsh/skills');
  assert.equal(targetRoot('./dsh', env, 'linux', '/tmp/project'), '/tmp/project/dsh');
  assert.equal(targetRoot('~/.dsh/skills', env, 'linux', '/tmp/project'), '/tmp/home/.dsh/skills');
  const roots = discoveryRoots(env, 'linux', '/tmp/project');
  assert(roots.includes('/tmp/home/.dsh/skills'));
  assert(roots.includes('/tmp/project/.dsh/skills'));
  assert(roots.includes('/tmp/custom-codex/skills'));
  assert.equal(roots.length, new Set(roots).size);
});

test('--to dsh 创建用户安装，重复目标去重，status/update 可发现且不写 ./dsh', async (t) => {
  const f = await fixture(t);
  const installed = data(await f.run(['install', 'oil-ui', '--to', 'dsh', '--to', root(f.home), '--json']));
  const directory = path.join(root(f.home), 'oil-ui');
  assert.deepEqual(installed.installations.map((item) => item.path), [directory]);
  assert.deepEqual(installed.links, []);
  await absent(path.join(f.cwd, 'dsh'));
  const status = data(await f.run(['status', '--json']));
  assert.deepEqual(status.installations.map((item) => item.path), [directory]);
  f.state.latest = '0.11.0';
  const updated = data(await f.run(['update', 'oil-ui', '--json']));
  assert.equal(updated.updated_count, 1);
  assert.equal(updated.installations[0].path, directory);
  assert.match(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), /0\.11\.0/);
});

test('默认检测 dsh 仍安装到共享 .agents，已有 .dsh 副本保留且其他宿主链接共享', async (t) => {
  for (const withClaude of [false, true]) await t.test(withClaude ? 'Claude 主安装' : '共享目录主安装', async (t) => {
    const f = await fixture(t);
    const existing = await writeSkill(root(f.home), 'oil-doc', '0.8.0');
    const before = await snapshot(existing);
    if (withClaude) await mkdir(path.join(f.home, '.claude'));
    const installed = data(await f.run(['install', 'oil-ui', '--json']));
    const primary = path.join(root(f.home, withClaude ? 'claude' : 'agents'), 'oil-ui');
    assert.deepEqual(installed.installations.map((item) => item.path), [primary]);
    assert.deepEqual(installed.links.map((item) => item.path), withClaude ? [path.join(root(f.home, 'agents'), 'oil-ui')] : []);
    if (withClaude) assert.equal(await readDirectoryLink(installed.links[0].path), primary);
    await absent(path.join(root(f.home), 'oil-ui'));
    await absent(path.join(f.cwd, 'dsh'));
    assert.deepEqual(await snapshot(existing), before);
  });
});

test('项目级 .dsh 会被发现，但不作为默认安装目标', async (t) => {
  const f = await fixture(t);
  const project = await writeSkill(root(f.cwd), 'oil-ui', '0.8.0');
  const before = await snapshot(project);
  const missing = await f.run(['install', 'oil-doc', '--json']);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stdout).error, 'missing_target');
  const status = data(await f.run(['status', '--json']));
  assert.deepEqual(status.installations.map((item) => item.path), [project]);
  assert.deepEqual(await snapshot(project), before);
  data(await f.run(['install', 'oil-doc', '--to', root(f.cwd), '--json']));
  await absent(root(f.home));
});

test('已有用户或项目 dsh Pro 无需 --path 即可更新，并清理同宿主开源版、保留其他宿主', async (t) => {
  for (const projectPro of [false, true]) await t.test(projectPro ? '项目 Pro' : '用户 Pro', async (t) => {
    const f = await fixture(t);
    const pro = await writeSkill(root(projectPro ? f.cwd : f.home), 'oil-ui-pro', '0.8.0', 'renamed-pro');
    const free = [await writeSkill(root(f.home), 'oil-ui', '0.8.0', 'renamed-free'),
      await writeSkill(root(f.cwd), 'oil-ui', '0.9.0')];
    const others = [];
    for (const agent of ['agents', 'codex', 'claude']) others.push(await writeSkill(root(f.home, agent), 'oil-ui', '0.8.0'));
    const before = await Promise.all(others.map(snapshot));
    const status = data(await f.run(['status', '--json']));
    assert(status.installations.some((item) => item.path === pro && item.current === '0.8.0' && item.update_available));
    assert(status.warnings.some((warning) => warning.includes(root(projectPro ? f.cwd : f.home))));
    const updated = data(await f.run(['update', 'oil-ui-pro', '--json'], { OIL_TOKEN: TOKEN }));
    assert.equal(updated.found_count, 1);
    assert.equal(updated.updated_count, 1);
    assert.deepEqual(updated.installations.map((item) => item.path), [pro]);
    assert.deepEqual(sorted(updated.removed), sorted(free));
    assert.deepEqual(updated.warnings, []);
    for (const file of free) await absent(file);
    assert.match(await readFile(path.join(pro, 'SKILL.md'), 'utf8'), /0\.10\.0/);
    assert.deepEqual(await Promise.all(others.map(snapshot)), before);
  });
});

test('安装 dsh Pro 清理用户及项目开源版，开发目录和链接继续受保护并提示冲突', async (t) => {
  const f = await fixture(t);
  const free = await writeSkill(root(f.cwd), 'oil-ui', '0.8.0', 'plain-free');
  const development = await writeSkill(root(f.home), 'oil-ui', '0.8.0', 'dev-free');
  await mkdir(path.join(development, '.git'));
  const external = await writeSkill(path.join(f.temporary, 'external'), 'oil-ui', '0.8.0');
  const linked = path.join(root(f.cwd), 'linked-free');
  await linkDirectory(external, linked);
  const before = await Promise.all([development, external].map(snapshot));
  const installed = data(await f.run(['install', 'oil-ui-pro', '--to', 'dsh', '--json'], { OIL_TOKEN: TOKEN }));
  assert.deepEqual(installed.removed, [free]);
  assert.deepEqual(sorted(installed.skipped.map((item) => item.reason)), ['development_directory', 'symbolic_link']);
  assert.equal(installed.warnings.length, 1);
  await absent(free);
  assert.equal(await readDirectoryLink(linked), external);
  assert.deepEqual(await Promise.all([development, external].map(snapshot)), before);
});

test('dsh 用户副本参与重复提示，项目副本不计入；链接共享后只更新一次', async (t) => {
  const f = await fixture(t);
  const shared = await writeSkill(root(f.home, 'agents'), 'oil-ui', '0.8.0');
  const native = await writeSkill(root(f.home), 'oil-ui', '0.8.0');
  await writeSkill(root(f.cwd), 'oil-ui', '0.8.0');
  const status = data(await f.run(['status', '--lang', 'en', '--json']));
  assert.equal(status.installations.length, 3);
  assert.equal(status.warnings.length, 1);
  assert.match(status.warnings[0], /2/);
  const installed = data(await f.run(['install', 'oil-ui', '--to', 'agents', '--to', 'dsh', '--json']));
  assert.deepEqual(installed.links.map((item) => item.path), [native]);
  assert.equal(await readDirectoryLink(native), shared);
  const linkedStatus = data(await f.run(['status', '--json']));
  assert.equal(linkedStatus.installations.length, 2);
  assert.deepEqual(linkedStatus.warnings, []);
  f.state.latest = '0.11.0';
  const updated = data(await f.run(['update', '--json']));
  assert.equal(updated.updated_count, 2);
  assert.match(await readFile(path.join(native, 'SKILL.md'), 'utf8'), /0\.11\.0/);
  assert.equal(await readDirectoryLink(native), shared);
});

test('dsh 中英文帮助说明显式目标、默认共享和扫描范围', async (t) => {
  const f = await fixture(t);
  for (const lang of ['zh', 'en']) {
    const result = await f.run(['help', '--lang', lang]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /\|dsh\|/);
    assert.match(result.stdout, /DeepSeek Harness/);
    assert.match(result.stdout, /~\/\.agents\/skills/);
    assert.match(result.stdout, /--to dsh/);
    assert.match(result.stdout, /~\/\.dsh\/skills/);
    assert.match(result.stdout, lang === 'zh' ? /项目级 \.dsh\/skills/ : /project-level \.dsh\/skills/);
  }
});
