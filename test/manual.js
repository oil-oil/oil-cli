import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fixture, writeSkill } from './fixture.js';

const f = await fixture();
try {
  f.state.requireApproval = true;
  await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-ui', '0.8.0');
  const development = await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-doc-pro', '0.8.0');
  await mkdir(path.join(development, '.git'));
  const paid = path.join(f.home, '.codex', 'skills', 'oil-ui-pro');
  for (const args of [
    ['login'],
    ['status'],
    ['list'],
    ['install', 'oil-ui-pro'],
    ['update'],
    ['update', '--path', paid],
    ['logout'],
  ]) {
    if (args[0] === 'update') f.state.latest = '0.11.0';
    process.stdout.write(`$ oil ${args.join(' ').replaceAll(f.temporary, '<临时目录>')}\n`);
    const result = await f.run(args, { OIL_TEST_BROWSER: 'approve' }, { real: true });
    // 报告保留输出内容，将每次运行不同的临时路径、端口统一为可读占位符。
    const output = (result.stdout + result.stderr).replaceAll(f.temporary, '<临时目录>').replaceAll(f.base, '<假服务>');
    process.stdout.write(output + `退出码：${result.code}\n\n`);
    if (result.code !== 0) throw new Error('手动运行失败');
  }
  if (!f.state.deviceApproved) throw new Error('模拟浏览器未允许登录');
  if (!(await readFile(path.join(development, 'SKILL.md'), 'utf8')).includes('0.8.0')) throw new Error('开发目录被改动');
  process.stdout.write('核对：浏览器脚本已允许设备码，logout 已撤销令牌，开发目录已保留；所有读写均在临时目录。\n');
} finally { await f.close(); }
