// 路径白名单校验测试（src/path-utils.js 纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createPathChecker } = require('../src/path-utils.js');

// Windows 风格路径（项目目标平台）
function win(p) {
  return p.replace(/\//g, path.sep);
}

test('白名单：根目录及其子目录允许', () => {
  const checker = createPathChecker([win('C:/docs')]);
  assert.ok(checker.isPathAllowed(win('C:/docs')));
  assert.ok(checker.isPathAllowed(win('C:/docs/a.md')));
  assert.ok(checker.isPathAllowed(win('C:/docs/sub/deep/b.md')));
});

test('白名单：目录外路径拒绝', () => {
  const checker = createPathChecker([win('C:/docs')]);
  assert.ok(!checker.isPathAllowed(win('C:/other/x.md')));
  assert.ok(!checker.isPathAllowed(win('C:/docsx/y.md'))); // 前缀相似但不在其内
  assert.ok(!checker.isPathAllowed(win('C:/'))); // 根目录本身不允许（除非是白名单根）
});

test('白名单：非字符串/空拒绝', () => {
  const checker = createPathChecker([win('C:/docs')]);
  assert.ok(!checker.isPathAllowed(null));
  assert.ok(!checker.isPathAllowed(undefined));
  assert.ok(!checker.isPathAllowed(''));
  assert.ok(!checker.isPathAllowed(123));
});

test('白名单：addRoot 动态添加后允许', () => {
  const checker = createPathChecker();
  assert.ok(!checker.isPathAllowed(win('C:/tmp/x.md')));
  checker.addRoot(win('C:/tmp'));
  assert.ok(checker.isPathAllowed(win('C:/tmp/x.md')));
});
