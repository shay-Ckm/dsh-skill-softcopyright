// 抽取 HTML 中所有内联 <script> 块并做语法编译校验（只编译不执行）
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2];
const html = fs.readFileSync(path, 'utf8');

const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, idx = 0, bad = 0;
while ((m = re.exec(html)) !== null) {
  idx++;
  const code = m[1];
  if (!code.trim()) continue;
  try {
    new vm.Script(code, { filename: `${path}#inline${idx}` });
    console.log(`  inline script #${idx}: OK (${code.length} chars)`);
  } catch (e) {
    bad++;
    console.log(`  inline script #${idx}: SYNTAX ERROR -> ${e.message}`);
  }
}
console.log(bad === 0 ? `ALL OK (${idx} inline script blocks)` : `FAILED: ${bad} block(s) with syntax errors`);
process.exit(bad === 0 ? 0 : 1);
