// 明暗主题：CSS 变量 + data-theme + localStorage 持久化
import { api } from './ipc.js';

const THEME_KEY = 'lumark-theme';
const BG_COLORS = { light: '#ffffff', dark: '#1e1e1e' };

export function getTheme() {
  return document.documentElement.dataset.theme || 'light';
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {}
  api.setBackground(BG_COLORS[theme] || '#ffffff');
  // 原生标题栏/菜单栏配色跟随主题
  api.setNativeTheme(theme);
  // 切主题后 mermaid 的 SVG 颜色是渲染期烘焙的，需要重跑（由 editor 侧监听）
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: theme }));
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
  let saved = 'light';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'light';
  } catch (_) {}
  setTheme(saved);
}
