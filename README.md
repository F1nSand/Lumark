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

从 [GitHub Releases](https://github.com/F1nSand/Lumark/releases) 下载 Windows x64 便携版 `Lumark-0.1.1-x64.exe`，下载后直接双击运行，无需安装。

## 开发

```bash
npm install        # 安装依赖
npm start          # 启动开发模式
npm test           # 运行测试
npm run pack       # 打包 Windows 便携版
```

## 技术栈

Electron · esbuild · markdown-it · Shiki · KaTeX · Mermaid

