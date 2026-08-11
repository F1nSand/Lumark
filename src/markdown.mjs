// markdown 渲染管线：markdown-it + Shiki + KaTeX → HTML 字符串
// 纯函数、无 DOM，可在 Node 下直接测试。
// 输出约定：
//   - 代码块/mermaid/公式/表格 包进只读卡片 .md-block（contenteditable="false"）
//   - mermaid 输出为 <div class="mermaid" data-code="encodeURIComponent">原始源码</div>
//   - 公式输出为带 data-math（原始 LaTeX）的元素，便于 turndown 还原
// 代码高亮：Shiki（TextMate 语法，VS Code 同款），懒加载 + 双主题 CSS 变量（切主题免重渲染）
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import taskLists from 'markdown-it-task-lists';
import { full as emojiPlugin } from 'markdown-it-emoji';
import * as katexNS from 'katex';

// CJS/ESM interop 防御：部分包走 ESM build（named exports）时没有 default
const katex = katexNS.default ?? katexNS;

// ---- Shiki 懒加载（与 editor.js 的 loadMermaid 同模式）----
// 主题静态导入（不能用模板字符串动态 import——esbuild 无法静态分析会保留裸模块名）
import githubLight from '@shikijs/themes/github-light';
import oneDarkPro from '@shikijs/themes/one-dark-pro';

// 明暗主题名：与 @shikijs/themes/github-light / one-dark-pro 对应
const THEME_LIGHT = 'github-light';
const THEME_DARK = 'one-dark-pro';

// 语言白名单 getter：按需动态 import，避免静态打包拖慢冷启动
// name → getter 索引：高亮器初始不加载任何语言，渲染时按文档实际用到再 loadLanguage
const LANG_LOADERS = [
  ['javascript', () => import('@shikijs/langs/javascript')],
  ['typescript', () => import('@shikijs/langs/typescript')],
  ['python', () => import('@shikijs/langs/python')],
  ['bash', () => import('@shikijs/langs/bash')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['java', () => import('@shikijs/langs/java')],
  ['json', () => import('@shikijs/langs/json')],
  ['css', () => import('@shikijs/langs/css')],
  ['html', () => import('@shikijs/langs/html')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['markdown', () => import('@shikijs/langs/markdown')],
];
// name/别名 → getter：规范名 + shiki bundle 自带的别名都收录。
// 仅加载规范名时别名自动注册（实测 loadLanguage(javascript) 后 js/cjs/mjs 均可高亮），
// 因此这里把别名也映射到同一 getter，ensureLangLoaded 遇到别名即加载对应规范语言。
const LANG_INDEX = new Map(LANG_LOADERS); // name → getter
{
  // 别名 → 规范名（来自 @shikijs/langs/* bundle 的 aliases 字段，静态固化）
  const ALIASES = {
    js: 'javascript', cjs: 'javascript', mjs: 'javascript',
    ts: 'typescript', cts: 'typescript', mts: 'typescript',
    py: 'python',
    sh: 'bash', shell: 'bash', zsh: 'bash',
    rs: 'rust',
    yml: 'yaml',
    md: 'markdown',
    'c++': 'cpp',
  };
  // 规范名静态存在，直接设置（别名与规范名互不冲突）
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    LANG_INDEX.set(alias, LANG_INDEX.get(canonical));
  }
}

// shiki 高亮记忆化（LRU）：读/编辑切换时同一代码块避免重复 codeToHtml
// 上限从 100 降到 20：仍覆盖单文档读/编辑模式切换的重复高亮，
// 但跨文档切换时（openFile 会 clearShikiCache）不再让大量历史代码块 HTML 长期驻留。
const SHIKI_CACHE_MAX = 20;
const shikiCache = new Map();

// 切文档时清空缓存：只保留当前文档的高亮结果，避免长会话内存线性累积
export function clearShikiCache() {
  shikiCache.clear();
}

let shikiPromise = null;
function loadShiki() {
  if (!shikiPromise) {
    shikiPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
      // 初始零语言：语法按文档实际用到再 loadLanguage，降低基线内存
      // 纯 JS 正则引擎（无 WASM，避免 CSP/资源改动）；forgiving 跳过个别不兼容语法规则
      return createHighlighterCore({
        themes: [githubLight, oneDarkPro],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })().catch((err) => {
      // 失败后重置缓存，允许下次重试（否则 rejected promise 永久缓存，高亮永远不可用）
      shikiPromise = null;
      throw err;
    });
  }
  return shikiPromise;
}

// 确保某语言已加载（幂等：已加载则 no-op；别名经 LANG_INDEX 解析到规范名）。
// 注意：非白名单语言会被 LANG_INDEX.get 返回 undefined → 交给 codeToHtml 抛错 → 调用方 catch → plain 兜底
async function ensureLangLoaded(hl, lang, loadedSet) {
  if (loadedSet.has(lang)) return;
  const getter = LANG_INDEX.get(lang);
  if (!getter) return;
  const bundle = await getter();
  // shiki v4 语言 bundle 的 default 导出是 grammar 数组，loadLanguage 接受数组
  await hl.loadLanguage(bundle.default);
  // 记录规范名 + 别名已加载（加载后 getLoadedLanguages 含规范名，别名也自动注册）
  loadedSet.add(bundle.default[0]?.name || lang);
}

// markdown fence 内嵌代码（如 ```markdown 里再嵌 ```js）依赖 embeddedLangsLazy 语言完整加载。
// 改动前这些白名单语言启动即预载，改动后需在加载 markdown 时同步预载其白名单内嵌语言，
// 保持 markdown 内嵌代码高亮与改动前等效（实测不改则内嵌 js 从 12 → 8 span）。
// 注意：shiki 的 embeddedLangsLazy 机制自身也会懒加载嵌入语言，这里主动预载只是保证完整高亮。
async function ensureMarkdownEmbeddedLangs(hl, loadedSet) {
  const bundle = await LANG_INDEX.get('markdown')();
  const grammar = bundle.default.find((g) => g && g.embeddedLangsLazy);
  if (!grammar) return;
  // 并行预载白名单内、被 markdown 内嵌引用的语言（58 种中大部分非白名单，忽略）
  await Promise.all(
    (grammar.embeddedLangsLazy || []).map(async (embedded) => {
      if (!LANG_INDEX.has(embedded) || loadedSet.has(embedded)) return;
      try {
        await ensureLangLoaded(hl, embedded, loadedSet);
      } catch (e) {
        console.error('[shiki] load embedded ' + embedded, e?.message || e);
      }
    })
  );
}

// 有界并发池：最多 limit 个异步任务同时运行，按输入顺序收集结果。
// 摊平多代码块文档的高亮尖峰（N 个 codeToHtml 同时跑 → 并发 4），输出顺序保持不变。
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx], idx);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// 标题锚点 id：基于文本 slug 生成，供文档内 TOC 链接（[标题](#标题)）跳转
// GitHub 风格 slug：小写、空白转 -、保留字母/数字（含中文），合并连续 -，去首尾 -
function slugify(text) {
  const s = String(text)
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return s;
}

// 唯一标题 id：同 slug 出现多次追加 -1、-2…。
// 状态存 env（每次渲染独立），避免并发渲染（openFile 与 modal 编辑交错）互相污染
function headingId(text, env) {
  const seen = (env.headingSeen ||= new Set());
  const fallback = (env.headingFallback ||= 0);
  const base = slugify(text) || `section-${fallback}`;
  env.headingFallback = fallback + 1;
  let id = base;
  let n = 1;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// markdown-it parser 单例：模块加载时构建并注册插件/规则，避免每次渲染重建
const mdit = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

{
  // ---- 数学：KaTeX ----
  mdit.use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { throwOnError: false, strict: false },
  });

  mdit.use(taskLists, { enabled: false });
  mdit.use(emojiPlugin);

  // ---- fence 重写：mermaid vs 代码，都包进只读卡片 ----
  mdit.renderer.rules.fence = (tokens, idx, _opts, env, slf) => {
    const t = tokens[idx];
    const info = t.info ? mdit.utils.unescapeAll(t.info).trim() : '';
    const lang = info.split(/\s+/)[0];
    const content = t.content;

    if (lang === 'mermaid') {
      return (
        `<div class="md-block md-block--mermaid" contenteditable="false">` +
        `<button class="md-block__edit" data-edit-kind="mermaid" title="编辑图表">✎</button>` +
        `<div class="mermaid" data-code="${encodeURIComponent(content)}">${escapeHtml(content)}</div>` +
        `</div>`
      );
    }

    // 优先使用 Shiki 预高亮结果（env.fenceHtml，由异步渲染入口填充）
    const highlighted = env?.fenceHtml?.get(idx);
    const langLabel = lang ? escapeHtml(lang) : '';
    if (highlighted) {
      return (
        `<div class="md-block md-block--code" contenteditable="false" data-lang="${langLabel}">` +
        `<button class="md-block__edit" data-edit-kind="code" title="编辑代码">✎</button>` +
        // shiki 输出自带 <pre class="shiki">，给 <code> 补 hljs 类以区分行内代码
        highlighted.replace(/<code(?=[\s>])/i, '<code class="hljs"') +
        `</div>`
      );
    }

    // 回退：未知/未加载语言 → 纯文本转义（保证任何文档都能渲染）
    return (
      `<div class="md-block md-block--code" contenteditable="false" data-lang="${langLabel}">` +
      `<button class="md-block__edit" data-edit-kind="code" title="编辑代码">✎</button>` +
      `<pre><code class="hljs">${escapeHtml(content)}</code></pre>` +
      `</div>`
    );
  };

  // ---- 标题打锚点 id（基于标题文本 slug，供文档内 TOC 链接跳转）----
  // 注意：markdown-it 15 的 render 用 token.type（heading_open）查规则，注册 h1..h6 无效
  const headingBase = (tokens, idx, _o, _e, slf) => slf.renderToken(tokens, idx, _o);
  mdit.renderer.rules.heading_open = (tokens, idx, opts, env, slf) => {
    const id = headingId(tokens[idx + 1]?.content || '', env);
    const attrs = [...(tokens[idx].attrs || [])];
    if (id) attrs.push(['id', id]);
    tokens[idx].attrs = attrs;
    return headingBase(tokens, idx, opts, env, slf);
  };

  // ---- 表格包只读卡片 ----
  // 注意：markdown-it 15 默认 rules 里 table_open/table_close 可能未定义，fallback 到 renderToken
  const defaultOpen = (tokens, idx, _o, _e, slf) => slf.renderToken(tokens, idx, _o);
  const defaultClose = (tokens, idx, _o, _e, slf) => slf.renderToken(tokens, idx, _o);
  const baseTableOpen = mdit.renderer.rules.table_open || defaultOpen;
  mdit.renderer.rules.table_open = (tokens, idx, opts, env, slf) => {
    const inner = baseTableOpen(tokens, idx, opts, env, slf);
    return (
      `<div class="md-block md-block--table" contenteditable="false">` +
      `<button class="md-block__edit" data-edit-kind="table" title="编辑表格">✎</button>` +
      inner
    );
  };
  const baseTableClose = mdit.renderer.rules.table_close || defaultClose;
  mdit.renderer.rules.table_close = (tokens, idx, opts, env, slf) => {
    const inner = baseTableClose(tokens, idx, opts, env, slf);
    return inner + `</div>`;
  };

  // 表格列对齐：markdown-it 15 把 align 放 attrs 的 style 里，turndown GFM 只认 align 属性。
  // 这里给 th 附加 align 属性作为序列化桥梁（视觉仍由 style 表达）。
  mdit.renderer.rules.th_open = (tokens, idx, opts, env, slf) => {
    const token = tokens[idx];
    const attrs = token.attrs || [];
    const styleAttr = attrs.find((a) => a[0] === 'style');
    if (styleAttr && !attrs.some((a) => a[0] === 'align')) {
      const m = /text-align:\s*(left|center|right)/.exec(styleAttr[1]);
      if (m) token.attrs = [...attrs, ['align', m[1]]];
    }
    return slf.renderToken(tokens, idx, opts);
  };

  // ---- 公式包 data-math（tex 去首尾换行，texmath 的 token.content 常含 \n）----
  mdit.renderer.rules.math_inline = (tokens, idx) => {
    const tex = tokens[idx].content.trim();
    let html;
    try {
      html = katex.renderToString(tex, { throwOnError: false, strict: false });
    } catch (_) {
      html = escapeHtml(tex);
    }
    return `<span class="math-inline" contenteditable="false" data-math="${encodeURIComponent(tex)}">${html}</span>`;
  };
  mdit.renderer.rules.math_block = (tokens, idx) => {
    const tex = tokens[idx].content.trim();
    let html;
    try {
      html = katex.renderToString(tex, { throwOnError: false, strict: false, displayMode: true });
    } catch (_) {
      html = escapeHtml(tex);
    }
    return (
      `<div class="md-block md-block--math" contenteditable="false" data-math="${encodeURIComponent(tex)}">` +
      `<button class="md-block__edit" data-edit-kind="math" title="编辑公式">✎</button>` +
      html +
      `</div>`
    );
  };

}

// 渲染入口：异步预高亮代码 fence，再同步 render（其余规则不受影响）
// 双主题 CSS 变量（defaultColor:false）→ 切主题只改 CSS，无需重渲染
export async function renderMarkdown(md) {
  const env = {}; // headingSeen/headingFallback 由 headingId 惰性初始化，每次渲染独立（避免并发竞态）
  const tokens = mdit.parse(md, env);

  // 收集需要高亮的代码 fence（mermaid 走独立分支）
  const jobs = [];
  const usedLangs = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'fence') continue;
    const info = t.info ? mdit.utils.unescapeAll(t.info).trim() : '';
    const lang = info.split(/\s+/)[0];
    if (lang === 'mermaid') continue;
    jobs.push({ i, lang, content: t.content });
    if (lang) usedLangs.add(lang);
  }

  // 批量加载本文档实际用到的语言（已加载则 no-op；非白名单语言跳过 → 走 plain 兜底）
  if (usedLangs.size > 0) {
    const hl = await loadShiki();
    const loadedSet = new Set(hl.getLoadedLanguages()); // 幂等检查用 Set，避免多次线性扫描
    // 并行加载；单个失败独立捕获，不阻断整篇渲染
    await Promise.all(
      [...usedLangs].map(async (lang) => {
        try {
          await ensureLangLoaded(hl, lang, loadedSet);
        } catch (e) {
          console.error('[shiki] loadLanguage(' + lang + ')', e?.message || e);
        }
      })
    );
    // markdown fence 内嵌代码依赖嵌入语言完整加载，保持与改动前等效
    // （usedLangs 可能存别名如 'md'，加载 markdown 后检查规范名）
    if (usedLangs.has('markdown') || loadedSet.has('markdown')) {
      try {
        await ensureMarkdownEmbeddedLangs(hl, loadedSet);
      } catch (e) {
        console.error('[shiki] markdown embedded langs', e?.message || e);
      }
    }
  }

  // 有界并发高亮（并发 4）；单个失败回退纯文本（不阻断整篇渲染）
  const results = await mapPool(jobs, 4, async (j) => {
    try {
      if (!j.lang) return null;
      // 记忆化：读/编辑模式切换时同一代码块重复渲染，按 lang+content 缓存 shiki HTML
      const cacheKey = `${j.lang} ${j.content}`;
      if (shikiCache.has(cacheKey)) {
        // 命中：刷新为最近使用（真 LRU，map 删除再重插移到最后）
        const cached = shikiCache.get(cacheKey);
        shikiCache.delete(cacheKey);
        shikiCache.set(cacheKey, cached);
        return { i: j.i, html: cached };
      }
      const hl = await loadShiki();
      const html = await hl.codeToHtml(j.content, {
        lang: j.lang,
        themes: { light: THEME_LIGHT, dark: THEME_DARK },
        defaultColor: false,
        cssVariablePrefix: '--shiki-',
      });
      // LRU：超容量删最旧（map 首项），防止长期使用内存膨胀
      shikiCache.set(cacheKey, html);
      if (shikiCache.size > SHIKI_CACHE_MAX) {
        shikiCache.delete(shikiCache.keys().next().value);
      }
      return { i: j.i, html };
    } catch (e) {
      console.error('[shiki]', e?.message || e);
      return null;
    }
  });
  env.fenceHtml = new Map();
  for (const r of results) if (r) env.fenceHtml.set(r.i, r.html);

  return mdit.renderer.render(tokens, mdit.options, env);
}
