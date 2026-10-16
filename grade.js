/*
 * grade.js — Moteur d'étalonnage de LUT Atelier.
 * Toutes les valeurs de couleur sont dans l'intervalle 0..1 (espace sRGB encodé),
 * ce qui correspond au domaine standard d'un fichier .cube (DOMAIN_MIN 0, DOMAIN_MAX 1).
 * Licence MIT.
 */
(function (global) {
  'use strict';

  /** Valeurs neutres : appliquées telles quelles, elles ne modifient pas l'image. */
  var DEFAULTS = {
    exposure: 0, contrast: 1, pivot: 0.45,
    lift: 0, gamma: 1, gain: 1,
    temperature: 0, tint: 0,
    saturation: 1, vibrance: 0,
    shadowHue: 200, shadowAmt: 0,
    highHue: 35, highAmt: 0, balance: 0,
    fade: 0, baseMix: 1, strength: 1
  };

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /** Teinte (degrés) vers une couleur RVB pure, centrée sur 0 (valeurs -0.5..0.5). */
  function hueOffset(h) {
    h = ((h % 360) + 360) % 360 / 60;
    var x = 1 - Math.abs(h % 2 - 1), r = 0, g = 0, b = 0;
    if (h < 1) { r = 1; g = x; } else if (h < 2) { r = x; g = 1; }
    else if (h < 3) { g = 1; b = x; } else if (h < 4) { g = x; b = 1; }
    else if (h < 5) { r = x; b = 1; } else { r = 1; b = x; }
    var m = (r + g + b) / 3; // retire la luminance moyenne pour ne garder que la teinte
    return [r - m, g - m, b - m];
  }

  /**
   * Prépare une fonction d'étalonnage à partir des paramètres.
   * Les calculs coûteux (teintes, puissances) sont faits une seule fois ici.
   * @param {object} p paramètres (voir DEFAULTS)
   * @param {object|null} base LUT importée {size, data:Float32Array} ou null
   * @returns {function(number,number,number,Array):Array} f(r,g,b,out) -> out [r,g,b]
   */
  function makeGrader(p, base) {
    var expo = Math.pow(2, p.exposure);
    var t = p.temperature / 100, ti = p.tint / 100;
    // Balance des blancs simple : chaud = plus de rouge, moins de bleu ; teinte = vert/magenta
    var wbR = 1 + 0.18 * t + 0.06 * ti, wbG = 1 - 0.12 * ti, wbB = 1 - 0.18 * t + 0.06 * ti;
    var invGamma = 1 / p.gamma;
    var sh = hueOffset(p.shadowHue), hi = hueOffset(p.highHue);
    var shA = p.shadowAmt * 0.5, hiA = p.highAmt * 0.5;
    var bal = p.balance;
    var fadeLift = p.fade * 0.16, fadeComp = p.fade * 0.06;
    var tmp = [0, 0, 0];

    return function (r, g, b, out) {
      var r0 = r, g0 = g, b0 = b;

      // 1. LUT importée (optionnelle), mélangée selon baseMix
      if (base) {
        sampleLut(base, r, g, b, tmp);
        var m = p.baseMix;
        r = r + (tmp[0] - r) * m; g = g + (tmp[1] - g) * m; b = b + (tmp[2] - b) * m;
      }

      // 2. Exposition et balance des blancs
      r *= expo * wbR; g *= expo * wbG; b *= expo * wbB;

      // 3. Lift / Gamma / Gain (modèle ASC-CDL simplifié)
      r = p.gain * (r + p.lift * (1 - r));
      g = p.gain * (g + p.lift * (1 - g));
      b = p.gain * (b + p.lift * (1 - b));
      r = r > 0 ? Math.pow(r, invGamma) : r;
      g = g > 0 ? Math.pow(g, invGamma) : g;
      b = b > 0 ? Math.pow(b, invGamma) : b;

      // 4. Contraste autour d'un pivot
      r = p.pivot + (r - p.pivot) * p.contrast;
      g = p.pivot + (g - p.pivot) * p.contrast;
      b = p.pivot + (b - p.pivot) * p.contrast;

      // 5. Saturation et vibrance (la vibrance épargne les couleurs déjà saturées)
      var y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      var curSat = mx > 0 ? (mx - mn) / Math.max(mx, 1e-6) : 0;
      var s = p.saturation * (1 + p.vibrance * (1 - clamp01(curSat)));
      r = y + (r - y) * s; g = y + (g - y) * s; b = y + (b - y) * s;

      // 6. Virage partiel : teinte dans les ombres et dans les hautes lumières
      if (shA || hiA) {
        var yy = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
        var ws = (1 - yy) * (1 - yy) * (1 + bal), wh = yy * yy * (1 - bal);
        r += sh[0] * shA * ws + hi[0] * hiA * wh;
        g += sh[1] * shA * ws + hi[1] * hiA * wh;
        b += sh[2] * shA * ws + hi[2] * hiA * wh;
      }

      // 7. Fondu film : noirs relevés, blancs légèrement compressés
      if (fadeLift) {
        var k = 1 - fadeLift - fadeComp;
        r = fadeLift + r * k; g = fadeLift + g * k; b = fadeLift + b * k;
      }

      // 8. Intensité globale (mélange avec l'image d'origine)
      var st = p.strength;
      out[0] = clamp01(r0 + (r - r0) * st);
      out[1] = clamp01(g0 + (g - g0) * st);
      out[2] = clamp01(b0 + (b - b0) * st);
      return out;
    };
  }

  /** Échantillonne une LUT 3D par interpolation trilinéaire. */
  function sampleLut(lut, r, g, b, out) {
    var n = lut.size, d = lut.data, nm = n - 1;
    var fr = clamp01(r) * nm, fg = clamp01(g) * nm, fb = clamp01(b) * nm;
    var r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    var r1 = Math.min(r0 + 1, nm), g1 = Math.min(g0 + 1, nm), b1 = Math.min(b0 + 1, nm);
    var dr = fr - r0, dg = fg - g0, db = fb - b0;
    for (var c = 0; c < 3; c++) {
      // Index .cube : le rouge varie le plus vite, puis le vert, puis le bleu
      var c000 = d[((b0 * n + g0) * n + r0) * 3 + c], c100 = d[((b0 * n + g0) * n + r1) * 3 + c];
      var c010 = d[((b0 * n + g1) * n + r0) * 3 + c], c110 = d[((b0 * n + g1) * n + r1) * 3 + c];
      var c001 = d[((b1 * n + g0) * n + r0) * 3 + c], c101 = d[((b1 * n + g0) * n + r1) * 3 + c];
      var c011 = d[((b1 * n + g1) * n + r0) * 3 + c], c111 = d[((b1 * n + g1) * n + r1) * 3 + c];
      var c00 = c000 + (c100 - c000) * dr, c10 = c010 + (c110 - c010) * dr;
      var c01 = c001 + (c101 - c001) * dr, c11 = c011 + (c111 - c011) * dr;
      var c0 = c00 + (c10 - c00) * dg, c1 = c01 + (c11 - c01) * dg;
      out[c] = c0 + (c1 - c0) * db;
    }
    return out;
  }

  /** Construit une LUT 3D de taille n à partir d'une fonction d'étalonnage. */
  function buildLut(grader, n) {
    var data = new Float32Array(n * n * n * 3), o = [0, 0, 0], i = 0, nm = n - 1;
    for (var b = 0; b < n; b++)
      for (var g = 0; g < n; g++)
        for (var r = 0; r < n; r++) {
          grader(r / nm, g / nm, b / nm, o);
          data[i++] = o[0]; data[i++] = o[1]; data[i++] = o[2];
        }
    return { size: n, data: data };
  }

  /** Sérialise une LUT au format Adobe/Resolve .cube. */
  function toCube(lut, title) {
    var lines = [
      '# Created with LUT Atelier - https://salimadour31-boop.github.io/lut-atelier/',
      'TITLE "' + String(title || 'LUT Atelier').replace(/"/g, '') + '"',
      'LUT_3D_SIZE ' + lut.size,
      'DOMAIN_MIN 0.0 0.0 0.0',
      'DOMAIN_MAX 1.0 1.0 1.0'
    ];
    var d = lut.data;
    for (var i = 0; i < d.length; i += 3)
      lines.push(d[i].toFixed(6) + ' ' + d[i + 1].toFixed(6) + ' ' + d[i + 2].toFixed(6));
    return lines.join('\n') + '\n';
  }

  /**
   * Lit un fichier .cube (LUT 3D). Gère TITLE, LUT_3D_SIZE, DOMAIN_MIN/MAX et les commentaires.
   * Lève une erreur si le fichier n'est pas une LUT 3D valide.
   */
  function parseCube(text) {
    var size = 0, min = [0, 0, 0], max = [1, 1, 1], vals = [], title = '';
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l || l.charAt(0) === '#') continue;
      var parts = l.split(/\s+/), key = parts[0].toUpperCase();
      if (key === 'TITLE') { title = l.slice(5).trim().replace(/^"|"$/g, ''); continue; }
      if (key === 'LUT_3D_SIZE') { size = parseInt(parts[1], 10); continue; }
      if (key === 'LUT_1D_SIZE') throw new Error('1D');
      if (key === 'DOMAIN_MIN') { min = parts.slice(1, 4).map(Number); continue; }
      if (key === 'DOMAIN_MAX') { max = parts.slice(1, 4).map(Number); continue; }
      if (/^[A-Z_]+$/.test(key)) continue; // autres mots-clés ignorés
      if (parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
    }
    if (!(size >= 2 && size <= 256) || vals.length !== size * size * size * 3) throw new Error('size');
    var data = new Float32Array(vals.length);
    for (var j = 0; j < vals.length; j++) {
      var c = j % 3, span = (max[c] - min[c]) || 1;
      data[j] = (vals[j] - min[c]) / span;
      if (!isFinite(data[j])) throw new Error('nan');
    }
    return { size: size, data: data, title: title };
  }

  global.Grade = {
    DEFAULTS: DEFAULTS, makeGrader: makeGrader, sampleLut: sampleLut,
    buildLut: buildLut, toCube: toCube, parseCube: parseCube
  };
})(typeof window !== 'undefined' ? window : globalThis);
