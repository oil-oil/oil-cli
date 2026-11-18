import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, TOKEN, EMAIL } from './fixture.js';

test('保存的令牌只发给签发它的服务器，OIL_API 指向别处时不带令牌', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  assert.equal((await f.run(['login', '--token', TOKEN, '--json'])).code, 0);
  const result = await f.run(['status', '--json'], { OIL_API: other.base });
  assert.equal(result.code, 0, result.stdout);
  assert(other.state.requests.length > 0);
  assert(other.state.requests.every((request) => request.token === undefined));
  assert(!result.stdout.includes(TOKEN));
});

test('OIL_TOKEN 是用户显式提供的，可以发给 OIL_API 指定的服务器', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['status', '--json'], { OIL_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert(f.state.requests.some((request) => request.token === TOKEN));
});

test('非本机地址必须用 HTTPS，否则退出 2 且不发任何请求', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['status', '--json'], { OIL_API: 'http://example.com' });
  assert.equal(result.code, 2);
  assert.match(result.stdout + result.stderr, /HTTPS/);
});

test('旧配置没有记录服务器时视为默认服务器，不发给其他地址', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.configFile), { recursive: true });
  await writeFile(f.configFile, JSON.stringify({ token: TOKEN, email: EMAIL }), { mode: 0o600 });
  const result = await f.run(['status', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert(f.state.requests.every((request) => request.token === undefined));
});

test('恢复设备登录只向签发服务器领取，切换 API 会申请新代码', async (t) => {
  for (const legacy of [false, true]) {
    const f = await fixture(t), other = await fixture(t);
    f.state.requireApproval = true;
    assert.equal((await f.run(['login', '--json'])).code, 3);
    const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
    saved.pending_device.device_code = 'original-origin-only-device-secret';
    if (legacy) delete saved.pending_device.api;
    await writeFile(f.configFile, JSON.stringify(saved));
    const result = await f.run(['login', '--json'], { OIL_API: other.base }, { startTime: 60000 });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(other.state.deviceRequests, 1);
    assert(other.state.requests.filter(request => request.path === '/api/cli/token')
      .every(request => request.body.device_code !== saved.pending_device.device_code));
    assert(!result.stdout.includes(saved.pending_device.device_code));
  }
});

test('旧设备记录可在原服务器恢复；不同来源的授权地址不用于恢复登录', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  assert.equal((await f.run(['login', '--json'])).code, 3);
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  delete saved.pending_device.api;
  await writeFile(f.configFile, JSON.stringify(saved));
  f.state.deviceApproved = true;
  assert.equal((await f.run(['login', '--json'], {}, { startTime: 60000 })).code, 0);
  assert.equal(f.state.deviceRequests, 1);

  // 旧格式仍需同时校验两个授权地址，防止打开另一个 origin。
  delete saved.token;
  saved.pending_device.verification_uri_complete = 'https://external.example/device/';
  await writeFile(f.configFile, JSON.stringify(saved));
  f.state.requireApproval = false;
  const result = await f.run(['login', '--json'], {}, { startTime: 60000 });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(f.state.deviceRequests, 2);
  assert(!result.trace.browserUrls.includes(saved.pending_device.verification_uri_complete));
});
