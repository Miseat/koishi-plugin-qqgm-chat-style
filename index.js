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
const { StyleCardStore } = require('./lib/compact');

const name = 'qqgm-chat-style';
/**
 * 不写 inject。
 *
 * 原因：主插件把 qqgmAiHooks 用 `ctx.root.set()` 挂到 root，它不是 Koishi 的 Service，
 * 而 inject 只解析 Service——写了 inject 反而会让 Koishi 一直等一个永远不会出现的服务，
 * 配置页因此显示“未安装/未就绪”。这里改为运行时探测：拿不到就安静退出并给出日志。
 */
const inject = [];

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
    .description('技能名，填 data/chat-styles 下的目录名，例如 naruto-mobile-chat。留空表示这条不生效。'),
  probability: Schema.percent().default(0.3)
    .description('每轮触发的概率（内部随机数）。0 等于永远不叠，1 等于每次都叠。默认 0.3 = 三成概率。'),
  enabled: Schema.boolean().default(true)
    .description('启用这条追加风格。勾选 = 生效，取消勾选 = 暂时停用（配置保留，随时可再勾回来）。'),
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
  Schema.object({
    compact: Schema.boolean().default(true)
      .description('把主风格 skill 压缩成一张更短的风格卡（保留人设/语气/口癖，丢掉示例与说明），显著降低每次调用的输入 token。'),
    compactMaxChars: Schema.natural().min(200).max(3000).default(900)
      .description('风格卡的字数上限（默认 900）。越小越省 token，但可能把锐评/暴论的骨架压丢；改小前先看卡片内容。'),
    compactModel: Schema.string().default('')
      .description('生成风格卡用的模型；留空沿用主插件的 aiModel。只在首次生成或 skill 正文变更时调用一次。'),
    compactExtras: Schema.boolean().default(false)
      .description('是否也压缩追加风格（默认关；追加风格本身较短，压缩收益有限）。'),
  }).description('风格卡压缩'),
]);

function resolveSkillRoot(ctx, config) {
  const base = ctx.baseDir || process.cwd();
  return path.resolve(base, String(config.skillDir || 'data/chat-styles'));
}

/**
 * 运行时挂载。
 *
 * 主插件的 qqgmAiHooks 不是 Koishi Service（它是 ctx.root.set 上去的普通对象），
 * 所以不能用 inject 声明依赖——那样 Koishi 会一直等一个永不到来的服务。
 * 这里改成：启动时探测一次，拿不到就在 ready 时再试一次。
 */
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

  // 风格卡：先把主风格（以及可选的追加风格）压成短卡，并缓存到磁盘
  const cards = new StyleCardStore({ ctx, root, logger, config });
  cards.ensure(set.primary.skill, set.primary.id);
  if (config.compactExtras) {
    for (const extra of set.extras) cards.ensure(extra.skill, extra.id);
  }

  // 只用 get() 读取：直接访问未注册属性会触发 Koishi 的 "not registered" 告警
  const findHooks = () => {
    const read = (target, key) => {
      try {
        return target && typeof target.get === 'function' ? target.get(key) : null;
      } catch {
        return null;
      }
    };
    return read(ctx.root, 'qqgmAiHooks')
      || read(ctx, 'qqgmAiHooks')
      || (read(ctx.root, 'nestimQqGroupManager') || {}).aiHooks
      || (read(ctx, 'nestimQqGroupManager') || {}).aiHooks
      || null;
  };

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
      } else {
        lines.push('', '当前追加风格：（无）');
      }
      const card = cards.get(set.primary.id);
      lines.push('', `风格卡：${config.compact === false
        ? '已关闭（每次发送完整 skill）'
        : (card ? `已启用（${card.length} 字）` : '生成中/生成失败，暂用完整 skill')}`);
      if (set.disabled && set.disabled.length) {
        lines.push('', '已关闭的追加风格：');
        for (const item of set.disabled) {
          lines.push(`- ${item.style}（enabled=false，不会叠加）`);
        }
      }
      return lines.join('\n');
    });

  const rolls = new RollCache();
  const offs = [];
  let mounted = false;
  let tried = false;

  function mount(hooks) {
    mounted = true;

    // 主风格：整段并入（或压缩后的风格卡），任何情况下都在
    offs.push(hooks.registerPromptSection(async (hookCtx) => {
      const primaryCard = cards.get(set.primary.id);
      if (!primaryCard) cards.ensure(set.primary.skill, set.primary.id);
      const parts = [primarySection(set.primary, config, {
        direct: !!hookCtx?.session?.isDirect,
        compactText: primaryCard,
      })];
      for (const extra of set.extras) {
        if (extra.probability <= 0) continue;
        if (!rolls.roll(hookCtx, extra.id, extra.probability)) continue;
        if (config.debug) {
          logger.info(`[style] 追加风格命中 ${extra.id} @ ${hookCtx?.groupId || 'direct'}`);
        }
        const extraCard = config.compactExtras ? cards.get(extra.id) : null;
        if (config.compactExtras && !extraCard) cards.ensure(extra.skill, extra.id);
        parts.push(extraSection(extra, extra.probability, extraCard));
      }
      return parts.join('\n\n');
    }));

    // 输出规范：字数上限取“本轮真正叠上的最宽值”，避免追加风格被主风格的长度截断
    const baseFilter = createOutputFilter(config, logger);
    offs.push(hooks.registerOutputFilter((text, hookCtx) => {
      let limit = null;
      for (const extra of set.extras) {
        if (extra.probability <= 0) continue;
        if (!rolls.roll(hookCtx, extra.id, extra.probability)) continue;
        limit = limit
          ? {
            maxChars: Math.max(limit.maxChars, extra.minChars),
            maxLines: Math.max(limit.maxLines, extra.maxLines),
          }
          : { maxChars: extra.minChars, maxLines: extra.maxLines };
      }
      if (!limit) return baseFilter(text);
      const merged = {
        ...config,
        maxChars: Math.max(Number(config.maxChars) || 60, limit.maxChars),
        maxLines: Math.max(Number(config.maxLines) || 3, limit.maxLines),
      };
      return createOutputFilter(merged, logger)(text);
    }));

    const extraDesc = set.extras.length
      ? set.extras.map((item) => `${item.id}(${Math.round(item.probability * 100)}%)`).join('、')
      : '无';
    const card = cards.get(set.primary.id);
    const cardDesc = config.compact === false
      ? '关'
      : (card ? `${card.length} 字` : '生成中（暂用完整 skill）');
    logger.info(
      `主风格「${set.primary.name}」(${set.primary.id})：正文 ${set.primary.skill.body.length} 字`
      + ` | 风格卡：${cardDesc} | 追加风格：${extraDesc}`,
    );
    if (config.debug) {
      logger.info(
        `[debug] skillDir=${root} 可用=${set.available.filter((i) => i.ok).map((i) => i.id).join(',')}`,
      );
    }
  }

  function tryMount() {
    if (mounted) return true;
    const hooks = findHooks();
    if (!hooks || typeof hooks.registerPromptSection !== 'function') {
      return false;
    }
    if (Number(hooks.version) < 1) {
      logger.warn(`aiHooks 版本过低（${hooks.version}），风格插件不启用`);
      return false;
    }
    mount(hooks);
    return true;
  }

  if (!tryMount()) {
    // 主插件可能还没把扩展点挂上，等 ready 再试一次
    ctx.on('ready', () => {
      if (mounted) return;
      if (!tryMount()) {
        tried = true;
        logger.warn(
          '未找到 qqgmAiHooks 扩展点：请确认已启用并与本插件同时加载 @nestim/koishi-plugin-qq-group-manager（>= 1.2.5）',
        );
      }
    });
  }

  ctx.on('dispose', () => {
    for (const off of offs) {
      try {
        off();
      } catch { /* 忽略 */ }
    }
    offs.length = 0;
    mounted = false;
  });
}

module.exports = { name, inject, Config, apply };
