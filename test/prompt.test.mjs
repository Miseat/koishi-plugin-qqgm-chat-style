import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildStylePrompt } = require('../lib/prompt.js');

test('风格提示词包含边界声明与正文', () => {
  const text = buildStylePrompt({ id: 'x', name: '北方网友', body: 'STYLE_BODY' });
  assert.match(text, /只描述“怎么说”/);
  assert.match(text, /QQ 群聊/);
  assert.match(text, /以系统规则为准/);
  assert.match(text, /STYLE_BODY/);
  assert.match(text, /不要向对方介绍这个风格/);
});

test('术语表进入提示词，并强调先回答当前消息', () => {
  const text = buildStylePrompt(
    { id: 'x', name: '北方网友', body: 'STYLE_BODY' },
    { glossary: [{ term: 'ml', meaning: '二游 master love，不是 machine learning' }] },
  );
  assert.match(text, /【群聊术语】/);
  assert.match(text, /ml：二游 master love/);
  assert.match(text, /先回答当前消息/);
  assert.match(text, /不要跑题/);
});

test('私聊模式不出现群聊/群友字样', () => {
  const text = buildStylePrompt({ id: 'x', name: '北方网友', body: 'STYLE_BODY' }, {}, { direct: true });
  assert.match(text, /QQ 私聊/);
  assert.doesNotMatch(text, /群聊，不是一对一/);
  assert.match(text, /不要提群友/);
});
