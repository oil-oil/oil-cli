import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fixture, writeSkill, INACTIVE } from './fixture.js';

// 真实入口和时钟，仅服务、浏览器和用户目录使用本地夹具。
for (const lang of ['zh', 'en']) {
  const f = await fixture();
  try {
    f.state.requireApproval = true;
    f.state.deviceToken = INACTIVE;
    const codexHome = path.join(f.home, 'custom-codex');
    await writeSkill(path.join(codexHome, 'skills'), 'oil-ui', '0.8.0');
    const development = await writeSkill(path.join(codexHome, 'skills'), 'oil-doc-pro', '0.8.0');
    await mkdir(path.join(development, '.git'));
    const paid = path.join(codexHome, 'skills', 'oil-ui-pro');
    const env = { OIL_LANG: lang, CODEX_HOME: codexHome, OIL_TEST_BROWSER: 'approve' };
    for (const args of [
      ['help'],
      ['install', 'oil-ui', '--to', 'agents'],
      ['login'],
      ['status'],
      ['list'],
      ['install', 'oil-ui-pro'],
      ['status'],
      ['update'],
      ['update', '--path', paid],
      ['logout'],
    ]) {
      if (args[0] === 'update') f.state.latest = '0.11.0';
      process.stdout.write(`$ OIL_LANG=${lang} npx github:oil-oil/oil-cli ${args.join(' ').replaceAll(f.temporary, '<temp>')}\n`);
      const result = await f.run(args, env, { real: true });
      const output = (result.stdout + result.stderr).replaceAll(f.temporary, '<temp>').replaceAll(f.base, '<fixture>');
      process.stdout.write(output + `exit=${result.code}\n\n`);
      if (result.code !== 0) throw new Error(`Manual command failed: ${args[0]}`);
      if (lang === 'en' && /\p{Script=Han}/u.test(output)) throw new Error('Chinese text in English output');
      if (/重启|新开对话|restart|new conversation/i.test(output)) throw new Error('Unexpected restart hint');
    }
    if (!f.state.deviceApproved) throw new Error('Browser did not approve sign-in');
    if (!(await readFile(path.join(development, 'SKILL.md'), 'utf8')).includes('0.8.0')) throw new Error('Development directory changed');
    process.stdout.write(`Verified ${lang}: temporary HOME, CODEX_HOME, browser sign-in, purchase, install, status, update, logout; development files preserved.\n\n`);
  } finally { await f.close(); }
}
