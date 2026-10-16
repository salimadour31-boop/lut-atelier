/*
 * app.js — Interface de LUT Atelier : chargement d'image/LUT, réglages, aperçu,
 * parade RVB et exports (.cube, PNG, Hald CLUT). Licence MIT.
 */
(function () {
  'use strict';
  var G = window.Grade, I18N = window.I18N;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Définition des réglages (min, max, pas) ---------- */
  var GROUPS = [
    { id: 'g_light', items: [
      ['exposure', -3, 3, 0.05], ['contrast', 0.5, 2, 0.01], ['pivot', 0.2, 0.7, 0.01],
      ['lift', -0.3, 0.3, 0.005], ['gamma', 0.5, 2, 0.01], ['gain', 0.5, 1.6, 0.01]] },
    { id: 'g_color', items: [
      ['temperature', -100, 100, 1], ['tint', -100, 100, 1],
      ['saturation', 0, 2, 0.01], ['vibrance', -1, 1, 0.01]] },
    { id: 'g_split', items: [
      ['shadowHue', 0, 360, 1, 'hue'], ['shadowAmt', 0, 1, 0.01],
      ['highHue', 0, 360, 1, 'hue'], ['highAmt', 0, 1, 0.01], ['balance', -1, 1, 0.01]] },
    { id: 'g_film', items: [
      ['fade', 0, 1, 0.01], ['baseMix', 0, 1, 0.01], ['strength', 0, 1, 0.01]] }
  ];

  /* ---------- Préréglages originaux (valeurs différentes des défauts) ---------- */
  var PRESETS = {
    p_neutral: {},
    p_tealorange: { contrast: 1.15, saturation: 1.1, shadowHue: 190, shadowAmt: 0.55, highHue: 30, highAmt: 0.45 },
    p_bleach: { saturation: 0.45, contrast: 1.4, gamma: 0.95, lift: -0.02 },
    p_warmfilm: { temperature: 30, fade: 0.35, contrast: 1.05, saturation: 0.9, highHue: 40, highAmt: 0.2 },
    p_daynight: { exposure: -1.3, temperature: -70, saturation: 0.55, shadowHue: 220, shadowAmt: 0.5, contrast: 1.1 },
    p_western: { temperature: 45, saturation: 0.7, fade: 0.2, highHue: 38, highAmt: 0.35, contrast: 1.15 },
    p_noir: { saturation: 0, contrast: 1.5, gamma: 0.9 },
    p_matrix: { tint: -60, shadowHue: 130, shadowAmt: 0.4, saturation: 0.8, contrast: 1.2 },
    p_nordic: { temperature: -45, saturation: 0.75, lift: 0.03, contrast: 1.05 },
    p_dream: { fade: 0.45, saturation: 0.8, lift: 0.05, highHue: 320, highAmt: 0.25, contrast: 0.85, exposure: 0.2 },
    p_sunset: { temperature: 55, highHue: 30, highAmt: 0.5, shadowHue: 280, shadowAmt: 0.2, vibrance: 0.3 },
    p_horror: { saturation: 0.3, tint: -20, contrast: 1.35, exposure: -0.4, shadowHue: 160, shadowAmt: 0.3 }
  };

  var params = Object.assign({}, G.DEFAULTS);
  var base = null;            // LUT importée
  var lang = 'fr';
  var srcFull = null;         // canvas à pleine résolution
  var srcPrev = null;         // ImageData de l'aperçu (non étalonné)
  var view = $('view'), vctx = view.getContext('2d');
  var graded = null;          // canvas de l'aperçu étalonné
  var pending = false, currentPreset = 'p_neutral';

  /* ---------- Traduction ---------- */
  function t(k) { return (I18N[lang] && I18N[lang][k]) || I18N.fr[k] || k; }
  function applyLang() {
    document.documentElement.lang = lang === 'kab' ? 'kab' : lang;
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-label]').forEach(function (el) { el.textContent = t(el.dataset.label); });
    if (base) showBase();
  }

  /* ---------- Construction des contrôles ---------- */
  function fmt(k, v) {
    if (k === 'shadowHue' || k === 'highHue') return Math.round(v) + '°';
    if (k === 'temperature' || k === 'tint') return (v > 0 ? '+' : '') + Math.round(v);
    if (k === 'exposure') return (v > 0 ? '+' : '') + v.toFixed(2);
    return v.toFixed(2);
  }
  function buildControls() {
    var root = $('controls');
    GROUPS.forEach(function (g) {
      var fs = document.createElement('fieldset');
      var lg = document.createElement('legend'); lg.dataset.label = g.id; fs.appendChild(lg);
      g.items.forEach(function (it) {
        var k = it[0], lab = document.createElement('label'); lab.className = 'ctl';
        var name = document.createElement('span'); name.dataset.label = k;
        var out = document.createElement('output'); out.id = 'o_' + k;
        var inp = document.createElement('input');
        inp.type = 'range'; inp.min = it[1]; inp.max = it[2]; inp.step = it[3]; inp.id = 'c_' + k;
        if (it[4] === 'hue') inp.className = 'hue';
        inp.title = '↺ double-clic';
        inp.addEventListener('input', function () { params[k] = +inp.value; currentPreset = null; markPreset(); sync(k); schedule(); });
        inp.addEventListener('dblclick', function () { params[k] = G.DEFAULTS[k]; sync(k); schedule(); });
        var head = document.createElement('span'); head.className = 'ctl-head';
        head.appendChild(name); head.appendChild(out);
        lab.appendChild(head); lab.appendChild(inp); fs.appendChild(lab);
      });
      root.appendChild(fs);
    });
    var pr = $('presets');
    Object.keys(PRESETS).forEach(function (key) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'preset';
      b.dataset.label = key; b.dataset.key = key;
      b.addEventListener('click', function () { applyPreset(key); });
      pr.appendChild(b);
    });
  }
  function sync(k) {
    var keys = k ? [k] : Object.keys(G.DEFAULTS);
    keys.forEach(function (key) {
      var i = $('c_' + key), o = $('o_' + key);
      if (i) i.value = params[key];
      if (o) o.textContent = fmt(key, params[key]);
    });
  }
  function applyPreset(key) {
    params = Object.assign({}, G.DEFAULTS, PRESETS[key]);
    if (base) params.baseMix = 1;
    currentPreset = key; markPreset(); sync(); schedule();
  }
  function markPreset() {
    document.querySelectorAll('.preset').forEach(function (b) { b.classList.toggle('on', b.dataset.key === currentPreset); });
  }

  /* ---------- Application d'une LUT à des pixels ---------- */
  function currentLut(n) { return G.buildLut(G.makeGrader(params, base), n); }
  function applyLut(lut, src, dst) {
    var s = src.data, d = dst.data, o = [0, 0, 0], k = 1 / 255;
    for (var i = 0; i < s.length; i += 4) {
      G.sampleLut(lut, s[i] * k, s[i + 1] * k, s[i + 2] * k, o);
      d[i] = o[0] * 255 + 0.5; d[i + 1] = o[1] * 255 + 0.5; d[i + 2] = o[2] * 255 + 0.5; d[i + 3] = s[i + 3];
    }
  }

  /* ---------- Rendu de l'aperçu ---------- */
  function schedule() {
    if (pending) return; pending = true;
    requestAnimationFrame(function () { pending = false; render(); });
  }
  function render() {
    if (!srcPrev) return;
    var lut = currentLut(33);
    var out = new ImageData(srcPrev.width, srcPrev.height);
    applyLut(lut, srcPrev, out);
    graded.getContext('2d').putImageData(out, 0, 0);
    drawView();
    if ($('showScope').checked) drawScope(out);
    writeHash();
  }
  function drawView() {
    if (!graded) return;
    var w = view.width, h = view.height, sx = Math.round(w * (+$('split').value) / 100);
    vctx.drawImage(graded, 0, 0);
    if (sx > 0) { vctx.putImageData(srcPrev, 0, 0, 0, 0, sx, h); }
    var line = $('splitLine');
    line.style.left = (+$('split').value) + '%';
    line.hidden = sx <= 0 || sx >= w;
  }

  /* Parade RVB : distribution des valeurs de chaque canal, colonne par colonne */
  function drawScope(img) {
    var c = $('scope'), ctx = c.getContext('2d'), W = c.width, H = c.height, pw = Math.floor(W / 3);
    var acc = [new Uint16Array(pw * H), new Uint16Array(pw * H), new Uint16Array(pw * H)];
    var d = img.data, iw = img.width, ih = img.height, stepY = Math.max(1, Math.floor(ih / 160));
    for (var y = 0; y < ih; y += stepY) for (var x = 0; x < iw; x += 2) {
      var i = (y * iw + x) * 4, col = Math.floor(x / iw * pw);
      for (var ch = 0; ch < 3; ch++) {
        var row = H - 1 - Math.floor(d[i + ch] / 256 * H);
        acc[ch][row * pw + col]++;
      }
    }
    var out = ctx.createImageData(W, H), od = out.data;
    // Nombre d'échantillons par colonne de la parade, pour normaliser la densité
    var perCol = Math.max(1, Math.ceil(ih / stepY) * (iw / 2) / pw);
    for (var p = 0; p < od.length; p += 4) { od[p] = od[p + 1] = od[p + 2] = 12; od[p + 3] = 255; }
    for (var chn = 0; chn < 3; chn++) for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < pw; xx++) {
      var v = acc[chn][yy * pw + xx]; if (!v) continue;
      var o = (yy * W + chn * pw + xx) * 4, a = Math.min(255, 35 + 220 * Math.sqrt(v / (perCol * 0.08)));
      od[o + chn] = Math.max(od[o + chn], a);
      od[o + (chn + 1) % 3] = Math.max(od[o + (chn + 1) % 3], a * 0.25);
      od[o + (chn + 2) % 3] = Math.max(od[o + (chn + 2) % 3], a * 0.25);
    }
    ctx.putImageData(out, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    for (var q = 1; q < 4; q++) { ctx.beginPath(); ctx.moveTo(0, H * q / 4 + .5); ctx.lineTo(W, H * q / 4 + .5); ctx.stroke(); }
  }

  /* ---------- Sources ---------- */
  function setSource(canvas) {
    srcFull = canvas;
    var maxW = 1400, sc = Math.min(1, maxW / canvas.width);
    var w = Math.max(1, Math.round(canvas.width * sc)), h = Math.max(1, Math.round(canvas.height * sc));
    var tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    var tctx = tmp.getContext('2d'); tctx.drawImage(canvas, 0, 0, w, h);
    srcPrev = tctx.getImageData(0, 0, w, h);
    view.width = w; view.height = h;
    graded = document.createElement('canvas'); graded.width = w; graded.height = h;
    document.body.classList.add('has-image');
    render();
  }
  function loadImageFile(file) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas'), maxSide = 8000;
      var sc = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); setSource(c);
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast(t('imgError')); };
    img.src = url;
  }
  function loadCubeFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        base = G.parseCube(String(r.result));
        base.name = file.name; params.baseMix = 1; sync('baseMix');
        showBase(); toast(t('cubeLoaded') + file.name); schedule();
      } catch (e) { toast(t('cubeError')); }
    };
    r.readAsText(file);
  }
  function showBase() {
    var el = $('baseInfo'); el.hidden = !base; if (!base) return;
    el.innerHTML = '';
    el.appendChild(document.createTextNode('LUT : ' + (base.title || base.name) + ' (' + base.size + '³) '));
    var x = document.createElement('button'); x.type = 'button'; x.textContent = '× ' + t('removeBase');
    x.addEventListener('click', function () { base = null; showBase(); schedule(); });
    el.appendChild(x);
  }
  function handleFiles(files) {
    Array.prototype.forEach.call(files, function (f) {
      if (/\.cube$/i.test(f.name)) loadCubeFile(f);
      else if (/^image\//.test(f.type)) loadImageFile(f);
    });
  }

  /* Image d'essai générée par le code (aucune ressource externe, libre de droits) */
  function sampleImage() {
    var W = 1600, H = 900, c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    var sky = x.createLinearGradient(0, 0, 0, H * 0.62);
    sky.addColorStop(0, '#1d3c78'); sky.addColorStop(0.55, '#6f8fc4'); sky.addColorStop(1, '#f2b37a');
    x.fillStyle = sky; x.fillRect(0, 0, W, H);
    var sun = x.createRadialGradient(W * 0.68, H * 0.5, 10, W * 0.68, H * 0.5, 220);
    sun.addColorStop(0, 'rgba(255,248,220,1)'); sun.addColorStop(0.18, 'rgba(255,214,140,.95)'); sun.addColorStop(1, 'rgba(255,170,90,0)');
    x.fillStyle = sun; x.fillRect(0, 0, W, H);
    function ridge(y0, amp, color, seed) {
      x.beginPath(); x.moveTo(0, H);
      for (var i = 0; i <= W; i += 8) {
        var y = y0 + Math.sin(i * 0.004 + seed) * amp + Math.sin(i * 0.013 + seed * 2) * amp * 0.35;
        x.lineTo(i, y);
      }
      x.lineTo(W, H); x.closePath(); x.fillStyle = color; x.fill();
    }
    ridge(H * 0.56, 40, '#5b5f86', 1); ridge(H * 0.63, 34, '#3a4060', 2.3); ridge(H * 0.72, 26, '#22291f', 4.1);
    var ground = x.createLinearGradient(0, H * 0.72, 0, H);
    ground.addColorStop(0, 'rgba(60,82,40,.0)'); ground.addColorStop(1, '#2f3d1c');
    x.fillStyle = ground; x.fillRect(0, H * 0.7, W, H * 0.3);
    // Silhouette stylisée avec un visage aux tons chair (pour juger les carnations)
    x.fillStyle = '#c98b6a'; x.beginPath(); x.ellipse(W * 0.27, H * 0.47, 58, 74, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#e2ae8c'; x.beginPath(); x.ellipse(W * 0.262, H * 0.455, 34, 46, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#7a2e2a'; x.beginPath(); x.moveTo(W * 0.2, H); x.quadraticCurveTo(W * 0.21, H * 0.6, W * 0.27, H * 0.58);
    x.quadraticCurveTo(W * 0.33, H * 0.6, W * 0.34, H); x.closePath(); x.fill();
    // Rampe de gris et nuancier de contrôle
    var rampY = H - 70, rw = W * 0.5;
    for (var s = 0; s < 16; s++) { var v = Math.round(s / 15 * 255); x.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; x.fillRect(W * 0.46 + s * rw / 16, rampY, rw / 16 + 1, 46); }
    var chips = ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#d35d8a'];
    chips.forEach(function (col, i) { x.fillStyle = col; x.fillRect(W * 0.46 + i * rw / 8, rampY - 52, rw / 8 - 4, 44); });
    return c;
  }

  /* ---------- Exports ---------- */
  function safeName() {
    return ($('lutName').value || 'lut-atelier').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'lut-atelier';
  }
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast(t('exported') + name);
  }
  function exportCube() {
    var n = +$('lutSize').value, lut = currentLut(n);
    download(new Blob([G.toCube(lut, $('lutName').value)], { type: 'text/plain' }), safeName() + '-' + n + '.cube');
  }
  function exportPng() {
    if (!srcFull) return;
    var w = srcFull.width, h = srcFull.height, c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'); ctx.drawImage(srcFull, 0, 0);
    var img = ctx.getImageData(0, 0, w, h); applyLut(currentLut(33), img, img); ctx.putImageData(img, 0, 0);
    c.toBlob(function (b) { download(b, safeName() + '.png'); }, 'image/png');
  }
  /* Hald CLUT niveau 8 (512×512, cube 64³) : compatible GIMP/G'MIC, darktable, RawTherapee, FFmpeg */
  function exportHald() {
    var L = 8, N = L * L, W = L * L * L, c = document.createElement('canvas'); c.width = W; c.height = W;
    var ctx = c.getContext('2d'), img = ctx.createImageData(W, W), d = img.data;
    var f = G.makeGrader(params, base), o = [0, 0, 0], i = 0;
    for (var b = 0; b < N; b++) for (var g = 0; g < N; g++) for (var r = 0; r < N; r++) {
      f(r / (N - 1), g / (N - 1), b / (N - 1), o);
      d[i] = o[0] * 255 + 0.5; d[i + 1] = o[1] * 255 + 0.5; d[i + 2] = o[2] * 255 + 0.5; d[i + 3] = 255; i += 4;
    }
    ctx.putImageData(img, 0, 0);
    c.toBlob(function (bl) { download(bl, safeName() + '-hald8.png'); }, 'image/png');
  }

  /* ---------- Lien partageable (réglages dans l'adresse) ---------- */
  function writeHash() {
    var parts = [];
    Object.keys(G.DEFAULTS).forEach(function (k) { if (params[k] !== G.DEFAULTS[k]) parts.push(k + '=' + (+params[k].toFixed(3))); });
    var h = parts.length ? '#' + parts.join('&') : ' ';
    history.replaceState(null, '', h === ' ' ? location.pathname + location.search : h);
  }
  function readHash() {
    location.hash.slice(1).split('&').forEach(function (p) {
      var kv = p.split('='); if (kv[0] in G.DEFAULTS && isFinite(+kv[1])) { params[kv[0]] = +kv[1]; currentPreset = null; }
    });
  }
  function copyLink() {
    writeHash();
    var url = location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast(t('copied')); }, function () { toast(t('copyFail') + url); });
    else toast(t('copyFail') + url);
  }

  var toastTimer;
  function toast(msg) {
    var el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  /* ---------- Événements ---------- */
  function initEvents() {
    $('lang').addEventListener('change', function () { lang = this.value; try { localStorage.setItem('lutatelier-lang', lang); } catch (e) {} applyLang(); });
    $('fileImg').addEventListener('change', function () { handleFiles(this.files); this.value = ''; });
    $('fileCube').addEventListener('change', function () { handleFiles(this.files); this.value = ''; });
    $('btnSample').addEventListener('click', function () { setSource(sampleImage()); });
    $('split').addEventListener('input', drawView);
    $('showScope').addEventListener('change', function () { $('scope').hidden = !this.checked; schedule(); });
    $('btnCube').addEventListener('click', exportCube);
    $('btnPng').addEventListener('click', exportPng);
    $('btnHald').addEventListener('click', exportHald);
    $('btnReset').addEventListener('click', function () { applyPreset('p_neutral'); });
    $('btnCopy').addEventListener('click', copyLink);
    // Glisser le curseur avant/après directement sur l'image
    var dragging = false;
    function setSplit(e) {
      var r = view.getBoundingClientRect();
      $('split').value = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)); drawView();
    }
    view.addEventListener('pointerdown', function (e) { dragging = true; view.setPointerCapture(e.pointerId); setSplit(e); });
    view.addEventListener('pointermove', function (e) { if (dragging) setSplit(e); });
    view.addEventListener('pointerup', function () { dragging = false; });
    // Glisser-déposer de fichiers
    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer) handleFiles(e.dataTransfer.files); });
  }

  /* ---------- Démarrage ---------- */
  try { lang = localStorage.getItem('lutatelier-lang') || ''; } catch (e) { lang = ''; }
  if (!I18N[lang]) { var nl = (navigator.language || 'fr').slice(0, 2); lang = nl === 'en' ? 'en' : (nl === 'kab' ? 'kab' : 'fr'); }
  var qs = new URLSearchParams(location.search).get('lang'); if (qs && I18N[qs]) lang = qs;
  $('lang').value = lang;
  buildControls(); readHash(); sync(); markPreset(); applyLang(); initEvents();
  setSource(sampleImage());
})();
