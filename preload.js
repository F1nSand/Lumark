const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 只暴露 IPC 薄壳，不含任何业务逻辑
contextBridge.exposeInMainWorld('api', {
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  chooseFile: () => ipcRenderer.invoke('dialog:choose-file'),
  readTree: (root) => ipcRenderer.invoke('fs:read-tree', root),
  readFile: (path) => ipcRenderer.invoke('fs:read-file', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:write-file', path, content),
  watchRoot: (root) => ipcRenderer.invoke('fs:watch-root', root),
  // 拖放打开：把 File 对象解析成真实文件路径，交由主进程判断类型并打开
  getPathForFile: (file) => webUtils.getPathForFile(file),
  dropPath: (p) => ipcRenderer.send('drop:path', p),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  setBackground: (color) => ipcRenderer.send('window:set-background', color),
  setNativeTheme: (theme) => ipcRenderer.send('window:set-native-theme', theme),

  onDirChanged: (cb) => {
    const h = (_e, root) => cb(root);
    ipcRenderer.on('dir-changed', h);
    return () => ipcRenderer.removeListener('dir-changed', h);
  },
  onDropOpenFile: (cb) => {
    const h = (_e, o) => cb(o);
    ipcRenderer.on('drop-open-file', h);
    return () => ipcRenderer.removeListener('drop-open-file', h);
  },
  onDropOpenFolder: (cb) => {
    const h = (_e, o) => cb(o);
    ipcRenderer.on('drop-open-folder', h);
    return () => ipcRenderer.removeListener('drop-open-folder', h);
  },
  onMenu: (cb) => {
    const h = (_e, action) => cb(action);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
});
