const { app, BrowserWindow, protocol, shell, dialog, ipcMain, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { fileURLToPath } = require('url');
const { createPathChecker } = require('./src/path-utils.js');

const APP_ROOT = __dirname;

// Windows 任务栏图标归属：固定 AppUserModelID，避免 portable 运行于临时目录时图标空白/分组错乱
app.setAppUserModelId('com.lumark.app');

// 单实例锁：右键"打开方式"/重复启动时，把文件转发给已有实例，而非新开进程
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

// 第二实例：把文件转发给主窗口打开，自身退出（getArgvMdPath 为函数声明，可提升引用）
app.on('second-instance', (_event, commandLine) => {
  const p = getArgvMdPath(commandLine);
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (p) deliverArgvFile(win, p);
});

// ---------------------------------------------------------------------------
// app:// 自定义协议 —— 根治 Windows 下 file:// 的 ESM CORS / 字体路径 / mermaid ESM 问题
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 路径白名单：仅允许用户通过对话框选中的根目录（含其子目录）
const pathChecker = createPathChecker();
const isPathAllowed = (p) => pathChecker.isPathAllowed(p);

// 正在被应用自身写入的文件路径集合（用于过滤 fs.watch 自触发刷新）
const dirtyPaths = new Set();

function assertWritablePath(p) {
  if (!isPathAllowed(p)) throw new Error('拒绝访问：路径不在已选目录内');
  if (!/\.(md|markdown)$/i.test(path.basename(p))) throw new Error('拒绝访问：只允许写入 .md/.markdown 文件');
}

function createWindow() {
  const win = new BrowserWindow({
    title: 'Lumark',
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#ffffff',
    show: true, // 立即显示静态壳（工具栏/空状态），JS 初始化在后台完成，不等 ready-to-show
    // 使用原生标题栏（保留窗口边框）；标题栏颜色由 nativeTheme 跟随系统
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 立即显示（show:true）：首帧不阻塞在 803KB 渲染 JS 的求值上
  win.on('closed', () => releaseWindowWatchers(win)); // 关闭时释放该窗口的目录监听
  win.loadURL('app://bundle/index.html');

  // 安全：拒绝新窗口；拦截导航，仅允许 app:// 本身；拖入的 file:// 导航作为兜底安全网转交文件/文件夹打开
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('app://')) return;
    e.preventDefault();
    if (url.startsWith('file:')) {
      try {
        openDroppedPath(win, fileURLToPath(url));
      } catch {
        // URL 解析失败：忽略
      }
    }
  });

  // VERIFY=1 模式：加载后做冒烟检查并自动退出（自动化验证用）
  if (process.env.VERIFY === '1') {
    const errors = [];
    const verifyTmpFiles = [];
    win.webContents.on('console-message', (e, ...args) => {
      // 兼容新旧签名：args 可能是 (level, message) 或 (detail)
      let level, message;
      if (args.length >= 2 && typeof args[1] === 'string') {
        level = args[0];
        message = args[1];
      } else if (args[0] && typeof args[0] === 'object') {
        level = args[0].level;
        message = args[0].message;
      } else {
        message = String(args[0] ?? '');
      }
      if (level === 3 || level === 'error') errors.push(String(message));
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
    // 兜底超时：正常流程在 did-finish-load 回调 finally 里清理并退出
    const timeout = setTimeout(() => {
      console.log('VERIFY_TIMEOUT: did-finish-load 回调未在 30s 内完成');
      app.exit(1);
    }, 30000);
    win.webContents.once('did-finish-load', async () => {
      try {
      // 留一点时间给 renderer 的 module script 执行
      if (process.env.VERIFY_ROOT) {
        const root = path.resolve(process.env.VERIFY_ROOT);
        pathChecker.addRoot(root);
        try {
          const tree = await scanTree(root);
          const result = await win.webContents.executeJavaScript(`
            window.__app && window.__app.testRenderTree(${JSON.stringify(tree)})
          `);
          console.log('VERIFY_TREE:', JSON.stringify(result));
          if (!result || !result.ok) {
            errors.push('verify-tree failed: ' + JSON.stringify(result));
          }
        } catch (err) {
          errors.push('verify-tree: ' + err.message);
        }
      }

      // VERIFY_FILE：打开指定文件并检查渲染结果
      if (process.env.VERIFY_FILE) {
        const file = path.resolve(process.env.VERIFY_FILE);
        pathChecker.addRoot(path.dirname(file));
        try {
          const result = await win.webContents.executeJavaScript(
            `window.__app && window.__app.testOpenFile(${JSON.stringify(file)})`
          );
          console.log('VERIFY_OPEN:', JSON.stringify(result));
          if (!result || !result.ok) {
            errors.push('verify-open failed: ' + JSON.stringify(result));
          }
        } catch (err) {
          errors.push('verify-open: ' + err.message);
        }

        // VERIFY_OUTLINE：大纲滚动联动与点击跳转
        const outlineResult = await win.webContents.executeJavaScript(
          `window.__app && window.__app.testOutline()`
        );
        console.log('VERIFY_OUTLINE:', JSON.stringify(outlineResult));
        if (!outlineResult || !outlineResult.ok) {
          errors.push('verify-outline failed: ' + JSON.stringify(outlineResult));
        }

        // VERIFY_SHIKI：代码块是否真正走 shiki 全彩渲染（pre.shiki + token span）
        const shikiResult = await win.webContents.executeJavaScript(
          `(async () => {
            await new Promise(r => setTimeout(r, 2500)); // 等 shiki 懒加载完成
            const pre = document.querySelector('.md-block--code pre');
            return {
              preClass: pre ? pre.getAttribute('class') : null,
              tokenCount: pre ? pre.querySelectorAll('span[style]').length : 0,
            };
          })()`
        );
        console.log('VERIFY_SHIKI:', JSON.stringify(shikiResult));
        if (!shikiResult || !(shikiResult.preClass || '').includes('shiki') || shikiResult.tokenCount === 0) {
          errors.push('verify-shiki failed: ' + JSON.stringify(shikiResult));
        }
      }

      // VERIFY_THEME：明暗主题切换与持久化
      if (process.env.VERIFY_THEME === '1') {
        const themeResult = await win.webContents.executeJavaScript(
          `window.__app && window.__app.testTheme()`
        );
        console.log('VERIFY_THEME:', JSON.stringify(themeResult));
        if (!themeResult || !themeResult.ok) {
          errors.push('verify-theme failed: ' + JSON.stringify(themeResult));
        }
      }

      // VERIFY_PANELS：面板折叠 + 目录展开反馈
      if (process.env.VERIFY_PANELS === '1' && process.env.VERIFY_ROOT) {
        const root = path.resolve(process.env.VERIFY_ROOT);
        pathChecker.addRoot(root);
        const tree = await scanTree(root);
        await win.webContents.executeJavaScript(
          `window.__app && window.__app.testSetupTree(${JSON.stringify(root)}, ${JSON.stringify(tree)})`
        );
        const panelResult = await win.webContents.executeJavaScript(
          `window.__app && window.__app.testPanelCollapse()`
        );
        console.log('VERIFY_PANEL_COLLAPSE:', JSON.stringify(panelResult));
        if (!panelResult || !panelResult.ok) {
          errors.push('verify-panel-collapse failed: ' + JSON.stringify(panelResult));
        }
        const dirResult = await win.webContents.executeJavaScript(
          `window.__app && window.__app.testDirHighlight()`
        );
        console.log('VERIFY_DIR_HIGHLIGHT:', JSON.stringify(dirResult));
        if (!dirResult || !dirResult.ok) {
          errors.push('verify-dir-highlight failed: ' + JSON.stringify(dirResult));
        }
      }

      // VERIFY_WATCH：外部增删文件 → 文件树自动刷新
      if (process.env.VERIFY_WATCH === '1' && process.env.VERIFY_ROOT) {
        const root = path.resolve(process.env.VERIFY_ROOT);
        pathChecker.addRoot(root);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const tmp = path.join(root, 'watch-test.md');
        try {
          // 加载根目录（含 watch 注册）
          const tree = await scanTree(root);
          const setup = await win.webContents.executeJavaScript(
            `window.__app && window.__app.testSetupTree(${JSON.stringify(root)}, ${JSON.stringify(tree)})`
          );
          if (!setup || !setup.ok) errors.push('verify-watch setup: ' + JSON.stringify(setup));
          // 外部创建文件
          await fsp.writeFile(tmp, '# 外部新增\n', 'utf-8');
          await sleep(1200); // 等 fs.watch + 300ms 防抖 + 刷新
          const afterCreate = await win.webContents.executeJavaScript(
            `window.__app && window.__app.testTreeHasFile('watch-test.md')`
          );
          // 外部删除文件
          await robustUnlink(tmp);
          await sleep(1200);
          const afterDelete = await win.webContents.executeJavaScript(
            `window.__app && window.__app.testTreeHasFile('watch-test.md')`
          );
          const result = {
            created: afterCreate?.found,
            deleted: !afterDelete?.found,
            createdFiles: afterCreate?.files,
            deletedFiles: afterDelete?.files,
          };
          console.log('VERIFY_WATCH:', JSON.stringify(result));
          if (!result.created || !result.deleted) {
            errors.push('verify-watch failed: ' + JSON.stringify(result));
          }
        } catch (err) {
          errors.push('verify-watch: ' + err.message);
        }
      }

      // VERIFY_TOOLBAR：工具栏粗体 + 插入代码卡片（用临时副本）
      if (process.env.VERIFY_TOOLBAR === '1' && process.env.VERIFY_ROOT) {
        const root = path.resolve(process.env.VERIFY_ROOT);
        pathChecker.addRoot(root);
        const src = path.join(root, 'demo.md');
        const tmp = path.join(root, 'verify-toolbar.md');
        try {
          await fsp.copyFile(src, tmp);
          const result = await win.webContents.executeJavaScript(
            `window.__app && window.__app.testToolbar(${JSON.stringify(tmp)})`
          );
          console.log('VERIFY_TOOLBAR:', JSON.stringify(result));
          if (!result || !result.ok) {
            errors.push('verify-toolbar failed: ' + JSON.stringify(result));
          }
        } catch (err) {
          errors.push('verify-toolbar: ' + err.message);
        } finally {
          verifyTmpFiles.push(tmp);
        }
      }

      // VERIFY_MODAL：只读卡片弹层编辑（用临时副本，避免污染 fixtures）
      if (process.env.VERIFY_MODAL === '1' && process.env.VERIFY_ROOT) {
        const root = path.resolve(process.env.VERIFY_ROOT);
        pathChecker.addRoot(root);
        const src = path.join(root, 'demo.md');
        const tmp = path.join(root, 'verify-modal.md');
        try {
          await fsp.copyFile(src, tmp);
          const modalResult = await win.webContents.executeJavaScript(
            `window.__app && window.__app.testModal(${JSON.stringify(tmp)})`
          );
          console.log('VERIFY_MODAL:', JSON.stringify(modalResult));
          if (!modalResult || !modalResult.ok) {
            errors.push('verify-modal failed: ' + JSON.stringify(modalResult));
          }
        } catch (err) {
          errors.push('verify-modal: ' + err.message);
        } finally {
          verifyTmpFiles.push(tmp); // 统一到退出前清理，避免与异步写盘竞态
        }
      }

      // VERIFY_EDIT：端到端编辑（编辑 → 序列化 → 写盘 → 读回）
      if (process.env.VERIFY_EDIT === '1' && process.env.VERIFY_ROOT) {
        const root = path.resolve(process.env.VERIFY_ROOT);
        pathChecker.addRoot(root);
        const src = path.join(root, 'demo.md');
        const tmp = path.join(root, 'verify-edit.md');
        try {
          await fsp.copyFile(src, tmp);
          const editResult = await win.webContents.executeJavaScript(
            `window.__app && window.__app.testEdit(${JSON.stringify(tmp)})`
          );
          console.log('VERIFY_EDIT:', JSON.stringify(editResult));
          const disk = await fsp.readFile(tmp, 'utf-8');
          // turndown 会把 _ 转义为 \_，去掉转义反斜杠后验证内容已写入
          const onDisk = disk.replace(/\\/g, '').includes('EDITED_MARKER');
          const clean = !disk.includes('contenteditable');
          const result = { ...editResult, onDisk, clean };
          console.log('VERIFY_EDIT_DISK:', JSON.stringify({ onDisk, clean }));
          if (!result.ok || !onDisk || !clean) {
            errors.push('verify-edit failed: ' + JSON.stringify(result));
          }
        } catch (err) {
          errors.push('verify-edit: ' + err.message);
        } finally {
          verifyTmpFiles.push(tmp); // 统一到退出前清理
        }
      }
      } catch (err) {
        errors.push('verify-exception: ' + (err && err.message));
      } finally {
        // 所有验证块完成后再清理临时文件并结束
        for (const f of verifyTmpFiles) {
          try {
            await robustUnlink(f);
          } catch (_) {}
        }
        console.log('VERIFY_RESULT:', JSON.stringify({ errors, ok: errors.length === 0, tmpCount: verifyTmpFiles.length, tmpFiles: verifyTmpFiles.map((f) => path.basename(f)) }));
        app.exit(errors.length === 0 ? 0 : 1);
      }
    });
  }

  return win;
}

// ---------------------------------------------------------------------------
// 目录扫描：只收集 .md/.markdown，跳过隐藏目录与常见忽略目录
// ---------------------------------------------------------------------------
async function scanTree(dir, depth = 0) {
  const result = { name: path.basename(dir), path: dir, type: 'dir', children: [] };
  if (depth > 12) return result;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      result.children.push(await scanTree(full, depth + 1));
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(name)) {
      result.children.push({ name, path: full, type: 'file' });
    }
  }
  result.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return result;
}

// 拖拽文件/文件夹到窗口：主入口按绝对路径判断类型 → 交给 renderer 打开
async function openDroppedPath(win, p) {
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    // 文件不存在：通知 renderer 提示（避免静默失败让用户困惑）
    if (!win.isDestroyed()) win.webContents.send('drop-open-failed', p);
    return;
  }
  if (st.isDirectory()) {
    const root = path.resolve(p);
    pathChecker.addRoot(root);
    const tree = await scanTree(root);
    win.webContents.send('drop-open-folder', { root, tree });
  } else if (/\.(md|markdown)$/i.test(p)) {
    const abs = path.resolve(p);
    pathChecker.addRoot(path.dirname(abs));
    win.webContents.send('drop-open-file', { path: abs });
  } else {
    // 非 .md/.markdown 文件：不支持，通知提示
    if (!win.isDestroyed()) win.webContents.send('drop-open-failed', p);
  }
}

// 从命令行参数中提取首个 .md/.markdown 路径（右键"打开方式"、或 Lumark.exe 文件.md 启动）
function getArgvMdPath(argv) {
  for (const raw of argv || []) {
    if (typeof raw !== 'string' || !raw) continue;
    const p = path.resolve(raw);
    if (/\.(md|markdown)$/i.test(p)) return p;
  }
  return null;
}

// argv 打开文件：加入白名单、渲染所在目录树、再打开文件（复用 drop 事件，零 renderer 改动）
async function openArgvFile(win, p) {
  const abs = path.resolve(p);
  if (!/\.(md|markdown)$/i.test(abs)) return; // 只接受 .md/.markdown
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return; // 不存在：忽略
  }
  if (!st.isFile()) return; // 拒绝目录
  if (win.isDestroyed()) return;
  const root = path.dirname(abs);
  pathChecker.addRoot(root);
  // 防驱动根目录全盘扫描（如 C:\ 下的 md 文件）
  let tree = null;
  if (path.parse(root).root !== root) {
    tree = await scanTree(root).catch(() => null);
  }
  if (tree && !win.isDestroyed()) win.webContents.send('drop-open-folder', { root, tree });
  if (!win.isDestroyed()) win.webContents.send('drop-open-file', { path: abs });
}

// 传递 argv 文件：renderer 未加载完时等 did-finish-load，避免事件丢失
function deliverArgvFile(win, p) {
  if (win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => openArgvFile(win, p));
  } else {
    openArgvFile(win, p);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('dialog:select-directory', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  const root = path.resolve(res.filePaths[0]);
  pathChecker.addRoot(root);
  const tree = await scanTree(root);
  return { root, tree };
});

ipcMain.handle('fs:read-tree', async (_e, root) => {
  if (!isPathAllowed(root)) throw new Error('拒绝访问：目录不在已选范围内');
  return scanTree(root);
});

ipcMain.handle('fs:read-file', async (_e, p) => {
  if (!isPathAllowed(p)) throw new Error('拒绝访问');
  return { content: await fsp.readFile(p, 'utf-8') };
});

// Windows 下文件可能被防病毒/句柄瞬态占用，unlink 也可能 EPERM——重试
async function robustUnlink(p) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.unlink(p);
      return;
    } catch (err) {
      if (i === 4) throw err;
      await delay(50 + i * 30);
    }
  }
}

async function atomicWrite(p, content) {
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, content, 'utf-8');
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rename(tmp, p);
      return;
    } catch (err) {
      if (i === 4) {
        // 兜底：非原子但保证保存成功
        try {
          await fsp.unlink(tmp);
        } catch (_) {}
        await fsp.writeFile(p, content, 'utf-8');
        return;
      }
      await delay(50 + i * 30);
    }
  }
}

ipcMain.handle('fs:write-file', async (_e, p, content) => {
  assertWritablePath(p);
  const resolved = path.resolve(p);
  dirtyPaths.add(resolved);
  dirtyPaths.add(resolved + '.tmp'); // atomicWrite 先写 .tmp 再 rename，避免 .tmp 事件触发整树误刷
  await atomicWrite(p, content);
  // 延迟移除脏标记，让 fs.watch 的后续事件被过滤
  setTimeout(() => {
    dirtyPaths.delete(resolved);
    dirtyPaths.delete(resolved + '.tmp');
  }, 2000);
  return true;
});

ipcMain.handle('shell:open-external', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
  return true;
});

// 窗口背景色跟随主题，避免缩放/切换时白闪
ipcMain.on('window:set-background', (e, color) => {
  if (typeof color !== 'string') return;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setBackgroundColor(color);
});

// 原生 chrome 配色跟随主题（标题栏/菜单栏/对话框用系统深色）
ipcMain.on('window:set-native-theme', (e, theme) => {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
});

// 目录监听（每根目录只监听一次；记录 watcher 供窗口关闭/换根时释放）
const watchedRoots = new Map(); // root -> { watcher, owner }
ipcMain.handle('fs:watch-root', (e, root) => {
  if (!isPathAllowed(root)) return true;
  const senderWin = BrowserWindow.fromWebContents(e.sender);
  if (watchedRoots.has(root)) {
    // 已有 watcher：更新归属窗口，避免多窗口发错目标
    watchedRoots.get(root).owner = senderWin;
    return true;
  }
  let timer = null;
  const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
    const name = filename?.toString() || '';
    if (/\.tmp$/.test(name)) return; // 应用自写的 .tmp 文件（atomicWrite 中间态）
    if (dirtyPaths.has(path.resolve(root, name))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const entry = watchedRoots.get(root);
      const wc = entry?.owner || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (wc && !wc.isDestroyed()) wc.webContents.send('dir-changed', root);
    }, 300);
  });
  watchedRoots.set(root, { watcher, owner: senderWin });
  return true;
});

// 窗口关闭时释放其拥有的 watcher（避免 recursive 句柄累积）
function releaseWindowWatchers(win) {
  for (const [root, entry] of watchedRoots) {
    if (entry.owner === win) {
      try {
        entry.watcher.close();
      } catch (_) {}
      watchedRoots.delete(root);
    }
  }
}

// 菜单
function buildMenu(win) {
  const send = (action) => win.webContents.send('menu', action);
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开文件夹…', accelerator: 'Ctrl+O', click: () => send('open-folder') },
        { label: '打开文件…', accelerator: 'Ctrl+Shift+O', click: () => send('open-file') },
        { type: 'separator' },
        { label: '退出', accelerator: 'Ctrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换主题', accelerator: 'Ctrl+T', click: () => send('toggle-theme') },
        { label: '切换编辑/阅读模式', accelerator: 'Ctrl+E', click: () => send('toggle-mode') },
        { label: '重新加载', accelerator: 'Ctrl+R', click: () => win.webContents.reload() },
        { type: 'separator' },
        { label: '切换开发者工具', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
      ],
    },
  ]);
}

// 选择单个 .md 文件（Ctrl+Shift+O）
ipcMain.handle('dialog:choose-file', async () => {
  const res = await dialog.showOpenDialog({
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const p = path.resolve(res.filePaths[0]);
  pathChecker.addRoot(path.dirname(p));
  return { path: p };
});

// 拖放打开：渲染进程经 webUtils 解析出真实路径后发来，主进程判断类型并打开
ipcMain.on('drop:path', (e, p) => {
  if (typeof p !== 'string' || !p) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) openDroppedPath(win, path.resolve(p));
});

// app:// MIME 映射（asar 打包后 net.fetch 不支持 asar 路径，改用 Node fs 读取）
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

app.whenReady().then(() => {
  // 未获得单实例锁（第二实例）：仅保留转发逻辑，不创建窗口
  if (!gotSingleInstanceLock) return;

  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.join(APP_ROOT, rel);
    // 防目录穿越：只服务项目根内
    if (!abs.startsWith(APP_ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      return new Response(data, { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // VERIFY_ALLOW：测试用，把目录加入白名单（等同对话框选择的授权）
  if (process.env.VERIFY_ALLOW) {
    const roots = process.env.VERIFY_ALLOW.split(path.delimiter);
    for (const r of roots) if (r) pathChecker.addRoot(path.resolve(r));
  }

  const win = createWindow();
  win.setMenu(buildMenu(win));

  // 首启带文件参数（右键"打开方式"）：加载完成后打开该文件
  const pendingPath = getArgvMdPath(process.argv);
  if (pendingPath) deliverArgvFile(win, pendingPath);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
