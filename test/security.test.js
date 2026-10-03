import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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
