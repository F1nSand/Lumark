// 只读块源码编辑弹层：纯 UI，通过 Promise 返回结果，不持有业务逻辑
let activeResolve = null;

const mask = () => document.getElementById('modal-mask');
const textarea = () => document.getElementById('modal-textarea');
const title = () => document.getElementById('modal-title');
const hint = () => document.getElementById('modal-hint');

/**
 * 打开编辑弹层
 * @param {{ title: string, initial: string, hint: string }} opts
 * @returns {Promise<string|null>} 保存返回新内容，取消返回 null
 */
export function openModal(opts) {
  return new Promise((resolve) => {
    activeResolve = resolve;
    title().textContent = opts.title || '编辑';
    textarea().value = opts.initial || '';
    hint().textContent = opts.hint || '';
    mask().hidden = false;
    // 延迟聚焦（等待弹层可见）
    setTimeout(() => {
      textarea().focus();
      textarea().select();
    }, 30);
  });
}

function close(result) {
  mask().hidden = true;
  if (activeResolve) {
    const r = activeResolve;
    activeResolve = null;
    r(result);
  }
}

// 事件绑定
document.getElementById('modal-ok').addEventListener('click', () => close(textarea().value));
document.getElementById('modal-cancel').addEventListener('click', () => close(null));
document.getElementById('modal-close').addEventListener('click', () => close(null));
mask().addEventListener('click', (e) => {
  if (e.target === mask()) close(null);
});

// 键盘：Esc 关闭 / Ctrl+Enter 保存
document.addEventListener('keydown', (e) => {
  if (mask().hidden) return;
  if (e.key === 'Escape') close(null);
  else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    close(textarea().value);
  }
});
