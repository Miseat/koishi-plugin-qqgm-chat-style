import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOutputFilter } = require('../lib/filter.js');

const config = {
  maxChars: 30,
  maxLines: 3,
  bannedPatterns: ['首先', '其次', '综上所述', '希望这对你有帮助'],
  replacements: [{ from: '……', to: '...' }],
  stripMarkdown: true,
  stripTrailingPeriod: true,
};

const filter = createOutputFilter(config);

test('去掉 Markdown、链接、CQ 码', () => {
  const out = filter('**你好** [链接](https://example.com) [CQ:at,qq=1] 看这个');
  assert.equal(out, '你好 链接 看这个');
});

test('删除禁词并替换省略号', () => {
  assert.equal(filter('首先，这事儿……'), '这事儿...');
});

test('超长时按标点截断', () => {
  const out = filter('这是一句很长的话，后面还有很多很多内容需要被截断掉，不然就太长了');
  assert.ok(out.length <= 30, out);
  assert.ok(!/[，,、；;]$/.test(out), out);
  assert.ok(!out.endsWith('。'), out);
});

test('限制行数', () => {
  const out = filter('一行\n二行\n三行\n四行');
  assert.equal(out.split('\n').length, 3);
});

test('去掉末尾句号', () => {
  assert.equal(filter('行吧。'), '行吧');
});

test('过滤后为空返回 null', () => {
  assert.equal(filter('**'), null);
  assert.equal(filter('，，，'), null);
  assert.equal(filter('首先其次'), null);
});

test('maxChars 生效且不硬切在半个标点上', () => {
  const out = filter('他说这事儿吧，其实也没那么复杂，就是你想太多了');
  assert.ok(out.length <= 30);
});
