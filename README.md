# Lumark

基于 Electron 的 Markdown 阅读与编辑器。

## 功能

- Shiki 全彩语法高亮，按需加载，支持 15+ 种常用语言
- KaTeX 数学公式渲染
- Mermaid 图表渲染，支持缩放、拖拽、点击激活
- 目录大纲，滚动时自动高亮当前章节
- 文件树浏览，支持目录折叠
- 编辑与阅读双模式切换
- 拖拽文件直接打开
- 明暗主题自动跟随系统
- 侧边面板折叠，状态持久化
- 原生标题栏与菜单栏

## 下载

从 [GitHub Releases](https://github.com/F1nSand/Lumark/releases) 下载 Windows x64 版本。提供两种格式：

| 版本 | 文件 | 说明 |
|------|------|------|
| **安装版（推荐）** | `Lumark-Setup-*.exe` | 安装后可选择安装目录，启动约 1 秒，带开始菜单/桌面快捷方式，适合日常使用 |
| **便携版** | `Lumark-*.exe` | 体积小（约 88MB），免安装、绿色携带，但每次启动需解压到临时目录，约慢 8 秒 |

- 日常使用建议选**安装版**：启动快、体验一致。
- 需要绿色免安装、U 盘携带时选**便携版**：灵活，但启动慢。

## 开发

```bash
npm install        # 安装依赖
npm start          # 启动开发模式
npm test           # 运行测试
npm run pack       # 打包 Windows 便携版
```

## 技术栈

Electron · esbuild · markdown-it · Shiki · KaTeX · Mermaid

