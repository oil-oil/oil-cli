import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { fixture as createFixture, writeSkill, snapshot, TOKEN, INVALID, INACTIVE, linkDirectory, readDirectoryLink } from './fixture.js';

const fixture = async (t) => {
  const f = await createFixture(t);
  // Node 的 cwd 在 macOS 上会解析 /var → /private/var，项目作用域输出使用该路径。
  f.cwd = await realpath(f.cwd);
  return f;
};

const data = (result) => {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const absent = (directory) => assert.rejects(access(directory), { code: 'ENOENT' });
const root = (base, agent) => path.join(base, `.${agent}`, 'skills');
const sorted = (paths) => [...paths].sort();

test('Pro 装到项目目录时移除同宿主用户和项目开源版；其他宿主逐字节保留', async (t) => {
  for (const agent of ['claude', 'codex', 'agents', 'cursor']) {
    await t.test(agent, async (t) => {
      const f = await fixture(t);
      const user = root(f.home, agent);
      const target = agent === 'cursor' ? user : root(f.cwd, agent);
      const free = [await writeSkill(user, 'oil-ui', '0.8.0', 'renamed-user')];
      if (agent !== 'cursor') free.push(await writeSkill(target, 'oil-ui', '0.9.0', 'renamed-project'));
      const others = [];
      for (const other of ['claude', 'codex', 'agents', 'cursor'].filter((other) => other !== agent)) {
        others.push(await writeSkill(root(f.home, other), 'oil-ui', '0.8.0'));
        if (other !== 'cursor') others.push(await writeSkill(root(f.cwd, other), 'oil-ui', '0.8.0'));
      }
      // Cursor 没有当前项目作用域。
      others.push(await writeSkill(root(f.cwd, 'cursor'), 'oil-ui', '0.8.0'));
      const before = await Promise.all(others.map(snapshot));
      const result = await f.run(['install', 'oil-ui-pro', '--to', target, '--json'], { OIL_TOKEN: TOKEN });
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(sorted(data(result).removed), sorted(free));
      assert.deepEqual(data(result).warnings, []);
      assert.equal(result.trace.questions.length, 0);
      for (const directory of free) await absent(directory);
      assert.deepEqual(await Promise.all(others.map(snapshot)), before);
      assert.match(await readFile(path.join(target, 'oil-ui-pro', 'SKILL.md'), 'utf8'), /name: oil-ui-pro/);
    });
  }
});

test('Pro 装到用户目录时也移除同宿主当前项目的开源版', async (t) => {
  for (const agent of ['claude', 'codex', 'agents']) {
    await t.test(agent, async (t) => {
      const f = await fixture(t);
      const free = await writeSkill(root(f.cwd, agent), 'oil-ui', '0.8.0', 'custom-name');
      const result = await f.run(['install', 'oil-ui-pro', '--to', agent, '--json'], { OIL_TOKEN: TOKEN });
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(data(result).removed, [free]);
      assert.deepEqual(data(result).warnings, []);
      await absent(free);
    });
  }
});

test('CODEX_HOME 定义 Codex 用户作用域，旧 ~/.codex 不参与清理', async (t) => {
  const f = await fixture(t);
  const codexHome = path.join(f.temporary, 'custom-codex');
  const free = [await writeSkill(path.join(codexHome, 'skills'), 'oil-ui', '0.8.0'),
    await writeSkill(root(f.cwd, 'codex'), 'oil-ui', '0.8.0')];
  const other = await writeSkill(root(f.home, 'codex'), 'oil-ui', '0.8.0');
  const before = await snapshot(other);
  const result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--json'], { OIL_TOKEN: TOKEN, CODEX_HOME: codexHome });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(sorted(data(result).removed), sorted(free));
  for (const directory of free) await absent(directory);
  assert.deepEqual(await snapshot(other), before);
});

test('无法归属的自定义 skills 目录只清理同目录，不按路径中的宿主名称猜测', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.cwd, 'elsewhere', '.claude', 'skills');
  const free = await writeSkill(custom, 'oil-ui', '0.8.0', 'free-renamed');
  const others = [await writeSkill(root(f.home, 'claude'), 'oil-ui', '0.8.0'),
    await writeSkill(root(f.cwd, 'claude'), 'oil-ui', '0.8.0')];
  const before = await Promise.all(others.map(snapshot));
  const result = await f.run(['install', 'oil-ui-pro', '--to', path.relative(f.cwd, custom), '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, [free]);
  await absent(free);
  assert.deepEqual(await Promise.all(others.map(snapshot)), before);
});

test('开发目录、无 .git 的符号链接和无法识别的 oil-ui 目录跳过，并解释原因', async (t) => {
  const f = await fixture(t);
  const user = root(f.home, 'claude'), project = root(f.cwd, 'claude');
  const development = await writeSkill(user, 'oil-ui', '0.8.0', 'dev-free');
  await mkdir(path.join(development, 'nested', '.git'), { recursive: true });
  const external = await writeSkill(path.join(f.temporary, 'external'), 'oil-ui', '0.8.0');
  const linked = path.join(user, 'linked-free');
  await linkDirectory(external, linked);
  const unknown = await writeSkill(project, 'unrelated', '1.0.0', 'oil-ui');
  await writeFile(path.join(unknown, 'SKILL.md'), '# no frontmatter\n');
  const removable = await writeSkill(project, 'oil-ui', '0.8.0', 'removable');
  const before = await Promise.all([development, external, unknown].map(snapshot));
  const result = await f.run(['install', 'oil-ui-pro', '--to', 'claude', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const value = data(result);
  assert.deepEqual(value.removed, [removable]);
  assert.deepEqual(value.skipped, [
    { name: 'oil-ui', path: development, reason: 'development_directory' },
    { name: 'oil-ui', path: linked, reason: 'symbolic_link' },
    { name: 'oil-ui', path: unknown, reason: 'unrecognized_skill' },
  ]);
  assert.equal(value.warnings.length, 1);
  assert.match(value.warnings[0], /抢着接同一类请求/);
  await absent(removable);
  assert.equal(await readDirectoryLink(linked), external);
  assert.deepEqual(await Promise.all([development, external, unknown].map(snapshot)), before);
  const zh = await f.run(['install', 'oil-ui-pro', '--to', 'claude'], { OIL_TOKEN: TOKEN });
  assert.equal(zh.code, 0, zh.stderr);
  assert.match(zh.stdout, /开发目录，跳过/);
  assert.match(zh.stdout, /符号链接指向的目录，跳过/);
  assert.match(zh.stdout, /SKILL.md 无法识别为此 Skill，跳过/);
  const en = await f.run(['install', 'oil-ui-pro', '--to', 'claude', '--lang', 'en'], { OIL_TOKEN: TOKEN });
  assert.equal(en.code, 0, en.stderr);
  assert.match(en.stdout, /development directory, skipped/);
  assert.match(en.stdout, /directory referenced by a symbolic link, skipped/);
  assert.match(en.stdout, /SKILL.md does not identify this skill, skipped/);
});

test('同宿主内符号链接的真实目标也保留，不因扫描去重遗漏保护', async (t) => {
  const f = await fixture(t);
  const user = root(f.home, 'codex'), project = root(f.cwd, 'codex');
  const free = await writeSkill(user, 'oil-ui', '0.8.0');
  await mkdir(project, { recursive: true });
  const linked = path.join(project, 'free-alias');
  await linkDirectory(free, linked);
  const before = await snapshot(free);
  const result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, []);
  assert.deepEqual(sorted(data(result).skipped.map((item) => item.path)), sorted([free, linked]));
  assert(data(result).skipped.every((item) => item.reason === 'symbolic_link'));
  assert.equal(await readDirectoryLink(linked), free);
  assert.deepEqual(await snapshot(free), before);
});

test('通过符号链接 skills 根目录安装 Pro 时，链接指向的开源版保留', async (t) => {
  const f = await fixture(t);
  const shared = path.join(f.temporary, 'shared-skills');
  const free = await writeSkill(shared, 'oil-ui', '0.8.0');
  await mkdir(path.join(f.home, '.claude'));
  const skills = root(f.home, 'claude');
  await linkDirectory(shared, skills);
  const before = await snapshot(free);
  const result = await f.run(['install', 'oil-ui-pro', '--to', 'claude', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, []);
  assert.deepEqual(data(result).skipped, [{ name: 'oil-ui', path: path.join(skills, 'oil-ui'), reason: 'symbolic_link' }]);
  assert.deepEqual(await snapshot(free), before);
  assert.equal(await readDirectoryLink(skills), shared);
});

test('同宿主两处 skills 指向同一实体时，从真实目录装 Pro 也保护软链接目标', async (t) => {
  const f = await fixture(t);
  const project = root(f.cwd, 'claude');
  const free = await writeSkill(project, 'oil-ui', '0.8.0');
  await mkdir(path.join(f.home, '.claude'));
  const user = root(f.home, 'claude');
  await linkDirectory(project, user);
  const before = await snapshot(free);
  const result = await f.run(['install', 'oil-ui-pro', '--to', project, '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, []);
  assert.deepEqual(sorted(data(result).skipped.map((item) => item.path)), sorted([free, path.join(user, 'oil-ui')]));
  assert(data(result).skipped.every((item) => item.reason === 'symbolic_link'));
  assert.equal(await readDirectoryLink(user), project);
  assert.deepEqual(await snapshot(free), before);
});

test('update oil-ui-pro --path --json 和自动 update 成功后清理同宿主两处开源版', async (t) => {
  for (const scoped of [true, false]) {
    await t.test(scoped ? '--path' : '自动扫描', async (t) => {
      const f = await fixture(t);
      const user = root(f.home, 'agents'), project = root(f.cwd, 'agents');
      const pro = await writeSkill(project, 'oil-ui-pro', '0.8.0', 'renamed-pro');
      const free = [await writeSkill(user, 'oil-ui', '0.8.0', 'renamed-user'),
        await writeSkill(project, 'oil-ui', '0.9.0')];
      const other = await writeSkill(root(f.home, 'claude'), 'oil-ui', '0.10.0');
      const before = await snapshot(other);
      const args = scoped ? ['update', 'oil-ui-pro', '--path', pro, '--json'] : ['update', '--json'];
      const result = await f.run(args, { OIL_TOKEN: TOKEN });
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(sorted(data(result).removed), sorted(free));
      assert.equal(data(result).updated_count, 1);
      assert.deepEqual(data(result).installations.map((item) => item.path), [pro]);
      assert.deepEqual(data(result).warnings, []);
      assert.equal(result.trace.questions.length, 0);
      for (const directory of free) await absent(directory);
      assert.match(await readFile(path.join(pro, 'SKILL.md'), 'utf8'), /0\.10\.0/);
      assert.deepEqual(await snapshot(other), before);
      assert(f.state.requests.filter((request) => request.path.startsWith('/api/store/download/')).every((request) => request.path.endsWith('/oil-ui-pro')));
    });
  }
});

test('update 授权或 Pro 下载校验失败时，同宿主用户和项目的开源版原样保留', async (t) => {
  const f = await fixture(t);
  const pro = await writeSkill(root(f.home, 'claude'), 'oil-ui-pro', '0.8.0');
  const free = [await writeSkill(root(f.home, 'claude'), 'oil-ui', '0.8.0'),
    await writeSkill(root(f.cwd, 'claude'), 'oil-ui', '0.8.0')];
  const before = await Promise.all([pro, ...free].map(snapshot));
  for (const [token, checksum, error] of [[INVALID, false, 'unauthorized'], [INACTIVE, false, 'inactive'], [TOKEN, true, 'checksum_mismatch']]) {
    f.state.proBadChecksum = checksum;
    const result = await f.run(['update', 'oil-ui-pro', '--path', pro, '--json'], { OIL_TOKEN: token });
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(data(result).error, error);
    assert.deepEqual(await Promise.all([pro, ...free].map(snapshot)), before);
  }
});

test('update --path 的自定义目录只清理同目录，普通移除输出支持中英文', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.cwd, 'custom-skills');
  const pro = await writeSkill(custom, 'oil-ui-pro', '0.8.0');
  const free = await writeSkill(custom, 'oil-ui', '0.8.0', 'custom-free');
  const other = await writeSkill(root(f.home, 'codex'), 'oil-ui', '0.8.0');
  const before = await snapshot(other);
  const result = await f.run(['update', 'oil-ui-pro', '--path', pro], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stderr);
  assert(result.stdout.includes(`已移除同一 Agent 里的 Oil UI 开源版：${free}`));
  await absent(free);
  assert.deepEqual(await snapshot(other), before);
  await writeSkill(custom, 'oil-ui', '0.8.0', 'custom-free');
  f.state.latest = '0.11.0';
  const english = await f.run(['update', 'oil-ui-pro', '--path', pro, '--lang', 'en'], { OIL_TOKEN: TOKEN });
  assert.equal(english.code, 0, english.stderr);
  assert(english.stdout.includes(`Removed Oil UI (open source) from the same Agent: ${free}`));
  await absent(free);
});

test('最新版 Pro 的 update 也清理遗留开源版，不询问且 JSON 列出 removed', async (t) => {
  const f = await fixture(t);
  const pro = await writeSkill(root(f.home, 'codex'), 'oil-ui-pro', '0.10.0');
  const free = await writeSkill(root(f.cwd, 'codex'), 'oil-ui', '0.8.0');
  const before = await snapshot(pro);
  const result = await f.run(['update', 'oil-ui-pro', '--path', pro, '--json'], {}, { interactive: true });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, [free]);
  assert.equal(data(result).status, 'up_to_date');
  assert.equal(data(result).updated_count, 0);
  assert.deepEqual(data(result).warnings, []);
  assert.equal(result.trace.questions.length, 0);
  assert.deepEqual(await snapshot(pro), before);
  await absent(free);
  assert.equal(f.state.requests.filter((request) => request.path.startsWith('/api/store/download/')).length, 0);
});

test('Pro 开发目录跳过更新时不清理开源版；跨作用域共存仍提示冲突', async (t) => {
  const f = await fixture(t);
  const pro = await writeSkill(root(f.home, 'claude'), 'oil-ui-pro', '0.8.0');
  await mkdir(path.join(pro, '.git'));
  const free = await writeSkill(root(f.cwd, 'claude'), 'oil-ui', '0.8.0');
  const before = await snapshot(free);
  const status = await f.run(['status', '--json']);
  assert.equal(data(status).warnings.length, 1);
  const result = await f.run(['update', 'oil-ui-pro', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, []);
  assert.equal(data(result).warnings.length, 1);
  assert.deepEqual(await snapshot(free), before);
});

test('批量安装中某宿主的 Pro 被保护时，不清理该宿主的其他开源版', async (t) => {
  const f = await fixture(t);
  const claude = root(f.home, 'claude');
  const external = await writeSkill(path.join(f.temporary, 'external'), 'oil-ui', '0.8.0');
  await mkdir(claude, { recursive: true });
  const linked = path.join(claude, 'oil-ui-pro');
  await linkDirectory(external, linked);
  const retained = await writeSkill(root(f.cwd, 'claude'), 'oil-ui', '0.8.0');
  const removed = await writeSkill(root(f.home, 'codex'), 'oil-ui', '0.8.0');
  const before = await Promise.all([external, retained].map(snapshot));
  const result = await f.run(['install', 'oil-ui-pro', '--to', 'claude', '--to', 'codex', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, [removed]);
  assert.deepEqual(data(result).installations.map((item) => item.path), [path.join(root(f.home, 'codex'), 'oil-ui-pro')]);
  assert.deepEqual(data(result).skipped, [{ name: 'oil-ui', path: linked, reason: 'symbolic_link' }]);
  assert.deepEqual(await Promise.all([external, retained].map(snapshot)), before);
  assert.equal(await readDirectoryLink(linked), external);
  await absent(removed);
});

test('批量 update 保护开发开源版时 skipped 只报告一次，未清理的冲突仍警告', async (t) => {
  const f = await fixture(t);
  const free = await writeSkill(root(f.cwd, 'claude'), 'oil-ui', '0.8.0');
  await mkdir(path.join(free, '.git'));
  const pro = await writeSkill(root(f.home, 'claude'), 'oil-ui-pro', '0.8.0');
  const before = await snapshot(free);
  const result = await f.run(['update', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(data(result).removed, []);
  assert.deepEqual(data(result).skipped, [{ name: 'oil-ui', path: free, reason: 'development_directory' }]);
  assert.equal(data(result).warnings.length, 1);
  assert.deepEqual(await snapshot(free), before);
  assert.match(await readFile(path.join(pro, 'SKILL.md'), 'utf8'), /0\.10\.0/);
});

test('帮助移除旧确认文案，中英文说明 Pro 自动清理同一 Agent', async (t) => {
  const f = await fixture(t);
  for (const lang of ['zh', 'en']) {
    const result = await f.run(['help', '--lang', lang]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, lang === 'zh' ? /安装或更新 Oil UI Pro 自动移除同一 Agent 的开源版/ : /Installing or updating Oil UI Pro automatically removes the open source version from the same Agent/);
    assert.doesNotMatch(result.stdout, /同位置|same location/);
  }
});
