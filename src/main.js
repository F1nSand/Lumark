// renderer 入口：装配各模块
import '../styles/style.css';
import 'katex/dist/katex.min.css';
import { log, toast, api } from './ipc.js';
import { openFolder, openSingleFile, refreshTree, bindFiletreeActions, setOnOpenFile, setOnFolderOpened, setActivePath, renderTree, loadRoot } from './filetree.js';
import { openFile, showEditor, toggleEditMode, setEditMode, flushSave, getEditMode, flushAll, getMdSource } from './editor.js';
import { renderMarkdown } from './markdown.mjs';
import { initTheme, toggleTheme } from './theme.js';
import { bindToolbar } from './toolbar.js';
import { initPanels, getPanelState } from './panels.js';

log('renderer loaded from app:// protocol');

initTheme();
initPanels();
bindFiletreeActions();
bindToolbar();

// 工具栏：主题 / 模式切换
document.getElementById('mode-btn').addEventListener('click', () => toggleEditMode());
document.querySelector('.toolbar [data-cmd="theme"]').addEventListener('click', () => toggleTheme());

// 文件树点击 → 打开文档
setOnOpenFile((path) => {
  setActivePath(path);
  openFile(path);
});

// 文件夹打开成功 → 显示编辑区
setOnFolderOpened(() => showEditor(true));

// 菜单动作
api.onMenu(async (action) => {
  switch (action) {
    case 'open-folder':
      openFolder();
      break;
    case 'open-file': {
      const p = await openSingleFile();
      if (p) {
        setActivePath(p);
        openFile(p);
      }
      break;
    }
    case 'toggle-theme':
      toggleTheme();
      break;
    case 'toggle-mode':
      toggleEditMode();
      break;
  }
});

// 目录变更 → 刷新树
api.onDirChanged(() => refreshTree());

// 拖拽打开：遮罩视觉反馈 + webUtils 取真实路径 → IPC 交给 main 打开
// 用 dragenter/dragleave 成对计数判断是否离开窗口，避免目标元素层级导致误判（遮罩 pointer-events: none）
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;
const isFilesDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!isFilesDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!isFilesDrag(e)) return;
  e.preventDefault();
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  dropOverlay.hidden = true;
  // preventDefault 阻止默认的 file:// 导航，改由 webUtils 解析真实路径后走 IPC
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const p = api.getPathForFile(file);
  if (p) api.dropPath(p);
});

api.onDropOpenFolder(({ root, tree }) => {
  loadRoot(root, tree);
  showEditor(true);
});
api.onDropOpenFile(({ path }) => {
  setActivePath(path);
  openFile(path);
});
api.onDropOpenFailed((path) => {
  toast('无法打开：文件不存在或不是 Markdown 文件', 'error', 4000);
});

// 测试钩子（自动化验证用）
window.__app = {
  // 诊断：直接渲染 markdown 文本，返回 HTML（验证 shiki 是否生效）
  async testRenderMarkdown(md) {
    try {
      const html = await renderMarkdown(md);
      const preClass = /<pre[^>]*class="([^"]*)"/.exec(html)?.[1] || null;
      return { ok: true, html: html.slice(0, 300), preClass, hasShiki: (preClass || '').includes('shiki') };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  testRenderTree(tree) {
    try {
      renderTree(tree);
      const rows = document.querySelectorAll('.ft-row').length;
      const files = document.querySelectorAll('.ft-row.ft-file').length;
      const dirs = document.querySelectorAll('.ft-row.ft-dir').length;
      return { ok: true, rows, files, dirs };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 真实加载根目录（含 watch 注册），供文件监听测试
  async testSetupTree(root, tree) {
    try {
      await loadRoot(root, tree);
      const fileCount = document.querySelectorAll('.ft-row.ft-file').length;
      return { ok: true, fileCount };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 检查文件树里是否存在指定文件名
  testTreeHasFile(basename) {
    const found = [...document.querySelectorAll('.ft-row.ft-file')].some(
      (r) => (r.dataset.path || '').replace(/\\/g, '/').split('/').pop() === basename
    );
    return { ok: true, found, files: [...document.querySelectorAll('.ft-row.ft-file')].map((r) => r.dataset.path.split(/[\\/]/).pop()) };
  },
  async testOpenFile(file) {
    try {
      await openFile(file);
      const doc = document;
      const headings = doc.querySelectorAll('.content__inner h1').length;
      const codeBlocks = doc.querySelectorAll('.md-block--code').length;
      const mathBlocks = doc.querySelectorAll('.md-block--math').length;
      const mathInline = doc.querySelectorAll('.math-inline').length;
      const tables = doc.querySelectorAll('.md-block--table').length;
      const mermaidNodes = doc.querySelectorAll('.mermaid').length;
      const outlineItems = doc.querySelectorAll('.outline .ol-item').length;
      const links = [...doc.querySelectorAll('.content__inner a')].map((a) => a.getAttribute('href'));
      const breadcrumb = doc.getElementById('file-breadcrumb').textContent;
      const editMode = doc.documentElement.dataset.editMode;
      return {
        ok: true,
        headings,
        codeBlocks,
        mathBlocks,
        mathInline,
        tables,
        mermaidNodes,
        outlineItems,
        links,
        breadcrumb,
        editMode,
        toolbarHidden: doc.getElementById('toolbar').hidden,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 大纲联动测试：滚动到指定标题，检查大纲高亮与点击跳转
  testOutline() {
    try {
      const scroller = document.getElementById('content');
      const headings = [...document.querySelectorAll('.content__inner h1, .content__inner h2, .content__inner h3')];
      if (headings.length < 2) return { ok: false, error: '标题不足 2 个' };
      // 滚动到第 2 个标题附近
      scroller.scrollTop = headings[1].offsetTop - scroller.offsetTop - 10;
      // 触发滚动后检查高亮（IO 异步，等一拍）
      return new Promise((resolve) => {
        setTimeout(() => {
          const active = document.querySelector('.outline .ol-item.ol-active');
          const idx = active ? Array.from(document.querySelectorAll('.outline .ol-item')).indexOf(active) : -1;
          // 点击第 3 个标题跳转
          const third = document.querySelectorAll('.outline .ol-item')[2];
          third.click();
          resolve({ ok: true, activeIdx: idx, outlineCount: document.querySelectorAll('.outline .ol-item').length });
        }, 300);
      });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 端到端编辑测试：进入编辑模式 → 改文本 → 保存 → 读模式重渲染
  async testEdit(file) {
    try {
      await openFile(file);
      setEditMode(true);
      const inner = document.querySelector('.content__inner');
      const p = inner.querySelector('p');
      if (!p) return { ok: false, error: '无段落可编辑' };
      p.textContent = '这是编辑后的第一段文字 EDITED_MARKER';
      p.dispatchEvent(new InputEvent('input', { bubbles: true })); // 走真实编辑路径（标记 dirty）
      await flushAll();
      const editModeDuring = getEditMode();
      const domHas = document.querySelector('.content__inner').textContent.includes('EDITED_MARKER');
      const mdPreview = (await window.__editApi.getMdSource?.()) || '';
      await setEditMode(false); // 读模式重渲染归一化（renderMarkdown 为异步，需等待）
      await window.__editApi.flushAll(); // 等待 setEditMode 触发的异步保存完成，避免写盘竞态
      const preserved = document.querySelector('.content__inner').textContent.includes('EDITED_MARKER');
      const outlineAfter = document.querySelectorAll('.outline .ol-item').length;
      return { ok: true, editModeDuring, domHas, mdHas: mdPreview.includes('EDITED_MARKER'), mdPreview: mdPreview.slice(0, 60), preserved, outlineAfter };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 工具栏测试：粗体 + 插入代码卡片
  async testToolbar(file) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await openFile(file);
      setEditMode(true);
      const inner = document.querySelector('.content__inner');
      const p = inner.querySelector('p');
      if (!p) return { ok: false, error: '无段落' };
      const sel = window.getSelection();
      // 选中第一段 → 粗体
      const r1 = document.createRange();
      r1.selectNodeContents(p);
      sel.removeAllRanges();
      sel.addRange(r1);
      document.querySelector('.toolbar [data-cmd="bold"]').click();
      const hasBold = !!inner.querySelector('b');
      // 光标放到末尾 → 插入代码卡片
      const endP = document.createElement('p');
      inner.appendChild(endP);
      const r2 = document.createRange();
      r2.selectNodeContents(endP);
      sel.removeAllRanges();
      sel.addRange(r2);
      document.querySelector('.toolbar [data-cmd="code"]').click();
      await sleep(120);
      const hasCode = !!inner.querySelector('.md-block--code');
      return { ok: hasBold && hasCode, hasBold, hasCode };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 只读卡片 modal 编辑测试：点编辑按钮 → 弹层 → 改代码 → 保存 → 就地重渲染
  async testModal(file) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await openFile(file);
      setEditMode(true);
      const btn = document.querySelector('.md-block--code .md-block__edit');
      if (!btn) return { ok: false, error: '无代码块编辑按钮' };
      btn.click();
      await sleep(60);
      const maskShown = !document.getElementById('modal-mask').hidden;
      const ta = document.getElementById('modal-textarea');
      ta.value = '```javascript\nconst edited = true;\n```';
      document.getElementById('modal-ok').click();
      await sleep(150);
      await window.__editApi.flushAll(); // 等待 modal 保存写盘完成
      const codeText = document.querySelector('.md-block--code code')?.textContent || '';
      const modalClosed = document.getElementById('modal-mask').hidden;
      const result = { ok: maskShown && codeText.includes('const edited = true;') && modalClosed, maskShown, codeText: codeText.slice(0, 40), modalClosed };
      return result;
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 主题切换测试：切换两次，检查 data-theme、持久化、背景色通知
  testTheme() {
    try {
      const { toggleTheme } = window.__themeApi || {};
      if (!toggleTheme) return { ok: false, error: 'theme api 未挂载' };
      toggleTheme();
      const t1 = document.documentElement.dataset.theme;
      toggleTheme();
      const t2 = document.documentElement.dataset.theme;
      const saved = localStorage.getItem('lumark-theme');
      return { ok: t1 === 'dark' && t2 === 'light', t1, t2, saved };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 面板折叠测试：点折叠按钮，断言 class + localStorage，再展开还原
  testPanelCollapse() {
    try {
      const before = window.__panelsApi.getPanelState();
      document.getElementById('btn-toggle-outline').click();
      const midOutline = window.__panelsApi.getPanelState().outline;
      document.getElementById('btn-toggle-tree').click();
      const midTree = window.__panelsApi.getPanelState().tree;
      const savedOutline = localStorage.getItem('lumark-outline-collapsed');
      const savedTree = localStorage.getItem('lumark-tree-collapsed');
      // 还原
      if (midOutline) document.getElementById('btn-toggle-outline').click();
      if (midTree) document.getElementById('btn-toggle-tree').click();
      const after = window.__panelsApi.getPanelState();
      return { ok: midOutline === true && midTree === true && savedOutline === '1' && savedTree === '1' && after.outline === false && after.tree === false, before, midOutline, midTree, savedOutline, savedTree, after };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
  // 目录展开反馈测试：点击两次应回到初始状态，且过程中 ft-dir--open 有变化
  testDirHighlight() {
    try {
      const dirRow = document.querySelector('.ft-row.ft-dir');
      if (!dirRow) return { ok: false, error: '无目录行' };
      const dirPath = dirRow.dataset.path;
      const before = dirRow.classList.contains('ft-dir--open');
      dirRow.click();
      const afterToggle = dirRow.classList.contains('ft-dir--open');
      dirRow.click(); // 还原
      const restored = dirRow.classList.contains('ft-dir--open');
      // 完整往返：状态翻转一次（before != afterToggle）且还原到初始（restored === before）
      const ok = before !== afterToggle && restored === before;
      return { ok, before, afterToggle, restored, dirPath };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },
};

// 测试钩子（端到端：编辑 → 序列化 → 写盘 / 主题切换）
window.__themeApi = { initTheme, toggleTheme, getTheme: () => document.documentElement.dataset.theme };
window.__editApi = {
  setEditMode,
  flushSave,
  flushAll,
  getEditMode,
  getMdSource,
};
window.__panelsApi = { initPanels, getPanelState };
