/**
 * 口径交叉验证：我的行数统计是否与上游脚本一致？
 *
 * 为什么必须做：`sc_audit` 的价值全在于"报出的 N 文件/M 行与源代码文档封面、哈希清单、
 * 研发日志一致"。如果我的行数口径与生成那些文档的脚本**不同**，审计就会**误报不一致** ——
 * 那比没有审计更糟。
 *
 * 做法：用真实脚本 collect_source_hashes.py 跑一遍真实目录，拿到它的 TOTAL_LINES；
 * 再对它报告的**同一批文件**用我的 countSourceLines 求和对比。这样把"文件筛选规则差异"
 * 排除掉，只检验**行数口径**本身。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const { countSourceLines, collectSourceStats, parseSourceHashes } = {
  ...(await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'audit', 'consistency.js')).href)),
  ...(await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'adapters', 'parse.js')).href))
};

const PYTHON = 'E:\\Users\\L\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe';
const SCRIPT = join(PLUGIN_ROOT, 'assets', 'skills', 'software-copyright-aigc-appeal', 'scripts', 'collect_source_hashes.py');
const TARGET = join(PLUGIN_ROOT, 'assets', 'skills', 'python-software-delivery', 'scripts');

console.log('口径交叉验证：countSourceLines vs collect_source_hashes.py');
console.log(`目标目录 : ${TARGET}`);

const { stdout, stderr } = await execFileAsync(PYTHON, [SCRIPT, TARGET], {
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true
});

const parsed = parseSourceHashes({ stdout, stderr, exitCode: 0 }, 'collect');
console.log(`\n脚本报告 : files=${parsed.fields.files} lines=${parsed.fields.lines} bytes=${parsed.fields.bytes}`);

// 对它报告的同一批文件，用我的口径求和
const rows = stdout
  .split(/\r?\n/)
  .filter((line) => /^.+?\t\d+\t\d+\t[0-9a-f]{64}$/.test(line))
  .map((line) => {
    const [rel, bytes, lines] = line.split('\t');
    // 脚本输出的 rel 是相对 root 的路径
    return { rel, scriptBytes: Number(bytes), scriptLines: Number(lines) };
  });

let myLines = 0;
let mismatches = [];
for (const row of rows) {
  const abs = join(TARGET, row.rel.replace(/^source\//, ''));
  let text = '';
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const mine = countSourceLines(text);
  myLines += mine;
  if (mine !== row.scriptLines) {
    mismatches.push({ rel: row.rel, script: row.scriptLines, mine });
  }
}

console.log(`我的口径 : lines=${myLines}`);
console.log(`\n逐文件不一致数 : ${mismatches.length}`);
for (const m of mismatches.slice(0, 15)) {
  console.log(`  ${m.rel}: 脚本=${m.script} 我=${m.mine}`);
}

const ok = myLines === parsed.fields.lines && mismatches.length === 0;
console.log(`\n结论：${ok ? 'PASS —— 行数口径与上游脚本完全一致' : 'FAIL —— 口径不一致，sc_audit 会误报'}`);

// 附：我的文件筛选规则在此目录上的结果（仅作参考，规则不同是预期的）
const mine = collectSourceStats(TARGET, { includeExt: ['.py'], excludeDirs: ['__pycache__'], keepInitPy: true });
console.log(`\n参考：我的筛选规则在 .py 上得 files=${mine.files} lines=${mine.lines}`);

process.exit(ok ? 0 : 1);
