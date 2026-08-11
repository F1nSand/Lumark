// 图表滚轮缩放 + 拖拽平移（事件委托：只挂一次，多图表块各自独立状态）
// 独立模块：只依赖 DOM，不依赖 editor 内部状态（从 editor.js 拆出）

const mermaidZoomMap = new WeakMap(); // block → { zoom, tx, ty, active }
let mermaidZoomBound = false;

function mermaidZoomState(block) {
  let st = mermaidZoomMap.get(block);
  if (!st) {
    st = { zoom: 1, tx: 0, ty: 0, active: false };
    mermaidZoomMap.set(block, st);
  }
  return st;
}

function mermaidZoomApply(block, st) {
  const svg = block.querySelector('svg');
  if (!svg) return;
  svg.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.zoom})`;
  svg.style.transformOrigin = '0 0';
  block.classList.toggle('mermaid--zoomed', st.zoom !== 1);
}

// 惰性挂全局委托监听（每个 block 通过 closest 匹配，状态存 WeakMap）
function ensureMermaidZoomBound() {
  if (mermaidZoomBound) return;
  mermaidZoomBound = true;

  // 点击激活：点击图表框进入缩放模式（排除编辑按钮；编辑模式不激活——避免误伤编辑交互）
  document.addEventListener('click', (e) => {
    if (document.documentElement.dataset.editMode === 'edit') return; // 编辑模式不激活缩放
    if (e.target.closest('.md-block__edit')) return; // 编辑按钮：不激活缩放，交给编辑事件
    const block = e.target.closest('.md-block--mermaid');
    if (block) {
      const st = mermaidZoomState(block);
      if (!st.active) {
        st.active = true;
        block.classList.add('mermaid--active');
      }
      // 已激活时点击保留（不退出）；阻止冒泡避免触发编辑
      e.stopPropagation();
    } else {
      // 点击框外退出所有激活的图表
      for (const b of document.querySelectorAll('.md-block--mermaid.mermaid--active')) {
        const st = mermaidZoomState(b);
        st.active = false;
        b.classList.remove('mermaid--active');
      }
    }
  });

  // 滚轮缩放（仅激活的图表块接管滚轮；编辑模式不接管，避免劫持页面滚动）
  document.addEventListener('wheel', (e) => {
    if (document.documentElement.dataset.editMode === 'edit') return;
    const block = e.target.closest('.md-block--mermaid.mermaid--active');
    if (!block) return; // 未激活不接管，页面正常滚动
    e.preventDefault();
    e.stopPropagation();
    const st = mermaidZoomState(block);
    const rect = block.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(5, Math.max(0.5, st.zoom * factor));
    const ratio = next / st.zoom;
    st.tx = cx - (cx - st.tx) * ratio;
    st.ty = cy - (cy - st.ty) * ratio;
    st.zoom = next;
    mermaidZoomApply(block, st);
  }, { passive: false });

  // 拖拽平移（仅激活的图表块；排除编辑按钮）
  let dragging = null; // { block, st, sx, sy, ox, oy }
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.md-block__edit')) return; // 编辑按钮不拖拽
    const block = e.target.closest('.md-block--mermaid.mermaid--active');
    if (!block) return;
    const st = mermaidZoomState(block);
    dragging = { block, st, sx: e.clientX, sy: e.clientY, ox: st.tx, oy: st.ty };
    block.classList.add('mermaid--dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const d = dragging;
    d.st.tx = d.ox + (e.clientX - d.sx);
    d.st.ty = d.oy + (e.clientY - d.sy);
    mermaidZoomApply(d.block, d.st);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging.block.classList.remove('mermaid--dragging');
    dragging = null;
  });
}

export function bindMermaidZoom() {
  ensureMermaidZoomBound(); // 事件委托挂一次，无需每块绑定
}
