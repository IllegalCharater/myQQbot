// 守住 src/ 的领域依赖方向。只做静态说明符检查，不执行源码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const LEVEL = new Map([
  ['core', 0],
  ['llm', 1], ['chat', 1], ['qq', 1], ['media', 1],
  ['stickers', 2],
  ['agent', 3],
  ['web', 4]
]);

// T1 领域默认彼此隔离。若将来确有必要，只能登记精确的“源文件 -> 目标文件”。
const T1_ALLOW = new Set([]);
const SOURCE_EXT = /\.(?:js|ts)$/;
const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : (SOURCE_EXT.test(entry.name) ? [full] : []);
  });
}

function slash(value) {
  return value.split(path.sep).join('/');
}

const errors = [];
const files = filesUnder(SRC);
for (const source of files) {
  const sourceRel = slash(path.relative(SRC, source));
  const sourceDomain = sourceRel.split('/')[0];
  if (!LEVEL.has(sourceDomain)) {
    errors.push(`${sourceRel}: 源文件不在已知领域目录中`);
    continue;
  }

  const text = fs.readFileSync(source, 'utf8');
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] || match[2] || match[3];
    if (!specifier.startsWith('.')) continue;
    if (!/\.[a-z0-9]+$/i.test(specifier)) {
      errors.push(`${sourceRel} -> ${specifier}: NodeNext 相对说明符必须显式带扩展名`);
      continue;
    }

    const resolved = path.resolve(path.dirname(source), specifier);
    const targetRel = slash(path.relative(SRC, resolved));
    if (targetRel.startsWith('../') || path.isAbsolute(targetRel)) {
      errors.push(`${sourceRel} -> ${specifier}: 相对引用越出 src/`);
      continue;
    }

    const targetDomain = targetRel.split('/')[0];
    if (!LEVEL.has(targetDomain)) {
      errors.push(`${sourceRel} -> ${targetRel}: 目标不在已知领域目录中`);
      continue;
    }
    const sourceTarget = fs.existsSync(resolved)
      || (specifier.endsWith('.js') && fs.existsSync(resolved.slice(0, -3) + '.ts'));
    if (!sourceTarget) {
      errors.push(`${sourceRel} -> ${targetRel}: 目标文件不存在`);
      continue;
    }
    if (sourceDomain === targetDomain) continue;

    const sourceLevel = LEVEL.get(sourceDomain);
    const targetLevel = LEVEL.get(targetDomain);
    if (targetLevel > sourceLevel) {
      errors.push(`${sourceRel} -> ${targetRel}: T${sourceLevel} 不得反向依赖 T${targetLevel}`);
      continue;
    }
    if (sourceLevel === 1 && targetLevel === 1 && !T1_ALLOW.has(`${sourceRel} -> ${targetRel}`)) {
      errors.push(`${sourceRel} -> ${targetRel}: T1 领域间引用未登记精确白名单`);
    }
  }
}

if (errors.length) {
  console.error(`依赖层级检查失败（${errors.length}）：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`依赖层级检查通过：${files.length} 个源码文件`);
