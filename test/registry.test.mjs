import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildStyleSet, RollCache, listAvailable, extraSection } = require('../lib/registry.js');

function makeSkill(root, id, { name = id, category = 'persona-chat', body = null } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const text = body || [
    '---',
    `name: ${name}`,
    'description: test',
    'metadata:',
    `  category: ${category}`,
    '---',
    '',
    `# ${name}`,
    '',
    '这是一段测试用的聊天风格正文，需要足够长才能通过校验。'.repeat(6),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
  return dir;
}

test('buildStyleSet：主风格 + 追加风格按配置解析', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-'));
  makeSkill(root, 'aaa-main');
  makeSkill(root, 'bbb-extra');
  const set = buildStyleSet(root, {
    primaryStyle: 'aaa-main',
    extraStyles: [{ style: 'bbb-extra', probability: 0.5 }],
  });
  assert.equal(set.primary.id, 'aaa-main');
  assert.equal(set.extras.length, 1);
  assert.equal(set.extras[0].id, 'bbb-extra');
  assert.equal(set.extras[0].probability, 0.5);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildStyleSet：追加风格缺省时回退第一个可用 skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-'));
  makeSkill(root, 'only-one');
  const set = buildStyleSet(root, {});
  assert.equal(set.primary.id, 'only-one');
  assert.equal(set.extras.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildStyleSet：主风格与追加风格重复时跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-'));
  makeSkill(root, 'same');
  const set = buildStyleSet(root, {
    primaryStyle: 'same',
    extraStyles: [{ style: 'same', probability: 1 }],
  });
  assert.equal(set.primary.id, 'same');
  assert.equal(set.extras.length, 0);
  assert.ok(set.warnings.some((w) => w.includes('重复')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildStyleSet：概率越界会被夹到 0..1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-'));
  makeSkill(root, 'm');
  makeSkill(root, 'e');
  const set = buildStyleSet(root, {
    primaryStyle: 'm',
    extraStyles: [{ style: 'e', probability: 5 }],
  });
  assert.equal(set.extras[0].probability, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildStyleSet：enabled=false 的追加风格不加载', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-'));
  makeSkill(root, 'm2');
  makeSkill(root, 'e2');
  const set = buildStyleSet(root, {
    primaryStyle: 'm2',
    extraStyles: [{ style: 'e2', probability: 0.4, enabled: false }],
  });
  assert.equal(set.extras.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('RollCache：同一轮内保持一致，不同群互不影响', () => {
  const cache = new RollCache();
  const ctx = { groupId: 'g1' };
  const a = cache.roll(ctx, 'x', 1);
  const b = cache.roll(ctx, 'x', 1);
  assert.equal(a, true);
  assert.equal(b, true);
  const c = cache.roll({ groupId: 'g2' }, 'x', 0);
  assert.equal(c, false);
});

test('RollCache：概率为 0 永不命中，为 1 必定命中', () => {
  const cache = new RollCache();
  let hits = 0;
  for (let i = 0; i < 50; i += 1) {
    if (cache.roll({ groupId: `g${i}` }, 'y', 1)) hits += 1;
  }
  assert.equal(hits, 50);
  let miss = 0;
  for (let i = 0; i < 50; i += 1) {
    if (!cache.roll({ groupId: `h${i}` }, 'z', 0)) miss += 1;
  }
  assert.equal(miss, 50);
});

test('extraSection：包含“不得压过主风格”的约束', () => {
  const section = extraSection({
    name: '火影',
    skill: { body: '正文内容' },
  }, 0.3);
  assert.match(section, /主风格的语气、句式、长度始终优先/);
  assert.match(section, /30%/);
  assert.match(section, /正文内容/);
});

test('listAvailable：坏 skill 会被标记不可用而不是抛出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-'));
  makeSkill(root, 'good');
  const badDir = path.join(root, 'bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(
    path.join(badDir, 'SKILL.md'),
    ['---', 'name: bad', 'metadata:', '  category: coding', '---', 'print(1)'].join('\n'),
    'utf8',
  );
  const list = listAvailable(root);
  const bad = list.find((item) => item.id === 'bad');
  assert.equal(bad.ok, false);
  assert.ok(list.some((item) => item.id === 'good' && item.ok));
  fs.rmSync(root, { recursive: true, force: true });
});
