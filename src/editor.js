// WYSIWYG 控制器：加载文档、渲染、编辑、保存、模式切换
// 核心不变量：mdSource 永远由显示 DOM 派生（serializeDocument），
// 输入过程中绝不整体重渲染（光标不丢），只在明确动作时重渲染。
import { renderMarkdown, clearShikiCache } from './markdown.mjs';
import { createSerializer, serializeDocument } from './serialize.mjs';
import { api, toast } from './ipc.js';
import { rebuildOutline } from './outline.js';
import { openModal } from './modal.js';
import { bindMermaidZoom } from './mermaid-zoom.js';

const content = () => document.getElementById('content');
const contentInner = () => document.querySelector('.content__inner');
const breadcrumb = () => document.getElementById('file-breadcrumb');
const toolbar = () => document.getElementById('toolbar');
const emptyState = () => document.getElementById('empty-state');
const modeBtn = () => document.getElementById('mode-btn');

const serializer = createSerializer(document);

// 当前文档状态
let activePath = null;
let mdSource = '';
let editMode = false;
let dirty = false; // 文档是否被编辑过（未编辑的文档切文件/切模式时不应重写盘）

// 保存管理
let saveChain = Promise.resolve();
let saveTimer = null;

// mermaid 懒加载：仅文档含图表时才动态 import 引擎，首次 init 一次（缓存 Promise）
let mermaidPromise = null;
function getMermaidTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
}
function loadMermaid() {
  if (!mermaidPromise) {
    // strict：mermaid 内置安全过滤，防止恶意 .md 的 label 注入 HTML（loose 允许原始 HTML）
    mermaidPromise = import('mermaid')
      .then((ns) => {
        const mermaid = ns.default ?? ns;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: getMermaidTheme() });
        return mermaid;
      })
      .catch((err) => {
        // 失败后重置缓存，允许下次重试（否则 rejected promise 永久缓存，图表永远不可用）
        mermaidPromise = null;
        throw err;
      });
  }
  return mermaidPromise;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function renderToDom(html) {
  const el = content();
  el.innerHTML = `<div class="content__inner">${html}</div>`;
  el.firstElementChild.contentEditable = String(editMode);
}

async function renderMermaid() {
  const nodes = [...content().querySelectorAll('.md-block--mermaid .mermaid')];
  if (!nodes.length) return;
  try {
    const mermaid = await loadMermaid();
    // 用 mermaid.render 逐块生成 SVG 替换（run 对已渲染节点会跳过，无法切主题重渲）
    for (const node of nodes) {
      const code = decodeURIComponent(node.getAttribute('data-code') || '');
      if (!code.trim()) continue;
      const id = 'mmd-' + Math.random().toString(36).slice(2, 8) + '-' + Math.random().toString(36).slice(2, 5);
      const { svg, bindFunctions } = await mermaid.render(id, code);
      const holder = document.createElement('div');
      holder.innerHTML = svg;
      const svgEl = holder.firstElementChild;
      node.replaceChildren(svgEl);
      bindFunctions?.(svgEl);
      fitMermaidBox(node, svgEl);
      bindMermaidZoom();
    }
  } catch (err) {
    console.error('[mermaid]', err);
    toast('图表渲染失败：' + (err?.message || err), 'error');
  }
}

// 图表框初始高度：横向图（宽>>高）按 100% 宽会压得很矮。
// 目标高度 clamp 在 [保底 200, 视口 70%]：矮图给可看高度，且不触发页面垂直滚动条
const MERMAID_MIN_H = 200;
function fitMermaidBox(node, svg) {
  const block = node.closest('.md-block--mermaid');
  if (!block) return;
  const vb = svg?.viewBox?.baseVal;
  if (!vb || !vb.width || !vb.height) return;
  const containerW = block.clientWidth - 24; // 减去 .md-block--mermaid padding
  const adaptH = (containerW * vb.height) / vb.width; // 100% 宽时的显示高度
  const maxH = Math.max(MERMAID_MIN_H, Math.round(window.innerHeight * 0.7));
  const targetH = Math.min(maxH, Math.max(MERMAID_MIN_H, Math.round(adaptH)));
  if (targetH > adaptH) {
    // 横向图（自然高低于目标）：高度优先，宽度按比例放大 → 超出容器则横向滚动
    svg.style.width = 'auto';
    svg.style.height = `${targetH}px`;
    block.classList.add('mermaid--wide');
  }
}

// ---------------------------------------------------------------------------
// 序列化与保存
// ---------------------------------------------------------------------------
// 同步：DOM → mdSource
function syncSource() {
  if (!activePath) return;
  mdSource = serializeDocument(contentInner(), serializer);
}

// 串行写盘队列（防乱序）
function enqueueSave(path, content) {
  saveChain = saveChain
    .then(async () => {
      try {
        await api.writeFile(path, content);
      } catch (err) {
        toast('保存失败：' + (err?.message || err), 'error', 4000);
      }
    })
    .catch(() => {});
  return saveChain;
}

// 立即保存（切文件/切模式/快捷键/窗口失焦）。force=true 时无条件写盘（Ctrl+S）。
export function flushSave(force = false) {
  if (!activePath) return Promise.resolve();
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty && !force) return Promise.resolve(); // 未编辑不写盘，避免 turndown 规范化重写
  syncSource();
  dirty = false;
  return enqueueSave(activePath, mdSource);
}

export function getMdSource() {
  return mdSource;
}

// 等待所有待写盘的保存完成（含 setEditMode 等内部触发的异步保存）
export async function flushAll() {
  if (!activePath) return;
  await flushSave(true);
  await saveChain;
}

// 收尾：重跑 mermaid + 重建大纲（多处重复的成对调用统一）
function rerenderChrome() {
  renderMermaid();
  rebuildOutline();
}

// 外部修改（工具栏插入卡片等）后的同步：序列化 → 保存 → 重跑 mermaid → 重建大纲
export function notifyExternalChange() {
  if (!activePath) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = null;
  syncSource();
  enqueueSave(activePath, mdSource);
  rerenderChrome();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    syncSource();
    dirty = false;
    enqueueSave(activePath, mdSource);
  }, 400);
}

// ---------------------------------------------------------------------------
// 打开 / 关闭文档
// ---------------------------------------------------------------------------
export async function openFile(path) {
  if (activePath && activePath === path) return;
  await flushSave(); // 先保存当前文档（dirty 才写盘）
  let res;
  try {
    res = await api.readFile(path);
  } catch (err) {
    // 文件被删/无权限/不在白名单：toast 提示，不崩溃、不污染 activePath
    toast('打开失败：' + (err?.message || err), 'error', 4000);
    return;
  }
  if (!res) return;
  activePath = path;
  mdSource = res.content;
  dirty = false;
  editMode = false;
  // 切文档：清空 shiki 高亮缓存，只保留当前文档的（避免跨文档缓存累积）
  clearShikiCache();
  renderToDom(await renderMarkdown(res.content));
  rebuildOutline(); // 先建大纲（只读 DOM 标题）；mermaid 懒加载可能在首次较慢
  await renderMermaid();
  setActiveFileUI(path);
  showEditor(true);
  updateModeBtn();
}

function setActiveFileUI(path) {
  breadcrumb().textContent = path.split(/[\\/]/).pop();
  breadcrumb().title = path;
}

export function showEditor(show) {
  toolbar().hidden = !show;
  emptyState().hidden = show;
}

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------
export async function setEditMode(on) {
  if (on === editMode) return;
  editMode = on;
  document.documentElement.dataset.editMode = on ? 'edit' : 'read';
  const inner = contentInner();
  if (!inner) return;
  if (!on) {
    // 进入读模式：先保存，再从 mdSource 整体重渲染（归一化 contenteditable 产生的 <div>/<br> 杂物）
    flushSave();
    renderToDom(await renderMarkdown(mdSource));
    rerenderChrome();
  } else {
    inner.contentEditable = 'true';
  }
  updateModeBtn();
}

export function toggleEditMode() {
  setEditMode(!editMode);
}

function updateModeBtn() {
  modeBtn().textContent = editMode ? '✓' : '✎';
  modeBtn().title = editMode ? '编辑模式（Ctrl+E 切回阅读）' : '阅读模式（Ctrl+E 进入编辑）';
}

export function getEditMode() {
  return editMode;
}

// ---------------------------------------------------------------------------
// 只读卡片（代码/表格/mermaid/公式）弹层编辑
// ---------------------------------------------------------------------------
function extractBlockMarkdown(block) {
  const kind = block.querySelector('.md-block__edit')?.dataset.editKind;
  if (kind === 'code') {
    const lang = block.getAttribute('data-lang') || '';
    const code = block.querySelector('code')?.textContent ?? '';
    return { title: '编辑代码块', initial: '```' + lang + '\n' + code + '\n```', hint: 'Fenced 代码块，支持语言标注，例如 ```javascript' };
  }
  if (kind === 'mermaid') {
    const code = decodeURIComponent(block.querySelector('.mermaid')?.getAttribute('data-code') || '');
    return { title: '编辑图表（Mermaid）', initial: '```mermaid\n' + code.trim() + '\n```', hint: 'Mermaid 图表语法，例如 graph TD' };
  }
  if (kind === 'math') {
    const tex = decodeURIComponent(block.getAttribute('data-math') || '');
    return { title: '编辑公式', initial: '$$\n' + tex + '\n$$', hint: 'LaTeX 公式，$$ 开头结尾' };
  }
  if (kind === 'table') {
    const table = block.querySelector('table');
    const inner = document.createElement('div');
    inner.appendChild(table.cloneNode(true));
    const md = serializer.turndown(inner).trim();
    return { title: '编辑表格', initial: md, hint: 'GFM 表格语法，用 | 分隔列' };
  }
  return null;
}

function bindBlockEdit() {
  content().addEventListener('click', async (e) => {
    if (!editMode) return;
    const btn = e.target.closest('.md-block__edit');
    if (!btn) return;
    e.preventDefault();
    const block = btn.closest('.md-block');
    if (!block) return;
    const spec = extractBlockMarkdown(block);
    if (!spec) return;
    const result = await openModal(spec);
    if (result == null) return;
    // 就地重渲染该块，不影响全文光标
    const html = await renderMarkdown(result);
    block.outerHTML = html;
    await renderMermaid();
    dirty = true;
    syncSource();
    enqueueSave(activePath, mdSource);
    rebuildOutline();
    toast('已更新');
  });
}

// ---------------------------------------------------------------------------
// 编辑事件
// ---------------------------------------------------------------------------
function bindEditEvents() {
  // input 防抖 → 同步 + 保存
  document.addEventListener('input', (e) => {
    if (!editMode) return;
    if (e.target.closest('.md-block')) return; // 只读卡片内部不触发
    if (e.target.id === 'modal-textarea') return;
    dirty = true;
    scheduleSave();
  });

  // 粘贴净化：富文本 → 纯文本
  document.addEventListener('paste', (e) => {
    if (!editMode) return;
    if (e.target.closest('.md-block')) return;
    if (e.target.id === 'modal-textarea') return;
    const text = e.clipboardData.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, text);
  });

  // Ctrl+S 强刷保存 / Ctrl+E 切模式 / Ctrl+B/I 行内样式
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      flushSave(true).then(() => toast('已保存'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      toggleEditMode();
    }
    if (editMode && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        document.execCommand('bold');
      } else if (k === 'i') {
        e.preventDefault();
        document.execCommand('italic');
      }
    }
  });

  // 链接点击：锚点（文档内 TOC）平滑滚动 / 外链走默认浏览器（读/编辑模式均生效）
  document.addEventListener('click', (e) => {
    if (e.target.closest('.md-block--mermaid')) return; // mermaid 图内链接不拦截，交给缩放交互
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      if (!id) return;
      const target = content().querySelector(`[id="${CSS.escape(id)}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      api.openExternal(href);
    }
  });

  // 窗口失焦 / 卸载：保存
  window.addEventListener('beforeunload', () => {
    if (editMode) flushSave();
  });
  window.addEventListener('blur', () => {
    if (editMode) flushSave();
  });
}

// 切主题重跑 mermaid：SVG 颜色渲染期烘焙，必须先重新 initialize 换主题再重渲
window.addEventListener('theme-changed', () => {
  if (!activePath) return;
  loadMermaid().then((mermaid) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: getMermaidTheme() });
    renderMermaid();
  });
});

bindBlockEdit();
bindEditEvents();
