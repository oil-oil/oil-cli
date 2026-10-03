import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, access, readFile } from 'node:fs/promises';
import { fixture, writeSkill, snapshot, TOKEN, linkDirectory, readDirectoryLink } from './fixture.js';

const data = (result) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};
const absent = (file) => assert.rejects(access(file), { code: 'ENOENT' });
const userRoot = (f) => path.join(f.home, '.workbuddy', 'skills');
const projectRoot = (f) => path.join(f.cwd, '.workbuddy', 'skills');

test('默认检测 WorkBuddy 用户目录，不把项目 .workbuddy 当默认目标或扫描范围', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.workbuddy'));
  const project = await writeSkill(projectRoot(f), 'oil-ui', '0.8.0');
  const before = await snapshot(project);
  const installed = data(await f.run(['install', 'oil-ui', '--json']));
  assert.deepEqual(installed.installations.map((item) => item.path), [path.join(userRoot(f), 'oil-ui')]);
  const status = data(await f.run(['status', '--json']));
  assert.deepEqual(status.installations.map((item) => item.path), [path.join(userRoot(f), 'oil-ui')]);
  f.state.latest = '0.11.0';
  const updated = data(await f.run(['update', '--json']));
  assert.equal(updated.updated_count, 1);
  assert.equal(updated.installations[0].version, '0.11.0');
  assert.deepEqual(await snapshot(project), before);
});

test('--to workbuddy 可创建用户目录，项目目录存在时仍需显式指定目标', async (t) => {
  const f = await fixture(t);
  await mkdir(projectRoot(f), { recursive: true });
  const missing = await f.run(['install', 'oil-ui', '--json']);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stdout).error, 'missing_target');
  const installed = data(await f.run(['install', 'oil-ui', '--to', 'workbuddy', '--json']));
  assert.equal(installed.installations[0].path, path.join(userRoot(f), 'oil-ui'));
  await absent(path.join(projectRoot(f), 'oil-ui'));
});

test('WorkBuddy 安装或更新 Pro 只清理用户目录，其他宿主及 .workbuddy 项目目录保留', async (t) => {
  for (const updating of [false, true]) await t.test(updating ? 'update --path' : 'install --to', async (t) => {
    const f = await fixture(t);
    const free = await writeSkill(userRoot(f), 'oil-ui', '0.8.0', 'renamed-free');
    const others = [await writeSkill(projectRoot(f), 'oil-ui', '0.8.0'),
      await writeSkill(path.join(f.home, '.claude', 'skills'), 'oil-ui', '0.8.0'),
      await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui', '0.8.0')];
    const before = await Promise.all(others.map(snapshot));
    const pro = updating ? await writeSkill(userRoot(f), 'oil-ui-pro', '0.8.0') : path.join(userRoot(f), 'oil-ui-pro');
    const args = updating ? ['update', 'oil-ui-pro', '--path', pro, '--json'] : ['install', 'oil-ui-pro', '--to', 'workbuddy', '--json'];
    const result = await f.run(args, { OIL_TOKEN: TOKEN });
    assert.deepEqual(data(result).removed, [free]);
    assert.deepEqual(data(result).warnings, []);
    assert.equal(result.trace.questions.length, 0);
    await absent(free);
    assert.match(await readFile(path.join(pro, 'SKILL.md'), 'utf8'), /0\.10\.0/);
    assert.deepEqual(await Promise.all(others.map(snapshot)), before);
  });
});

test('显式 .workbuddy 项目路径作为自定义目录，只清理自身开源版', async (t) => {
  const f = await fixture(t);
  const user = await writeSkill(userRoot(f), 'oil-ui', '0.8.0');
  const project = await writeSkill(projectRoot(f), 'oil-ui', '0.8.0');
  const before = await snapshot(user);
  const result = await f.run(['install', 'oil-ui-pro', '--to', projectRoot(f), '--json'], { OIL_TOKEN: TOKEN });
  assert.deepEqual(data(result).removed, [project]);
  await absent(project);
  assert.deepEqual(await snapshot(user), before);
});

test('WorkBuddy 清理沿用开发目录和符号链接/junction 保护，更新失败不移除', async (t) => {
  const f = await fixture(t);
  const free = await writeSkill(userRoot(f), 'oil-ui', '0.8.0', 'development');
  await mkdir(path.join(free, '.git'));
  const external = await writeSkill(path.join(f.temporary, 'external'), 'oil-ui', '0.8.0');
  const linked = path.join(userRoot(f), 'linked-free');
  await linkDirectory(external, linked);
  const before = await Promise.all([free, external].map(snapshot));
  const installed = data(await f.run(['install', 'oil-ui-pro', '--to', 'workbuddy', '--json'], { OIL_TOKEN: TOKEN }));
  assert.deepEqual(installed.removed, []);
  assert.deepEqual(installed.skipped.map((item) => item.reason).sort(), ['development_directory', 'symbolic_link']);
  assert.equal(installed.warnings.length, 1);
  assert.equal(await readDirectoryLink(linked), external);
  assert.deepEqual(await Promise.all([free, external].map(snapshot)), before);
  const removable = await writeSkill(userRoot(f), 'oil-ui', '0.8.0', 'plain-free');
  const plainBefore = await snapshot(removable);
  f.state.latest = '0.11.0';
  f.state.proBadChecksum = true;
  const failed = await f.run(['update', 'oil-ui-pro', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(failed.stdout).error, 'checksum_mismatch');
  assert.deepEqual(await snapshot(removable), plainBefore);
});

test('WorkBuddy 中英文帮助包含别名与用户目录范围', async (t) => {
  const f = await fixture(t);
  for (const lang of ['zh', 'en']) {
    const result = await f.run(['help', '--lang', lang]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--to claude\|codex\|agents\|cursor\|workbuddy\|/);
    assert.match(result.stdout, /~\/\.workbuddy\/skills/);
    assert.match(result.stdout, lang === 'zh' ? /不自动扫描项目级/ : /not scanned automatically/);
  }
});
