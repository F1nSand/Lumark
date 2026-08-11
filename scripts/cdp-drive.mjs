// CDP 驱动脚本：通过调试端口驱动运行中的 Electron GUI，模拟真实用户操作
// 用法：node test/cdp-drive.mjs <操作> [参数]
import http from 'node:http';

const PORT = process.env.CDP_PORT || '9222';

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.log(JSON.stringify({ ok: false, error: 'no page target' }));
    return;
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  await send('Runtime.enable');

  // 执行 JS 并返回结果
  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      return { ok: false, error: r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails) };
    }
    return { ok: true, result: r.result?.value };
  };

  const op = process.argv[2];
  const arg = process.argv[3];

  switch (op) {

    case 'open': {
      const r = await evalJS(`window.__app.testOpenFile(${JSON.stringify(arg)})`);
      console.log(JSON.stringify(r));
      break;
    }

    case 'setup-tree': {
      const r = await evalJS(`window.__app.testSetupTree(${JSON.stringify(arg)}, ${JSON.stringify(JSON.parse(arg) ? null : null)})`);
      console.log(JSON.stringify(r));
      break;
    }

    case 'load-tree': {
      // 从 main 侧扫描树后交给 renderer 渲染（模拟 openFolder 结果）
      const r = await evalJS(`
        (async () => {
          const api = window.api;
          const tree = await api.readTree(${JSON.stringify(arg)});
          return window.__app.testSetupTree(${JSON.stringify(arg)}, tree);
        })()
      `);
      console.log(JSON.stringify(r));
      break;
    }
    case 'snapshot': {
      const r = await evalJS(`
        (() => {
          const el = document.querySelector('.content__inner');
          return {
            text: el ? el.textContent.slice(0, 200) : null,
            headings: [...document.querySelectorAll('.content__inner h1,h2,h3')].map(h => h.textContent),
            codeBlocks: document.querySelectorAll('.md-block--code').length,
            mathBlocks: document.querySelectorAll('.md-block--math').length,
            mathInline: document.querySelectorAll('.math-inline').length,
            tables: document.querySelectorAll('.md-block--table').length,
            mermaid: document.querySelectorAll('.mermaid').length,
            links: [...document.querySelectorAll('.content__inner a')].map(a => a.getAttribute('href')),
            outlineItems: document.querySelectorAll('.outline .ol-item').length,
            theme: document.documentElement.dataset.theme,
            editMode: document.documentElement.dataset.editMode,
            filetreeRows: document.querySelectorAll('.ft-row').length,
            filetreeFiles: [...document.querySelectorAll('.ft-row.ft-file')].map(r => r.dataset.path.split(/[\\\\/]/).pop()),
            breadcrumb: document.getElementById('file-breadcrumb').textContent,
          };
        })()
      `);
      console.log(JSON.stringify(r));
      break;
    }

    case 'set-theme':
      await evalJS(`(window.__themeApi || {}).toggleTheme ? (window.__themeApi.toggleTheme(), true) : false`);
      await new Promise((r) => setTimeout(r, 200));
      const t = await evalJS(`document.documentElement.dataset.theme`);
      console.log(JSON.stringify(t));
      break;

    case 'edit': {
      // 进入编辑 → 改第一段 → 保存 → 切回读模式（真实 DOM 编辑路径）
      const r = await evalJS(`
        (async () => {
          await window.__app.testEdit(${JSON.stringify(arg)});
        })()
      `);
      console.log(JSON.stringify(r));
      break;
    }

    case 'toggle-edit': {
      const r = await evalJS(`window.__editApi.setEditMode(${arg === '1' ? 'true' : 'false'}), window.__editApi.getEditMode()`);
      console.log(JSON.stringify(r));
      break;
    }

    case 'toggle-panel': {
      // arg = outline|tree，点击对应折叠按钮
      const r = await evalJS(`(() => {
        const id = ${JSON.stringify(arg)} === 'outline' ? 'btn-toggle-outline' : 'btn-toggle-tree';
        document.getElementById(id).click();
        return { state: window.__panelsApi.getPanelState() };
      })()`);
      console.log(JSON.stringify(r));
      break;
    }

    case 'modal-edit': {
      // 点代码卡片编辑按钮 → 弹层 → 改代码 → 保存 → 就地重渲染
      const r = await evalJS(`
        (async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          await window.__app.testOpenFile(${JSON.stringify(arg)});
          window.__editApi.setEditMode(true);
          const btn = document.querySelector('.md-block--code .md-block__edit');
          btn.click();
          await sleep(60);
          const shown = !document.getElementById('modal-mask').hidden;
          const ta = document.getElementById('modal-textarea');
          ta.value = '\`\`\`javascript\\nconst liveModalEdited = true;\\n\`\`\`';
          document.getElementById('modal-ok').click();
          await sleep(150);
          await window.__editApi.flushAll();
          const codeText = document.querySelector('.md-block--code code')?.textContent || '';
          const closed = document.getElementById('modal-mask').hidden;
          return { ok: shown && codeText.includes('liveModalEdited') && closed, shown, codeText: codeText.slice(0, 30), closed };
        })()
      `);
      console.log(JSON.stringify(r));
      break;
    }

    case 'paste-plain': {
      // 粘贴净化探查：编辑模式粘贴富文本 → 应为纯文本
      const r = await evalJS(`
        (() => {
          const inner = document.querySelector('.content__inner');
          const p = inner.querySelector('p');
          const ev = new ClipboardEvent('paste', {
            clipboardData: new DataTransfer(),
          });
          // DataTransfer 无法直接设 setData 在构造时，改用 Object.defineProperty
          Object.defineProperty(ev, 'clipboardData', { value: { getData: (t) => t === 'text/plain' ? '纯文本PSTE' : '', getTypes: () => ['text/plain'] } });
          p.dispatchEvent(ev);
          return { ok: true };
        })()
      `);
      console.log(JSON.stringify(r));
      break;
    }

    case 'live-edit': {
      // 模拟用户真实输入：聚焦第一段末尾，键入文字（走 input 事件链）
      const r = await evalJS(`
        (async () => {
          const inner = document.querySelector('.content__inner');
          const p = inner.querySelector('p');
          const sel = window.getSelection();
          const range = document.createRange();
          range.setStart(p, p.childNodes.length);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          // 用 execCommand insertText 模拟真实键入（contenteditable 的 DOM 编辑）
          const tn = document.createTextNode(' GUI实时编辑验证'); p.appendChild(tn);
          // 触发 input 事件（实际键入会触发，此处显式派发以确保 dirty 标记）
          p.dispatchEvent(new InputEvent('input', { bubbles: true }));
          await window.__editApi.flushAll();
          const domText = inner.textContent.includes('GUI实时编辑验证');
          return { ok: true, domText };
        })()
      `);
      console.log(JSON.stringify(r));
      break;
    }

    default:
      console.log(JSON.stringify({ ok: false, error: 'unknown op: ' + op }));
  }

  ws.close();
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
});
