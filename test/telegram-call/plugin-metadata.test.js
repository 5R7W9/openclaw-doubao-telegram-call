import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../', import.meta.url);
const REALTIME_PROVIDER_CONTRACT_KEY = ['realtime', 'VoiceProviders'].join('');
const REGISTER_PROVIDER_TEXT = ['registerRealtime', 'VoiceProvider'].join('');
const BUILD_PROVIDER_TEXT = ['buildDoubao', 'RealtimeVoiceProvider'].join('');

test('companion plugin metadata declares only Telegram call surfaces', async () => {
  const [packageJson, manifestJson, indexSource] = await Promise.all([
    readJson(new URL('../../package.json', import.meta.url)),
    readJson(new URL('../../openclaw.plugin.json', import.meta.url)),
    readText(new URL('../../index.js', import.meta.url)),
  ]);

  assert.equal(packageJson.name, 'openclaw-doubao-telegram-call');
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(manifestJson.id, 'doubao-telegram-call');
  assert.ok(manifestJson.setup.envVars.includes('TELEGRAM_CALL_PROFILES_JSON'));
  assert.deepEqual(manifestJson.contracts[REALTIME_PROVIDER_CONTRACT_KEY] ?? [], []);
  assert.deepEqual(manifestJson.providers ?? [], []);
  assert.deepEqual(packageJson.openclaw.providers ?? [], []);
  assert.deepEqual(packageJson.openclaw.tools, [
    'create_telegram_call_link',
    'send_telegram_call_card',
    'list_telegram_call_profiles',
  ]);

  assert.match(indexSource, /registerTelegramCallRoutes/);
  assert.match(indexSource, /registerTelegramCallTools/);
  assert.equal(indexSource.includes(REGISTER_PROVIDER_TEXT), false);
  assert.equal(indexSource.includes(BUILD_PROVIDER_TEXT), false);
});

test('companion package files exclude provider implementation', async () => {
  const packageJson = await readJson(new URL('../../package.json', import.meta.url));
  const files = packageJson.files;

  assert.deepEqual(files, [
    '.env.example',
    'index.js',
    'LICENSE',
    'openclaw.plugin.json',
    'src/telegram-call/',
    'src/values.js',
    'web/telegram-call/',
    'skills/openclaw-doubao-telegram-call/',
    'telegram-call.config.example.json',
    'README.md',
    'docs/PROJECT_BOUNDARIES.md',
  ]);
  assert.equal(files.some((entry) => entry === 'src/' || entry.includes('provider')), false);
});

test('companion skill is usable as a first-run OpenClaw runbook', async () => {
  const skill = await readText(new URL('../../skills/openclaw-doubao-telegram-call/SKILL.md', import.meta.url));

  assert.match(skill, /^---\nname: openclaw-doubao-telegram-call\n/m);
  assert.match(skill, /^description: Use when .*OpenClaw.*Telegram.*Doubao.*$/m);
  for (const required of [
    'openclaw skills check',
    'openclaw plugins list',
    'openclaw gateway status',
    'tailscale serve status',
    'talk.catalog',
    'catalog.realtime?.providers',
    "provider?.transports?.includes('gateway-relay')",
    'openclaw plugins install clawhub:openclaw-doubao-realtime',
    'create_telegram_call_link',
    'send_telegram_call_card',
    'TELEGRAM_CALL_PUBLIC_BASE_URL',
    'TELEGRAM_CALL_PROFILES_JSON',
    'VOLCENGINE_REALTIME_APP_ID',
    'VOLCENGINE_REALTIME_ACCESS_KEY',
    'publicBaseUrl',
    '不要打印 token',
  ]) {
    assert.ok(skill.includes(required), `missing runbook phrase: ${required}`);
  }
});

test('example config uses a Telegram-compatible MagicDNS HTTPS public base URL', async () => {
  const example = await readJson(new URL('../../telegram-call.config.example.json', import.meta.url));

  assert.match(example.publicBaseUrl, /^https:\/\/[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net$/);
});

test('public docs and examples avoid local identities and committed secrets', async () => {
  const entries = [
    'README.md',
    'docs/PROJECT_BOUNDARIES.md',
    'skills/openclaw-doubao-telegram-call/SKILL.md',
    'telegram-call.config.example.json',
    '.env.example',
  ];
  const forbidden = [
    ['no', 'x-1207'].join(''),
    ['100', '97', '146', '68'].join('.'),
    ['tail4', 'aa7b2'].join(''),
    '/home/',
    ['8019', '444268'].join(''),
  ];

  for (const entry of entries) {
    const text = await readText(new URL(`../../${entry}`, import.meta.url));
    for (const value of forbidden) {
      assert.equal(text.includes(value), false, `${entry} contains local identity: ${value}`);
    }
    assert.doesNotMatch(text, /(?:TELEGRAM_BOT_TOKEN|VOLCENGINE_REALTIME_ACCESS_KEY)=["']?[^"'\s<>]+/);
  }
});

test('env example documents runtime variables without real values', async () => {
  const envExample = await readText(new URL('../../.env.example', import.meta.url));
  const gitignore = await readText(new URL('../../.gitignore', import.meta.url));

  for (const required of [
    'TELEGRAM_CALL_PUBLIC_BASE_URL=""',
    'TELEGRAM_CALL_PROFILES_JSON=\'{}\'',
    'TELEGRAM_BOT_TOKEN=""',
    'TELEGRAM_CALL_CHAT_ID=""',
    'TELEGRAM_BOT_API_BASE_URL="https://api.telegram.org"',
    'TELEGRAM_CALL_CONFIG_FILE=""',
  ]) {
    assert.ok(envExample.includes(required), `missing env example entry: ${required}`);
  }
  assert.ok(gitignore.includes('!.env.example'));
});

async function readJson(url) {
  return JSON.parse(await readText(url));
}

async function readText(url) {
  return readFile(url, 'utf8');
}
