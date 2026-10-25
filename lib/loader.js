/**
 * .skill 加载器：只接受“聊天风格”类 skill。
 *
 * 判定条件（满足其一）：
 *   - front matter: kind: chat-style
 *   - front matter: metadata.category 在 allowCategories 里（默认 persona-chat / chat-style）
 *
 * 正文处理：
 *   - 去掉“文件索引”整节（引用的 references/examples/scripts 不会随插件加载）
 *   - 去掉提到 references/examples/scripts/eval 路径的行
 *   - 去掉代码块、HTML 注释
 *   - 拒绝含执行/联网/系统提示覆盖等内容的文件
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ALLOW_CATEGORIES = ['persona-chat', 'chat-style'];
const MAX_BYTES = 16 * 1024;
const MIN_BYTES = 200;

const DENY_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above)\s+instructions/i,
  /忽略(以上|之前|前面)(的)?(所有)?(指令|提示)/,
  /(系统提示|system\s*prompt)/i,
  /(执行|运行)(命令|脚本|代码)/,
  /(读取|打开|写入|删除)(文件|目录)/,
  /(pip|npm|yarn)\s+install/i,
  /(python|node|bash|powershell)\s+/i,
  /https?:\/\//i,
  /file:\/\//i,
  /<script\b/i,
  /(工具调用|函数调用|tool\s*call|function\s*call)/i,
];

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function parseFrontMatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { front: '', body: raw, meta: {} };
  const front = match[1];
  const body = raw.slice(match[0].length).replace(/^\n+/, '');
  const pick = (re) => {
    const m = re.exec(front);
    return m ? m[1].trim() : '';
  };
  return {
    front,
    body,
    meta: {
      name: pick(/^name:\s*(.+)$/m),
      kind: pick(/^\s*kind:\s*(\S+)\s*$/m),
      category: pick(/^\s*category:\s*(\S+)\s*$/m),
      version: pick(/^\s*version:\s*(\S+)\s*$/m),
    },
  };
}

function stripFileIndex(body) {
  // 去掉 “## 文件索引” 到下一个二级标题之前（逐行处理，避免正则跨节误伤）
  const out = [];
  let skipping = false;
  for (const line of String(body).split(/\r?\n/)) {
    if (/^##\s*文件索引\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^##\s+/.test(line)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function stripFileReferences(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => !/(^|[\s`(])(references|examples|scripts|eval)\//.test(line))
    .join('\n')
    .replace(/`(?:references|examples|scripts|eval)\/[^`]*`/g, '');
}

function stripCodeAndComments(body) {
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function validateBody(body) {
  const text = body.trim();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < MIN_BYTES) return `正文过短（${bytes} 字节）`;
  if (bytes > MAX_BYTES) return `正文过大（${bytes} 字节，上限 ${MAX_BYTES}）`;
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(text)) return `正文命中禁用内容：${pattern}`;
  }
  if (!/[\u4e00-\u9fa5]/.test(text)) return '正文没有中文内容';
  return '';
}

function loadSkillFromDir(dir, options = {}) {
  const id = path.basename(dir);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) {
    return { ok: false, id, dir, reason: '缺少 SKILL.md' };
  }
  const raw = readText(file);
  const { body, meta } = parseFrontMatter(raw);
  const allowCategories = options.allowCategories || DEFAULT_ALLOW_CATEGORIES;

  const isChatStyle = meta.kind === 'chat-style' || allowCategories.includes(meta.category);
  if (!isChatStyle) {
    return {
      ok: false,
      id,
      dir,
      reason: `不是聊天风格 skill（kind=${meta.kind || '-'} category=${meta.category || '-'}）`,
    };
  }

  let cleaned = stripFileIndex(body);
  cleaned = stripFileReferences(cleaned);
  cleaned = stripCodeAndComments(cleaned);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  const invalid = validateBody(cleaned);
  if (invalid) return { ok: false, id, dir, reason: invalid };

  return {
    ok: true,
    skill: {
      id,
      dir,
      name: meta.name || id,
      category: meta.category || '',
      kind: meta.kind || '',
      version: meta.version || '',
      body: cleaned,
    },
  };
}

function listSkillDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push(dir);
  }
  // 允许 skillDir 本身就是 skill 目录
  if (!out.length && fs.existsSync(path.join(rootDir, 'SKILL.md'))) out.push(rootDir);
  return out;
}

/**
 * 扫描目录并选出要启用的 skill。
 * @returns {{ skill: object|null, warnings: string[], skills: object[] }}
 */
function loadConfiguredSkill(rootDir, options = {}) {
  const dirs = listSkillDirs(rootDir);
  const warnings = [];
  if (!dirs.length) {
    return { skill: null, warnings: [`目录下没有找到含 SKILL.md 的 skill：${rootDir}`], skills: [] };
  }

  const skills = [];
  for (const dir of dirs) {
    const result = loadSkillFromDir(dir, options);
    if (result.ok) {
      skills.push(result.skill);
    } else {
      warnings.push(`跳过 ${result.id}：${result.reason}`);
    }
  }

  if (!skills.length) {
    return { skill: null, warnings, skills: [] };
  }

  const wanted = String(options.style || '').trim();
  if (wanted) {
    const found = skills.find((item) => item.id === wanted || item.name === wanted);
    if (!found) {
      return {
        skill: null,
        warnings: [...warnings, `指定的风格「${wanted}」不存在；可用：${skills.map((s) => s.id).join(', ')}`],
        skills,
      };
    }
    return { skill: found, warnings, skills };
  }

  if (skills.length > 1) {
    warnings.push(`目录下有多个可用风格，默认使用 ${skills[0].id}（可用 style 配置指定）`);
  }
  return { skill: skills[0], warnings, skills };
}

module.exports = {
  DEFAULT_ALLOW_CATEGORIES,
  parseFrontMatter,
  loadSkillFromDir,
  loadConfiguredSkill,
  listSkillDirs,
  validateBody,
};
