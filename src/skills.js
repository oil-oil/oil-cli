import { t, skillLabel } from './i18n.js';
import { lstat, stat, realpath, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './io.js';
import { pathsFor, userHome, directoryKey } from './platform.js';

const agents = ['claude', 'codex', 'agents', 'cursor', 'workbuddy'];
const projectAgents = ['claude', 'agents', 'codex'];

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
      if (entries.some((entry) => (process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) === '.git')) return true;
      for (const entry of entries) {
        // 内部软链接不属于会被整体删除的内容，不向外遍历。
        if (entry.isDirectory() && await containsGit(path.join(current, entry.name))) return true;
      }
      return false;
    };
    return await containsGit(resolved);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw new CliError(t('developmentRead', { path: directory }), 1, 'skill_read');
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
    throw new CliError(t('skillRead', { path: directory }), 1, 'skill_read');
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

// 只解析父目录：Skill 目录本身可能是指向主安装的链接，不能和主安装算成同一路径。
export async function logicalDirectory(directory) {
  const absolute = path.resolve(directory);
  return path.join(await canonicalDirectory(path.dirname(absolute)), path.basename(absolute));
}

export async function uniqueDirectories(directories) {
  const seen = new Set(), result = [];
  for (const directory of directories) {
    const resolved = directoryKey(await canonicalDirectory(directory));
    if (!seen.has(resolved)) { result.push(directory); seen.add(resolved); }
  }
  return result;
}

// 安装目标只检测用户的 Agent 目录，不把当前项目的目录当作默认目标。
// 第一个是主安装（优先 Claude），其余 Agent 用链接共享它；~/.agents 只在 --to agents 时使用。
export async function installationRoots() {
  const roots = [];
  for (const agent of ['claude', 'codex', 'cursor', 'workbuddy']) {
    const root = targetRoot(agent);
    const directory = path.dirname(root);
    try {
      if ((await stat(directory)).isDirectory()) roots.push(root);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new CliError(t('agentRead', { path: directory }), 1, 'skill_read');
    }
  }
  return roots;
}

export function resolveDirectory(value, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const home = userHome(env, platform), paths = pathsFor(platform);
  if (value === '~') return home;
  if (/^~[/\\]/.test(value)) return paths.resolve(home, value.slice(2));
  return paths.resolve(cwd, value);
}

export function discoveryRoots(env = process.env, platform = process.platform, cwd = process.cwd()) {
  return [...new Set([
    ...agents.map((agent) => targetRoot(agent, env, platform, cwd)),
    ...projectAgents.map((agent) => pathsFor(platform).resolve(cwd, `.${agent}`, 'skills')),
  ])];
}

export function targetRoot(value, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const home = userHome(env, platform), paths = pathsFor(platform);
  if (value === 'codex' && env.CODEX_HOME) return paths.join(resolveDirectory(env.CODEX_HOME, env, platform, cwd), 'skills');
  if (agents.includes(value)) return paths.join(home, `.${value}`, 'skills');
  return resolveDirectory(value, env, platform, cwd);
}

function agentRootGroups() {
  return agents.map((agent) => [
    targetRoot(agent), ...(projectAgents.includes(agent) ? [path.resolve(`.${agent}`, 'skills')] : []),
  ]);
}

// 显式路径也按宿主识别；无法归属的自定义目录只清理自身。
export async function sameAgentRoots(directory) {
  const groups = agentRootGroups();
  // 先按逻辑位置归属宿主，避免多个宿主的链接指向同一目录时误选宿主。
  const exact = groups.find((roots) => roots.some((root) => directoryKey(root, process.platform, null) === directoryKey(directory, process.platform, null)));
  if (exact) return [...new Set([directory, ...exact])];
  const resolved = directoryKey(await canonicalDirectory(directory));
  const matches = [];
  for (const roots of groups) {
    if ((await Promise.all(roots.map(async (root) => directoryKey(await canonicalDirectory(root))))).includes(resolved)) matches.push(roots);
  }
  return [...new Set([directory, ...(matches.length === 1 ? matches[0] : [])])];
}

// 保护 Skill 本身、skills 目录及其宿主目录上的软链接；不把系统路径别名当作安装链接。
const installationParents = (root) => [root, ...(path.basename(root).toLowerCase() === 'skills' ? [path.dirname(root)] : [])];
async function hasDirectoryLink(directories) {
  for (const current of directories) {
    try { if ((await lstat(current)).isSymbolicLink()) return true; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new CliError(t('skillRead', { path: current }), 1, 'skill_read');
    }
  }
  return false;
}
export const isLinkedInstallation = (directory) => hasDirectoryLink([directory, ...installationParents(path.dirname(directory))]);

// 与版本扫描分开：不能因 real_path 去重而漏报软链接或未知同名目录。
export async function freeReplacements(name, roots) {
  const candidates = [], skipped = [], linkedTargets = new Set(), seenRoots = new Set();
  for (const root of [...new Set(roots)]) {
    // 普通路径别名去重，但软链接作用域必须保留，才能保护它指向的真实安装。
    const linkedRoot = await hasDirectoryLink(installationParents(root));
    const resolved = directoryKey(await canonicalDirectory(root));
    if (!linkedRoot && seenRoots.has(resolved)) continue;
    if (!linkedRoot) seenRoots.add(resolved);
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw new CliError(t('scanRead', { path: root }), 1, 'skill_read');
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const directory = path.join(root, entry.name);
      const item = await inspectSkill(directory, [name]);
      if (!item && (process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) !== name) continue;
      const candidate = item || { name, path: directory };
      if (await isLinkedInstallation(directory)) {
        if (item) linkedTargets.add(directoryKey(item.real_path));
        skipped.push({ name, path: directory, reason: 'symbolic_link' });
      } else if (item?.development || (!item && await isDevelopmentDirectory(directory))) {
        skipped.push({ name, path: directory, reason: 'development_directory' });
      } else if (!item) skipped.push({ name, path: directory, reason: 'unrecognized_skill' });
      else candidates.push(candidate);
    }
  }
  const removable = candidates.filter((item) => {
    if (!linkedTargets.has(directoryKey(item.real_path))) return true;
    skipped.push({ name, path: item.path, reason: 'symbolic_link' });
    return false;
  });
  return { removable, skipped };
}

export async function scan(names, roots = discoveryRoots()) {
  // 同一目录可能经由不同路径（符号链接、/var 与 /private/var）被扫到两次，只保留一份。
  const found = [], seen = new Set();
  for (const root of [...new Set(roots)]) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw new CliError(t('scanRead', { path: root }), 1, 'skill_read');
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = await inspectSkill(path.join(root, entry.name), names);
      if (skill && !seen.has(directoryKey(skill.real_path))) { seen.add(directoryKey(skill.real_path)); found.push(skill); }
    }
  }
  return found;
}

// scan 已按真实路径去重，同名的多条记录就是多份互不相干的副本。
// 只看用户级 Agent 目录：项目里的 .claude/skills 是有意的局部安装；开发目录也不算。
export function duplicateCopies(found, env = process.env, platform = process.platform) {
  const userRoots = new Set(agents.map((agent) => directoryKey(targetRoot(agent, env, platform), platform, null)));
  const groups = new Map();
  for (const item of found.filter((item) => !item.development && userRoots.has(directoryKey(item.root, platform, null)))) groups.set(item.name, [...(groups.get(item.name) || []), item.path]);
  return [...groups].filter(([, paths]) => paths.length > 1).map(([name, paths]) => ({ name, paths }));
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

export async function conflicts(installed, catalog) {
  const warnings = [];
  for (const product of catalog.filter((product) => product.free && product.paid)) {
    const seen = new Set();
    for (const pro of installed.filter((item) => item.name === product.paid.skill)) {
      const roots = product.paid.skill === 'oil-ui-pro' ? await sameAgentRoots(pro.root) : [pro.root];
      const canonical = [...new Set(await Promise.all(roots.map(async (root) => directoryKey(await canonicalDirectory(root)))))];
      const key = [...canonical].sort().join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      for (const free of installed.filter((item) => item.name === product.free.skill)) {
        if (!canonical.includes(directoryKey(await canonicalDirectory(free.root)))) continue;
        warnings.push(t('conflict', { prefix: `${pro.root}: `, free: skillLabel(product.free.skill), paid: skillLabel(product.paid.skill) }));
        break;
      }
    }
  }
  return warnings;
}
