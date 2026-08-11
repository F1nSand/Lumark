// 回环幂等测试：render(md) → DOM → serialize → md 再次 render，视觉上必须等价
// 这是整个 WYSIWYG 编辑器正确性的基石。
// 比较策略：把两次渲染的 HTML 做"语义归一化"（非 pre/code 元素的文本空白折叠为单空格），
// 容忍列表 marker 空格、软换行等合法 markdown 格式差异，同时严格保住代码/公式/mermaid 内容。
// 注意：renderMarkdown 为异步（Shiki 懒加载高亮），所有断言均 await。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/markdown.mjs';
import { createSerializer, serializeDocument } from '../src/serialize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function parseToDom(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  return dom.window.document.getElementById('root');
}

// 序列化：HTML → markdown
function serialize(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  const td = createSerializer(dom.window.document);
  return serializeDocument(root, td);
}

// 语义归一化：非 pre/code 元素文本空白折叠为单空格；删除 align 属性（序列化桥梁，视觉由 style 表达）
function htmlSemantic(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  const fold = (el) => {
    if (el.matches && el.matches('pre, code, .katex-mathml')) return;
    el.removeAttribute && el.removeAttribute('align');
    for (const child of [...el.childNodes]) {
      if (child.nodeType === 3) child.nodeValue = child.nodeValue.replace(/\s+/g, ' ');
      else if (child.nodeType === 1) fold(child);
    }
  };
  fold(root);
  return root.innerHTML;
}

// 核心断言：md 序列化后再次渲染，视觉等价
async function assertVisualRoundtrip(md, label) {
  const once = htmlSemantic(await renderMarkdown(md));
  const md2 = serialize(await renderMarkdown(md));
  const twice = htmlSemantic(await renderMarkdown(md2));
  assert.equal(twice, once, `${label} 视觉不等价\n原始: ${JSON.stringify(md)}\n序列化: ${JSON.stringify(md2)}`);
}

test('纯文本段落', async () => {
  await assertVisualRoundtrip('Hello world', '段落');
});

test('标题层级', async () => {
  await assertVisualRoundtrip('# H1\n\n## H2\n\n### H3', '标题');
});

test('行内样式：粗体/斜体/行内代码/链接', async () => {
  await assertVisualRoundtrip('**粗体** *斜体* `code` [link](https://example.com)', '行内');
});

test('无序与有序列表', async () => {
  await assertVisualRoundtrip('- a\n- b\n  - b1\n\n1. one\n2. two', '列表');
});

test('引用块', async () => {
  await assertVisualRoundtrip('> 引用第一行\n> 引用第二行', '引用');
});

test('代码块（fenced + 语言）', async () => {
  await assertVisualRoundtrip('```javascript\nconst x = 1;\n```', '代码块');
});

test('GFM 表格', async () => {
  await assertVisualRoundtrip('| a | b |\n| --- | --- |\n| 1 | 2 |', '表格');
});

test('行内公式 $..$', async () => {
  await assertVisualRoundtrip('公式 $E=mc^2$ 行内', '行内公式');
});

test('块级公式 $$..$$', async () => {
  await assertVisualRoundtrip('$$\n\\int_0^1 x dx\n$$', '块级公式');
});

test('mermaid 代码块', async () => {
  await assertVisualRoundtrip('```mermaid\ngraph TD\n  A --> B\n```', 'mermaid');
});

test('完整 demo 文档回环', async () => {
  const md = fs.readFileSync(path.join(fixturesDir, 'demo.md'), 'utf-8');
  await assertVisualRoundtrip(md, 'demo 文档');
});

test('序列化保真：代码/公式/mermaid/表格还原', async () => {
  const html = await renderMarkdown(fs.readFileSync(path.join(fixturesDir, 'demo.md'), 'utf-8'));
  const md = serialize(html);
  // 关键内容与标记都必须存在
  assert.ok(md.includes('```javascript'), '代码块语言标签');
  assert.ok(md.includes('Hello, ${name}!'), '代码内容');
  assert.ok(md.includes('$$'), '块级公式标记');
  assert.ok(md.includes('E = mc^2'), '行内公式内容');
  assert.ok(md.includes('```mermaid'), 'mermaid 标记');
  assert.ok(md.includes('graph TD'), 'mermaid 内容');
  assert.ok(md.match(/\| 名称 \|/), '表格列');
});

test('标题生成文本 slug 锚点 id（供 TOC 链接跳转）', async () => {
  // 中文标题 slug 保留汉字
  const h1 = await renderMarkdown('# 第一章 介绍');
  assert.ok(h1.includes('<h1 id="第一章-介绍"'), '中文标题 slug，实际: ' + h1);
  // 重复标题追加 -1 后缀
  const dup = await renderMarkdown('## 重复\n\n## 重复\n\n## 重复');
  assert.ok(dup.includes('<h2 id="重复"'), '首个重复标题，实际: ' + dup);
  assert.ok(dup.includes('<h2 id="重复-1"'), '第二重复标题 -1，实际: ' + dup);
  assert.ok(dup.includes('<h2 id="重复-2"'), '第三重复标题 -2，实际: ' + dup);
  // 空标题回退 section-N
  const empty = await renderMarkdown('##\n\n##');
  assert.ok(empty.includes('id="section-0"') && empty.includes('id="section-1"'), '空标题回退，实际: ' + empty);
});

test('并发渲染标题 id 互不污染（headingId 每次渲染独立）', async () => {
  // 两个 renderMarkdown 同时执行（如 openFile 与 modal 编辑交错）
  const [a, b] = await Promise.all([
    renderMarkdown('# 第一章\n\n# 第一章'), // 两个相同标题 → 第一章 / 第一章-1
    renderMarkdown('## 子节\n\n## 子节'), // 两个相同标题 → 子节 / 子节-1
  ]);
  assert.ok(a.includes('<h1 id="第一章"') && a.includes('<h1 id="第一章-1"'), 'A 的重复标题，实际: ' + a);
  assert.ok(b.includes('<h2 id="子节"') && b.includes('<h2 id="子节-1"'), 'B 的重复标题，实际: ' + b);
  // 各自独立：A 的计数不因 B 的标题而偏移（若共用全局状态会串）
  assert.ok(a.includes('id="第一章-1"') && !a.includes('id="第一章-2"'), 'A 不受 B 干扰');
  assert.ok(b.includes('id="子节-1"') && !b.includes('id="子节-2"'), 'B 不受 A 干扰');
});

test('编辑后 HTML（contenteditable 产物）应能还原', () => {
  // 模拟 contenteditable 产生的杂散 <div>/<br>
  const html =
    '<p>第一段</p>' +
    '<div>杂散 div 内容<br>换行</div>' +
    '<ul><li>项目</li></ul>' +
    '<div class="md-block md-block--math" data-math="%5Cfrac%7B1%7D%7B2%7D" contenteditable="false"><span>渲染后公式</span><button class="md-block__edit">✎</button></div>';
  const md = serialize(html);
  assert.ok(md.includes('第一段'), '段落内容，实际: ' + md);
  assert.ok(md.includes('杂散 div 内容'), '杂散 div 内容');
  assert.ok(md.includes('项目'), '列表项内容');
  assert.ok(md.includes('$$'), '公式应从 data-math 还原为 $$..$$，实际: ' + md);
  assert.ok(md.includes('\\frac{1}{2}'), '公式内容');
});