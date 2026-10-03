import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat, chmod, access } from 'node:fs/promises';
import { fixture, writeSkill, TOKEN, EMAIL } from './fixture.js';

const config = async (f) => JSON.parse(await readFile(f.configFile, 'utf8'));
const events = (result) => {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
};
const noDeviceSecret = (result, secret) => {
  const output = result.stdout + result.stderr;
  assert(!output.includes('device_code'), output);
  assert(!output.includes(secret), output);
  assert(!output.includes(secret.slice(0, 8)), output);
};

test('非交互最多等待 60 秒，保存权限 600 的待领取记录，退出 3 并提示再运行原命令', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const args = ['install', 'oil-ui-pro', '--to', 'codex'];
  const result = await f.run(args);
  assert.equal(result.code, 3);
  assert.equal(result.signal, null);
  assert.equal(result.trace.delays.reduce((sum, ms) => sum + ms, 0), 60000);
  const saved = await config(f);
  assert.deepEqual(saved, { pending_device: {
    device_code: f.state.deviceCode, user_code: f.state.userCode,
    verification_uri: `${f.base}/device/`, verification_uri_complete: `${f.base}/device/?code=${f.state.userCode}`,
    expires_at: 600000, interval: 5,
  } });
  assert.equal((await stat(f.configFile)).mode & 0o777, 0o600);
  assert.match(result.stdout, /没能自动打开浏览器/);
  assert(result.stdout.includes(`请打开：${saved.pending_device.verification_uri_complete}\n授权码：${saved.pending_device.user_code}\n`));
  assert.equal(result.stderr.trim(), `在浏览器打开 ${saved.pending_device.verification_uri_complete}，确认授权码 ${saved.pending_device.user_code} 后点“允许”，然后再运行一次刚才的命令。`);
  noDeviceSecret(result, saved.pending_device.device_code);
  await assert.rejects(access(path.join(f.home, '.codex', 'skills', 'oil-ui-pro')), { code: 'ENOENT' });

  // pending-only 配置也是合法配置；读取时修正权限。
  await chmod(f.configFile, 0o644);
  const status = await f.run(['status', '--json']);
  assert.equal(status.code, 0);
  assert.equal(events(status).at(-1).account, null);
  assert.equal((await stat(f.configFile)).mode & 0o777, 0o600);
  const retried = await f.run([...args, '--json'], {}, { startTime: 60000 });
  assert.equal(retried.code, 3);
  assert.equal(f.state.deviceRequests, 1);
  const output = events(retried);
  const pending = output.at(-1);
  assert.equal(pending.error, 'authorization_pending');
  assert.equal(pending.next_command, 'npx github:oil-oil/oil-cli install oil-ui-pro --to codex --json');
  for (const key of ['user_code', 'verification_uri', 'verification_uri_complete', 'expires_at', 'interval']) {
    assert.equal(pending[key], saved.pending_device[key]);
    assert.equal(output[0][key], saved.pending_device[key]);
  }
  assert(output[0].warnings.some((warning) => warning.includes('没能自动打开浏览器')));
  noDeviceSecret(retried, saved.pending_device.device_code);
});

test('第二次运行领取同一设备码，保存令牌、清掉待领取记录并继续安装', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const root = path.join(f.home, '.codex', 'skills');
  const free = await writeSkill(root, 'oil-ui', '0.8.0');
  const args = ['install', 'oil-ui-pro', '--json'];
  const first = await f.run(args);
  assert.equal(first.code, 3);
  const pending = (await config(f)).pending_device;
  await access(free);
  // 模拟 Agent 这一轮已经退出后，用户才在浏览器允许。
  const response = await fetch(`${f.base}/api/cli/device/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'oil_session=fake' },
    body: JSON.stringify({ user_code: pending.user_code, approve: true }),
  });
  assert.equal(response.status, 200);
  const second = await f.run(args, {}, { startTime: 90000 });
  assert.equal(second.code, 0, second.stdout);
  const output = events(second);
  assert.deepEqual(output.map((event) => event.event), ['device', 'login', undefined]);
  assert.equal(output[0].verification_uri_complete, pending.verification_uri_complete);
  assert.equal(output[0].user_code, pending.user_code);
  assert.equal(f.state.deviceRequests, 1);
  assert(f.state.requests.filter((request) => request.path === '/api/cli/token').every((request) => request.body.device_code === pending.device_code));
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL });
  assert.equal((await stat(f.configFile)).mode & 0o777, 0o600);
  assert.match(await readFile(path.join(root, 'oil-ui-pro', 'SKILL.md'), 'utf8'), /name: oil-ui-pro/);
  await assert.rejects(access(free), { code: 'ENOENT' });
  noDeviceSecret(first, pending.device_code);
  noDeviceSecret(second, pending.device_code);
});

test('真实 CLI 在设备码显示后被杀掉，浏览器随后允许，下一进程仍能继续安装', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const args = ['install', 'oil-ui-pro', '--to', 'codex'];
  const first = await f.run(args, {}, { real: true, killOnDevice: true });
  assert.equal(first.signal, 'SIGKILL');
  assert.equal(f.state.devicePolls, 0);
  const pending = (await config(f)).pending_device;
  assert(pending.expires_at > Date.now());
  assert.equal((await stat(f.configFile)).mode & 0o777, 0o600);
  const response = await fetch(`${f.base}/api/cli/device/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'oil_session=fake' },
    body: JSON.stringify({ user_code: pending.user_code, approve: true }),
  });
  assert.equal(response.status, 200);
  const second = await f.run(args, {}, { real: true });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(f.state.deviceRequests, 1);
  assert.match(second.stdout, /已安装 oil-ui-pro/);
  assert(second.stdout.includes(`授权码：${pending.user_code}`));
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL });
  noDeviceSecret(first, pending.device_code);
  noDeviceSecret(second, pending.device_code);
});

test('本机已有令牌时也先完成待领取登录；OIL_TOKEN 仍优先', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['login', '--token', TOKEN])).code, 0);
  f.state.requireApproval = true;
  assert.equal((await f.run(['login', '--json'])).code, 3);
  const pending = (await config(f)).pending_device;
  const envResult = await f.run(['manage', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(envResult.code, 0);
  assert.equal(events(envResult).length, 1);
  assert.deepEqual((await config(f)).pending_device, pending);
  f.state.deviceApproved = true;
  const result = await f.run(['manage', '--json'], {}, { startTime: 65000 });
  assert.equal(result.code, 0);
  assert.equal(events(result)[0].user_code, pending.user_code);
  assert.equal(f.state.deviceRequests, 1);
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL });
});

test('update、subscribe、manage 也优先领取待授权设备码并继续原命令', async (t) => {
  for (const args of [
    ['update', 'oil-doc-pro', '--json'],
    ['subscribe', 'oil-doc-pro', '--plan', 'yearly', '--json'],
    ['manage', '--json'],
  ]) {
    await t.test(args[0], async (t) => {
      const f = await fixture(t);
      await writeSkill(path.join(f.home, '.codex', 'skills'), 'oil-doc-pro', '0.8.0');
      f.state.requireApproval = true;
      assert.equal((await f.run(['login', '--json'])).code, 3);
      const pending = (await config(f)).pending_device;
      f.state.deviceApproved = true;
      const result = await f.run(args, {}, { startTime: 65000 });
      assert.equal(result.code, 0, result.stdout);
      assert.equal(events(result)[0].user_code, pending.user_code);
      assert.equal(f.state.deviceRequests, 1);
      assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL });
      noDeviceSecret(result, pending.device_code);
    });
  }
});

test('待领取设备码被拒绝或服务端宣告过期，清掉旧记录并申请新代码', async (t) => {
  for (const error of ['access_denied', 'expired_token']) {
    await t.test(error, async (t) => {
      const f = await fixture(t);
      f.state.deviceStatuses = ['authorization_pending'];
      assert.equal((await f.run(['login', '--json'])).code, 3);
      const old = (await config(f)).pending_device;
      f.state.deviceStatusesByRequest = [[error], ['authorization_pending']];
      const offset = f.state.requests.length;
      const result = await f.run(['install', 'oil-ui-pro', '--to', 'codex', '--json'], {}, { startTime: 60000 });
      assert.equal(result.code, 3);
      assert.equal(f.state.deviceRequests, 2);
      const fresh = (await config(f)).pending_device;
      assert.notEqual(fresh.device_code, old.device_code);
      assert.notEqual(fresh.user_code, old.user_code);
      assert.equal(fresh.expires_at, 665000);
      const requests = f.state.requests.slice(offset).filter((request) => request.path.startsWith('/api/cli/'));
      assert.deepEqual(requests.slice(0, 3).map((request) => request.path), ['/api/cli/token', '/api/cli/device', '/api/cli/token']);
      assert.equal(requests[0].body.device_code, old.device_code);
      assert(requests.slice(2).every((request) => request.body.device_code === fresh.device_code));
      const output = events(result);
      assert.equal(output[0].user_code, old.user_code);
      assert.equal(output[1].user_code, fresh.user_code);
      assert.equal(output.at(-1).user_code, fresh.user_code);
      assert.equal((await stat(f.configFile)).mode & 0o777, 0o600);
      noDeviceSecret(result, old.device_code);
      noDeviceSecret(result, fresh.device_code);
    });
  }
});

test('本机记录已到期时直接清掉并换新，不轮询旧设备码', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['authorization_pending'];
  assert.equal((await f.run(['login', '--json'])).code, 3);
  const old = (await config(f)).pending_device;
  f.state.deviceStatuses = ['success'];
  const offset = f.state.requests.length;
  const result = await f.run(['login', '--json'], {}, { startTime: old.expires_at });
  assert.equal(result.code, 0);
  assert.equal(f.state.deviceRequests, 2);
  const requests = f.state.requests.slice(offset);
  assert.equal(requests[0].path, '/api/cli/device');
  assert(requests.filter((request) => request.path === '/api/cli/token').every((request) => request.body.device_code !== old.device_code));
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL });
  noDeviceSecret(result, old.device_code);
  noDeviceSecret(result, f.state.deviceCode);
});

test('交互终端复用待领取代码并等满 10 分钟；实际到期时清掉记录', async (t) => {
  const f = await fixture(t);
  f.state.expiresIn = 3600;
  f.state.deviceStatuses = ['authorization_pending'];
  assert.equal((await f.run(['login', '--json'])).code, 3);
  const pending = (await config(f)).pending_device;
  const result = await f.run(['login'], {}, { interactive: true, startTime: 60000 });
  assert.equal(result.code, 3);
  assert.equal(result.trace.delays.reduce((sum, ms) => sum + ms, 0), 600000);
  assert.equal(f.state.deviceRequests, 1);
  assert.match(result.stdout, /最长等待 10 分钟/);
  assert(result.stdout.includes(`请打开：${pending.verification_uri_complete}\n授权码：${pending.user_code}`));
  assert.deepEqual((await config(f)).pending_device, pending);
  noDeviceSecret(result, pending.device_code);
  // 清除后发起的新代码也拒绝时，应删除新记录并退出，避免无限换码。
  f.state.deviceStatuses = ['access_denied'];
  const denied = await f.run(['login', '--json'], {}, { startTime: pending.expires_at });
  assert.equal(denied.code, 1);
  assert.equal(events(denied).at(-1).error, 'access_denied');
  assert.equal(f.state.deviceRequests, 2);
  await assert.rejects(access(f.configFile), { code: 'ENOENT' });
});

test('slow_down 后的轮询间隔跨轮次保留；错误输出完全隐藏设备密钥及其编码形式', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['slow_down', 'authorization_pending'];
  const first = await f.run(['login', '--json']);
  assert.equal(first.code, 3);
  const pending = (await config(f)).pending_device;
  assert.equal(pending.interval, 10);
  assert.equal(events(first).at(-1).interval, 10);
  f.state.deviceStatuses = ['failed'];
  f.state.deviceErrorMessage = `密钥 ${pending.device_code}，编码 ${encodeURIComponent(pending.device_code)}`;
  const second = await f.run(['login', '--json'], {}, { startTime: 65000 });
  assert.equal(second.code, 1);
  assert.deepEqual(second.trace.delays, [10000]);
  assert.equal(f.state.deviceRequests, 1);
  assert(events(second).at(-1).message.includes('[已隐藏]'));
  noDeviceSecret(second, pending.device_code);
});

test('换新设备码时自动打开浏览器也受剩余预算限制，非交互总等待不超过 60 秒', async (t) => {
  const f = await fixture(t);
  f.state.interval = 54;
  f.state.deviceStatuses = ['authorization_pending'];
  assert.equal((await f.run(['login', '--json'])).code, 3);
  f.state.deviceStatusesByRequest = [['access_denied'], ['authorization_pending']];
  const result = await f.run(['login', '--json'], {}, { startTime: 60000, browserDelay: 10000 });
  assert.equal(result.code, 3);
  assert.equal(f.state.deviceRequests, 2);
  assert.deepEqual(result.trace.browserTimeouts, [5000, 1000]);
  assert.equal(result.trace.delays.reduce((sum, ms) => sum + ms, 0) + result.trace.browserTimeouts.reduce((sum, ms) => sum + ms, 0), 60000);
  assert.equal(events(result).at(-1).user_code, f.state.userCode);
  assert.equal((await config(f)).pending_device.device_code, f.state.deviceCode);
});
