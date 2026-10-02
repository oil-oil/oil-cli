import { lstat, stat, realpath, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { CliError } from './io.js';

export const isSkillName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
export const isVersion = (value) => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

function scalar(value) {
  value = value.trim();
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (!match) return null;
    try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    return match ? match[1].replaceAll("''", "'") : null;
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function inlineVersion(value) {
  // 逗号只在引号和子容器外拆分；允许 metadata 的其他字段。
  const content = value.trim().replace(/\s+#.*$/, '');
  if (!content.startsWith('{') || !content.endsWith('}')) return { count: 0, version: null };
  const fields = [];
  let start = 1, quote = null, depth = 0;
  for (let i = 1; i < content.length - 1; i++) {
    const char = content[i];
    if (quote) {
      if (char === '\\' && quote === '"') { i++; continue; }
      if (char === quote) {
        if (quote === "'" && content[i + 1] === "'") { i++; continue; }
        quote = null;
      }
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === ',' && !depth) { fields.push(content.slice(start, i)); start = i + 1; }
  }
  if (quote || depth) return { count: 0, version: null };
  fields.push(content.slice(start, -1));
  const versions = fields.map((field) => field.match(/^\s*(?:version|"version"|'version')\s*:\s*(.*?)\s*$/)).filter(Boolean);
  return { count: versions.length, version: versions.length === 1 ? scalar(versions[0][1]) : null };
}

// 只读取 frontmatter 的 name 和 metadata.version，不执行 YAML 标签。
export function parseSkill(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/);
  if (!match) return { name: null, version: null };
  let name = null, version = null, metadata = false, childIndent = null, nameCount = 0, metadataCount = 0, versionCount = 0;
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const nameLine = line.match(/^(?:name|"name"|'name')\s*:\s*(.*)$/);
    if (nameLine) { name = scalar(nameLine[1]); nameCount++; }
    const metaLine = line.match(/^(?:metadata|"metadata"|'metadata')\s*:\s*(.*)$/);
    if (metaLine) {
      metadata = !metaLine[1].trim() || metaLine[1].trim().startsWith('#'); metadataCount++; childIndent = null;
      const inline = inlineVersion(metaLine[1]);
      if (inline.count) { version = inline.version; versionCount += inline.count; }
    } else if (/^\S/.test(line)) metadata = false;
    else if (metadata) {
      const indent = line.match(/^ */)[0].length;
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue;
      const versionLine = line.match(/^ +(?:version|"version"|'version')\s*:\s*(.*)$/);
      if (versionLine) { version = scalar(versionLine[1]); versionCount++; }
    }
  }
  return { name: nameCount === 1 ? name : null, version: metadataCount === 1 && versionCount === 1 && isVersion(version) ? version : null };
}

// .git 可以是目录、worktree 的文件或链接；先解析安装路径的软链接。
export async function isDevelopmentDirectory(directory) {
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory()) return false;
    const containsGit = async (current) => {
      const entries = await readdir(current, { withFileTypes: true });
      if (entries.some((entry) => entry.name === '.git')) return true;
      for (const entry of entries) {
        // 内部软链接不属于会被整体删除的内容，不向外遍历。
        if (entry.isDirectory() && await containsGit(path.join(current, entry.name))) return true;
      }
      return false;
    };
    return await containsGit(resolved);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw new CliError(`无法检查开发目录：${directory}`, 1, 'skill_read');
  }
}

export async function inspectSkill(directory, names) {
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory()) return null;
    const file = path.join(resolved, 'SKILL.md');
    if (!(await lstat(file)).isFile()) return null;
    const skill = parseSkill(await readFile(file, 'utf8'));
    return names.includes(skill.name) ? { ...skill, path: directory, real_path: resolved, root: path.dirname(directory), development: await isDevelopmentDirectory(resolved) } : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    if (error instanceof CliError) throw error;
    throw new CliError(`无法读取 Skill 目录：${directory}`, 1, 'skill_read');
  }
}

// 目标可能还没创建，沿父目录解析软链接，用于重复/嵌套目标检查。
export async function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  try { return await realpath(absolute); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(absolute) === absolute) throw error;
    return path.join(await canonicalDirectory(path.dirname(absolute)), path.basename(absolute));
  }
}

export async function uniqueDirectories(directories) {
  const seen = new Set(), result = [];
  for (const directory of directories) {
    const resolved = await canonicalDirectory(directory);
    if (!seen.has(resolved)) { result.push(directory); seen.add(resolved); }
  }
  return result;
}

// 安装目标只检测用户的 Agent 目录，不把当前项目的目录当作默认目标。
export async function installationRoots() {
  const home = process.env.HOME || homedir();
  const roots = [];
  for (const agent of ['claude', 'codex', 'cursor', 'agents']) {
    const directory = path.join(home, `.${agent}`);
    const root = path.join(directory, 'skills');
    try {
      if ((await stat(agent === 'agents' ? root : directory)).isDirectory()) roots.push(root);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new CliError(`无法检测 Agent 目录：${directory}`, 1, 'skill_read');
    }
  }
  return roots;
}

export function resolveDirectory(value) {
  const home = process.env.HOME || homedir();
  if (value === '~') return home;
  if (/^~[/\\]/.test(value)) return path.resolve(home, value.slice(2));
  return path.resolve(value);
}

export function discoveryRoots() {
  const home = process.env.HOME || homedir();
  return [...new Set([
    ...['claude', 'codex', 'agents', 'cursor'].map((agent) => path.join(home, `.${agent}`, 'skills')),
    ...['claude', 'agents', 'codex'].map((agent) => path.resolve(`.${agent}`, 'skills')),
  ])];
}

export function targetRoot(value) {
  const home = process.env.HOME || homedir();
  if (['claude', 'codex', 'agents', 'cursor'].includes(value)) return path.join(home, `.${value}`, 'skills');
  return resolveDirectory(value);
}

export async function scan(names, roots = discoveryRoots()) {
  const found = [];
  for (const root of [...new Set(roots)]) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new CliError(`无法扫描目录：${root}`, 1, 'skill_read');
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = await inspectSkill(path.join(root, entry.name), names);
      if (skill) found.push(skill);
    }
  }
  return found;
}

export function compare(a, b) {
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}

export function updates(current, release) {
  return release.history.filter((item) => isVersion(item.version) && (!current || compare(item.version, current) > 0) && compare(item.version, release.latest) <= 0)
    .sort((a, b) => compare(a.version, b.version))
    .map(({ version, published_at, notes }) => ({ version, published_at, notes: typeof notes === 'string' ? notes : '' }));
}

export function conflicts(installed, catalog) {
  return catalog.filter((product) => product.free && product.paid).flatMap((product) =>
    [...new Set(installed.map((i) => i.root))]
      .filter((root) => [product.free.skill, product.paid.skill].every((name) => installed.some((i) => i.root === root && i.name === name)))
      .map((root) => `${root}：${product.free.skill} 和 ${product.paid.skill} 两个版本同时装会抢着接同一类请求`));
}
