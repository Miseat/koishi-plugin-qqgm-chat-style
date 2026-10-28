/**
 * lib/compact.js —— 风格卡压缩。
 *
 * 背景：一份完整的风格 skill 动辄 4000+ 字，而它每次模型调用都要整段塞进
 * system prompt。真实用量里这是最大的一块固定开销。
 *
 * 做法：
 *   - 第一次运行时让模型把 skill 正文蒸馏成一张 700 字左右的「风格卡」
 *     （保留人设、语气、句长、口癖、称呼、禁忌；丢掉示例、解释、元信息）；
 *   - 风格卡按 skill 正文的哈希缓存到 `<skillDir>/.style-cards.json`，
 *     正文没变就一直复用，不会每次启动都调模型；
 *   - 生成失败时不影响聊天：继续用完整 skill，隔一段时间再重试。
 *
 * 依赖主插件暴露的 qqgmAiRuntime.chat()；拿不到就静默跳过。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_FILE = '.style-cards.json';
const RETRY_MS = 10 * 60 * 1000;
/** 压缩提示词版本：改了提示词就 +1，缓存哈希跟着变，旧卡自动重生成 */
const PROMPT_VERSION = 2;

function hashSkill(skill) {
  const body = String((skill && skill.body) || '');
  return crypto.createHash('sha256').update(`${PROMPT_VERSION}|${body}`).digest('hex').slice(0, 16);
}

function cleanCard(raw, maxChars) {
  let text = String(raw || '').trim();
  if (!text) return '';
  text = text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
    .trim();
  if (!text) return '';

  const limit = Math.max(50, Number(maxChars) || 900);
  if (text.length > limit) {
    const slice = text.slice(0, limit);
    const cut = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('；'),
      slice.lastIndexOf('\n'),
    );
    text = cut >= Math.floor(limit * 0.5) ? slice.slice(0, cut + 1) : `${slice}…`;
  }
  // 模型在字数上限处截断时，可能停在一个逗号/顿号上：退回到最近的完整句
  if (/[，、：；,;]$/.test(text)) {
    const cut = Math.max(text.lastIndexOf('。'), text.lastIndexOf('\n'));
    if (cut > text.length * 0.6) text = text.slice(0, cut + 1).trim();
  }
  return text.trim();
}

/** 让模型把 skill 压成风格卡 */
function buildCompactPrompt(skill, maxChars) {
  const name = (skill && (skill.name || skill.id)) || '当前风格';
  const system = [
    '你在把一份「聊天风格说明」压缩成一张更短的风格卡，供另一个模型直接照着说话。',
    '',
    '必须保留：',
    '- 人设身份：这个角色是谁、怎么称呼别人、自称什么；',
    '- 语气与态度：说话冲不冲、爱不爱抬杠、是否骂人；',
    '- 句长与节奏：一句话大概多长、一次说几句；',
    '- 高频口癖与语气词（挑最有辨识度的，不要抄整段）；',
    '- 明确的禁忌与边界。',
    '',
    '如果原文里写了下面这些「行为机制」，必须原样保留其骨架，不能只留态度：',
    '- 模式与切换：接话 / 锐评 / 对线 / 收着说 分别在什么信号下触发、大概多长；',
    '- 锐评与暴论的结构：先给结论、再给机制、最后补一刀；或者「接住 → 换层 → 给证据 → 补刀/留台阶」；',
    '- 骂人分档与使用范围（哪些档位只能在对喷模式用）、对喷的退出条件；',
    '- 什么时候必须收嘴、脱角色。',
    '',
    '必须丢掉：',
    '- 背景故事、来源说明、示例对话、作者/版本/标签等元信息；',
    '- 重复解释、教学式说明、“这段用来……”之类的描述。',
    '',
    '输出要求：',
    `- 一张纯文本风格卡，不超过 ${maxChars} 字；`,
    '- 锐评/暴论的部分宁可占篇幅，也不要压成一句“爱抬杠”；',
    '- 接近字数上限时用一句完整的话收尾，不要截断在半句；',
    '- 用第二人称写（“你说话……”），像给演员的角色提示；',
    '- 不要标题、编号、列表、Markdown、代码块；',
    '- 不要新增原说明里没有的设定。',
  ].join('\n');

  const user = [
    `【原始风格说明：${name}】`,
    String((skill && skill.body) || '').trim(),
    '',
    '现在输出压缩后的风格卡。',
  ].join('\n');

  return { system, user };
}

class StyleCardStore {
  constructor(options = {}) {
    this.ctx = options.ctx;
    this.root = options.root;
    this.logger = options.logger;
    this.config = options.config || {};
    this.enabled = this.config.compact !== false;
    const configured = Number(this.config.compactMaxChars);
    this.maxChars = Math.max(200, Math.min(3000, Number.isFinite(configured) && configured > 0 ? configured : 900));
    this.model = String(this.config.compactModel || '').trim();

    this.texts = new Map();
    this.pending = new Map();
    this.retryAt = new Map();
    this.file = path.join(this.root, CACHE_FILE);
    this.cache = this.readCache();
  }

  readCache() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  writeCache() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.logger?.warn?.(`[style-card] 写入缓存失败: ${String(error)}`);
    }
  }

  /** 当前可用的风格卡文本；没有就返回 null（调用方继续用完整 skill） */
  get(id) {
    if (!this.enabled) return null;
    return this.texts.get(id) || null;
  }

  /** 确保该 skill 的风格卡已就绪（命中缓存 / 后台生成 / 冷却中跳过） */
  ensure(skill, id) {
    if (!this.enabled || !skill || !id) return;
    if (this.texts.has(id) || this.pending.has(id)) return;
    if ((this.retryAt.get(id) || 0) > Date.now()) return;

    const hash = hashSkill(skill);
    const cached = this.cache[id];
    if (cached && cached.hash === hash && typeof cached.text === 'string' && cached.text.trim()) {
      this.texts.set(id, cached.text);
      this.logger?.info?.(
        `[style-card] ${id} 命中缓存：${cached.text.length} 字（原 ${String(skill.body || '').length} 字）`,
      );
      return;
    }

    this.pending.set(id, this.generate(skill, id, hash).finally(() => this.pending.delete(id)));
  }

  resolveRuntime() {
    try {
      const value = this.ctx.root.get('qqgmAiRuntime');
      if (value && typeof value.chat === 'function') return value;
    } catch { /* ignore */ }
    return null;
  }

  async generate(skill, id, hash) {
    const runtime = this.resolveRuntime();
    if (!runtime) {
      // 主插件还没挂上门面：等下一次 AI 回复时再试
      this.retryAt.set(id, Date.now() + 60 * 1000);
      return;
    }

    const prompt = buildCompactPrompt(skill, this.maxChars);
    try {
      const result = await runtime.chat({
        system: prompt.system,
        user: prompt.user,
        temperature: 0.2,
        maxTokens: Math.max(800, Math.min(3000, this.maxChars * 4)),
        model: this.model || undefined,
      });
      if (!result || !result.ok) {
        this.retryAt.set(id, Date.now() + RETRY_MS);
        this.logger?.warn?.(`[style-card] ${id} 生成失败: ${result && result.error}`);
        return;
      }
      const text = cleanCard(result.text, this.maxChars);
      if (!text) {
        this.retryAt.set(id, Date.now() + RETRY_MS);
        this.logger?.warn?.(`[style-card] ${id} 生成结果为空，继续用完整 skill`);
        return;
      }

      this.cache[id] = {
        hash,
        text,
        chars: text.length,
        sourceChars: String(skill.body || '').length,
        model: this.model || '',
        at: new Date().toISOString(),
      };
      this.writeCache();
      this.texts.set(id, text);
      this.logger?.info?.(
        `[style-card] ${id} 已生成：${text.length} 字（原 ${String(skill.body || '').length} 字，`
        + `每次省约 ${Math.max(0, String(skill.body || '').length - text.length)} 字）`,
      );
    } catch (error) {
      this.retryAt.set(id, Date.now() + RETRY_MS);
      this.logger?.warn?.(`[style-card] ${id} 生成异常: ${String(error)}`);
    }
  }
}

module.exports = {
  StyleCardStore,
  buildCompactPrompt,
  cleanCard,
  hashSkill,
};
