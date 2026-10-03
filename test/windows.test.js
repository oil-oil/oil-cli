import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { userHome, directoryKey, tarInvocation, restrictPermissions } from '../src/platform.js';
import { targetRoot, resolveDirectory, discoveryRoots, parseSkill } from '../src/skills.js';
import { configPath } from '../src/config.js';
import { formatCommand } from '../src/i18n.js';
import { openBrowser } from '../src/browser.js';
import { replaceAll, validateArchive } from '../src/install.js';
import { fixture, writeSkill, snapshot, TOKEN } from './fixture.js';

const exec = promisify(execFile);
const windows = { USERPROFILE: 'C:\\Users\\中文 user', HOME: 'D:\\Git Home', APPDATA: 'C:\\Users\\中文 user\\AppData\\Roaming' };

test('Windows 主目录优先 USERPROFILE，再 HOME；POSIX 优先 HOME', () => {
  assert.equal(userHome(windows, 'win32'), windows.USERPROFILE);
  assert.equal(userHome({ HOME: windows.HOME }, 'win32'), windows.HOME);
  assert.equal(userHome(windows, 'darwin'), windows.HOME);
  assert.equal(resolveDirectory('~', windows, 'win32'), windows.USERPROFILE);
  assert.equal(resolveDirectory('~/.workbuddy/skills', windows, 'win32'), `${windows.USERPROFILE}\\.workbuddy\\skills`);
  assert.equal(resolveDirectory('~\\.claude\\skills', windows, 'win32'), `${windows.USERPROFILE}\\.claude\\skills`);
  assert.equal(resolveDirectory('custom skills', windows, 'win32', 'D:\\Project'), 'D:\\Project\\custom skills');
  for (const agent of ['claude', 'codex', 'agents', 'cursor', 'workbuddy']) assert.equal(targetRoot(agent, windows, 'win32'), `${windows.USERPROFILE}\\.${agent}\\skills`);
});

test('Windows CODEX_HOME 支持跨盘、UNC、~ 和相对目录，配置固定使用 APPDATA', () => {
  for (const [value, expected] of [
    ['D:\\Custom Codex', 'D:\\Custom Codex\\skills'],
    ['\\\\server\\share\\codex', '\\\\server\\share\\codex\\skills'],
    ['~/codex', `${windows.USERPROFILE}\\codex\\skills`],
    ['.codex-home', 'D:\\Project\\.codex-home\\skills'],
  ]) assert.equal(targetRoot('codex', { ...windows, CODEX_HOME: value }, 'win32', 'D:\\Project'), expected);
  assert.equal(configPath({ ...windows, XDG_CONFIG_HOME: 'D:\\ignored' }, 'win32'), `${windows.APPDATA}\\oil\\config.json`);
  assert.throws(() => configPath({ USERPROFILE: windows.USERPROFILE }, 'win32'), { error: 'failed' });
});

test('Windows 扫描范围包含五个用户目录和三个项目目录，WorkBuddy 仅用户级', () => {
  const roots = discoveryRoots(windows, 'win32', 'D:\\Project');
  assert.equal(roots.length, 8);
  assert(roots.includes(`${windows.USERPROFILE}\\.workbuddy\\skills`));
  assert(roots.includes('D:\\Project\\.codex\\skills'));
  assert(!roots.includes('D:\\Project\\.workbuddy\\skills'));
  assert(!roots.includes('D:\\Project\\.cursor\\skills'));
});

test('Windows 路径比较统一大小写、/ 和扩展路径前缀，POSIX 保留大小写', () => {
  assert.equal(directoryKey('C:/Users/Test/.Claude/SKILLS/../skills', 'win32'), directoryKey('c:\\users\\test\\.claude\\skills', 'win32'));
  assert.equal(directoryKey('\\\\?\\C:\\Users\\Test\\skills', 'win32'), directoryKey('c:/users/test/skills', 'win32'));
  assert.equal(directoryKey('\\\\?\\UNC\\Server\\Share\\Skills', 'win32'), directoryKey('\\\\server\\share\\skills', 'win32'));
  assert.notEqual(directoryKey('/tmp/Skills', 'linux'), directoryKey('/tmp/skills', 'linux'));
});

test('POSIX 设置 0600 并保留错误，Windows 沿用 ACL 不调用 chmod', async () => {
  const calls = [];
  const change = async (...args) => calls.push(args);
  await restrictPermissions('config.json', 'linux', change);
  await restrictPermissions('config.json', 'darwin', change);
  await restrictPermissions('config.json', 'win32', async () => { throw new Error('must not chmod'); });
  assert.deepEqual(calls, [['config.json', 0o600], ['config.json', 0o600]]);
  await assert.rejects(restrictPermissions('config.json', 'linux', async () => { throw new Error('permission denied'); }), /permission denied/);
});

test('tar.exe 用相对归档名和原始参数，支持 C 盘下载解压到 D 盘，不传 --force-local', () => {
  const invocation = tarInvocation('C:\\Temp & 中文\\release.tar.gz', 'D:\\Target skills\\extracted', 'win32', { SystemRoot: 'C:\\Windows' });
  assert.deepEqual(invocation, { command: 'C:\\Windows\\System32\\tar.exe', args: ['-xzf', 'release.tar.gz', '-C', 'D:\\Target skills\\extracted'], cwd: 'C:\\Temp & 中文' });
  assert(!invocation.args.includes('--force-local'));
  assert.equal(tarInvocation('C:\\Temp\\release.tar.gz', 'C:\\Temp\\out', 'win32', {}).command, 'tar.exe');
  assert.deepEqual(tarInvocation('/tmp/release.tar.gz', '/tmp/out', 'linux'), { command: 'tar', args: ['-xzf', 'release.tar.gz', '-C', '/tmp/out'], cwd: '/tmp' });
});

test('Windows 浏览器命令保持固定，URL 的 &、%、!、^ 和引号通过环境变量传递', async () => {
  const value = 'https://example.com/pay?a=1&b=%PATH%&bang=!TEMP!&caret=^&paren=()&quote="';
  let called;
  assert.equal(await openBrowser(value, 'win32', async (...args) => { called = args; }), true);
  assert.equal(called[0], 'cmd.exe');
  assert.deepEqual(called[1], ['/d', '/v:off', '/s', '/c', '"start "" "%OIL_BROWSER_URL%""']);
  assert.equal(called[2].windowsVerbatimArguments, true);
  assert.equal(called[2].env.OIL_BROWSER_URL, new URL(value).href);
  assert(!called[1].some((arg) => arg.includes('example.com')));
  assert.equal(await openBrowser(value, 'win32', async () => { throw new Error('no browser'); }), false);
});

test('Windows 可复制命令按 PowerShell 保留盘符、空格、单引号和 shell 字符', () => {
  const location = "C:\\Users\\O'Neil & 100% !\\skills\\oil-ui-pro";
  const command = formatCommand(['update', 'oil-ui-pro', '--path', location, '--json'], 'win32');
  assert.equal(command, "npx github:oil-oil/oil-cli update oil-ui-pro --path 'C:\\Users\\O''Neil & 100% !\\skills\\oil-ui-pro' --json");
  assert.equal(formatCommand(['update', '--path', "/home/O'Neil/skills"], 'linux'), "npx github:oil-oil/oil-cli update --path '/home/O'\\''Neil/skills'");
});

test('BOM 和 CRLF 的 SKILL.md 可解析并参与 status/update', async (t) => {
  const f = await fixture(t);
  const directory = await writeSkill(path.join(f.home, '.workbuddy', 'skills'), 'oil-ui', '0.8.0');
  const text = '\uFEFF---\r\nname: "oil-ui"\r\nmetadata:\r\n  version: "0.8.0"\r\n---\r\n# Skill\r\n';
  assert.deepEqual(parseSkill(text), { name: 'oil-ui', version: '0.8.0' });
  await writeFile(path.join(directory, 'SKILL.md'), text);
  const status = await f.run(['status', '--json']);
  assert.equal(status.code, 0, status.stdout);
  assert.equal(JSON.parse(status.stdout).installations[0].current, '0.8.0');
  const update = await f.run(['update', 'oil-ui', '--json']);
  assert.equal(update.code, 0, update.stdout);
  assert.equal(JSON.parse(update.stdout).updated_count, 1);
});

function tarEntry(name, type = '0', content = '') {
  const header = Buffer.alloc(512), data = Buffer.from(content);
  header.write(name, 0, 100);
  for (const [offset, length, value] of [[100, 8, 0o755], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  header.fill(32, 148, 156); header.write(type, 156, 1); header.write('ustar\0', 257);
  header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

test('Windows 归档预检拒绝盘符、ADS、设备名、尾部点空格和大小写碰撞', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'oil-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const good = [tarEntry('oil-ui/', '5'), tarEntry('oil-ui/SKILL.md', '0', 'skill')];
  for (const bad of ['C:/escape', 'oil-ui/C:/escape', 'oil-ui/file:stream', 'oil-ui/CON.txt', 'oil-ui/nul', 'oil-ui/LPT1', 'oil-ui/file.', 'oil-ui/file ', 'oil-ui/skill.MD']) {
    const file = path.join(directory, 'bad.tar.gz');
    await writeFile(file, gzipSync(Buffer.concat([...good, tarEntry(bad), Buffer.alloc(1024)])));
    await assert.rejects(validateArchive(file, 'oil-ui', 'win32'), { error: 'invalid_archive' });
  }
  const file = path.join(directory, 'good.tar.gz');
  await writeFile(file, gzipSync(Buffer.concat([...good, tarEntry('oil-ui/assets/example.txt'), Buffer.alloc(1024)])));
  await validateArchive(file, 'oil-ui', 'win32');
});

test('EXDEV 替换失败时整批还原，rename 只使用各目标旁的暂存目录', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'oil-volume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await writeSkill(path.join(directory, 'volume-a', 'skills'), 'oil-ui', '0.8.0');
  const second = await writeSkill(path.join(directory, 'volume-b', 'skills'), 'oil-ui', '0.8.0');
  const source = await writeSkill(path.join(directory, 'download-volume'), 'oil-ui', '0.10.0');
  const before = await Promise.all([first, second].map(snapshot));
  const renameFile = async (from, to) => {
    assert.notEqual(from, source);
    assert.notEqual(to, source);
    const original = [first, second].find((location) => from === location || to === location);
    assert(original, `${from} -> ${to}`);
    const stage = from === original ? path.dirname(to) : path.dirname(from);
    assert.equal(path.dirname(stage), path.dirname(original));
    if (path.basename(from) === 'new' && to === second) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    return rename(from, to);
  };
  await assert.rejects(replaceAll([{ path: first, source, previousName: 'oil-ui' }, { path: second, source, previousName: 'oil-ui' }], { renameFile, names: ['oil-ui'] }), { error: 'replace' });
  assert.deepEqual(await Promise.all([first, second].map(snapshot)), before);
  for (const original of [first, second]) assert.deepEqual(await readdir(path.dirname(original)), ['oil-ui']);
});

test('Windows 真 cmd.exe 保留 URL 参数中的 &、%、! 和 ^', { skip: process.platform !== 'win32' }, async () => {
  const value = 'https://example.com/?a=1&b=2&pct=%OIL_CMD_PROBE%&bang=!OIL_CMD_PROBE!&caret=^&paren=()';
  let output;
  const opened = await openBrowser(value, 'win32', async (command, args, options) => {
    args = [...args.slice(0, -1), args.at(-1).replace('start ""', 'echo')];
    output = await exec(process.env.ComSpec || command, args, { ...options, env: { ...options.env, OIL_CMD_PROBE: 'expanded' } });
  });
  assert.equal(opened, true);
  assert.equal(output.stdout.trim(), `"${new URL(value).href}"`);
});

test('Windows 自动化通过 cmd.exe 调用实际的 npx.cmd', { skip: process.platform !== 'win32' }, async () => {
  const result = await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', '"npx.cmd --version"'], { windowsVerbatimArguments: true, windowsHide: true });
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('Windows 大小写路径识别同宿主，保护无法识别的 OIL-UI 目录', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.workbuddy', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0', 'renamed-free');
  const unknown = await writeSkill(root, 'unknown', '1.0.0', 'OIL-UI');
  const before = await snapshot(unknown);
  const result = await f.run(['install', 'oil-ui-pro', '--to', root.toUpperCase(), '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.removed.map((value) => directoryKey(value)), [directoryKey(free)]);
  assert.deepEqual(data.skipped.map((item) => item.reason), ['unrecognized_skill']);
  assert.deepEqual(await snapshot(unknown), before);
  await assert.rejects(access(free), { code: 'ENOENT' });
});

test('Windows 跨实际盘符复制发布物，各盘目标原地暂存并替换', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'oil-cross-volume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (directoryKey(path.parse(directory).root) === directoryKey(path.parse(process.cwd()).root)) {
    t.skip('TEMP 和工作区在同一盘，需不同盘符环境验证');
    return;
  }
  const target = await mkdtemp(path.join(process.cwd(), '.oil-cross-volume-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const source = await writeSkill(directory, 'oil-ui', '0.10.0');
  const original = await writeSkill(target, 'oil-ui', '0.8.0');
  await replaceAll([{ path: original, source, previousName: 'oil-ui' }], { names: ['oil-ui'] });
  assert.match(await readFile(path.join(original, 'SKILL.md'), 'utf8'), /0\.10\.0/);
  assert.deepEqual(await readdir(target), ['oil-ui']);
});
