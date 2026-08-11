// 左侧面板折叠：大纲 / 文件树两个 section 可收起到只剩 header，状态持久化 localStorage

const KEYS = {
  outline: 'lumark-outline-collapsed',
  tree: 'lumark-tree-collapsed',
};

function read(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function write(key, v) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {}
}

function paint(panel, btn, collapsed) {
  panel.classList.toggle('panel--collapsed', collapsed);
  btn.textContent = collapsed ? '▸' : '▾';
  btn.title = collapsed ? '展开' : '收起';
}

export function initPanels() {
  const outline = document.getElementById('outline-panel');
  const tree = document.getElementById('filetree-panel');
  const btnOutline = document.getElementById('btn-toggle-outline');
  const btnTree = document.getElementById('btn-toggle-tree');

  const toggle = (panel, btn, key) => {
    const collapsed = !panel.classList.contains('panel--collapsed');
    paint(panel, btn, collapsed);
    write(key, collapsed);
  };

  btnOutline.addEventListener('click', () => toggle(outline, btnOutline, KEYS.outline));
  btnTree.addEventListener('click', () => toggle(tree, btnTree, KEYS.tree));

  // 启动时恢复持久化状态
  paint(outline, btnOutline, read(KEYS.outline));
  paint(tree, btnTree, read(KEYS.tree));
}

export function getPanelState() {
  return {
    outline: document.getElementById('outline-panel').classList.contains('panel--collapsed'),
    tree: document.getElementById('filetree-panel').classList.contains('panel--collapsed'),
  };
}
