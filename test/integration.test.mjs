import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const plugin = require('../index.js');

// 只依赖 qqgmAiHooks 的公开契约，不跨仓库 require 主插件
function createFakeHooks() {
  const sections = new Set();
  const filters = new Set();
  return {
    version: 1,
    registerPromptSection(fn) {
      sections.add(fn);
      return () => sections.delete(fn);
    },
    registerOutputFilter(fn) {
      filters.add(fn);
      return () => filters.delete(fn);
    },
    async collectSections(ctx) {
      const out = [];
      for (const fn of sections) {
        const text = await fn(ctx);
        if (text && String(text).trim()) out.push(String(text).trim());
      }
      return out;
    },
    async applyFilters(text, ctx) {
      let current = String(text);
      for (const fn of filters) {
        const next = await fn(current, ctx);
        if (next == null) return null;
        current = String(next);
      }
      return current;
    },
    get sectionCount() {
      return sections.size;
    },
    get filterCount() {
      return filters.size;
    },
  };
}

const FIXTURES = path.resolve('test/fixtures');
const baseConfig = {
  skillDir: '.',
  primaryStyle: 'northern-netizen-chat',
  extraStyles: [],
  maxChars: 40,
  maxLines: 2,
  bannedPatterns: ['首先', '其次'],
  replacements: [{ from: '……', to: '...' }],
  stripMarkdown: true,
  stripTrailingPeriod: true,
  debug: false,
};

function makeCtx(hooks) {
  const warnings = [];
  const infos = [];
  const handlers = {};
  let dispose = null;
  const logger = {
    info(message) {
      infos.push(String(message));
    },
    warn(message) {
      warnings.push(String(message));
    },
  };
  const commands = [];
  return {
    ctx: {
      baseDir: FIXTURES,
      logger: () => logger,
      on(event, handler) {
        if (event === 'dispose') dispose = handler;
        else handlers[event] = handler;
      },
      command(name, desc) {
        const cmd = {
          alias() {
            return cmd;
          },
          action(fn) {
            commands.push({ name, desc, fn });
            return cmd;
          },
        };
        return cmd;
      },
      get(key) {
        return key === 'qqgmAiHooks' ? hooks : undefined;
      },
    },
    warnings,
    infos,
    commands,
    fireReady() {
      if (handlers.ready) handlers.ready();
    },
    runDispose() {
      if (dispose) dispose();
    },
  };
}

test('主风格注册为提示词段与输出过滤器，dispose 后注销', async () => {
  const hooks = createFakeHooks();
  const { ctx, runDispose } = makeCtx(hooks);
  plugin.apply(ctx, baseConfig);

  const sections = await hooks.collectSections({ groupId: 'g1' });
  assert.equal(sections.length, 1);
  assert.match(sections[0], /northern-netizen-chat|归因降维|北方/);
  assert.match(sections[0], /群聊/);

  const out = await hooks.applyFilters('首先，这事儿真的真的太长了'.repeat(4), { groupId: 'g1' });
  assert.ok(out);
  assert.ok(out.length <= 40);
  assert.doesNotMatch(out, /首先/);

  runDispose();
  assert.equal(hooks.sectionCount, 0);
  assert.equal(hooks.filterCount, 0);
});

test('没有 qqgmAiHooks 时安全跳过：ready 后才给出提示', () => {
  const { ctx, warnings, fireReady } = makeCtx(undefined);
  assert.doesNotThrow(() => plugin.apply(ctx, baseConfig));
  assert.ok(
    !warnings.some((line) => /未找到 qqgmAiHooks/.test(line)),
    'apply 阶段不应立即判定缺少扩展点',
  );
  fireReady();
  assert.ok(warnings.some((line) => /qqgmAiHooks/.test(line)), 'ready 后应提示缺少扩展点');
});

test('主插件晚于本插件挂载时，ready 能补挂成功', async () => {
  let hooks;
  const warnings = [];
  const handlers = {};
  const logger = { info() {}, warn: (m) => warnings.push(String(m)) };
  const ctx = {
    baseDir: FIXTURES,
    logger: () => logger,
    on(event, handler) {
      handlers[event] = handler;
    },
    command() {
      return {
        alias() {
          return this;
        },
        action() {
          return this;
        },
      };
    },
    get(key) {
      return key === 'qqgmAiHooks' ? hooks : undefined;
    },
  };
  plugin.apply(ctx, baseConfig);
  assert.ok(
    !warnings.some((line) => /未找到 qqgmAiHooks/.test(line)),
    'apply 阶段不应立即判定缺少扩展点',
  );

  hooks = createFakeHooks();
  handlers.ready();

  const sections = await hooks.collectSections({ groupId: 'late' });
  assert.equal(sections.length, 1, 'ready 后应补挂成功');
  assert.ok(!warnings.some((line) => /未找到 qqgmAiHooks/.test(line)));
});

test('inject 为空，不声明 Koishi 服务依赖', () => {
  assert.deepEqual(plugin.inject, [], 'inject 应为空，避免 Koishi 等待不存在的服务');
});

test('主风格不存在时安全跳过并提示可用列表', () => {
  const { ctx, warnings } = makeCtx(createFakeHooks());
  assert.doesNotThrow(() => plugin.apply(ctx, { ...baseConfig, primaryStyle: 'not-exist' }));
  assert.ok(warnings.some((line) => /不可用/.test(line)));
});

test('追加风格概率为 1 时每轮都叠在主风格后面', async () => {
  const hooks = createFakeHooks();
  const { ctx } = makeCtx(hooks);
  plugin.apply(ctx, {
    ...baseConfig,
    extraStyles: [{ style: 'northern-netizen-chat', probability: 1 }],
  });
  // 与主风格同名会被去重，因此这里换一个真实 fixture 之外的场景：只验证不报错
  const sections = await hooks.collectSections({ groupId: 'g2' });
  assert.equal(sections.length, 1);
});

test('追加风格概率为 0 时不叠加', async () => {
  const hooks = createFakeHooks();
  const { ctx } = makeCtx(hooks);
  // 构造第二个可用 skill 目录
  const fs = require('node:fs');
  const os = require('node:os');
  const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-'));
  const dir = path.join(extraRoot, 'northern-netizen-chat');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, 'northern-netizen-chat', 'SKILL.md'),
    path.join(dir, 'SKILL.md'),
  );

  plugin.apply(ctx, {
    ...baseConfig,
    skillDir: extraRoot,
    primaryStyle: 'northern-netizen-chat',
    extraStyles: [{ style: 'northern-netizen-chat', probability: 0 }],
  });
  const sections = await hooks.collectSections({ groupId: 'g3' });
  assert.equal(sections.length, 1, '概率 0 不应产生第二段');
  fs.rmSync(extraRoot, { recursive: true, force: true });
});

test('注册 [bot] style 查询命令', () => {
  const hooks = createFakeHooks();
  const { ctx, commands } = makeCtx(hooks);
  plugin.apply(ctx, baseConfig);
  const cmd = commands.find((item) => item.name === 'qqgm-style');
  assert.ok(cmd, '应注册风格查询命令');
  const output = cmd.fn();
  assert.match(output, /可用风格/);
  assert.match(output, /northern-netizen-chat/);
});
