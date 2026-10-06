import { t } from './i18n.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './io.js';
import { inspectSkill, isDevelopmentDirectory, isLinkedInstallation, logicalDirectory } from './skills.js';
import { tarInvocation, directoryKey } from './platform.js';

const exec = promisify(execFile);
const archiveError = () => new CliError(t('invalidArchive'), 1, 'invalid_archive');
const string = (buffer) => buffer.toString('utf8').split('\0')[0];

function tarNumber(buffer) {
  // GNU base-256 与标准八进制。
  if (buffer[0] & 0x80) {
    if (buffer[0] !== 0x80) throw archiveError();
    let value = 0n;
    for (const byte of buffer.subarray(1)) value = value * 256n + BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError();
    return Number(value);
  }
  const text = string(buffer).trim();
  if (!/^[0-7]+$/.test(text)) throw archiveError();
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw archiveError();
  return value;
}

function paxFields(buffer) {
  const fields = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) throw archiveError();
    const sizeText = buffer.subarray(offset, space).toString();
    if (!/^[1-9]\d*$/.test(sizeText)) throw archiveError();
    const size = Number(sizeText), end = offset + size;
    if (!Number.isSafeInteger(size) || end > buffer.length || end <= space + 1 || buffer[end - 1] !== 10) throw archiveError();
    const record = buffer.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) throw archiveError();
    const key = record.slice(0, equals);
    // 不接受会改变数据布局或链接行为的扩展。
    if (key === 'size' || key === 'linkpath' || /sparse/i.test(key)) throw archiveError();
    fields[key] = record.slice(equals + 1);
    offset = end;
  }
  return fields;
}

// 在系统 tar 解压前流式检查所有实际条目，避免路径穿越及软/硬链接。
export async function validateArchive(file, name, platform = process.platform) {
  const input = createReadStream(file);
  const unzip = createGunzip();
  input.on('error', (error) => unzip.destroy(error));
  input.pipe(unzip);
  let buffer = Buffer.alloc(0), remaining = 0, padding = 0, metaType = null, meta = [], extended = {}, longName = null;
  let ended = false, count = 0, hasSkill = false;
  const windowsEntries = new Set();
  try {
    for await (const chunk of unzip) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (ended) {
          if (buffer.some((byte) => byte !== 0)) throw archiveError();
          buffer = Buffer.alloc(0); break;
        }
        if (remaining) {
          const amount = Math.min(remaining, buffer.length);
          if (metaType) meta.push(buffer.subarray(0, amount));
          buffer = buffer.subarray(amount); remaining -= amount;
          if (remaining) break;
          if (metaType) {
            const payload = Buffer.concat(meta);
            if (metaType === 'L') longName = string(payload).replace(/\n$/, '');
            else {
              const fields = paxFields(payload);
              if (metaType === 'g' && fields.path) throw archiveError();
              if (metaType === 'x') extended = { ...extended, ...fields };
            }
            metaType = null; meta = [];
          }
        }
        if (padding) {
          const amount = Math.min(padding, buffer.length);
          buffer = buffer.subarray(amount); padding -= amount;
          if (padding) break;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) { ended = true; continue; }
        const checksum = tarNumber(header.subarray(148, 156));
        const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (checksum !== sum) throw archiveError();
        const size = tarNumber(header.subarray(124, 136));
        const type = String.fromCharCode(header[156] || 48);
        remaining = size; padding = (512 - size % 512) % 512;
        if (['x', 'g', 'L'].includes(type)) {
          if (size === 0 || size > 1024 * 1024) throw archiveError();
          metaType = type; continue;
        }
        if (!['0', '5'].includes(type)) throw archiveError();
        let entry = string(header.subarray(0, 100));
        const prefix = string(header.subarray(345, 500));
        if (prefix && string(header.subarray(257, 263)) === 'ustar') entry = `${prefix}/${entry}`;
        entry = extended.path || longName || entry;
        extended = {}; longName = null;
        while (entry.startsWith('./')) entry = entry.slice(2);
        const parts = entry.replace(/\/$/, '').split('/');
        if (!entry || entry.includes('\\') || /[\0\r\n]/.test(entry) || parts[0] !== name || parts.some((part) => !part || part === '..' || part === '.') || (parts.length === 1 && type !== '5')) throw archiveError();
        if (platform === 'win32') {
          // 拒绝盘符/ADS、设备名、尾部点空格和大小写碰撞，避免 Windows 把不同条目映射到同一路径。
          if (parts.some((part) => /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw archiveError();
          const key = parts.join('/').toLowerCase();
          if (windowsEntries.has(key)) throw archiveError();
          windowsEntries.add(key);
        }
        if (type === '5' && size !== 0) throw archiveError();
        if (entry === `${name}/SKILL.md` && type === '0') hasSkill = true;
        count++;
      }
    }
    if (remaining || padding || buffer.length || !ended || !count || !hasSkill || metaType || longName || Object.keys(extended).length) throw archiveError();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw archiveError();
  } finally { input.destroy(); unzip.destroy(); }
}

async function checkTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await checkTree(path.join(directory, entry.name));
    else if (!entry.isFile()) throw archiveError();
  }
}

export async function prepare(client, name, release, token, paid, product, signal) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'oil-download-'));
  let dispose, response;
  try {
    if (paid && !token) throw new CliError(t('loginRequired'), 3, 'unauthorized');
    const route = `/api/store/download/${encodeURIComponent(name)}?version=${encodeURIComponent(release.latest)}&format=tar.gz`;
    const download = await client.request(route, { token: paid ? token : undefined, download: true, skill: name, product });
    dispose = download.dispose;
    response = download.response;
    // 免费下载的 302 响应头不会保留，使用 versions 给出的摘要。
    const expected = paid ? response.headers.get('X-Content-SHA256') : release.sha256 || response.headers.get('X-Content-SHA256');
    if (!/^[a-fA-F0-9]{64}$/.test(expected || '')) throw new CliError(t('missingChecksum'), 1, 'missing_checksum');
    const headerVersion = response.headers.get('X-Skill-Version');
    if ((paid || headerVersion) && headerVersion !== release.latest) throw new CliError(t('versionMismatch'), 1, 'version_mismatch');
    const archive = path.join(temporary, 'release.tar.gz');
    const hash = createHash('sha256');
    const hashing = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(Readable.fromWeb(download.response.body), hashing, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    } catch { throw new CliError(signal.aborted ? t('canceled') : t('downloadFailed'), 1, signal.aborted ? 'cancelled' : 'download'); }
    if (hash.digest('hex') !== expected.toLowerCase()) throw new CliError(t('checksumMismatch'), 1, 'checksum_mismatch');
    await validateArchive(archive, name);
    const extracted = path.join(temporary, 'extracted');
    await mkdir(extracted);
    const tar = tarInvocation(archive, extracted);
    try { await exec(tar.command, tar.args, { cwd: tar.cwd, timeout: 60_000, maxBuffer: 1024 * 1024, signal }); }
    catch { throw new CliError(t('extractFailed'), 1, 'extract'); }
    const entries = await readdir(extracted);
    if (entries.length !== 1 || entries[0] !== name) throw archiveError();
    const source = path.join(extracted, name);
    await checkTree(source);
    const skill = await inspectSkill(source, [name]);
    if (!skill || skill.name !== name || skill.version !== release.latest) throw new CliError(t('packageMismatch'), 1, 'skill_mismatch');
    return { name, version: release.latest, source, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    dispose?.();
  }
}

async function exists(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// 在目标文件系统上暂存新目录和备份，跨多个目标一起提交或回滚。
// action.link 表示在 path 放一个指向主安装的目录链接（Windows 用 junction），而不是复制一份。
// renameFile、linkDirectory 可供测试注入真实的中途失败；CLI 使用系统调用。
const systemLink = (target, directory) => symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
export async function replaceAll(actions, { renameFile = rename, linkDirectory = systemLink, signal, names = [] } = {}) {
  // 在暂存前检查整批目标；在每次 rename 前再检查，防止下载期间变成开发目录。
  const protect = async (action) => {
    const directory = action.path;
    if (action.protectSymlinks && await isLinkedInstallation(directory)) throw new CliError(t('skippedSymbolicLink', { name: action.previousName, path: directory }), 1, 'symbolic_link', { path: directory });
    if (await isDevelopmentDirectory(directory)) throw new CliError(t('developmentProtected', { path: directory }), 1, 'development_directory', { path: directory });
  };
  for (const action of actions) await protect(action);
  const paths = await Promise.all(actions.map(async (action) => directoryKey(await logicalDirectory(action.path))));
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const relative = path.relative(paths[i], paths[j]);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new CliError(t('overlappingTargets'), 2, 'overlapping_targets');
    }
  }
  const transactions = [];
  const staging = [];
  let committed = false;
  const warnings = [];
  try {
    for (const action of actions) {
      if (signal?.aborted) throw new CliError(t('canceled'), 1, 'cancelled');
      await mkdir(path.dirname(action.path), { recursive: true });
      const stage = await mkdtemp(path.join(path.dirname(action.path), '.oil-stage-'));
      staging.push(stage);
      const transaction = { ...action, stage, backup: path.join(stage, 'old'), incoming: path.join(stage, 'new'), movedOld: false, movedNew: false };
      transactions.push(transaction);
      if (action.source) await cp(action.source, transaction.incoming, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    }
    for (const transaction of transactions) {
      if (signal?.aborted) throw new CliError(t('canceled'), 1, 'cancelled');
      await protect(transaction);
      const info = await exists(transaction.path);
      const current = info ? await inspectSkill(transaction.path, names) : null;
      if (current?.development) throw new CliError(t('developmentProtected', { path: transaction.path }), 1, 'development_directory', { path: transaction.path });
      if (info && (!current || current.name !== transaction.previousName)) throw new CliError(t('occupied', { path: transaction.path }), 1, 'occupied');
      if (!info && transaction.previousName) throw new CliError(t('changed', { path: transaction.path }), 1, 'changed');
      if (info) {
        await renameFile(transaction.path, transaction.backup);
        transaction.movedOld = true;
      }
      if (transaction.source) {
        transaction.incomingInfo = await lstat(transaction.incoming);
        await renameFile(transaction.incoming, transaction.path);
        transaction.movedNew = true;
      } else if (transaction.link) {
        await linkDirectory(path.resolve(transaction.link), transaction.path);
        transaction.incomingInfo = await lstat(transaction.path);
        transaction.movedNew = true;
      }
    }
    committed = true;
  } catch (error) {
    const recovery = [];
    for (const transaction of [...transactions].reverse()) {
      try {
        if (transaction.movedNew) {
          const current = await exists(transaction.path);
          if (current && (current.dev !== transaction.incomingInfo.dev || current.ino !== transaction.incomingInfo.ino)) throw new Error('destination changed');
          await rm(transaction.path, { recursive: true, force: true });
        }
        if (transaction.movedOld && await exists(transaction.path)) throw new Error('destination occupied');
        if (transaction.movedOld) await renameFile(transaction.backup, transaction.path);
      } catch { recovery.push(transaction.movedOld ? transaction.backup : transaction.path); }
    }
    if (recovery.length) {
      throw new CliError(t('rollbackFailed'), 1, 'rollback_failed', { recovery_paths: recovery });
    }
    if (error instanceof CliError) throw error;
    throw new CliError(t('replaceFailed'), 1, 'replace');
  } finally {
    for (const stage of staging) {
      // 回滚失败的备份绝不能在清理时删除。
      if (!committed && await exists(path.join(stage, 'old'))) continue;
      try { await rm(stage, { recursive: true, force: true }); }
      catch { warnings.push(t('cleanupWarning', { path: stage })); }
    }
  }
  return warnings;
}
