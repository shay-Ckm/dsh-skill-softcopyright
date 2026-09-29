/*
 * export-png.js — "一键导出 PNG（2559×1559）"功能片段
 * =====================================================
 * 用途：让界面图集 HTML 支持把每张 .shot 截图导出为 2559×1559 PNG，
 *       免去手动逐张截图。用法：把下方 CSS 片段复制进 <style>，
 *       JS 片段复制进页面末尾的 <script>（保留原有目录平滑滚动脚本）。
 *
 * 导出策略（双重保障）：
 *   主路径 html2canvas（纯 JS 重绘，不触发浏览器 Tainted canvas 安全限制；
 *       读取浏览器已计算像素值，cqw/cqh 已被原生解析，无需单位换算）。
 *       库加载：优先 window.html2canvas（若已内联 assets/html2canvas.min.js），
 *       否则动态加载 CDN（需联网）。
 *   回退路径 SVG <foreignObject>（个别浏览器可能 Tainted → 降级下载 .svg）。
 *
 * 原理：克隆 .shot 为 2559px 宽的离屏容器（cqw/cqh 容器查询按 2559 基准
 *       重新计算，即"原始设计尺寸"），挂载到 document.body 隐藏容器完成
 *       真实布局，再交给 html2canvas 截图。导出前对克隆节点消毒：
 *       嵌套 <svg>→dataURI <img>、表单控件→<span>，规避 Tainted 与兼容性。
 * 依赖：现代 Chromium 内核浏览器（Chrome / Edge）。
 *
 * ============ CSS 片段（复制进 <style> 末尾） ============
.export-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 13px;border:1px solid #91caff;border-radius:6px;background:#fff;color:#1677ff;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:all .15s}
.export-btn:hover{background:#e6f4ff;border-color:#1677ff}
.cap .export-btn{height:24px;font-size:12px;padding:0 10px;margin-left:10px;vertical-align:middle}
.fab-export{position:fixed;right:22px;bottom:26px;z-index:300;height:38px;padding:0 18px;font-size:13.5px;border-color:#1677ff;background:#1677ff;color:#fff;box-shadow:0 4px 16px rgba(22,119,255,.35)}
.fab-export:hover{background:#0e5fd8;border-color:#0e5fd8}
.fab-export.working{opacity:.75;cursor:wait}
#exportHint{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:400;background:rgba(11,31,58,.92);color:#fff;font-size:13px;padding:8px 18px;border-radius:8px;display:none}
 * ============ JS 片段（复制进 <script>） ============
 * 离线可选：把 assets/html2canvas.min.js 内容内联为 <script>...</script>
 * 置于本片段之前，则无需联网。
 */
(function(){
  var pageCss = Array.prototype.map.call(document.querySelectorAll('style'), function(s){ return s.textContent; }).join('\n');
  var hintEl = null;
  function showHint(msg){
    if(!hintEl){ hintEl = document.createElement('div'); hintEl.id='exportHint'; document.body.appendChild(hintEl); }
    hintEl.textContent = msg;
    hintEl.style.display = 'block';
  }
  function hideHint(){ if(hintEl) hintEl.style.display = 'none'; }

  // 规避 canvas Tainted：foreignObject 内嵌套 <svg> 与原生表单控件会被 Chrome 视为跨源。
  // 1) 嵌套 <svg>（图表）→ 序列化为 dataURI 的 <img>；2) input/button/select/textarea → <span>（保留 class 与样式）
  function sanitizeCloneForSvg(node){
    node.querySelectorAll('svg').forEach(function(svgEl){
      var s = new XMLSerializer().serializeToString(svgEl);
      var b64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s)));
      var img = document.createElement('img');
      img.src = b64;
      img.style.width = svgEl.getAttribute('width') || '100%';
      img.style.height = svgEl.getAttribute('height') || '';
      if(svgEl.getAttribute('style')) img.setAttribute('style', svgEl.getAttribute('style'));
      svgEl.parentNode.replaceChild(img, svgEl);
    });
    node.querySelectorAll('input,button,select,textarea').forEach(function(el){
      var d = document.createElement('span');
      d.className = el.className || '';
      if(el.getAttribute('style')) d.setAttribute('style', el.getAttribute('style'));
      if(el.tagName === 'INPUT'){
        d.textContent = el.value || el.placeholder || '';
        d.style.display = 'inline-flex';
        d.style.alignItems = 'center';
      } else {
        d.textContent = el.textContent || '';
      }
      el.parentNode.replaceChild(d, el);
    });
  }

  // 动态加载 html2canvas（CDN）。html2canvas 为纯 JS 重绘，不经过 SVG foreignObject，
  // 不触发浏览器 canvas Tainted 安全限制；它读取浏览器已计算好的像素值（cqw 已被原生解析）。
  var h2cPromise = null;
  function loadHtml2canvas(){
    if(window.html2canvas) return Promise.resolve(window.html2canvas);
    if(h2cPromise) return h2cPromise;
    h2cPromise = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = 'https://html2canvas.hertzen.com/dist/html2canvas.min.js';
      s.onload = function(){ resolve(window.html2canvas); };
      s.onerror = function(){ reject(new Error('html2canvas CDN 加载失败（可能需要联网）')); };
      document.head.appendChild(s);
    });
    return h2cPromise;
  }

  // 克隆 .shot 为 2559×1559 并挂载到隐藏 DOM（html2canvas 依赖真实布局计算位置）
  function makeClone(figEl){
    var shot = figEl.querySelector('.shot');
    if(!shot) return null;
    var clone = shot.cloneNode(true);
    clone.style.maxWidth = 'none';
    clone.style.width = '2559px';
    clone.style.height = '1559px';
    sanitizeCloneForSvg(clone); // svg→img dataURI、表单控件→span
    var holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:2559px;height:1559px;overflow:hidden;pointer-events:none;z-index:-1;';
    holder.appendChild(clone);
    document.body.appendChild(holder);
    clone.offsetHeight; // 强制 reflow，确保布局完成
    return {clone: clone, holder: holder};
  }

  // 主路径：html2canvas
  function exportViaHtml2canvas(env, fileName){
    return loadHtml2canvas().then(function(h2c){
      return h2c(env.clone, {scale:1, width:2559, height:1559, backgroundColor:'#ffffff', logging:false, useCORS:true});
    }).then(function(canvas){
      var a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = fileName;
      a.click();
    });
  }

  // 回退路径：SVG foreignObject（可能受浏览器 Tainted 限制）
  function exportViaForeignObject(figEl, fileName){
    var shot = figEl.querySelector('.shot');
    var clone = shot.cloneNode(true);
    clone.style.maxWidth = 'none';
    clone.style.width = '2559px';
    clone.style.height = '1559px';
    sanitizeCloneForSvg(clone);
    var wrapper = document.createElement('div');
    wrapper.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
    var styleEl = document.createElement('style');
    styleEl.textContent = pageCss;
    wrapper.appendChild(styleEl);
    wrapper.appendChild(clone);
    var svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
    svg.setAttribute('width','2559');
    svg.setAttribute('height','1559');
    var fo = document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
    fo.setAttribute('width','100%');
    fo.setAttribute('height','100%');
    fo.appendChild(wrapper);
    svg.appendChild(fo);
    var holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:2559px;height:1559px;overflow:hidden;pointer-events:none;z-index:-1;';
    holder.appendChild(svg);
    document.body.appendChild(holder);
    var svgStr = new XMLSerializer().serializeToString(svg);
    var blob = new Blob([svgStr], {type:'image/svg+xml;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    return new Promise(function(resolve, reject){
      var img = new Image();
      img.onload = function(){
        try {
          var canvas = document.createElement('canvas');
          canvas.width = 2559; canvas.height = 1559;
          canvas.getContext('2d').drawImage(img, 0, 0, 2559, 1559);
          var a = document.createElement('a');
          a.href = canvas.toDataURL('image/png');
          a.download = fileName;
          a.click();
          resolve();
        } catch(e) {
          var svgName = fileName.replace(/\.png$/i, '') + '.svg';
          var a2 = document.createElement('a');
          a2.href = url;
          a2.download = svgName;
          a2.click();
          reject(new Error('PNG 导出受浏览器安全限制（Tainted canvas），已降级下载 SVG 矢量文件：' + svgName + '。可将 SVG 用浏览器打开后另存为 PNG，或使用最新版 Chrome/Edge 重试。'));
        } finally {
          URL.revokeObjectURL(url);
          document.body.removeChild(holder);
        }
      };
      img.onerror = function(){
        URL.revokeObjectURL(url);
        document.body.removeChild(holder);
        reject(new Error('导出失败：' + fileName + '（当前浏览器不支持 SVG foreignObject 渲染，请使用最新版 Chrome / Edge 打开本页面后重试）'));
      };
      img.src = url;
    });
  }

  function doExportFig(figEl){
    var capB = figEl.querySelector('.cap b');
    var fileName = (capB ? capB.textContent.trim() : '图') + '.png';
    var env = makeClone(figEl);
    if(!env) return Promise.reject(new Error('未找到截图容器'));
    return exportViaHtml2canvas(env, fileName).then(function(){
      document.body.removeChild(env.holder);
    }).catch(function(err){
      document.body.removeChild(env.holder);
      return exportViaForeignObject(figEl, fileName).catch(function(e2){
        throw e2;
      });
    });
  }
  // 等待字体加载完成后再导出，避免中文/图标缺失
  function exportFigPng(figEl){
    var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready.then(function(){}) : Promise.resolve();
    return ready.then(function(){ return doExportFig(figEl); });
  }
  window.exportFigPng = exportFigPng;

  // 每张图注右侧注入"导出PNG"按钮
  document.querySelectorAll('.fig').forEach(function(fig){
    var cap = fig.querySelector('.cap');
    if(!cap) return;
    var btn = document.createElement('button');
    btn.className = 'export-btn';
    btn.textContent = '导出PNG';
    btn.addEventListener('click', function(){
      var label = fig.querySelector('.cap b') ? fig.querySelector('.cap b').textContent : '';
      showHint('正在导出 ' + label + ' …');
      exportFigPng(fig).then(hideHint).catch(function(e){ hideHint(); alert(e.message); });
    });
    cap.appendChild(btn);
  });

  // 右下角悬浮"全部导出"按钮
  var fab = document.createElement('button');
  fab.className = 'export-btn fab-export';
  fab.id = 'exportAllBtn2';
  fab.textContent = '⬇ 全部导出 PNG';
  fab.addEventListener('click', function(){
    var figs = Array.prototype.slice.call(document.querySelectorAll('.fig'));
    var orig = fab.textContent;
    fab.classList.add('working');
    (async function(){
      try {
        for(var i = 0; i < figs.length; i++){
          fab.textContent = '导出中 ' + (i+1) + '/' + figs.length + ' …';
          showHint('正在导出 ' + (i+1) + '/' + figs.length + '：' + (figs[i].querySelector('.cap b') ? figs[i].querySelector('.cap b').textContent : ''));
          await exportFigPng(figs[i]);
          await new Promise(function(r){ setTimeout(r, 400); }); // 间隔，避免浏览器拦截批量下载
        }
        showHint('✔ 全部 ' + figs.length + ' 张已导出');
        setTimeout(hideHint, 2000);
      } catch(e) {
        showHint('✗ ' + e.message);
        setTimeout(hideHint, 3000);
      } finally {
        fab.textContent = orig;
        fab.classList.remove('working');
      }
    })();
  });
  document.body.appendChild(fab);

  // 页头"一键导出全部"按钮联动（需页面中存在 id="exportAllBtn" 的按钮）
  var topBtn = document.getElementById('exportAllBtn');
  if(topBtn) topBtn.addEventListener('click', function(){
    var fab2 = document.getElementById('exportAllBtn2');
    if(fab2) fab2.click();
  });
})();
