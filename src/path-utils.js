// 路径白名单校验（纯函数，可测试；主进程 main.js 用它实例化）
// 仅允许用户通过对话框选中的根目录（含其子目录）
'use strict';
const path = require('node:path');

module.exports = {
  createPathChecker(roots) {
    const allowed = new Set((roots || []).map((r) => path.resolve(r)));
    return {
      isPathAllowed(p) {
        if (typeof p !== 'string') return false;
        const abs = path.resolve(p);
        for (const root of allowed) {
          if (abs === root || abs.startsWith(root + path.sep)) return true;
        }
        return false;
      },
      addRoot(r) {
        allowed.add(path.resolve(r));
      },
    };
  },
};
