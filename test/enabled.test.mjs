import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildStyleSet } = require('../lib/registry.js');

function makeSkill(root, id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${id}`,
      'metadata:',
      '  category: persona-chat',
      '---',
      '',
      `# ${id}`,
      '',
      '这是一段测试用的聊天风格正文，需要足够长才能通过校验。'.repeat(6),
    ].join('\n'),
    'utf8',
  );
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  makeSkill(root, 'main');
  makeSkill(root, 'extra');
  return root;
}

test('enabled=false 会被跳过，并给出可见告警', () => {
  const root = tmpRoot();
  const set = buildStyleSet(root, {
    primaryStyle: 'main',
    extraStyles: [{ style: 'extra', enabled: false }],
  });
  assert.equal(set.extras.length, 0, '关闭的项不应加入');
  assert.equal(set.disabled.length, 1, '应记录为已关闭');
  assert.ok(
    set.warnings.some((w) => /已关闭/.test(w) && /enabled=false/.test(w)),
    '必须告警说明为什么没生效',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('enabled 未填视为启用', () => {
  const root = tmpRoot();
  const set = buildStyleSet(root, {
    primaryStyle: 'main',
    extraStyles: [{ style: 'extra' }],
  });
  assert.equal(set.extras.length, 1, '缺省应启用');
  assert.equal(set.disabled.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('enabled=true 正常启用', () => {
  const root = tmpRoot();
  const set = buildStyleSet(root, {
    primaryStyle: 'main',
    extraStyles: [{ style: 'extra', enabled: true, probability: 0.5 }],
  });
  assert.equal(set.extras.length, 1);
  assert.equal(set.extras[0].probability, 0.5);
  fs.rmSync(root, { recursive: true, force: true });
});

test('probability 为 1 表示每次叠加', () => {
  const root = tmpRoot();
  const set = buildStyleSet(root, {
    primaryStyle: 'main',
    extraStyles: [{ style: 'extra', probability: 1 }],
  });
  assert.equal(set.extras[0].probability, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('多行追加风格都生效', () => {
  const root = tmpRoot();
  makeSkill(root, 'extra2');
  makeSkill(root, 'extra3');
  const set = buildStyleSet(root, {
    primaryStyle: 'main',
    extraStyles: [
      { style: 'extra', enabled: true },
      { style: 'extra2', enabled: true },
      { style: 'extra3', enabled: false },
    ],
  });
  assert.equal(set.extras.length, 2);
  assert.deepEqual(set.extras.map((e) => e.id), ['extra', 'extra2']);
  assert.equal(set.disabled.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
