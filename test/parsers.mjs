/**
 * dsh-skill-softcopyright —— 解析器 harness
 *
 * 为什么单独一个文件：这 20 个脚本的输出格式是**中文自由文本**，解析错会静默给出
 * 错误数字（比抛错危险得多）。这里的每个用例都用"逐字抄自脚本源码的格式串"构造输入，
 * 把解析契约锁死。上游脚本改格式 → 这里先红。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

const P = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'adapters', 'parse.js')).href);

console.log('dsh-skill-softcopyright —— 解析器 harness');

// ---------------------------------------------------------------- 1 check_manual_docx
section('parseManualCheck');
{
  const stdout = [
    '== 说明书复验 ==',
    '箭头符号          0',
    'Markdown**        0',
    '非黑颜色          0',
    '斜体              0',
    '图题/图位         图题=37 图位=37 一致=True',
    '结论: 通过'
  ].join('\n');
  const r = P.parseManualCheck({ stdout, exitCode: 0 });
  check('退出码 0 → ok', r.ok === true);
  check('箭头为 0', r.fields.arrows === 0);
  check('Markdown** 名能被匹配', r.fields.markdownBold === 0);
  check('非黑颜色为 0', r.fields.nonBlack === 0);
  check('斜体为 0', r.fields.italic === 0);
  check('图题 37', r.fields.figureCaptions === 37);
  check('图位 37', r.fields.figureSlots === 37);
  check('一致 True 解析为布尔', r.fields.figureMatch === true);

  const bad = P.parseManualCheck({ stdout: stdout.replace('结论: 通过', '结论: 未通过'), exitCode: 1 });
  check('退出码 1 → ok=false', bad.ok === false);
  check('未通过给出提示', bad.notes.length === 1);
}

// ---------------------------------------------------------------- 2 manual_stats
section('parseManualStats');
{
  const stdout = [
    '== 说明书规模统计 ==',
    '段落数(非空)      : 412',
    '表格数            : 12',
    '图题数            : 37',
    '图位数(占位说明)  : 37',
    '正文字符数(含表格) : 33821',
    '页数（Word 真实渲染）: 60.0 页',
    '  [✔] 图题 ≥ 30     = True',
    '达标判定: 达标'
  ].join('\n');
  const r = P.parseManualStats({ stdout, exitCode: 0 });
  check('ok=true', r.ok === true);
  check('段落数（冒号前两空格）', r.fields.paragraphs === 412);
  check('表格数', r.fields.tables === 12);
  check('图题数', r.fields.figureCaptions === 37);
  check('图位数', r.fields.figureSlots === 37);
  check('正文字符数（冒号前多一空格）', r.fields.chars === 33821);
  check('真实页数 60', r.fields.pages === 60);
  check('页数来源为 Word 真实渲染', r.fields.pagesSource === 'Word 真实渲染');
  check('达标判定文本', r.fields.verdict === '达标');

  const fallback = P.parseManualStats({
    stdout: ['[提示] --render 失败（未装 Word / 无 pywin32），回退到其他方式', '页数估计区间      : 45.0 ~ 55.0 页', '达标判定: 不达标（见上方 ✘ 项）'].join('\n'),
    exitCode: 1
  });
  check('回退时区间被解析', fallback.fields.pagesEstimateLow === 45);
  check('回退时 pages 为空', fallback.fields.pages === undefined);
  check('回退时两条提示', fallback.notes.length === 2, JSON.stringify(fallback.notes));
}

// ---------------------------------------------------------------- 3 page_estimate
section('parsePageEstimate');
{
  const r = P.parsePageEstimate({
    stdout: ['文件: a.docx', '累计排版高度: 800.0 cm   单页可用高度: 24.70 cm', '  正文 700.0 cm | 表格 50.0 cm | 内嵌图 50.0 cm', '估算页数: 32.4 页'].join('\n'),
    exitCode: 0
  });
  check('ok=true', r.ok === true);
  check('页数 32.4', r.fields.pages === 32.4);
  check('正文高度', r.fields.bodyHeightCm === 700);
  check('表格高度', r.fields.tableHeightCm === 50);
  check('图片高度', r.fields.imageHeightCm === 50);
}

// ---------------------------------------------------------------- 4 check_src_doc
section('parseCheckSrcDoc');
{
  const stdout = [
    '  main.py                      OK 一致(120行)',
    '  db.py                        X 差异 3 处 (源码90/文档88)',
    '      第12行  源码:\'a\'',
    '      第13行  源码:\'b\'',
    '  [警告] 源码缺失: core/gone.py',
    '完整性: X 存在差异'
  ].join('\n');
  const r = P.parseCheckSrcDoc({ stdout, exitCode: 1 });
  check('ok=false', r.ok === false);
  check('一致文件数 1', r.fields.consistentFiles === 1);
  check('差异文件数 1', r.fields.mismatchedFiles === 1);
  check('缺失源码被记录', r.fields.missingFromSource === 1);
  check('结论行被解析', /存在差异/.test(r.fields.verdict));

  const good = P.parseCheckSrcDoc({ stdout: '  a.py  OK 一致(1行)\n完整性: OK 全部一致', exitCode: 0 });
  check('全一致时 ok=true', good.ok === true);
}

// ---------------------------------------------------------------- 5 gen_src_docx
section('parseGenSrcDocx');
{
  const r = P.parseGenSrcDocx({
    stdout: ['已生成: D:/out/源代码文档_V2.docx', '文件数: 26 | 代码行数: 4103'].join('\n'),
    exitCode: 0
  });
  check('ok=true', r.ok === true);
  check('取最后一次「已生成」（另存 _V2）', r.fields.outPath === 'D:/out/源代码文档_V2.docx');
  check('文件数 26', r.fields.files === 26);
  check('代码行数 4103', r.fields.lines === 4103);

  const failed = P.parseGenSrcDocx({
    stdout: '保存失败（目标与 _V2~_V10 均被占用），临时文件位于: C:/tmp/x.docx',
    exitCode: 0
  });
  check('保存失败时 ok=false（尽管退出码 0）', failed.ok === false);
  check('保存失败给出提示', failed.notes.length === 1, JSON.stringify(failed.notes));
}

// ---------------------------------------------------------------- 6 build_src_package
section('parseBuildPackage');
{
  const okRun = P.parseBuildPackage({
    stdout: ['已生成 zip: D:/dist/app.zip | 文件数: 140', '已生成 sdist 到: D:/dist/app-1.0.0.tar.gz'].join('\n'),
    exitCode: 0
  });
  check('zip 与 sdist 都解析到', okRun.fields.zipPath === 'D:/dist/app.zip' && okRun.fields.sdistStatus === 'ok');
  check('ok=true', okRun.ok === true);

  const sdistFail = P.parseBuildPackage({
    stdout: ['已生成 zip: D:/dist/app.zip | 文件数: 140', 'sdist 构建失败（可先 pip install build）：No module named build'].join('\n'),
    exitCode: 0
  });
  check('sdist 失败时 ok=false（退出码仍是 0）', sdistFail.ok === false, JSON.stringify(sdistFail.fields));
  check('sdist 状态为 failed', sdistFail.fields.sdistStatus === 'failed');

  const skipped = P.parseBuildPackage({
    stdout: ['已生成 zip: D:/dist/app.zip | 文件数: 12', '提示：项目无 pyproject.toml，跳过 sdist；如需标准源码包请先创建打包配置。'].join('\n'),
    exitCode: 0
  });
  check('跳过 sdist 不算失败', skipped.ok === true && skipped.fields.sdistStatus === 'skipped');

  const usage = P.parseBuildPackage({ stdout: 'usage: ...', exitCode: 1 });
  check('参数不足时 ran=false', usage.ran === false);
}

// ---------------------------------------------------------------- 7 package_smoke
section('parsePackageSmoke');
{
  const r = P.parsePackageSmoke({
    stdout: ['[PASS] A1 结构与 __init__.py                        12.3 ms', '[FAIL] C2 核心链路                            ', '用例总数: 42   通过: 41   失败: 1   通过率: 97.6%'].join('\n'),
    exitCode: 1
  });
  check('ok=false', r.ok === false);
  check('总数/通过/失败/通过率', r.fields.total === 42 && r.fields.passed === 41 && r.fields.failed === 1 && r.fields.passRatePct === 97.6);
  check('失败用例被列出', r.fields.failedCases.includes('C2'));
  check('提示这是模板脚本', r.notes.some((n) => /模板脚本/.test(n)));

  const missing = P.parsePackageSmoke({ stdout: '!! 包根目录不存在', exitCode: 2 });
  check('退出码 2 标记目录不存在', missing.fields.dirMissing === true);
}

// ---------------------------------------------------------------- 8 check_inline_js
section('parseCheckInlineJs');
{
  const ok = P.parseCheckInlineJs({ stdout: '  inline script #1: OK (120 chars)\nALL OK (3 inline script blocks)', exitCode: 0 });
  check('ok=true 且块数 3', ok.ok === true && ok.fields.blocks === 3);

  const bad = P.parseCheckInlineJs({
    stdout: ['  inline script #2: SYNTAX ERROR -> Unexpected token }', 'FAILED: 1 block(s) with syntax errors'].join('\n'),
    exitCode: 1
  });
  check('ok=false 且错误被记录', bad.ok === false && bad.fields.syntaxErrors === 1);
  check('错误详情进 notes', (bad.notes[0] ?? '').startsWith('#2:'), JSON.stringify(bad.notes));
}

// ---------------------------------------------------------------- 9 check_manual_with_figs
section('parseManualWithFigs');
{
  const r = P.parseManualWithFigs({
    stdout: ['== 说明书（插图版）复验 ==', '箭头符号          0', '图题/图片         图题=37 图片=36 一致=False；图号连续=True；残留占位段=0；表格=12', '提示：图题≠图片通常意味着有重复截图（Word 对完全相同图片去重）——', '结论: 未通过'].join('\n'),
    exitCode: 1
  });
  check('ok=false', r.ok === false);
  check('图题 37 / 图片 36', r.fields.figureCaptions === 37 && r.fields.images === 36);
  check('一致 False', r.fields.figureMatch === false);
  check('图号连续 True', r.fields.numberingContinuous === true);
  check('残留占位段 0', r.fields.placeholdersLeft === 0);
  check('表格 12', r.fields.tables === 12);
  check('重复截图提示被捕获', r.notes.some((n) => /md5/.test(n)));
}

// ---------------------------------------------------------------- 10 extract_docx
section('parseExtractDocx');
{
  const r = P.parseExtractDocx({
    stdout: ['✔ 已提取 412 个段落 -> D:/out/manual.txt', '  正文实际引用 37 张图片（按出现顺序对应"图1~图37"）'].join('\n'),
    stderr: '',
    exitCode: 0
  });
  check('ok=true', r.ok === true);
  check('段落 412 与输出路径', r.fields.paragraphs === 412 && r.fields.outPath === 'D:/out/manual.txt');
  check('引用图片 37', r.fields.referencedImages === 37);

  const notDocx = P.parseExtractDocx({ stdout: '', stderr: '错误：x.txt 不是有效的 docx（缺少 word/document.xml）', exitCode: 1 });
  check('非 docx 时 ok=false 且 stderr 透出', notDocx.ok === false && /不是有效的 docx/.test(notDocx.fields.stderr));
}

// ---------------------------------------------------------------- 11 insert_atlas
section('parseInsertAtlas');
{
  const okRun = P.parseInsertAtlas({
    stdout: ['发现图题 37 处，其中带占位段 37 处', '已备份 -> D:/docs/manual_仅图位版.docx', '已插入图片 37 张并移除占位段，文档已保存', '下一步：check_manual_with_figs.py "D:/docs/manual.docx" --expect 37'].join('\n'),
    exitCode: 0
  });
  check('ok=true', okRun.ok === true);
  check('插图 37 张', okRun.fields.insertedImages === 37);
  check('图题与占位段', okRun.fields.captions === 37 && okRun.fields.captionsWithPlaceholder === 37);
  check('备份路径被记录', /仅图位版/.test(okRun.fields.backupPath));

  const twice = P.parseInsertAtlas({
    stdout: ['发现图题 37 处，其中带占位段 0 处', '警告：文档内已有 37 处图片，疑似已插图过；请从 _仅图位版 备份恢复后重跑', '已插入图片 0 张并移除占位段，文档已保存'].join('\n'),
    exitCode: 0
  });
  check('二次插图时 ok=false（退出码仍是 0）', twice.ok === false);
  check('二次插图给出恢复指引', twice.notes.some((n) => /_仅图位版/.test(n)), JSON.stringify(twice.notes));
  check('已有图片数被解析', twice.fields.existingImages === 37);
}

// ---------------------------------------------------------------- 12 validate_atlas
section('parseValidateAtlas');
{
  const r = P.parseValidateAtlas({
    stdout: ['== 界面图集静态校验 ==', '  截图容器数: 37 | 图注数: 37 | 编号连续: True', '  预期图数: 37 | 实际: 37 | 一致: True', '  图表 div 数: 12 | init 引用数: 12', '  图表未初始化: [] | 无容器初始化: []', '  2559x1559 尺寸: True', '结论: 通过'].join('\n'),
    exitCode: 0
  });
  check('ok=true', r.ok === true);
  check('容器/图注', r.fields.containers === 37 && r.fields.captions === 37);
  check('编号连续 True', r.fields.numberingContinuous === true);
  check('预期/实际一致', r.fields.expectedCaptions === 37 && r.fields.actualCaptions === 37);
  check('图表 div 与 init 引用', r.fields.chartDivs === 12 && r.fields.chartInitRefs === 12);
  check('尺寸布尔', r.fields.sizeOk === true);
}

// ---------------------------------------------------------------- 13 validate_html
section('parseValidateHtml');
{
  const r = P.parseValidateHtml({
    stdout: ['截图容器: 37 | 图注: 37 | 目录锚点: 37 | 目标图数: 37（图1~图37）', '  ✗ 残留占位文字: 待补充', '✗ 存在上述问题，请修复后重跑'].join('\n'),
    exitCode: 1
  });
  check('ok=false', r.ok === false);
  check('四项计数', r.fields.containers === 37 && r.fields.captions === 37 && r.fields.anchors === 37 && r.fields.targetFigures === 37);
  check('问题清单被采集', r.fields.problems.length === 1 && /残留占位文字/.test(r.fields.problems[0]));
}

// ---------------------------------------------------------------- 14 scale_units
section('parseScaleUnits');
{
  const r = P.parseScaleUnits({ stdout: '✔ 已将 5 个 cqw/cqh 单位乘以 1.5 -> D:/out/big.html', exitCode: 0 });
  check('ok=true 且替换 5 处', r.ok === true && r.fields.replaced === 5);
  check('倍率与输出路径', r.fields.factor === '1.5' && r.fields.outPath === 'D:/out/big.html');
}

// ---------------------------------------------------------------- 15 shoot_real_ui
section('parseShootRealUi');
{
  const r = P.parseShootRealUi({
    stdout: ['  图01 -> D:/atlas/fig01.png (420 KB)', '      [警告] 页面未产生滚动，本屏将与上一屏重复——请调大 zoom 或换内容区', '完成，耗时 62.1 s', '唯一图 36 / 总图 37', '重复截图: fig02.png', '唯一性校验: 未通过（按上面重复清单重拍）'].join('\n'),
    stderr: '',
    exitCode: 1
  });
  check('ok=false（唯一性未通过）', r.ok === false);
  check('唯一图 36 / 总图 37', r.fields.uniqueImages === 36 && r.fields.totalImages === 37);
  check('图号列表被采集', r.fields.figures.includes('fig01'));
  check('未滚动警告被提升为提示', r.notes.some((n) => /未产生滚动/.test(n)));

  const crashed = P.parseShootRealUi({ stdout: '', stderr: 'ModuleNotFoundError: No module named playwright', exitCode: 1 });
  check('崩溃时 ran=false', crashed.ran === false);
  check('崩溃时提示含 stderr 摘要', crashed.notes.some((n) => /playwright/.test(n)), JSON.stringify(crashed.notes));

  const ok = P.parseShootRealUi({ stdout: '唯一图 37 / 总图 37\n唯一性校验: 通过', stderr: '', exitCode: 0 });
  check('唯一性通过时 ok=true', ok.ok === true);
}

// ---------------------------------------------------------------- 16 check_aigc
section('parseAigcScan');
{
  const r = P.parseAigcScan({
    stdout: ['== AI 高频词（共 74 种） ==', '  正文段落: 412 | 字数: 33821', '  句长均值: 24.3 | 标准差(突发性): 11.20 | 最长: 128 | 超60字句: 42 | 列举式长句(分号≥3): 9', '== 降幅对比（旧版 → 新版） ==', '  AI 高频词合计: 74 → 25 (↓66%)', '  结构性问题合计: 0'].join('\n'),
    exitCode: 0
  });
  check('扫描跑成功 ok=true', r.ok === true);
  check('高频词种类 74', r.fields.highFrequencyKinds === 74);
  check('段落与字数', r.fields.paragraphs === 412 && r.fields.chars === 33821);
  check('节奏五项', r.fields.avgSentenceLength === 24.3 && r.fields.sentenceStdDev === 11.2 && r.fields.longestSentence === 128 && r.fields.over60Chars === 42 && r.fields.enumeratedLong === 9);
  check('降幅 74→25 =66%', r.fields.oldVocabTotal === 74 && r.fields.newVocabTotal === 25 && r.fields.reductionPct === 66);
  check('结构性残留 0', r.fields.structuralTotal === 0);
  check('明确提示退出码无语义', r.notes.some((n) => /恒 0/.test(n)));
}

// ---------------------------------------------------------------- 17 probe_residue
section('parseProbeResidue');
{
  const ok = P.parseProbeResidue({ stdout: ['标红段总数: 18（颜色: 红/橙/紫）', '全文残留: 0', '✓ 全部标红段已清除（0 残留）'].join('\n'), exitCode: 0 });
  check('ok=true', ok.ok === true);
  check('标红段 18、残留 0', ok.fields.flaggedTotal === 18 && ok.fields.residue === 0);
  check('颜色列表', ok.fields.colors === '红/橙/紫');

  const zero = P.parseProbeResidue({ stdout: '标红段总数: 0（颜色: 红/橙/紫）\n全文残留: 0', exitCode: 0 });
  check('总数为 0 也算 ok（脚本语义）', zero.ok === true);
  check('但明确提示别误判为已达标', zero.notes.some((n) => /本来就没有标红段/.test(n)), JSON.stringify(zero.notes));

  const residue = P.parseProbeResidue({ stdout: '标红段总数: 18（颜色: 红/橙/紫）\n全文残留: 3\n  残留[红]: 本系统采用了…', exitCode: 1 });
  check('有残留时 ok=false 且样本被采集', residue.ok === false && residue.fields.samples.length === 1);

  const badColor = P.parseProbeResidue({ stdout: '', stderr: '无效颜色，可选：红/橙/紫', exitCode: 2 });
  check('退出码 2 标记无效颜色', badColor.fields.invalidColor === true);
}

// ---------------------------------------------------------------- 18/19 hashes
section('parseSourceHashes（collect 变体，汇总在 stderr）');
{
  const digest = 'a'.repeat(64);
  const r = P.parseSourceHashes(
    {
      stdout: [`main.py\t1200\t90\t${digest}`, `db.py\t800\t60\t${'b'.repeat(64)}`].join('\n'),
      stderr: '# TOTAL_FILES=26 TOTAL_LINES=4103 TOTAL_BYTES=204800',
      exitCode: 0
    },
    'collect'
  );
  check('ok=true', r.ok === true);
  check('汇总取自 stderr：26/4103/204800', r.fields.files === 26 && r.fields.lines === 4103 && r.fields.bytes === 204800);
  check('TSV 行数 2', r.fields.entries === 2);
}

section('parseSourceHashes（stats 变体，键名不同）');
{
  const r = P.parseSourceHashes(
    { stdout: `a.py\t10\t5\t${'c'.repeat(64)}`, stderr: '# FILES=1 LINES=5 BYTES=10', exitCode: 0 },
    'stats'
  );
  check('键名 FILES/LINES/BYTES 正确解析', r.fields.files === 1 && r.fields.lines === 5 && r.fields.bytes === 10);

  const noTotals = P.parseSourceHashes({ stdout: `a.py\t10\t5\t${'c'.repeat(64)}`, stderr: '', exitCode: 0 }, 'stats');
  check('缺汇总行时回退为按行累加', noTotals.fields.files === 1 && noTotals.fields.lines === 5);
  check('缺汇总行给出提示', noTotals.notes.some((n) => /stderr/.test(n)));
}

// ---------------------------------------------------------------- 20 gen_proof_docx
section('parseGenProofDocx');
{
  const r = P.parseGenProofDocx({
    stdout: ['已生成: D:/docs/x_源程序文件目录结构及哈希值清单.docx', '已生成: D:/docs/x_项目研发日志.docx', '文件数: 26 | 总行数: 4103'].join('\n'),
    exitCode: 0
  });
  check('ok=true', r.ok === true);
  check('两份文档都被采集', r.fields.generated.length === 2);
  check('文件数/总行数', r.fields.files === 26 && r.fields.lines === 4103);

  const failed = P.parseGenProofDocx({ stdout: '保存失败（目标与 _V2~_V10 均被占用），临时文件位于: C:/tmp/x.docx', exitCode: 0 });
  check('保存失败时 ok=false（退出码仍是 0）', failed.ok === false);
  check('保存失败给出提示', failed.notes.length === 1);
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log('\n失败：');
  for (const f of failures) console.log(`  x ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length === 0 ? 0 : 1);
