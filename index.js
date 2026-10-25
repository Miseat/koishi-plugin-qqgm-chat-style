/**
 * qqgm-chat-style：依附于 @nestim/koishi-plugin-qq-group-manager 的聊天风格插件。
 *
 * 做三件事：
 *   1. 读取一个主风格 .skill，整段并入 AI 系统提示词（决定基本人格与说话方式）；
 *   2. 读取任意多个追加风格，按各自概率随机叠加，只作“加味”，不得压过主风格；
 *   3. 发送前统一做文本规范：去 Markdown/CQ/URL、删禁词、限行数/字数。
 *
 * 不注册群指令、不碰触发与上下文；所有随机都在插件内部完成。
 */
const path = require('node:path');
const { Schema } = require('koishi');
const { createOutputFilter } = require('./lib/filter');
const {
  RollCache,
  buildStyleSet,
  listAvailable,
  primarySection,
  extraSection,
} = require('./lib/registry');

const name = 'qqgm-chat-style';
const inject = ['qqgmAiHooks'];

const DEFAULT_BANNED = [
  '首先',
  '其次',
  '综上所述',
  '值得注意的是',
  '总的来说',
  '希望这对你有帮助',
  '作为AI',
  '作为一个AI',
  '你细品',
  '懂得都懂',
];

/** 追加风格：一条一条往下加，字段名尽量短，配置页只剩“几个字 + 一个框”。 */
const ExtraStyle = Schema.object({
  style: Schema.string().default('')
    .description('技能名，填 data/chat-styles 下的目录名，例如 naruto-mobile-chat。留空表示不启用。'),
  probability: Schema.percent().default(0.3)
    .description('每轮触发的概率（内部随机数）。0 等于永远不叠，1 等于每次都叠。'),
  enabled: Schema.boolean().default(true)
    .description('临时关掉这条追加风格，不必删掉它。'),
  maxChars: Schema.natural().min(10).max(500).default(60)
    .description('叠加时的字数上限；留默认即可，通常沿用主风格。'),
  maxLines: Schema.natural().min(1).max(10).default(3)
    .description('叠加时的行数上限；留默认即可。'),
}).description('追加风格');

const Config = Schema.intersect([
  Schema.object({
    primaryStyle: Schema.string().default('')
      .description('填技能目录名，例如 northern-netizen-chat。留空则用目录里第一个可用 skill。'),
    skillDir: Schema.string().default('data/chat-styles')
      .description('风格目录（相对 Koishi 数据目录），一般不用改。'),
  }).description('主风格'),
  Schema.object({
    extraStyles: Schema.array(ExtraStyle).role('table').default([])
      .description('可无限添加；每轮按各自概率随机叠加，只加味道，不盖主风格。'),
  }).description('追加风格'),
  Schema.object({
    maxChars: Schema.natural().min(10).max(500).default(60)
      .description('单条回复最大字符数，超出按标点截断。'),
    maxLines: Schema.natural().min(1).max(10).default(3)
      .description('单条回复最大行数，多出的行会被丢弃。'),
    bannedPatterns: Schema.array(String).role('table').default(DEFAULT_BANNED)
      .description('命中即从输出中删除的词/短语。'),
    replacements: Schema.array(Schema.object({
      from: Schema.string().required(),
      to: Schema.string().default(''),
    })).role('table').default([{ from: '……', to: '...' }])
      .description('输出中的字面替换。'),
    glossary: Schema.array(Schema.object({
      term: Schema.string().required(),
      meaning: Schema.string().required(),
    })).role('table').default([])
      .description('群聊术语解释，避免缩写歧义。'),
    stripMarkdown: Schema.boolean().default(true)
      .description('去掉 Markdown 标记、链接、代码块。'),
    stripTrailingPeriod: Schema.boolean().default(true)
      .description('去掉回复末尾的句号。'),
    debug: Schema.boolean().default(false)
      .description('日志里打印风格组合、随机结果与过滤细节。'),
  }).description('输出规范'),
]);

function resolveSkillRoot(ctx, config) {
  const base = ctx.baseDir || process.cwd();
  return path.resolve(base, String(config.skillDir || 'data/chat-styles'));
}

function apply(ctx, config) {
  const logger = ctx.logger('qqgm-chat-style');
  const root = resolveSkillRoot(ctx, config);

  let set;
  try {
    set = buildStyleSet(root, config);
  } catch (error) {
    logger.warn(`读取风格目录失败：${String(error)}`);
    return;
  }
  for (const warning of set.warnings) logger.warn(warning);

  if (!set.primary) {
    logger.warn(`未找到主风格 skill（目录：${root}），插件不启用`);
    return;
  }

  const hooks = ctx.qqgmAiHooks
    || (ctx.root && typeof ctx.root.get === 'function' ? ctx.root.get('qqgmAiHooks') : null)
    || (ctx.nestimQqGroupManager && ctx.nestimQqGroupManager.aiHooks);
  if (!hooks || typeof hooks.registerPromptSection !== 'function') {
    logger.warn('未找到 qqgmAiHooks 扩展点（需要 @nestim/koishi-plugin-qq-group-manager >= 1.2.2），风格插件不启用');
    return;
  }
  if (Number(hooks.version) < 1) {
    logger.warn(`aiHooks 版本过低（${hooks.version}），风格插件不启用`);
    return;
  }

  // [bot] style —— 列出可用风格，省得用户去翻文件目录
  ctx.command('qqgm-style', '列出可用的聊天风格')
    .alias('style')
    .action(() => {
      const available = listAvailable(root);
      if (!available.length) return `目录里没有可用风格：${root}`;
      const lines = ['可用风格：'];
      for (const item of available) {
        const mark = item.id === set.primary.id ? ' ← 当前主风格' : '';
        lines.push(item.ok ? `- ${item.id}（${item.name}）${mark}` : `- ${item.id}（不可用：${item.reason}）`);
      }
      if (set.extras.length) {
        lines.push('', '当前追加风格：');
        for (const extra of set.extras) {
          lines.push(`- ${extra.id} · ${Math.round(extra.probability * 100)}%`);
        }
      }
      return lines.join('\n');
    });

  const rolls = new RollCache();

  // 主风格：整段并入，任何情况下都在
  const primaryFn = (hookCtx) =>
    primarySection(set.primary, config, { direct: !!hookCtx?.session?.isDirect });

  const offPrompt = hooks.registerPromptSection(async (hookCtx) => {
    const parts = [primaryFn(hookCtx)];
    for (const extra of set.extras) {
      if (extra.probability <= 0) continue;
      const hit = rolls.roll(hookCtx, extra.id, extra.probability);
      if (!hit) continue;
      if (config.debug) {
        logger.info(`[style] 追加风格命中 ${extra.id} @ ${hookCtx?.groupId || 'direct'}`);
      }
      parts.push(extraSection(extra, extra.probability));
    }
    return parts.join('\n\n');
  });

  // 输出规范：字数上限取“本轮真正叠上的最严值”，避免追加风格被主风格的长度截断
  const baseFilter = createOutputFilter(config, logger);
  const offFilter = hooks.registerOutputFilter((text, hookCtx) => {
    let limit = null;
    for (const extra of set.extras) {
      if (extra.probability <= 0) continue;
      if (!rolls.roll(hookCtx, extra.id, extra.probability)) continue;
      limit = limit
        ? { maxChars: Math.max(limit.maxChars, extra.minChars), maxLines: Math.max(limit.maxLines, extra.maxLines) }
        : { maxChars: extra.minChars, maxLines: extra.maxLines };
    }
    if (!limit) return baseFilter(text);
    const merged = {
      ...config,
      maxChars: Math.max(Number(config.maxChars) || 60, limit.maxChars),
      maxLines: Math.max(Number(config.maxLines) || 3, limit.maxLines),
      stripMarkdown: config.stripMarkdown,
      stripTrailingPeriod: config.stripTrailingPeriod,
      bannedPatterns: config.bannedPatterns,
      replacements: config.replacements,
    };
    return createOutputFilter(merged, logger)(text);
  });

  const extraDesc = set.extras.length
    ? set.extras.map((item) => `${item.id}(${Math.round(item.probability * 100)}%)`).join('、')
    : '无';
  logger.info(
    `主风格「${set.primary.name}」(${set.primary.id})：正文 ${set.primary.skill.body.length} 字 | 追加风格：${extraDesc}`,
  );
  if (config.debug) {
    logger.info(`[debug] skillDir=${root} 可用=${set.available.filter((i) => i.ok).map((i) => i.id).join(',')}`);
  }

  ctx.on('dispose', () => {
    offPrompt();
    offFilter();
  });
}

module.exports = { name, inject, Config, apply };
