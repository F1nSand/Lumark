// 右侧大纲：从渲染后 DOM 提取 h1-h6，scroll 事件驱动高亮（滚动到哪个标题就高亮哪个）
const outlineEl = () => document.getElementById('outline');
const contentScrollEl = () => document.getElementById('content');

// 滚动高亮偏移：标题顶部进入容器顶 + OFFSET 内即视为"当前章节"
const OFFSET = 60;

let scrollHandler = null;
let headings = []; // 当前文档标题 DOM 列表
let items = []; // 大纲项 { el, heading }

// 收集标题，构建大纲列表
export function rebuildOutline() {
  const scroller = contentScrollEl();
  headings = [...scroller.querySelectorAll('.content__inner h1, .content__inner h2, .content__inner h3, .content__inner h4, .content__inner h5, .content__inner h6')];
  const el = outlineEl();
  el.innerHTML = '';
  if (scrollHandler) {
    scroller.removeEventListener('scroll', scrollHandler);
    scrollHandler = null;
  }
  items = [];

  if (!headings.length) {
    el.innerHTML = '<div class="ol-empty">暂无标题</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'outline';

  headings.forEach((h) => {
    const lvl = Number(h.tagName[1]);
    const item = document.createElement('button');
    item.className = 'ol-item';
    item.dataset.level = lvl;
    item.style.paddingLeft = `${8 + (lvl - 1) * 14}px`;
    item.textContent = h.textContent.trim() || '（无标题）';
    item.title = h.textContent.trim();
    item.addEventListener('click', () => {
      scroller.scrollTo({ top: h.offsetTop - scroller.offsetTop - 20, behavior: 'smooth' });
    });
    items.push({ el: item, heading: h });
    list.appendChild(item);
  });

  el.appendChild(list);

  // scroll 事件驱动：找最后一个 top <= 容器顶 + OFFSET 的标题（高亮当前章节）
  // 滚动到 4.2.1 时，即使 4.2.2/4.2.3 部分可见也高亮 4.2.1，不跳
  // rAF 合并滚动回调，避免每帧对全部标题 getBoundingClientRect 强制回流
  const updateHighlight = () => {
    const containerTop = scroller.getBoundingClientRect().top;
    const limit = containerTop + OFFSET;
    let active = items[0]?.heading || null;
    for (const { heading } of items) {
      if (heading.getBoundingClientRect().top <= limit) active = heading;
      else break; // 后续标题都在下方，未滚到
    }
    highlight(active);
  };
  let rafId = 0;
  const onScroll = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      updateHighlight();
    });
  };

  scrollHandler = onScroll;
  scroller.addEventListener('scroll', scrollHandler, { passive: true });
  // 初始高亮（打开文档/重建后立即定位）
  updateHighlight();
}

function highlight(heading) {
  items.forEach(({ el, heading: h }) => {
    el.classList.toggle('ol-active', h === heading);
  });
}
