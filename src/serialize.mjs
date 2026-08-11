// HTML → Markdown 序列化（WYSIWYG 的唯一出口）
// 纯函数、可 Node 测试。turndown + GFM + 自定义规则还原只读卡片。
// 工厂模式：createSerializer(document) —— renderer 传浏览器 document，测试传 jsdom document。
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export function createSerializer(doc) {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    bulletListMarker: '-',
    strongDelimiter: '**',
    emDelimiter: '*',
    document: doc,
  });

  td.use(gfm);
  td.remove(['.md-block__edit', 'button']);

  // ---- 行内公式：从 data-math 还原 $..$ ----
  td.addRule('inlineMath', {
    filter: (node) => node.classList && node.classList.contains('math-inline'),
    replacement: (_content, node) => {
      const tex = decodeURIComponent(node.getAttribute('data-math') || '');
      return '$' + tex + '$';
    },
  });

  // ---- 块级公式：$$..$$ ----
  td.addRule('blockMath', {
    filter: (node) => node.classList && node.classList.contains('md-block--math'),
    replacement: (_content, node) => {
      const tex = decodeURIComponent(node.getAttribute('data-math') || '');
      return '\n\n$$\n' + tex + '\n$$\n\n';
    },
  });

  // ---- mermaid：从 data-code 还原 ```mermaid ----
  td.addRule('mermaid', {
    filter: (node) => node.classList && node.classList.contains('md-block--mermaid'),
    replacement: (_content, node) => {
      const mermaidEl = node.querySelector('.mermaid');
      const code = decodeURIComponent(mermaidEl && mermaidEl.getAttribute('data-code') || '');
      return '```mermaid\n' + code.trim() + '\n```';
    },
  });

  // ---- 代码块：从 data-lang + code.textContent 还原 ----
  td.addRule('codeBlock', {
    filter: (node) => node.classList && node.classList.contains('md-block--code'),
    replacement: (_content, node) => {
      const lang = node.getAttribute('data-lang') || '';
      const codeEl = node.querySelector('code');
      const code = (codeEl ? codeEl.textContent : '').replace(/\n+$/, '');
      return '```' + lang + '\n' + code + '\n```';
    },
  });

  // ---- 表格：去掉外层只读卡片包装，交给 GFM table 规则 ----
  td.addRule('tableBlock', {
    filter: (node) => node.classList && node.classList.contains('md-block--table'),
    replacement: (content) => '\n\n' + content.trim() + '\n\n',
  });

  return td;
}

// 序列化单个块。
// 注意：turndown 的 turndown(node) 不处理 node 自身，只遍历其子节点。
// 因此必须用临时 wrapper 包裹该块，让 turndown 遍历 wrapper 的子节点（即块本身）时匹配到块的规则。
function serializeBlock(el, td) {
  const doc = el.ownerDocument;
  const wrapper = doc.createElement('div');
  wrapper.appendChild(el.cloneNode(true));
  return td.turndown(wrapper).trim();
}

// 整文序列化：逐块序列化后以空行拼接，保证块边界
export function serializeDocument(rootEl, td) {
  const blocks = [];
  for (const child of rootEl.children) {
    const s = serializeBlock(child, td);
    if (s) blocks.push(s);
  }
  return blocks.join('\n\n');
}
