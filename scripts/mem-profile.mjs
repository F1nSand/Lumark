// 内存剖析脚本：通过 CDP 采样渲染进程堆使用量，对比文档打开前后的内存变化
// 用法（需先以 --remote-debugging-port 启动 Electron）：
//   node scripts/mem-profile.mjs scenarioA <path-to-dir-or-fixture>
//   node scripts/mem-profile.mjs scenarioB <dir> [count]
// 通过 CDP Runtime.getHeapUsage 获取 JS 堆（usedSize / totalSize），单位 MB。
import http from 'node:http';
import path from 'node:path';

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

async function connect() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
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
  return { ws, send };
}

async function evalJS(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result?.value;
}

// 获取当前 JS 堆使用量（MB）
async function heapMB(send) {
  const h = await send('Runtime.getHeapUsage');
  return { used: +(h.usedSize / 1048576).toFixed(1), total: +(h.totalSize / 1048576).toFixed(1) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openFile(send, p) {
  // 通过测试钩子真实打开文件并等待渲染完成
  const r = await evalJS(send, `window.__app.testOpenFile(${JSON.stringify(p)})`);
  if (!r || !r.ok) throw new Error('open failed: ' + JSON.stringify(r));
  await sleep(300);
  // 强制一次 GC（Chromium --js-flags=--expose-gc 下 window.gc 可用；不可用则跳过）
  await evalJS(send, `typeof gc === 'function' ? (gc(), true) : false`);
  return heapMB(send);
}

async function scenarioA(send, file) {
  const abs = path.resolve(file);
  const before = await heapMB(send);
  const opened = await openFile(send, abs);
  const nodeCount = await evalJS(send, `document.querySelectorAll('.content__inner *').length`);
  const codeBlocks = await evalJS(send, `document.querySelectorAll('.md-block--code').length`);
  const spanCount = await evalJS(send, `document.querySelectorAll('.content__inner span').length`);
  return {
    before,
    opened,
    delta: { used: +(opened.used - before.used).toFixed(1), total: +(opened.total - before.total).toFixed(1) },
    nodeCount,
    codeBlocks,
    spanCount,
  };
}

async function scenarioB(send, dir, count) {
  const files = [];
  for (let i = 0; i < count; i++) files.push(path.join(dir, `doc${i}.md`));
  const baseline = await heapMB(send);
  const samples = [{ step: 'baseline', ...baseline }];
  for (let i = 0; i < files.length; i++) {
    const h = await openFile(send, files[i]);
    samples.push({ step: `doc${i}`, ...h });
  }
  // 回到首个文件验证缓存收敛（若改动后缓存应停留在当前文档量级）
  await openFile(send, files[0]);
  const backToFirst = await heapMB(send);
  return { baseline, samples, backToFirst };
}

async function main() {
  const op = process.argv[2];
  if (!op) {
    console.log(JSON.stringify({ ok: false, error: 'usage: node scripts/mem-profile.mjs <scenarioA|scenarioB> <file|dir> [count]' }));
    return;
  }
  const { ws, send } = await connect();
  let result;
  if (op === 'scenarioA') {
    result = await scenarioA(send, process.argv[3]);
  } else if (op === 'scenarioB') {
    result = await scenarioB(send, process.argv[3], Number(process.argv[4] || 10));
  } else {
    result = { ok: false, error: 'unknown op ' + op };
  }
  console.log(JSON.stringify(result, null, 2));
  ws.close();
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
});
