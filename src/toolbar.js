// 工具栏：行内样式/标题/列表/引用 用 execCommand；代码/表格/公式/图表 插入只读卡片
import { renderMarkdown } from './markdown.mjs';
import { getEditMode, notifyExternalChange, flushAll } from './editor.js';
import { toast } from './ipc.js';

function contentInner() {
  return document.querySelector('.content__inner');
}

// 在光标处插入渲染后的只读卡片
async function insertCard(mdFragment) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const template = document.createElement('template');
  template.innerHTML = await renderMarkdown(mdFragment);
  const node = template.content.firstElementChild;
  if (!node) return;
  // 若在段落中间，先把范围收缩到块边界外
  range.deleteContents();
  range.insertNode(node);
  // 光标移到卡片之后
  range.setStartAfter(node);
  range.collapse(true);
  const br = document.createElement('br');
  range.insertNode(br);
  sel.removeAllRanges();
  sel.addRange(range);
}

const CARD_TEMPLATES = {
  code: '```javascript\n// 在这里编写代码…\n```',
  table: '| 列1 | 列2 |\n| --- | --- |\n|  |  |',
  math: '$$\n\\int_0^1 f(x) dx = \\frac{1}{2}\n$$',
  mermaid: '```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```',
};

export async function handleCommand(cmd) {
  const inner = contentInner();
  if (!inner) return;
  if (!getEditMode()) {
    toast('请先进入编辑模式（Ctrl+E）', 'info');
    return;
  }
  inner.focus();

  switch (cmd) {
    case 'bold':
      document.execCommand('bold');
      break;
    case 'italic':
      document.execCommand('italic');
      break;
    case 'heading':
      document.execCommand('formatBlock', false, 'h3');
      break;
    case 'ul':
      document.execCommand('insertUnorderedList');
      break;
    case 'ol':
      document.execCommand('insertOrderedList');
      break;
    case 'quote':
      document.execCommand('formatBlock', false, 'blockquote');
      break;
    case 'code':
    case 'table':
    case 'math':
    case 'mermaid':
      // 卡片插入：DOM 直接改，走 notifyExternalChange 同步+保存
      await insertCard(CARD_TEMPLATES[cmd]);
      notifyExternalChange();
      break;
    default:
      return;
  }
}

export function bindToolbar() {
  document.querySelectorAll('.toolbar [data-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd;
      if (cmd === 'theme') return; // 主题按钮单独绑定
      if (cmd === 'mode') return; // 模式按钮单独绑定
      await handleCommand(cmd);
    });
  });
}
