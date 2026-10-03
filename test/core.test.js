import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, access, readdir, symlink, readlink } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSkill, compare, updates } from '../src/skills.js';
import { replaceAll as replace, validateArchive } from '../src/install.js';
import { Output } from '../src/io.js';
import { configPath } from '../src/config.js';
import { openBrowser } from '../src/browser.js';
import { writeSkill, snapshot, TOKEN } from './fixture.js';

const replaceAll = (actions, options = {}) => replace(actions, { names: ['oil-ui', 'oil-ui-pro'], ...options });

async function temp(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'oil-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('frontmatter 读取引号、注释、CRLF 和简单行内 metadata；重复 name 不被当成目标', () => {
  assert.deepEqual(parseSkill('\uFEFF---\r\nname: "oil-ui" # 注释\r\nmetadata:\r\n  version: \'0.10.0\' # 注释\r\n---\r\n'), { name: 'oil-ui', version: '0.10.0' });
  assert.deepEqual(parseSkill('---\nname: oil-ui-pro\nmetadata: {version: "1.0.0"}\n---\n'), { name: 'oil-ui-pro', version: '1.0.0' });
  assert.equal(parseSkill('---\nname: oil-ui\nmetadata: {author: "oil, oil", version: "0.10.0", other: [a, b]} # 注释\n---\n').version, '0.10.0');
  assert.equal(parseSkill('---\nname: oil-ui\nmetadata:\n  other:\n    version: 9.9.9\n  version: 0.10.0\n---\n').version, '0.10.0');
  assert.equal(parseSkill('---\nname: oil-ui\nname: unrelated\n---\n').name, null);
  assert.equal(parseSkill('# 文档\nname: oil-ui\n').name, null);
  assert.equal(parseSkill('---\nname: oil-ui\nmetadata:\n  version: 01.0.0\n---\n').version, null);
  assert(compare('0.10.0', '0.9.0') > 0);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
  assert.deepEqual(updates('0.9.0', { latest: '0.10.0', history: [{ version: '0.10.0', notes: '新' }, { version: 'invalid' }, { version: '0.9.0' }] }).map((v) => v.version), ['0.10.0']);
});

test('特殊字符、JSON 转义和编码后的凭据均脱敏，只显示前 8 字符', () => {
  const malformed = 'key"\\中文_123456789012345';
  const output = new Output(true, 'login', [TOKEN, malformed]);
  const result = output.sanitize({ token: TOKEN, nested: [malformed, `错误：${malformed}`, encodeURIComponent(malformed)], server: `未注册的 oil_Testothersecretsignature` });
  assert.equal(result.token, `${TOKEN.slice(0, 8)}…`);
  assert.equal(result.nested[0], `${malformed.slice(0, 8)}…`);
  assert(!JSON.stringify(result).includes('123456789012345'));
  assert(!JSON.stringify(result).includes('othersecretsignature'));
});

test('第二处替换中途失败时，两处旧目录的内容和权限都恢复', async (t) => {
  const directory = await temp(t);
  const first = await writeSkill(path.join(directory, 'a'), 'oil-ui', '0.8.0');
  const second = await writeSkill(path.join(directory, 'b'), 'oil-ui', '0.9.0');
  const source = await writeSkill(path.join(directory, 'source'), 'oil-ui', '0.10.0');
  const before = await Promise.all([snapshot(first), snapshot(second)]);
  const renameFile = async (from, to) => {
    if (from.endsWith(`${path.sep}new`) && to === second) throw Object.assign(new Error('injected'), { code: 'EACCES' });
    return rename(from, to);
  };
  await assert.rejects(replaceAll([{ path: first, source, previousName: 'oil-ui' }, { path: second, source, previousName: 'oil-ui' }], { renameFile }), { error: 'replace', code: 1 });
  assert.deepEqual(await snapshot(first), before[0]);
  assert.deepEqual(await snapshot(second), before[1]);
  assert.deepEqual(await readdir(path.join(directory, 'a')), ['oil-ui']);
  assert.deepEqual(await readdir(path.join(directory, 'b')), ['oil-ui']);
});

test('安装 Pro 时移除的免费版也跟随整批操作回滚', async (t) => {
  const directory = await temp(t);
  const root = path.join(directory, 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0', 'custom-free');
  const source = await writeSkill(path.join(directory, 'source'), 'oil-ui-pro', '0.10.0');
  const unknown = await writeSkill(path.join(directory, 'occupied'), 'other', '1.0.0', 'oil-ui-pro');
  const before = await snapshot(free);
  await assert.rejects(replaceAll([
    { path: path.join(root, 'oil-ui-pro'), source, previousName: null },
    { path: free, previousName: 'oil-ui' },
    { path: unknown, source, previousName: null },
  ]), { error: 'occupied' });
  assert.deepEqual(await snapshot(free), before);
  await assert.rejects(access(path.join(root, 'oil-ui-pro')), { code: 'ENOENT' });
});

test('跨用户和项目移除中途失败时，已更新 Pro 和已移除开源版一起还原', async (t) => {
  const directory = await temp(t);
  const user = path.join(directory, 'home', '.claude', 'skills');
  const project = path.join(directory, 'project', '.claude', 'skills');
  const pro = await writeSkill(user, 'oil-ui-pro', '0.8.0');
  const free = await writeSkill(user, 'oil-ui', '0.8.0');
  const projectFree = await writeSkill(project, 'oil-ui', '0.9.0');
  const source = await writeSkill(path.join(directory, 'source'), 'oil-ui-pro', '0.10.0');
  const before = await Promise.all([pro, free, projectFree].map(snapshot));
  const renameFile = async (from, to) => {
    if (from === projectFree) throw new Error('injected removal failure');
    return rename(from, to);
  };
  await assert.rejects(replaceAll([
    { path: pro, source, previousName: 'oil-ui-pro' },
    { path: free, previousName: 'oil-ui', protectSymlinks: true },
    { path: projectFree, previousName: 'oil-ui', protectSymlinks: true },
  ], { renameFile }), { error: 'replace' });
  assert.deepEqual(await Promise.all([pro, free, projectFree].map(snapshot)), before);
  assert.deepEqual((await readdir(user)).sort(), ['oil-ui', 'oil-ui-pro']);
  assert.deepEqual(await readdir(project), ['oil-ui']);
});

test('清理前重查符号链接，途中变成链接时回滚 Pro 并保留链接目标', async (t) => {
  const directory = await temp(t);
  const root = path.join(directory, 'skills');
  const pro = await writeSkill(root, 'oil-ui-pro', '0.8.0');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  const external = path.join(directory, 'external-free');
  const source = await writeSkill(path.join(directory, 'source'), 'oil-ui-pro', '0.10.0');
  const before = await Promise.all([snapshot(pro), snapshot(free)]);
  const renameFile = async (from, to) => {
    if (path.basename(from) === 'new' && to === pro) {
      await rename(free, external);
      await symlink(external, free, 'dir');
    }
    return rename(from, to);
  };
  await assert.rejects(replaceAll([
    { path: pro, source, previousName: 'oil-ui-pro' },
    { path: free, previousName: 'oil-ui', protectSymlinks: true },
  ], { renameFile }), { error: 'symbolic_link' });
  assert.deepEqual(await snapshot(pro), before[0]);
  assert.deepEqual(await snapshot(external), before[1]);
  assert.equal(await readlink(free), external);
});

test('还原本身失败时保留原目录备份，禁止清理掉它', async (t) => {
  const directory = await temp(t);
  const original = await writeSkill(path.join(directory, 'skills'), 'oil-ui', '0.8.0');
  const source = await writeSkill(path.join(directory, 'source'), 'oil-ui', '0.10.0');
  const before = await snapshot(original);
  const renameFile = async (from, to) => {
    if (['new', 'old'].includes(path.basename(from))) throw new Error('injected failure');
    return rename(from, to);
  };
  let recovery;
  await assert.rejects(replaceAll([{ path: original, source, previousName: 'oil-ui' }], { renameFile }), (error) => {
    assert.equal(error.error, 'rollback_failed');
    assert.equal(error.code, 1);
    recovery = error.details.recovery_paths;
    return true;
  });
  // 再直接定位备份，验证失败清理没有删除原文件。
  const stage = (await readdir(path.dirname(original))).find((name) => name.startsWith('.oil-stage-'));
  assert(stage);
  assert.deepEqual(recovery, [path.join(path.dirname(original), stage, 'old')]);
  assert.deepEqual(await snapshot(path.join(path.dirname(original), stage, 'old')), before);
});

test('目标路径互相包含时在任何修改前拒绝', async (t) => {
  const directory = await temp(t);
  const original = await writeSkill(directory, 'oil-ui', '0.8.0');
  const before = await snapshot(original);
  await assert.rejects(replaceAll([{ path: original, previousName: 'oil-ui' }, { path: path.join(original, 'nested'), previousName: null }]), { code: 2, error: 'overlapping_targets' });
  assert.deepEqual(await snapshot(original), before);
});

function tarEntry(name, type = '0', content = '') {
  const header = Buffer.alloc(512), data = Buffer.from(content);
  header.write(name, 0, 100);
  for (const [offset, length, value] of [[100, 8, 0o755], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  header.fill(32, 148, 156); header.write(type, 156, 1); header.write('ustar\0', 257);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

test('预检拒绝绝对路径、../、硬链接和拼接的第二份 tar', async (t) => {
  const directory = await temp(t);
  const good = [tarEntry('oil-ui/', '5'), tarEntry('oil-ui/SKILL.md', '0', 'name: oil-ui')];
  for (const bad of [tarEntry('/tmp/escape'), tarEntry('oil-ui/../../escape'), tarEntry('oil-ui/hard', '1'), tarEntry('oil-ui/link', '2')]) {
    const file = path.join(directory, 'bad.tar.gz');
    await writeFile(file, gzipSync(Buffer.concat([...good, bad, Buffer.alloc(1024)])));
    await assert.rejects(validateArchive(file, 'oil-ui'), { error: 'invalid_archive' });
  }
  const file = path.join(directory, 'appended.tar.gz');
  await writeFile(file, gzipSync(Buffer.concat([...good, Buffer.alloc(1024), tarEntry('oil-ui/hidden'), Buffer.alloc(1024)])));
  await assert.rejects(validateArchive(file, 'oil-ui'), { error: 'invalid_archive' });
});

test('系统 tar 生成的长路径（PAX/ustar）发布物可以通过预检', async (t) => {
  const directory = await temp(t);
  const source = path.join(directory, 'source');
  const skill = await writeSkill(source, 'oil-ui', '0.10.0');
  const deep = path.join(skill, 'assets', 'a'.repeat(150), 'b'.repeat(110));
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, '中文.txt'), '长路径');
  const file = path.join(directory, 'long.tar.gz');
  await promisify(execFile)('tar', ['-czf', file, '-C', source, 'oil-ui'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  await validateArchive(file, 'oil-ui');
});

test('配置位置遵守 XDG、HOME 和 Windows APPDATA；浏览器调用平台原生命令', async () => {
  assert.equal(configPath({ HOME: '/tmp/home' }, 'linux'), path.join('/tmp/home', '.config', 'oil', 'config.json'));
  assert.equal(configPath({ HOME: '/tmp/home', XDG_CONFIG_HOME: '/tmp/config' }, 'darwin'), path.join('/tmp/config', 'oil', 'config.json'));
  assert.equal(configPath({ APPDATA: '/tmp/appdata' }, 'win32'), path.join('/tmp/appdata', 'oil', 'config.json'));
  for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open'], ['win32', 'cmd.exe']]) {
    let called;
    assert.equal(await openBrowser('https://example.com/pay?a=1&b=2', platform, async (...args) => { called = args; }), true);
    assert.equal(called[0], command);
    if (platform === 'win32') {
      assert(called[1].at(-1).startsWith('start '));
      assert.equal(called[2].env.OIL_BROWSER_URL, 'https://example.com/pay?a=1&b=2');
    } else assert.deepEqual(called[1], ['https://example.com/pay?a=1&b=2']);
  }
  assert.equal(await openBrowser('https://example.com', 'linux', async () => { throw new Error(); }), false);
  let browserTimeout;
  await openBrowser('https://example.com', 'linux', async (command, args, options) => { browserTimeout = options.timeout; }, 1000);
  assert.equal(browserTimeout, 1000);
  await assert.rejects(openBrowser('file:///tmp/a'), { error: 'invalid_response' });
});

test('目录接受数组和 products/catalog 外层、Skill 字符串或对象，拒绝路径穿越和重复名称', async () => {
  const { normalizeCatalog, catalogNames } = await import('../src/client.js');
  const entry = { id: 'new-product', name: 'New Product', free: 'new-skill', paid: { skill: 'new-skill-pro' }, prices: {} };
  for (const data of [[entry], { products: [entry] }, { catalog: [entry] }]) {
    assert.deepEqual(catalogNames(normalizeCatalog(data)), ['new-skill', 'new-skill-pro']);
  }
  for (const free of ['../escape', '/absolute', '.', 'bad/name', 'bad\\name']) {
    assert.throws(() => normalizeCatalog([{ ...entry, free }]), { error: 'invalid_response' });
  }
  assert.throws(() => normalizeCatalog([entry, { ...entry, id: 'different-id' }]), { error: 'invalid_response' });
  assert.throws(() => normalizeCatalog({}), { error: 'invalid_response' });
});

test('服务返回的陌生令牌即使带省略号也只能显示前 8 字符', () => {
  const output = new Output(false, 'status');
  assert.equal(output.redact('oil_UnrecognizedSecretToken123…'), 'oil_Unre…');
});

test('替换层在暂存前拒绝开发目录；即使绕过 CLI 也不替换或移除', async (t) => {
  const directory = await temp(t);
  const original = await writeSkill(path.join(directory, 'skills'), 'oil-ui', '0.8.0');
  await mkdir(path.join(original, '.git'));
  const source = await writeSkill(path.join(directory, 'source'), 'oil-ui', '0.10.0');
  const before = await snapshot(original);
  for (const action of [{ path: original, source, previousName: 'oil-ui' }, { path: original, previousName: 'oil-ui' }]) {
    await assert.rejects(replaceAll([action]), { error: 'development_directory' });
    assert.deepEqual(await snapshot(original), before);
    assert.deepEqual(await readdir(path.dirname(original)), ['oil-ui']);
  }
});

test('替换前重查 .git：处理中途出现开发目录时，已完成目标回滚，开发代码保留', async (t) => {
  const directory = await temp(t);
  const first = await writeSkill(path.join(directory, 'a'), 'oil-ui', '0.8.0');
  const second = await writeSkill(path.join(directory, 'b'), 'oil-ui', '0.8.0');
  const source = await writeSkill(path.join(directory, 'source'), 'oil-ui', '0.10.0');
  const firstBefore = await snapshot(first);
  const secondCode = await readFile(path.join(second, 'SKILL.md'), 'utf8');
  const renameFile = async (from, to) => {
    if (from.endsWith(`${path.sep}new`) && to === first) await writeFile(path.join(second, '.git'), 'gitdir: preserved');
    return rename(from, to);
  };
  await assert.rejects(replaceAll([
    { path: first, source, previousName: 'oil-ui' }, { path: second, source, previousName: 'oil-ui' },
  ], { renameFile }), { error: 'development_directory' });
  assert.deepEqual(await snapshot(first), firstBefore);
  assert.equal(await readFile(path.join(second, 'SKILL.md'), 'utf8'), secondCode);
  assert.equal(await readFile(path.join(second, '.git'), 'utf8'), 'gitdir: preserved');
});
