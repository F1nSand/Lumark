// 文件树：从 main 进程扫描结果渲染 DOM 树，支持展开/折叠/选中高亮/刷新保留状态
import { api, safeCall } from './ipc.js';

let currentRoot = null;
let expanded = new Set(); // 存储展开的目录 path
let selectedPath = null;
let activePath = null; // 当前打开的文件（高亮）

const DIR_ICONS = { open: '📂', closed: '📁' };
const FILE_ICON = '📄';

export function getCurrentRoot() {
  return currentRoot;
}

export function getActivePath() {
  return activePath;
}

export function setActivePath(p) {
  activePath = p;
  highlight(selectedPath ?? p);
}

// 加载根目录（openFolder 与测试共用）
export async function loadRoot(root, tree) {
  currentRoot = root;
  expanded = new Set([root]);
  selectedPath = null;
  await api.watchRoot(currentRoot).catch(() => {});
  renderTree(tree);
}

// 打开文件夹：由对话框选择
export async function openFolder() {
  const res = await safeCall('select-directory', () => api.selectDirectory());
  if (!res) return null;
  await loadRoot(res.root, res.tree);
  onFolderOpened?.();
  return res;
}

// 打开单个文件：父目录加入白名单
export async function openSingleFile() {
  const res = await safeCall('choose-file', () => api.chooseFile());
  if (!res) return null;
  // 父目录未必有完整树，用其目录扫描
  const dir = res.path.replace(/[\\/][^\\/]*$/, '');
  currentRoot = dir;
  expanded = new Set([dir]);
  selectedPath = null;
  const tree = await safeCall('read-tree', () => api.readTree(dir));
  if (tree) {
    renderTree(tree);
    await api.watchRoot(currentRoot).catch(() => {});
    return res.path;
  }
  return null;
}

// 目录变更 → 重扫并保留展开/选中状态
export async function refreshTree() {
  if (!currentRoot) return;
  const tree = await safeCall('read-tree', () => api.readTree(currentRoot));
  if (tree) renderTree(tree);
}

// 懒渲染 + 事件委托：目录未展开时子节点留空，展开时才构建；点击由 #filetree 容器统一分发
let treeData = null; // 当前完整树（展开时懒构建子节点用）

export function renderTree(tree) {
  treeData = tree;
  const el = document.getElementById('filetree');
  el.innerHTML = '';
  el.appendChild(buildNode(tree, 0));
  bindFiletreeDelegate(); // 容器级事件委托（只挂一次）
}

// 目录未展开时构建空 children ul；展开时由 expandDir 填充
function buildNode(node, depth) {
  const li = document.createElement('li');

  if (node.type === 'dir') {
    const isOpen = expanded.has(node.path);
    const row = document.createElement('div');
    row.className = 'ft-row ft-dir' + (isOpen ? ' ft-dir--open' : '');
    row.dataset.path = node.path;

    const caret = document.createElement('span');
    caret.className = 'ft-caret' + (isOpen ? ' ft-caret--open' : '');
    caret.textContent = '▶';
    const icon = document.createElement('span');
    icon.className = 'ft-icon';
    icon.textContent = isOpen ? DIR_ICONS.open : DIR_ICONS.closed;
    const name = document.createElement('span');
    name.className = 'ft-name';
    name.textContent = node.name;
    name.title = node.path;

    row.append(caret, icon, name);

    // 懒渲染：仅在展开态构建子节点（大目录省 DOM + 监听）
    const children = document.createElement('ul');
    children.className = 'ft-dir-children' + (isOpen ? ' ft-open' : '');
    if (isOpen) buildChildren(node, children);

    li.append(row, children);
  } else {
    const row = document.createElement('div');
    row.className = 'ft-row ft-file';
    row.dataset.path = node.path;
    if (node.path === activePath) row.classList.add('ft-active');

    const icon = document.createElement('span');
    icon.className = 'ft-icon';
    icon.textContent = FILE_ICON;
    const name = document.createElement('span');
    name.className = 'ft-name';
    name.textContent = node.name;
    name.title = node.path;

    row.append(icon, name);
    li.appendChild(row);
  }

  return li;
}

function buildChildren(node, ul) {
  for (const child of node.children || []) {
    ul.appendChild(buildNode(child, 0));
  }
}

// 按 path 在树里找 node（懒展开用）
function findNode(node, path) {
  if (node.path === path) return node;
  for (const child of node.children || []) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

// 事件委托：容器统一处理目录展开/文件选择（替代每行 addEventListener）
let filetreeDelegateBound = false;
function bindFiletreeDelegate() {
  if (filetreeDelegateBound) return;
  filetreeDelegateBound = true;
  const container = document.getElementById('filetree');
  container.addEventListener('click', (e) => {
    const row = e.target.closest('.ft-row');
    if (!row) return;
    const path = row.dataset.path;
    if (!path || !treeData) return;
    if (row.classList.contains('ft-dir')) {
      const node = findNode(treeData, path);
      if (node) toggleDir(node, expanded.has(node.path));
    } else {
      selectFile(path);
    }
  });
}

function toggleDir(node, currentlyOpen) {
  const row = document.querySelector(`.ft-dir[data-path="${CSS.escape(node.path)}"]`);
  const caret = row?.querySelector('.ft-caret');
  const icon = row?.querySelector('.ft-icon');
  const children = row?.nextElementSibling;

  if (currentlyOpen) {
    expanded.delete(node.path);
    row?.classList.remove('ft-dir--open');
    caret?.classList.remove('ft-caret--open');
    icon.textContent = DIR_ICONS.closed;
    children?.classList.remove('ft-open');
  } else {
    expanded.add(node.path);
    row?.classList.add('ft-dir--open');
    caret?.classList.add('ft-caret--open');
    icon.textContent = DIR_ICONS.open;
    // 懒渲染：首次展开才构建子节点（大目录省 DOM）
    if (children && !children.hasChildNodes()) {
      buildChildren(node, children);
    }
    children?.classList.add('ft-open');
  }
}

function selectFile(path) {
  selectedPath = path;
  highlight(path);
  if (onOpenFile) onOpenFile(path);
}

// 高亮选中行
function highlight(path) {
  document.querySelectorAll('.ft-row').forEach((r) => r.classList.remove('ft-active'));
  const row = document.querySelector(`.ft-row[data-path="${CSS.escape(path)}"]`);
  if (row) {
    row.classList.add('ft-active');
    row.scrollIntoView({ block: 'nearest' });
  }
}

// 外部注入：文件被选中打开时回调（由 editor 模块注册）
let onOpenFile = null;
export function setOnOpenFile(cb) {
  onOpenFile = cb;
}

// 外部注入：文件夹打开成功回调（用于显示编辑区）
let onFolderOpened = null;
export function setOnFolderOpened(cb) {
  onFolderOpened = cb;
}

// 选择单个文件打开（header 📄 与空状态共用）
export async function openChosenFile() {
  const p = await openSingleFile();
  if (p) selectFile(p);
  return p;
}

// 工具栏：打开文件夹 / 文件 / 收起全部
export function bindFiletreeActions() {
  document.getElementById('btn-open-folder').addEventListener('click', () => openFolder());
  document.getElementById('btn-open-file').addEventListener('click', () => openChosenFile());
  document.getElementById('btn-empty-open').addEventListener('click', () => openFolder());
  document.getElementById('btn-empty-open-file').addEventListener('click', () => openChosenFile());
  document.getElementById('btn-collapse-tree').addEventListener('click', () => {
    expanded = new Set([currentRoot]);
    refreshTree();
  });
}
