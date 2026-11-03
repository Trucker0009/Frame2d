/* app.js - drawing UI for the 2D frame app. Uses solver2d.js (solver) and core.js (document logic). */
(function () {
  'use strict';
  const C = window.SA2DCore;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const numStr = v => String(+(+v).toPrecision(12));
  const clone = o => JSON.parse(JSON.stringify(o));
  function fmt(v) { if (v === undefined || v === null || !isFinite(v)) return '–'; if (Math.abs(v) < 1e-9) return '0'; return String(+v.toPrecision(4)); }
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return e;
  }

  /* ---------------- state ---------------- */
  let doc = C.newDoc();
  const S = { grid: 1, snap: true, fu: 'kN', lu: 'm', E: 2e8, A: 0.01, I: 1e-4, labels: true, react: true };
  const opt = { memberType: 'frame', chain: true, support: 'pin', inclInput: 'angle', inclAngle: 26.565051, rise: 1, run: 2, loadType: 'point', F: 10, ang: 90, system: 'global', w1: 10, w2: 10, from: '', to: '', M: 10, nx: 0, ny: 0 };
  const inclAng = () => opt.inclInput === 'angle' ? +opt.inclAngle : +(Math.atan2(opt.rise, opt.run) * 180 / Math.PI).toFixed(6);   // slope surface angle from Angle or Rise / Run
  let tool = 'select', sel = null, pending = null, hover = null;
  let view = { ox: 80, oy: 400, s: 50 }, viewInit = false;
  let results = null, mode = 'model', diagScale = 1, flip = false;
  let undoStack = [], redoStack = [];
  let panelOpen = window.innerWidth > 900, detailsOpen = false, spaceDown = false;
  const KEY = 'frame2d_v1';

  const HINTS = {
    select: 'Tap a node or member to edit it. Drag a node to move it. Drag empty space to pan; pinch or mouse wheel to zoom.',
    node: 'Tap the canvas to add a node (snaps to the grid), or type X, Y and press Add. A node placed on a member splits it.',
    member: 'Tap the start point, then the end point (nodes or empty grid points).',
    support: 'Pick a support type, then tap a node.',
    load: 'Pick a load type, set the values, then tap a node or a member.',
    delete: 'Tap a node (its members go too) or a member to delete it.',
  };

  /* ---------------- persistence ---------------- */
  function normalizeDoc(d) {
    const o = C.newDoc();
    if (!d || typeof d !== 'object') return o;
    o.nodes = (d.nodes || []).map(n => ({ x: +n.x, y: +n.y }));
    o.members = (d.members || []).map(m => ({ i: m.i, j: m.j, E: m.E, A: m.A, I: m.I, truss: !!m.truss, hingeStart: !!m.hingeStart, hingeEnd: !!m.hingeEnd, loads: m.loads || [] }))
      .filter(m => o.nodes[m.i] && o.nodes[m.j]);
    o.supports = d.supports || {};
    o.nodeLoads = (d.nodeLoads || []).filter(l => o.nodes[l.node]);
    return o;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ doc, S, view })); } catch (e) { /* ignore */ } }
  function restore() {
    try {
      const t = localStorage.getItem(KEY); if (!t) return;
      const o = JSON.parse(t);
      doc = normalizeDoc(o.doc); Object.assign(S, o.S || {});
      if (o.view && isFinite(o.view.s)) { view = o.view; viewInit = true; }
    } catch (e) { /* ignore */ }
  }

  /* ---------------- messages ---------------- */
  function msg(t, err) { const m = $('msg'); m.textContent = t || ''; m.className = err ? 'err' : ''; }

  /* ---------------- editing / undo ---------------- */
  const snapDoc = () => JSON.stringify(doc);
  function edit(fn) {
    const before = snapDoc();
    const r = fn();
    if (r === false) { doc = JSON.parse(before); return false; }
    undoStack.push(before); if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    afterChange();
    return true;
  }
  function afterChange() {
    results = null; mode = 'model';
    if (sel && ((sel.t === 'node' && !doc.nodes[sel.id]) || (sel.t === 'member' && !doc.members[sel.id]))) sel = null;
    save(); refreshButtons(); refreshPanel(); draw();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapDoc()); doc = JSON.parse(undoStack.pop()); pending = null; afterChange(); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapDoc()); doc = JSON.parse(redoStack.pop()); pending = null; afterChange(); }

  /* ---------------- canvas / view ---------------- */
  const cv = $('cv'), cx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, raf = 0;
  const toScr = (x, y) => [view.ox + x * view.s, view.oy - y * view.s];
  const toWld = (sx, sy) => [(sx - view.ox) / view.s, (view.oy - sy) / view.s];
  const nodeScr = i => toScr(doc.nodes[i].x, doc.nodes[i].y);

  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    const w = Math.max(0, r.width), h = Math.max(0, r.height), d = window.devicePixelRatio || 1;
    if (w === W && h === H && d === dpr) return;
    W = w; H = h; dpr = d;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    if (!viewInit && W > 0) { view = { ox: 80, oy: H - 80, s: 50 }; viewInit = true; }
    draw();
  }
  function zoomAt(sx, sy, f) {
    const ns = clamp(view.s * f, 0.5, 5000);
    view.ox = sx - (sx - view.ox) * ns / view.s;
    view.oy = sy - (sy - view.oy) * ns / view.s;
    view.s = ns; draw();
  }
  function fitView() {
    if (!doc.nodes.length) { view = { ox: 80, oy: H - 80, s: 50 }; draw(); return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    doc.nodes.forEach(n => { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); });
    const pad = results ? 130 : 80, w = x1 - x0, h = y1 - y0;
    let s = Math.min(w > 1e-9 ? (W - 2 * pad) / w : Infinity, h > 1e-9 ? (H - 2 * pad) / h : Infinity);
    if (!isFinite(s)) s = 50;
    s = clamp(s, 2, 300);
    view.s = s; view.ox = W / 2 - (x0 + x1) / 2 * s; view.oy = H / 2 + (y0 + y1) / 2 * s;
    save(); draw();
  }

  /* ---------------- hit testing / snapping ---------------- */
  const tolFor = type => type === 'mouse' ? 10 : 22;
  function hitNode(sx, sy, tol, skip) {
    let best = -1, bd = tol;
    doc.nodes.forEach((n, i) => {
      if (i === skip) return;
      const [px, py] = toScr(n.x, n.y), d = Math.hypot(px - sx, py - sy);
      if (d <= bd) { bd = d; best = i; }
    });
    return best;
  }
  function distSeg(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = clamp(t, 0, 1);
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }
  function hitMember(sx, sy, tol) {
    let best = -1, bd = tol;
    doc.members.forEach((m, k) => {
      const d = distSeg(sx, sy, nodeScr(m.i), nodeScr(m.j));
      if (d <= bd) { bd = d; best = k; }
    });
    return best;
  }
  function snapAt(sx, sy, tol, skip) {
    const n = tol > 0 ? hitNode(sx, sy, tol, skip) : -1;
    if (n >= 0) return { x: doc.nodes[n].x, y: doc.nodes[n].y, node: n };
    let [x, y] = toWld(sx, sy);
    if (S.snap && S.grid > 0) { x = Math.round(x / S.grid) * S.grid; y = Math.round(y / S.grid) * S.grid; x = +x.toFixed(9); y = +y.toFixed(9); }
    else { const dec = Math.max(0, Math.ceil(Math.log10(view.s)) + 1); x = +x.toFixed(dec); y = +y.toFixed(dec); }
    return { x, y, node: null };
  }

  /* ---------------- drawing helpers ---------------- */
  function draw() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  function line(a, b) { cx.beginPath(); cx.moveTo(a[0], a[1]); cx.lineTo(b[0], b[1]); cx.stroke(); }
  function label(t, x, y, col, align) {
    cx.font = '12px system-ui, sans-serif'; cx.textAlign = align || 'center'; cx.textBaseline = 'middle';
    cx.lineWidth = 3; cx.strokeStyle = 'rgba(255,255,255,.9)'; cx.strokeText(t, x, y);
    cx.fillStyle = col || '#333'; cx.fillText(t, x, y);
  }
  function head(tx, ty, dx, dy) {
    const s = 9, w = 4.5;
    cx.beginPath(); cx.moveTo(tx, ty); cx.lineTo(tx - dx * s - dy * w, ty - dy * s + dx * w); cx.lineTo(tx - dx * s + dy * w, ty - dy * s - dx * w); cx.closePath(); cx.fill();
  }
  function arrow(tx, ty, dx, dy, len, col) {
    cx.strokeStyle = col; cx.fillStyle = col; cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(tx - dx * len, ty - dy * len); cx.lineTo(tx, ty); cx.stroke(); head(tx, ty, dx, dy);
  }
  const scrDir = (fx, fy) => { const m = Math.hypot(fx, fy); return m < 1e-12 ? null : [fx / m, -fy / m]; };
  function memberWorldVec(k, ld, fx, fy) {
    if (ld.system !== 'local') return [fx, fy];
    const g = C.mGeom(doc, doc.members[k]);
    return [fx * g.c - fy * g.s, fx * g.s + fy * g.c];
  }
  function memberPoint(k, a) {
    const m = doc.members[k], n = doc.nodes[m.i], g = C.mGeom(doc, m);
    return toScr(n.x + g.c * a, n.y + g.s * a);
  }

  /* ---------------- rendering ---------------- */
  function render() {
    if (!W || !H) return;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H); cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
    drawGrid();
    let note = '';
    if (results && mode === 'defl') note = drawDeflected();
    else if (results && (mode === 'N' || mode === 'V' || mode === 'M')) note = drawDiagram(mode);
    drawMembers();
    if (mode === 'model' || !results) drawLoads();
    drawSupports();
    drawNodes();
    if (results && S.react) drawReactions();
    drawCursor();
    if (note) { cx.font = '13px system-ui, sans-serif'; cx.textAlign = 'left'; cx.textBaseline = 'top'; cx.fillStyle = '#1f3a5f'; cx.fillText(note, 10, 8); }
  }

  function drawGrid() {
    const base = S.grid > 0 ? S.grid : 1, nice = [1, 2, 5];
    let i = 0, m = 1;
    while (base * m * view.s < 14) { i++; m = nice[i % 3] * Math.pow(10, Math.floor(i / 3)); }
    const ws = base * m;
    let labelWs = ws;
    while (labelWs * view.s < 48) labelWs *= 2;
    const [x0, y0] = toWld(0, H), [x1, y1] = toWld(W, 0);
    cx.lineWidth = 1; cx.strokeStyle = '#e8ebf0'; cx.beginPath();
    for (let gx = Math.ceil(x0 / ws) * ws; gx <= x1; gx += ws) { const sx = Math.round(toScr(gx, 0)[0]) + .5; cx.moveTo(sx, 0); cx.lineTo(sx, H); }
    for (let gy = Math.ceil(y0 / ws) * ws; gy <= y1; gy += ws) { const sy = Math.round(toScr(0, gy)[1]) + .5; cx.moveTo(0, sy); cx.lineTo(W, sy); }
    cx.stroke();
    cx.strokeStyle = '#b8c2d1'; cx.beginPath();
    const ax = toScr(0, 0);
    if (ax[0] >= 0 && ax[0] <= W) { cx.moveTo(Math.round(ax[0]) + .5, 0); cx.lineTo(Math.round(ax[0]) + .5, H); }
    if (ax[1] >= 0 && ax[1] <= H) { cx.moveTo(0, Math.round(ax[1]) + .5); cx.lineTo(W, Math.round(ax[1]) + .5); }
    cx.stroke();
    for (let gx = Math.ceil(x0 / labelWs) * labelWs; gx <= x1; gx += labelWs) {
      const sx = toScr(gx, 0)[0];
      if (sx >= 0 && sx <= W) label(fmt(gx), sx, H - 10, '#64748b');
    }
    for (let gy = Math.ceil(y0 / labelWs) * labelWs; gy <= y1; gy += labelWs) {
      const sy = toScr(0, gy)[1];
      if (sy >= 0 && sy <= H) label(fmt(gy), 24, sy, '#64748b', 'right');
    }
  }

  function drawMembers() {
    const light = mode !== 'model' && results;
    cx.lineCap = 'round';
    doc.members.forEach((m, k) => {
      const a = nodeScr(m.i), b = nodeScr(m.j), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      if (sel && sel.t === 'member' && sel.id === k) { cx.strokeStyle = 'rgba(239,68,68,.35)'; cx.lineWidth = 10; line(a, b); }
      cx.strokeStyle = light ? '#94a3b8' : (m.truss ? '#9a3412' : '#1f3a5f'); cx.lineWidth = m.truss ? 2.5 : 3.5; line(a, b);
      if (L > 30) {
        cx.lineWidth = 1.5; cx.strokeStyle = '#1f3a5f'; cx.fillStyle = '#fff';
        if (m.truss || m.hingeStart) { cx.beginPath(); cx.arc(a[0] + u[0] * 9, a[1] + u[1] * 9, 4.5, 0, 7); cx.fill(); cx.stroke(); }
        if (m.truss || m.hingeEnd) { cx.beginPath(); cx.arc(b[0] - u[0] * 9, b[1] - u[1] * 9, 4.5, 0, 7); cx.fill(); cx.stroke(); }
      }
      if (S.labels) label('M' + (k + 1), (a[0] + b[0]) / 2 - u[1] * 12, (a[1] + b[1]) / 2 + u[0] * 12, '#64748b');
    });
  }

  function drawNodes() {
    doc.nodes.forEach((n, i) => {
      const [px, py] = toScr(n.x, n.y);
      const isSel = sel && sel.t === 'node' && sel.id === i;
      if (isSel) { cx.fillStyle = 'rgba(239,68,68,.3)'; cx.beginPath(); cx.arc(px, py, 11, 0, 7); cx.fill(); }
      cx.fillStyle = '#111827'; cx.beginPath(); cx.arc(px, py, 3.8, 0, 7); cx.fill();
      if (S.labels) label('N' + (i + 1), px + 12, py - 11, '#0f172a', 'left');
    });
  }

  function supportOrientation(n, kind) {
    const p = nodeScr(n); let ax = 0, ay = 0;
    doc.members.forEach(m => {
      const o = m.i === n ? nodeScr(m.j) : (m.j === n ? nodeScr(m.i) : null);
      if (o) { const d = Math.hypot(o[0] - p[0], o[1] - p[1]) || 1; ax += (o[0] - p[0]) / d; ay += (o[1] - p[1]) / d; }
    });
    if (kind === 'rollerV') return [ax > 0.01 ? -1 : (ax < -0.01 ? 1 : -1), 0];
    if (kind === 'pin' || kind === 'roller') return [0, ay > 0.3 ? -1 : 1];
    if (Math.hypot(ax, ay) < 0.2) return [0, 1];
    const ox = -ax, oy = -ay;
    return Math.abs(ox) > Math.abs(oy) ? [Math.sign(ox), 0] : [0, Math.sign(oy)];
  }
  function inclOrientation(n, angDeg) {   // screen direction from the node toward the ground for an inclined roller
    const r = angDeg * Math.PI / 180;
    let nx = -Math.sin(r), ny = Math.cos(r), ax = 0, ay = 0;
    doc.members.forEach(m => {
      const o = m.i === n ? m.j : (m.j === n ? m.i : -1);
      if (o >= 0) { const dx = doc.nodes[o].x - doc.nodes[n].x, dy = doc.nodes[o].y - doc.nodes[n].y, d = Math.hypot(dx, dy) || 1; ax += dx / d; ay += dy / d; }
    });
    if (nx * ax + ny * ay > 0) { nx = -nx; ny = -ny; }   // ground is on the side away from the members
    return [nx, -ny];
  }
  function drawSupports() {
    for (const [key, s] of Object.entries(doc.supports)) {
      const n = +key; if (!doc.nodes[n]) continue;
      let kind = C.supportKind(s);
      if (kind === 'none') continue;
      if (kind === 'custom') kind = (s.rx && s.ry && s.rr) ? 'fixed' : (s.rx && s.ry) ? 'pin' : s.ry ? 'roller' : s.rx ? 'rollerV' : 'spring';
      const [px, py] = nodeScr(n);
      let o = supportOrientation(n, kind);
      if (kind === 'inclined') { o = inclOrientation(n, s.ang); kind = 'roller'; }
      if (kind === 'spring' && !s.ky && s.kx) o = [-1, 0];
      cx.save(); cx.translate(px, py); cx.rotate(Math.atan2(-o[0], o[1]));
      cx.strokeStyle = '#111827'; cx.fillStyle = '#fff'; cx.lineWidth = 2; cx.lineCap = 'butt';
      const ground = (y, hw) => { cx.beginPath(); cx.moveTo(-hw, y); cx.lineTo(hw, y); for (let x = -hw; x <= hw - 4; x += 6) { cx.moveTo(x + 6, y); cx.lineTo(x, y + 6); } cx.stroke(); };
      const tri = (h, hw) => { cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(-hw, h); cx.lineTo(hw, h); cx.closePath(); cx.fill(); cx.stroke(); };
      if (kind === 'fixed') { cx.lineWidth = 3.5; cx.beginPath(); cx.moveTo(-14, 0); cx.lineTo(14, 0); cx.stroke(); cx.lineWidth = 1.5; cx.beginPath(); for (let x = -14; x < 14; x += 6) { cx.moveTo(x + 6, 0); cx.lineTo(x, 8); } cx.stroke(); }
      else if (kind === 'pin') { tri(15, 9); ground(15, 15); }
      else if (kind === 'roller' || kind === 'rollerV') { tri(13, 9); cx.beginPath(); cx.arc(-5, 16, 3, 0, 7); cx.fill(); cx.stroke(); cx.beginPath(); cx.arc(5, 16, 3, 0, 7); cx.fill(); cx.stroke(); ground(19, 15); }
      else { cx.beginPath(); cx.moveTo(0, 0); [[0, 5], [-6, 8], [6, 13], [-6, 18], [6, 23], [0, 26], [0, 30]].forEach(p => cx.lineTo(p[0], p[1])); cx.stroke(); ground(30, 12); }
      cx.restore();
    }
  }

  function drawLoads() {
    const col = '#d1242f';
    let wmax = 0;
    doc.members.forEach(m => m.loads.forEach(ld => { if (ld.kind === 'dist') wmax = Math.max(wmax, Math.hypot(ld.fx1, ld.fy1), Math.hypot(ld.fx2, ld.fy2)); }));
    for (const nl of doc.nodeLoads) {
      const [px, py] = nodeScr(nl.node), d = scrDir(nl.fx, nl.fy);
      if (d) { const tx = px - d[0] * 6, ty = py - d[1] * 6; arrow(tx, ty, d[0], d[1], 44, col); label(fmt(nl.F) + ' ' + S.fu, tx - d[0] * 58, ty - d[1] * 58, col); }
      if (nl.mz) {
        const r = 19, A = -0.25 * Math.PI, B = 1.25 * Math.PI;
        cx.strokeStyle = col; cx.fillStyle = col; cx.lineWidth = 2; cx.beginPath(); cx.arc(px, py, r, A, B, false); cx.stroke();
        if (nl.mz < 0) head(px + r * Math.cos(B), py + r * Math.sin(B), -Math.sin(B), Math.cos(B));
        else head(px + r * Math.cos(A), py + r * Math.sin(A), Math.sin(A), -Math.cos(A));
        label(fmt(nl.mz) + ' ' + S.fu + '·' + S.lu, px, py - r - 12, col);
      }
    }
    doc.members.forEach((m, k) => {
      const g = C.mGeom(doc, m);
      for (const ld of m.loads) {
        if (ld.kind === 'point') {
          const [wx, wy] = memberWorldVec(k, ld, ld.fx, ld.fy), d = scrDir(wx, wy); if (!d) continue;
          const p = memberPoint(k, ld.a), tx = p[0] - d[0] * 4, ty = p[1] - d[1] * 4;
          arrow(tx, ty, d[0], d[1], 44, col); label(fmt(ld.F) + ' ' + S.fu, tx - d[0] * 58, ty - d[1] * 58, col);
        } else {
          const a = ld.a ?? 0, b = ld.b ?? g.L, pa = memberPoint(k, a), pb = memberPoint(k, b);
          const lenPx = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), n = Math.max(2, Math.ceil(lenPx / 24) + 1);
          const tails = [];
          for (let i = 0; i < n; i++) {
            const t = i / (n - 1), x = a + (b - a) * t;
            const [wx, wy] = memberWorldVec(k, ld, ld.fx1 + (ld.fx2 - ld.fx1) * t, ld.fy1 + (ld.fy2 - ld.fy1) * t);
            const mag = Math.hypot(wx, wy), d = scrDir(wx, wy); if (!d) { tails.push(null); continue; }
            const len = 12 + 30 * mag / (wmax || 1), p = memberPoint(k, x), tx = p[0] - d[0] * 3, ty = p[1] - d[1] * 3;
            arrow(tx, ty, d[0], d[1], len, col); tails.push([tx - d[0] * len, ty - d[1] * len, d]);
          }
          cx.strokeStyle = col; cx.lineWidth = 1.5; cx.beginPath(); let pen = false;
          tails.forEach(t => { if (!t) { pen = false; return; } if (pen) cx.lineTo(t[0], t[1]); else cx.moveTo(t[0], t[1]); pen = true; }); cx.stroke();
          const f = tails.find(t => t), l = [...tails].reverse().find(t => t);
          if (f) { const txt = (ld.w1 === ld.w2) ? fmt(ld.w1) + ' ' + S.fu + '/' + S.lu : fmt(ld.w1) + '→' + fmt(ld.w2) + ' ' + S.fu + '/' + S.lu; const mx = (f[0] + l[0]) / 2, my = (f[1] + l[1]) / 2; label(txt, mx - f[2][0] * 12, my - f[2][1] * 12, col); }
        }
      }
    });
  }

  function drawReactions() {
    const R = results.res.reactions; let rmax = 0;
    for (const r of Object.values(R)) rmax = Math.max(rmax, Math.abs(r.fx), Math.abs(r.fy), Math.abs(r.mz));
    if (rmax <= 0) return;
    for (const [k, r] of Object.entries(R)) {
      if (!doc.nodes[+k]) continue;
      const [px, py] = nodeScr(+k), parts = [];
      if (Math.abs(r.fx) > 1e-6 * rmax) parts.push('Rx=' + fmt(r.fx));
      if (Math.abs(r.fy) > 1e-6 * rmax) parts.push('Ry=' + fmt(r.fy));
      if (r.rn !== undefined) parts.push('R⊥=' + fmt(r.rn));
      if (Math.abs(r.mz) > 1e-6 * rmax) parts.push('Mz=' + fmt(r.mz));
      parts.forEach((t, i) => label(t, px + 20, py + 22 + i * 13, '#0b6b3a', 'left'));
    }
  }

  function drawDiagram(T) {
    let mx = 0;
    results.diag.forEach(d => d[T].forEach(v => { mx = Math.max(mx, Math.abs(v)); }));
    const names = { N: 'Axial force N (' + S.fu + '), tension +', V: 'Shear force V (' + S.fu + ')', M: 'Bending moment M (' + S.fu + '·' + S.lu + '), drawn on the tension side' };
    if (mx < 1e-12) return names[T] + ' — all zero';
    const colr = { N: [22, 163, 74], V: [147, 51, 234], M: [37, 99, 235] }[T];
    const k0 = 70 * diagScale / mx, sign = (T === 'M' ? -1 : 1) * (flip ? -1 : 1);
    doc.members.forEach((m, k) => {
      const d = results.diag[k], g = C.mGeom(doc, m), P0 = nodeScr(m.i), P1 = nodeScr(m.j);
      const Lpx = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) || 1, u = [(P1[0] - P0[0]) / Lpx, (P1[1] - P0[1]) / Lpx], nv = [-g.s, -g.c];
      const arr = d[T], pt = i => { const al = d.x[i] / g.L * Lpx, off = sign * k0 * arr[i]; return [P0[0] + u[0] * al + nv[0] * off, P0[1] + u[1] * al + nv[1] * off, off]; };
      cx.beginPath(); cx.moveTo(P0[0], P0[1]);
      for (let i = 0; i < arr.length; i++) { const p = pt(i); cx.lineTo(p[0], p[1]); }
      cx.lineTo(P1[0], P1[1]); cx.closePath();
      cx.fillStyle = 'rgba(' + colr.join(',') + ',.22)'; cx.fill();
      cx.strokeStyle = 'rgb(' + colr.join(',') + ')'; cx.lineWidth = 1.5; cx.stroke();
      const cand = new Set([0, arr.length - 1]); let imax = 0, imin = 0;
      arr.forEach((v, i) => { if (v > arr[imax]) imax = i; if (v < arr[imin]) imin = i; }); cand.add(imax); cand.add(imin);
      const shown = [];
      for (const i of [...cand].sort((a, b) => a - b)) {
        if (Math.abs(arr[i]) < 1e-3 * mx) continue;
        if (shown.some(j => Math.abs(d.x[j] - d.x[i]) < 0.04 * g.L)) continue;
        shown.push(i);
        const p = pt(i), side = p[2] >= 0 ? 1 : -1;
        label(fmt(arr[i]), p[0] + nv[0] * side * 11, p[1] + nv[1] * side * 11, 'rgb(' + colr.map(v => Math.round(v * .7)).join(',') + ')');
      }
    });
    return names[T];
  }

  function drawDeflected() {
    let maxD = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    doc.nodes.forEach(n => { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); });
    results.diag.forEach(d => { for (let i = 0; i < d.dX.length; i++) maxD = Math.max(maxD, Math.hypot(d.dX[i], d.dY[i])); });
    const size = Math.max(x1 - x0, y1 - y0, 1e-9), sc = maxD > 0 ? 0.08 * size / maxD * diagScale : 1;
    cx.strokeStyle = '#dc2626'; cx.lineWidth = 2.5; cx.lineJoin = 'round';
    results.diag.forEach(d => {
      cx.beginPath();
      for (let i = 0; i < d.X.length; i++) { const p = toScr(d.X[i] + sc * d.dX[i], d.Y[i] + sc * d.dY[i]); if (i) cx.lineTo(p[0], p[1]); else cx.moveTo(p[0], p[1]); }
      cx.stroke();
    });
    return 'Deflected shape, exaggerated ×' + fmt(sc) + ' (largest true displacement ' + fmt(maxD) + ' ' + S.lu + ')';
  }

  function drawCursor() {
    if (pending) {
      const a = pending.node != null && doc.nodes[pending.node] ? nodeScr(pending.node) : toScr(pending.x, pending.y);
      cx.fillStyle = '#16a34a'; cx.beginPath(); cx.arc(a[0], a[1], 6, 0, 7); cx.fill();
      if (hover) {
        cx.strokeStyle = '#16a34a'; cx.lineWidth = 1.5; cx.setLineDash([6, 4]); const b = toScr(hover.p.x, hover.p.y); line(a, b); cx.setLineDash([]);
        const dx = b[0] - a[0], dy = b[1] - a[1], px = (a[0] + b[0]) / 2, py = (a[1] + b[1]) / 2;
        const lp = Math.hypot(dx, dy) || 1;
        label('L = ' + fmt(Math.hypot(hover.p.x - pending.x, hover.p.y - pending.y)) + ' ' + S.lu, px - dy / lp * 16, py + dx / lp * 16, '#15803d');
      }
    }
    if (hover && (tool === 'node' || tool === 'member' || tool === 'select')) {
      const [px, py] = toScr(hover.p.x, hover.p.y);
      cx.strokeStyle = hover.p.node != null ? '#16a34a' : '#2563eb'; cx.lineWidth = 1.5;
      cx.beginPath(); cx.arc(px, py, hover.p.node != null ? 9 : 5, 0, 7); cx.stroke();
    }
  }

  /* ---------------- pointer input ---------------- */
  const ptrs = new Map(); let g = null;
  const rectOf = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function setCoord(p) { $('coord').textContent = p ? 'x=' + fmt(p.x) + '  y=' + fmt(p.y) + ' ' + S.lu : ''; }
  function updateHover(sx, sy, type) { const p = snapAt(sx, sy, tolFor(type)); hover = { sx, sy, p }; setCoord(p); draw(); }

  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    const [sx, sy] = rectOf(e);
    try { cv.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    ptrs.set(e.pointerId, { x: sx, y: sy });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      g = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: [(a.x + b.x) / 2, (a.y + b.y) / 2], v0: { ...view } };
      return;
    }
    if (ptrs.size > 2) return;
    e.preventDefault();
    if (e.button === 1 || e.button === 2 || spaceDown) { g = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy }; return; }
    g = { kind: 'tool', sx, sy, ox: view.ox, oy: view.oy, moved: false, type: e.pointerType || 'mouse' };
    if (e.pointerType !== 'mouse') updateHover(sx, sy, e.pointerType);
    if (tool === 'select') {
      const n = hitNode(sx, sy, tolFor(g.type));
      if (n >= 0) { g.kind = 'dragnode'; g.node = n; g.before = snapDoc(); g.dragged = false; select({ t: 'node', id: n }); }
    }
  });
  cv.addEventListener('pointermove', e => {
    const [sx, sy] = rectOf(e);
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: sx, y: sy });
    if (g && g.kind === 'pinch') {
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, c = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        const ns = clamp(g.v0.s * d / g.d0, 0.5, 5000), wx = (g.c0[0] - g.v0.ox) / g.v0.s, wy = (g.v0.oy - g.c0[1]) / g.v0.s;
        view.s = ns; view.ox = c[0] - wx * ns; view.oy = c[1] + wy * ns; draw();
      }
      return;
    }
    if (!g) { if (e.pointerType === 'mouse') updateHover(sx, sy, 'mouse'); return; }
    const dist = Math.hypot(sx - g.sx, sy - g.sy), thr = g.type === 'mouse' ? 5 : 9;
    if (g.kind === 'pan') { view.ox = g.ox + sx - g.sx; view.oy = g.oy + sy - g.sy; draw(); }
    else if (g.kind === 'tool') {
      if (!g.moved && dist > thr) g.moved = true;
      if (g.moved) { view.ox = g.ox + sx - g.sx; view.oy = g.oy + sy - g.sy; draw(); }
      else if (e.pointerType === 'mouse' || tool === 'member') updateHover(sx, sy, e.pointerType || 'mouse');
    } else if (g.kind === 'dragnode') {
      if (!g.dragged && dist > thr) g.dragged = true;
      if (g.dragged) { const p = snapAt(sx, sy, 0); doc.nodes[g.node].x = p.x; doc.nodes[g.node].y = p.y; results = null; mode = 'model'; setCoord(p); draw(); }
    }
  });
  function endPointer(e, cancel) {
    ptrs.delete(e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch') { if (ptrs.size === 0) g = null; return; }
    if (g.kind === 'tool' && !g.moved && !cancel) handleClick(g.sx, g.sy, g.type);
    if (g.kind === 'dragnode' && g.dragged) {
      if (cancel) { doc = JSON.parse(g.before); afterChange(); }
      else { undoStack.push(g.before); redoStack = []; afterChange(); }
    }
    if (g.kind === 'tool' || g.kind === 'pan') save();
    g = null;
  }
  cv.addEventListener('pointerup', e => endPointer(e, false));
  cv.addEventListener('pointercancel', e => endPointer(e, true));
  cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !g) { hover = null; setCoord(null); draw(); } });
  cv.addEventListener('wheel', e => { e.preventDefault(); const [sx, sy] = rectOf(e); zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

  /* ---------------- tool actions ---------------- */
  function select(s) {
    sel = s; if (s) panelOpen = true;
    if (s && window.innerWidth <= 900 && H) { // keep the selected item above the bottom sheet
      const y = s.t === 'node' ? nodeScr(s.id)[1] : (nodeScr(doc.members[s.id].i)[1] + nodeScr(doc.members[s.id].j)[1]) / 2;
      if (y > H * 0.5 - 20) view.oy -= y - (H * 0.5 - 60);
    }
    refreshPanel(); draw();
  }

  function handleClick(sx, sy, type) {
    const tol = tolFor(type);
    if (tool === 'select') {
      const n = hitNode(sx, sy, tol);
      if (n >= 0) return select({ t: 'node', id: n });
      const k = hitMember(sx, sy, tol);
      if (k >= 0) return select({ t: 'member', id: k });
      sel = null; refreshPanel(); draw(); return;
    }
    if (tool === 'node') {
      const p = snapAt(sx, sy, tol);
      if (p.node != null) { msg('There is already a node there.', true); return; }
      edit(() => { C.addNodeAt(doc, p.x, p.y); }); msg('Node added.'); return;
    }
    if (tool === 'member') {
      const p = snapAt(sx, sy, tol);
      if (!pending) { pending = { x: p.x, y: p.y, node: p.node }; msg('Now tap the end point.'); draw(); return; }
      let err = null, endNode = null;
      const ok = edit(() => {
        const a = pending.node != null ? pending.node : C.addNodeAt(doc, pending.x, pending.y);
        const b = p.node != null ? p.node : C.addNodeAt(doc, p.x, p.y);
        const r = C.addMember(doc, a, b, { E: S.E, A: S.A, I: S.I, truss: opt.memberType === 'truss' });
        if (r.error) { err = r.error; return false; }
        endNode = b;
      });
      if (err) { msg(err, true); return; }
      if (ok) {
        if (opt.chain) { pending = { x: doc.nodes[endNode].x, y: doc.nodes[endNode].y, node: endNode }; msg('Member added. Tap the next point, or tap the Member tool again to stop.'); }
        else { pending = null; msg('Member added.'); }
      }
      draw(); return;
    }
    if (tool === 'support') {
      const n = hitNode(sx, sy, tol);
      if (n < 0) { msg('Tap a node to place a support. Add the node first with the Node tool.', true); return; }
      edit(() => { if (opt.support === 'none') delete doc.supports[n]; else if (opt.support === 'incl') doc.supports[n] = { ang: inclAng() }; else doc.supports[n] = { ...C.SUPPORT_PRESETS[opt.support] }; });
      msg(opt.support === 'none' ? 'Support removed.' : 'Support set at N' + (n + 1) + '.'); return;
    }
    if (tool === 'delete') {
      const n = hitNode(sx, sy, tol);
      if (n >= 0) { pending = null; if (sel) sel = null; edit(() => { C.deleteNode(doc, n); }); msg('Node deleted.'); return; }
      const k = hitMember(sx, sy, tol);
      if (k >= 0) { if (sel) sel = null; edit(() => { C.deleteMember(doc, k); }); msg('Member deleted.'); return; }
      return;
    }
    if (tool === 'load') loadClick(sx, sy, tol);
  }

  function loadClick(sx, sy, tol) {
    const lt = opt.loadType;
    if (lt === 'moment') {
      const n = hitNode(sx, sy, tol);
      if (n < 0) { msg('Tap a node to apply a moment.', true); return; }
      edit(() => { doc.nodeLoads.push(C.mkNodeLoad(n, 0, 0, opt.M)); }); msg('Moment added at N' + (n + 1) + '.'); return;
    }
    if (lt === 'point') {
      const n = hitNode(sx, sy, tol);
      if (n >= 0) { edit(() => { doc.nodeLoads.push(C.mkNodeLoad(n, opt.F, opt.ang, 0)); }); msg('Load added at N' + (n + 1) + '.'); return; }
      const k = hitMember(sx, sy, tol);
      if (k < 0) { msg('Tap a node or a member.', true); return; }
      const [wx, wy] = toWld(sx, sy), pr = C.projectOnMember(doc, k, wx, wy);
      let a = pr.t;
      if (S.snap) { const q = snapAt(sx, sy, 0), p2 = C.projectOnMember(doc, k, q.x, q.y); if (p2.dist < 1e-6 * (1 + p2.L)) a = p2.t; }
      a = +clamp(a, 0, pr.L).toFixed(3);
      edit(() => { doc.members[k].loads.push(C.mkPoint(a, opt.F, opt.ang, opt.system)); });
      msg('Point load added on M' + (k + 1) + ' at ' + fmt(a) + ' ' + S.lu + ' from its start.'); return;
    }
    // distributed
    const k = hitMember(sx, sy, tol);
    if (k < 0) { msg('Tap a member for a distributed load.', true); return; }
    const L = C.mGeom(doc, doc.members[k]).L;
    const a = opt.from === '' ? 0 : +opt.from, b = opt.to === '' ? null : +opt.to;
    if (!(a >= 0) || a >= L || (b !== null && (!(b > a) || b > L + 1e-9))) { msg('From/To must lie within the member (length ' + fmt(L) + ' ' + S.lu + ') with From < To.', true); return; }
    edit(() => { doc.members[k].loads.push(C.mkDist(a, b, opt.w1, opt.w2, opt.ang, opt.system)); });
    msg('Distributed load added on M' + (k + 1) + '.');
  }

  function deleteSelected() {
    if (!sel) return;
    const s = sel; sel = null; pending = null;
    if (s.t === 'node') edit(() => { C.deleteNode(doc, s.id); }); else edit(() => { C.deleteMember(doc, s.id); });
  }

  /* ---------------- UI helpers ---------------- */
  function fnum(label, get, set) {
    const i = el('input', { type: 'number', step: 'any', class: 'num' }); i.value = numStr(get());
    i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) set(v); i.value = numStr(get()); });
    return el('label', { class: 'fld' }, label, i);
  }
  function fopt(label, get, set) {
    const i = el('input', { type: 'number', step: 'any', class: 'num', placeholder: 'full' }); i.value = get() === '' ? '' : numStr(get());
    i.addEventListener('change', () => { const t = i.value.trim(), v = parseFloat(t); set(t === '' || !isFinite(v) ? '' : v); i.value = get() === '' ? '' : numStr(get()); });
    return el('label', { class: 'fld' }, label, i);
  }
  const seg = (items, cur, pick) => el('div', { class: 'seg' }, items.map(([v, l]) => el('button', { class: v === cur ? 'active' : '', onclick: () => pick(v) }, l)));
  const chk = (label, get, set) => { const i = el('input', { type: 'checkbox' }); i.checked = !!get(); i.addEventListener('change', () => set(i.checked)); return el('label', { class: 'fld' }, i, label); };

  function refreshOptions() {
    const o = $('opts'); o.replaceChildren();
    if (tool === 'select' || tool === 'delete') { o.append(el('small', { class: 'muted' }, HINTS[tool])); return; }
    if (tool === 'node') {
      o.append(fnum('X', () => opt.nx, v => { opt.nx = v; }), fnum('Y', () => opt.ny, v => { opt.ny = v; }),
        el('button', { onclick: () => { let added = false; edit(() => { const n = doc.nodes.length; C.addNodeAt(doc, opt.nx, opt.ny); if (doc.nodes.length === n) return false; added = true; }); msg(added ? 'Node added.' : 'There is already a node there.', !added); } }, 'Add'),
        el('small', { class: 'muted' }, HINTS.node));
    } else if (tool === 'member') {
      o.append(seg([['frame', 'Frame'], ['truss', 'Truss']], opt.memberType, v => { opt.memberType = v; refreshOptions(); }),
        chk('Chain', () => opt.chain, v => { opt.chain = v; }),
        el('small', { class: 'muted' }, 'Frame = rigid joints (carries bending). Truss = pinned ends (axial force only). Chain = each member starts where the last one ended.'));
    } else if (tool === 'support') {
      o.append(seg([['pin', 'Pin'], ['roller', 'Roller'], ['rollerV', 'Roller ↕'], ['incl', 'Roller ∠'], ['fixed', 'Fixed'], ['none', 'None']], opt.support, v => { opt.support = v; refreshOptions(); }),
        ...(opt.support === 'incl' ? [
          seg([['angle', 'Angle'], ['slope', 'Rise / Run']], opt.inclInput, v => {
            const a = inclAng(), r = a * Math.PI / 180;
            opt.inclInput = v;
            if (v === 'angle') opt.inclAngle = a;
            else { opt.rise = Math.sin(r); opt.run = Math.cos(r); }
            refreshOptions();
          }),
          ...(opt.inclInput === 'angle'
            ? [fnum('Angle (deg)', () => opt.inclAngle, v => { opt.inclAngle = v; refreshOptions(); })]
            : [fnum('Rise', () => opt.rise, v => { opt.rise = v; refreshOptions(); }), fnum('Run', () => opt.run, v => { opt.run = v; refreshOptions(); })]),
          el('span', { class: 'fld' }, '= ' + fmt(inclAng()) + '°')
        ] : []),
        el('small', { class: 'muted' }, 'Roller slides horizontally (restrains Y). Roller ↕ slides vertically (restrains X). Roller ∠ = roller on a sloping surface. Enter its surface angle, or use Rise and Run (a 1:2 slope = Rise 1, Run 2). Springs / settlement: select the node and open "Custom".'));
    } else if (tool === 'load') {
      o.append(seg([['point', 'Point'], ['dist', 'Distributed'], ['moment', 'Moment']], opt.loadType, v => { opt.loadType = v; refreshOptions(); }));
      if (opt.loadType === 'point') o.append(fnum('F (' + S.fu + ')', () => opt.F, v => { opt.F = v; }), fnum('Angle °', () => opt.ang, v => { opt.ang = v; }), sysSeg());
      if (opt.loadType === 'dist') o.append(fnum('w1', () => opt.w1, v => { opt.w1 = v; }), fnum('w2', () => opt.w2, v => { opt.w2 = v; }), fnum('Angle °', () => opt.ang, v => { opt.ang = v; }),
        fopt('From', () => opt.from, v => { opt.from = v; }), fopt('To', () => opt.to, v => { opt.to = v; }), sysSeg());
      if (opt.loadType === 'moment') o.append(fnum('M (' + S.fu + '·' + S.lu + ')', () => opt.M, v => { opt.M = v; }));
      o.append(el('small', { class: 'muted' }, opt.loadType === 'moment' ? 'Counter-clockwise is positive.' :
        'Angle = direction the arrow comes FROM: 90° pushes down, 180° pushes right, 270° pushes up, 0° pushes left. Distributed w is per unit member length (w1 at From, w2 at To; blank = whole member). Local angles are measured from the member axis.'));
    }
  }
  function sysSeg() { return seg([['global', 'Global'], ['local', 'Local']], opt.system, v => { opt.system = v; refreshOptions(); }); }

  function setTool(t) { tool = t; pending = null; refreshOptions(); refreshButtons(); msg(HINTS[t]); draw(); }

  function refreshButtons() {
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    document.querySelectorAll('[data-mode]').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); b.disabled = b.dataset.mode !== 'model' && !results; });
    $('bUndo').disabled = !undoStack.length; $('bRedo').disabled = !redoStack.length;
    $('dscale').disabled = !results || mode === 'model'; $('flip').disabled = !results || mode === 'model' || mode === 'defl';
  }

  /* ---------------- panel ---------------- */
  const pnum = (label, val, set, blank) => {
    const i = el('input', { type: 'number', step: 'any', class: 'num', placeholder: blank ? 'full' : null }); i.value = val === '' || val == null ? '' : numStr(val);
    i.addEventListener('change', () => { const t = i.value.trim(); if (t === '' && blank) { edit(() => set(null)); return; } const v = parseFloat(t); if (isFinite(v)) edit(() => set(v)); else refreshPanel(); });
    return el('label', { class: 'fld' }, label, i);
  };
  const row = (...k) => el('div', { class: 'row' }, ...k);
  const pchk = (label, val, set, dis) => { const i = el('input', { type: 'checkbox', disabled: !!dis }); i.checked = !!val; i.addEventListener('change', () => edit(() => set(i.checked))); return el('label', { class: 'fld' }, i, label); };
  function table(head, rows) { return el('table', { class: 'res' }, head ? el('tr', {}, head.map(h => el('th', {}, h))) : null, rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))); }
  function psec(P) { const s = el('div', { class: 'sec' }); P.append(s); return s; }
  const phead = t => el('div', { class: 'phead' }, el('b', {}, t), el('button', { onclick: () => { sel = null; panelOpen = false; refreshPanel(); draw(); } }, '✕'));

  function refreshPanel() {
    const P = $('panel'); P.classList.toggle('hidden', !panelOpen); P.replaceChildren();
    resize();
    if (!panelOpen) return;
    if (sel && sel.t === 'node' && doc.nodes[sel.id]) nodePanel(P, sel.id);
    else if (sel && sel.t === 'member' && doc.members[sel.id]) memberPanel(P, sel.id);
    else summaryPanel(P);
  }

  function nodePanel(P, n) {
    const nd = doc.nodes[n], lu = S.lu;
    P.append(phead('Node N' + (n + 1)));
    let s = psec(P);
    s.append(row(pnum('X (' + lu + ')', nd.x, v => { nd.x = v; }), pnum('Y (' + lu + ')', nd.y, v => { nd.y = v; })));
    s = psec(P);
    const sup = doc.supports[n], kind = C.supportKind(sup);
    const sl = el('select', {}, [['none', 'No support'], ['pin', 'Pin'], ['roller', 'Roller (slides in X)'], ['rollerV', 'Roller (slides in Y)'], ['incl', 'Inclined roller'], ['fixed', 'Fixed'], ['custom', 'Custom…']].map(([v, l]) => el('option', { value: v }, l)));
    sl.value = kind === 'inclined' ? 'incl' : kind;
    sl.addEventListener('change', () => { const v = sl.value; if (v === 'incl') { edit(() => { doc.supports[n] = { ang: sup && typeof sup.ang === 'number' ? sup.ang : inclAng() }; }); return; } if (v === 'custom') { detailsOpen = true; refreshPanel(); return; } edit(() => { if (v === 'none') delete doc.supports[n]; else doc.supports[n] = { ...C.SUPPORT_PRESETS[v] }; }); });
    s.append(row(el('b', {}, 'Support'), sl));
    if (kind === 'inclined') s.append(row(pnum('Surface angle °', sup.ang, v => { doc.supports[n].ang = v; })), el('small', { class: 'muted' }, 'Angle of the sloping surface from horizontal (rising to the right = positive; 1:2 slope = 26.565°). The roller can only slide along the surface and pushes perpendicular to it.'));
    const d = el('details', {}, el('summary', {}, 'Custom restraints, springs, settlement')); d.open = detailsOpen || kind === 'custom';
    d.addEventListener('toggle', () => { detailsOpen = d.open; });
    const su = () => doc.supports[n] || (doc.supports[n] = {});
    d.append(row(pchk('Restrain X', sup && sup.rx, v => { su().rx = v; }), pchk('Restrain Y', sup && sup.ry, v => { su().ry = v; }), pchk('Restrain rotation', sup && sup.rr, v => { su().rr = v; })),
      row(pnum('kx', sup && sup.kx || 0, v => { su().kx = v; }), pnum('ky', sup && sup.ky || 0, v => { su().ky = v; }), pnum('kr', sup && sup.kr || 0, v => { su().kr = v; })),
      row(pnum('dx', sup && sup.dx || 0, v => { su().dx = v; }), pnum('dy', sup && sup.dy || 0, v => { su().dy = v; }), pnum('dr', sup && sup.dr || 0, v => { su().dr = v; })),
      el('small', { class: 'muted' }, 'k = spring stiffness (' + S.fu + '/' + lu + ', moment/rad) on a free direction. d = settlement of a restrained direction (' + lu + ', rad).'));
    s.append(d);
    s = psec(P);
    s.append(pchk('Hinge (releases rotation of all members here)', C.nodeHinged(doc, n), v => { C.setNodeHinge(doc, n, v); }));
    s = psec(P);
    s.append(el('b', {}, 'Loads at this node'));
    doc.nodeLoads.forEach((nl, li) => {
      if (nl.node !== n) return;
      s.append(el('div', { class: 'loadrow' }, row(
        pnum('F', nl.F, v => { nl.F = v; C.recalcNodeLoad(nl); }), pnum('Angle °', nl.ang, v => { nl.ang = v; C.recalcNodeLoad(nl); }), pnum('M', nl.mz, v => { nl.mz = v; }),
        el('button', { class: 'danger', onclick: () => edit(() => { doc.nodeLoads.splice(li, 1); }) }, '✕'))));
    });
    s.append(el('button', { onclick: () => edit(() => { doc.nodeLoads.push(C.mkNodeLoad(n, 10, 90, 0)); }) }, '+ Add load'));
    if (results) {
      s = psec(P); const u = results.res.u[n], r = results.res.reactions[n];
      s.append(el('b', {}, 'Results'), table(null, [['ux (' + lu + ')', fmt(u.ux)], ['uy (' + lu + ')', fmt(u.uy)], ['rotation (rad)', fmt(u.rz)]]));
      if (r) s.append(table(null, [['Rx (' + S.fu + ')', fmt(r.fx)], ['Ry (' + S.fu + ')', fmt(r.fy)], ['Mz (' + S.fu + '·' + lu + ')', fmt(r.mz)], ...(r.rn !== undefined ? [['R⊥ to surface (' + S.fu + ')', fmt(r.rn)]] : [])]));
    }
    s = psec(P); s.append(el('button', { class: 'danger', onclick: deleteSelected }, 'Delete node'));
  }

  function memberPanel(P, k) {
    const m = doc.members[k], g = C.mGeom(doc, m), lu = S.lu;
    P.append(phead('Member M' + (k + 1) + '  (N' + (m.i + 1) + ' → N' + (m.j + 1) + ')'));
    let s = psec(P);
    s.append(el('div', {}, 'Length ' + fmt(g.L) + ' ' + lu));
    const ts = el('select', {}, el('option', { value: 'frame' }, 'Frame (rigid joints)'), el('option', { value: 'truss' }, 'Truss (pinned ends)')); ts.value = m.truss ? 'truss' : 'frame';
    ts.addEventListener('change', () => edit(() => { m.truss = ts.value === 'truss'; }));
    s.append(row(el('b', {}, 'Type'), ts));
    s.append(row(pnum('E', m.E, v => { m.E = v; }), pnum('A', m.A, v => { m.A = v; }), pnum('I', m.I, v => { m.I = v; })));
    s.append(row(pchk('Hinge at start', m.hingeStart, v => { m.hingeStart = v; }, m.truss), pchk('Hinge at end', m.hingeEnd, v => { m.hingeEnd = v; }, m.truss)));
    s.append(el('button', { onclick: () => edit(() => { doc.members.forEach(o => { o.E = m.E; o.A = m.A; o.I = m.I; }); }) }, 'Copy E, A, I to all members'));
    s = psec(P); s.append(el('b', {}, 'Loads on this member'));
    m.loads.forEach((ld, li) => {
      const common = [pnum('Angle °', ld.ang, v => { ld.ang = v; C.recalcLoad(ld); })];
      const sy = el('select', {}, el('option', { value: 'global' }, 'Global'), el('option', { value: 'local' }, 'Local')); sy.value = ld.system || 'global';
      sy.addEventListener('change', () => edit(() => { ld.system = sy.value; }));
      const del = el('button', { class: 'danger', onclick: () => edit(() => { m.loads.splice(li, 1); }) }, '✕');
      if (ld.kind === 'point') s.append(el('div', { class: 'loadrow' }, el('div', {}, 'Point load'), row(pnum('F', ld.F, v => { ld.F = v; C.recalcLoad(ld); }), ...common, pnum('a (' + lu + ')', ld.a, v => { ld.a = v; })), row(sy, del)));
      else s.append(el('div', { class: 'loadrow' }, el('div', {}, 'Distributed load'), row(pnum('w1', ld.w1, v => { ld.w1 = v; C.recalcLoad(ld); }), pnum('w2', ld.w2, v => { ld.w2 = v; C.recalcLoad(ld); }), ...common),
        row(pnum('From', ld.a ?? 0, v => { ld.a = v; }), pnum('To', ld.b, v => { ld.b = v; }, true)), row(sy, del)));
    });
    s.append(row(el('button', { onclick: () => edit(() => { m.loads.push(C.mkPoint(+(g.L / 2).toFixed(3), 10, 90, 'global')); }) }, '+ Point'),
      el('button', { onclick: () => edit(() => { m.loads.push(C.mkDist(0, null, 10, 10, 90, 'global')); }) }, '+ Distributed')));
    if (results) {
      s = psec(P); const r = results.res.members[k], st = results.diag[k].stats;
      s.append(el('b', {}, 'Results'),
        table(['', 'start', 'end'], [['N (' + S.fu + ')', fmt(r.N1), fmt(r.N2)], ['V (' + S.fu + ')', fmt(r.V1), fmt(r.V2)], ['M (' + S.fu + '·' + lu + ')', fmt(r.M1), fmt(r.M2)]]),
        table(['Extremes', 'max', 'at', 'min', 'at'], [['N', fmt(st.N.max), fmt(st.N.xMax), fmt(st.N.min), fmt(st.N.xMin)], ['V', fmt(st.V.max), fmt(st.V.xMax), fmt(st.V.min), fmt(st.V.xMin)], ['M', fmt(st.M.max), fmt(st.M.xMax), fmt(st.M.min), fmt(st.M.xMin)]]),
        el('small', { class: 'muted' }, '"at" = distance from the start node. M positive = sagging. V positive = up on the left of a cut (member axes). N positive = tension.'));
    }
    s = psec(P); s.append(el('button', { class: 'danger', onclick: deleteSelected }, 'Delete member'));
  }

  function summaryPanel(P) {
    P.append(phead('Model'));
    let s = psec(P);
    s.append(el('div', {}, doc.nodes.length + ' nodes, ' + doc.members.length + ' members, ' + Object.keys(doc.supports).length + ' supports'),
      el('div', {}, 'Units: ' + S.fu + ', ' + S.lu + '. Tap a node or member (Select tool) to edit it.'));
    if (!results) { s.append(el('small', { class: 'muted' }, 'Press ▶ Solve to see reactions and diagrams.')); return; }
    s = psec(P); const R = results.res.reactions, rows = [];
    for (const [n, r] of Object.entries(R)) rows.push(['N' + (+n + 1), fmt(r.fx), fmt(r.fy), fmt(r.mz)]);
    s.append(el('b', {}, 'Support reactions'), table(['', 'Rx', 'Ry', 'Mz'], rows));
    for (const [n, r] of Object.entries(R)) if (r.rn !== undefined) s.append(el('div', {}, 'N' + (+n + 1) + ': reaction ⊥ to the sloping surface = ' + fmt(r.rn) + ' ' + S.fu));
    let mu = 0, nu = -1; results.res.u.forEach((u, i) => { const d = Math.hypot(u.ux, u.uy); if (d > mu) { mu = d; nu = i; } });
    s = psec(P); s.append(el('div', {}, 'Largest node displacement: ' + fmt(mu) + ' ' + S.lu + (nu >= 0 ? ' at N' + (nu + 1) : '')));
    const eq = results.eq;
    s.append(el('div', { class: eq.ok ? 'good' : 'bad' }, eq.ok ? 'Equilibrium check passed.' : 'Equilibrium check FAILED (fx=' + fmt(eq.fx) + ', fy=' + fmt(eq.fy) + ', mz=' + fmt(eq.mz) + '). Check the model.'));
  }

  /* ---------------- solve ---------------- */
  function solve() {
    try {
      const r = C.solveDoc(doc); const eq = C.equilibriumCheck(doc, r.res);
      results = { ...r, eq }; mode = 'M';
      msg(eq.ok ? 'Solved. Use the buttons below the canvas to view Deflected / N / V / M.' : 'Solved, but the equilibrium check failed. Check the model.', !eq.ok);
    } catch (e) { results = null; mode = 'model'; msg(C.niceError(e), true); }
    refreshButtons(); refreshPanel(); draw();
  }

  /* ---------------- menu / files / examples ---------------- */
  function buildExample(name) {
    const d = C.newDoc(), P = { E: 2e8, A: 0.01, I: 1e-4 }, A = (x, y) => C.addNodeAt(d, x, y);
    if (name === 'beam') {
      const a = A(0, 0), b = A(6, 0); C.addMember(d, a, b, P);
      d.supports[a] = { ...C.SUPPORT_PRESETS.pin }; d.supports[b] = { ...C.SUPPORT_PRESETS.roller };
      d.members[0].loads.push(C.mkDist(0, null, 10, 10, 90, 'global'));
    } else if (name === 'truss') {
      const a = A(0, 0), b = A(4, 0), c = A(2, 3);
      [[a, b], [b, c], [c, a]].forEach(([i, j]) => C.addMember(d, i, j, { ...P, truss: true }));
      d.supports[a] = { ...C.SUPPORT_PRESETS.pin }; d.supports[b] = { ...C.SUPPORT_PRESETS.roller };
      d.nodeLoads.push(C.mkNodeLoad(c, 20, 90, 0));
    } else if (name === 'incl') {   // MATHalino P-351: pin at A, roller on a 1:2 slope at B, 40 kN at 3 m
      const a = A(0, 0), b = A(4, 0); C.addMember(d, a, b, P);
      d.supports[a] = { ...C.SUPPORT_PRESETS.pin }; d.supports[b] = { ang: +(Math.atan2(1, 2) * 180 / Math.PI).toFixed(6) };
      d.members[0].loads.push(C.mkPoint(3, 40, 90, 'global'));
    } else {
      const q = [[0, 0], [0, 4], [6, 4], [6, 0]].map(([x, y]) => A(x, y));
      C.addMember(d, q[0], q[1], P); C.addMember(d, q[1], q[2], P); C.addMember(d, q[2], q[3], P);
      d.supports[q[0]] = { ...C.SUPPORT_PRESETS.fixed }; d.supports[q[3]] = { ...C.SUPPORT_PRESETS.fixed };
      d.nodeLoads.push(C.mkNodeLoad(q[1], 20, 180, 0)); d.members[1].loads.push(C.mkDist(0, null, 10, 10, 90, 'global'));
    }
    return d;
  }
  function loadDoc(d) { edit(() => { doc = d; }); sel = null; pending = null; fitView(); }
  function saveFile() {
    const blob = new Blob([JSON.stringify({ app: 'frame2d', version: 1, doc, S }, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'structure.json' }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  function openFile() {
    const i = el('input', { type: 'file', accept: '.json,application/json' });
    i.addEventListener('change', () => {
      const f = i.files[0]; if (!f) return;
      f.text().then(t => { const o = JSON.parse(t); if (o.S) Object.assign(S, o.S); loadDoc(normalizeDoc(o.doc || o)); closeMenu(); msg('File opened.'); }).catch(() => msg('Could not read that file.', true));
    });
    i.click();
  }
  function closeMenu() { $('modal').hidden = true; refreshOptions(); draw(); }
  function openMenu() {
    const M = $('modal'); M.replaceChildren(); M.hidden = false;
    const setS = k => v => { S[k] = v; save(); draw(); };
    const card = el('div', { class: 'card' }, el('h3', {}, 'Menu'),
      el('div', { class: 'row' }, el('b', {}, 'Settings')),
      row(fnum('Grid', () => S.grid, v => { if (v > 0) setS('grid')(v); }), chk('Snap to grid', () => S.snap, setS('snap'))),
      row(chk('Show labels (N1, M1)', () => S.labels, setS('labels')), chk('Show reactions', () => S.react, setS('react'))),
      row(textFld('Force unit', 'fu'), textFld('Length unit', 'lu')),
      el('div', { class: 'row' }, el('b', {}, 'Defaults for new members')),
      row(fnum('E', () => S.E, v => { if (v > 0) setS('E')(v); }), fnum('A', () => S.A, v => { if (v > 0) setS('A')(v); }), fnum('I', () => S.I, v => { if (v > 0) setS('I')(v); })),
      el('small', { class: 'muted' }, 'Use consistent units (for kN and m: E in kN/m², A in m², I in m⁴). Steel E ≈ 2e8 kN/m².'),
      el('div', { class: 'row' }, el('b', {}, 'File')),
      row(el('button', { onclick: () => { if (confirm('Start a new empty model?')) { loadDoc(C.newDoc()); closeMenu(); } } }, 'New'), el('button', { onclick: openFile }, 'Open…'), el('button', { onclick: saveFile }, 'Save…')),
      el('div', { class: 'row' }, el('b', {}, 'Examples (replace the current model; Undo brings it back)')),
      row(el('button', { onclick: () => { loadDoc(buildExample('beam')); closeMenu(); } }, 'Beam + UDL'), el('button', { onclick: () => { loadDoc(buildExample('truss')); closeMenu(); } }, 'Truss'), el('button', { onclick: () => { loadDoc(buildExample('portal')); closeMenu(); } }, 'Portal frame'), el('button', { onclick: () => { loadDoc(buildExample('incl')); closeMenu(); } }, 'Inclined roller')),
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: closeMenu }, 'Close')));
    M.append(card);
  }
  function textFld(label, key) { const i = el('input', { type: 'text', class: 'num', maxlength: '8' }); i.value = S[key]; i.addEventListener('change', () => { S[key] = i.value.trim() || S[key]; save(); draw(); refreshPanel(); }); return el('label', { class: 'fld' }, label, i); }

  /* ---------------- wiring ---------------- */
  document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => { if (b.dataset.tool === tool && tool === 'member') { pending = null; msg('Stopped. Tap a start point.'); draw(); } else setTool(b.dataset.tool); }));
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { if (!results && b.dataset.mode !== 'model') return; mode = b.dataset.mode; refreshButtons(); draw(); }));
  $('bUndo').addEventListener('click', undo); $('bRedo').addEventListener('click', redo);
  $('bSolve').addEventListener('click', solve); $('bFit').addEventListener('click', fitView);
  $('bZin').addEventListener('click', () => zoomAt(W / 2, H / 2, 1.3)); $('bZout').addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / 1.3));
  $('bInfo').addEventListener('click', () => { panelOpen = !panelOpen; refreshPanel(); draw(); });
  $('bMenu').addEventListener('click', openMenu);
  $('dscale').addEventListener('input', e => { diagScale = parseFloat(e.target.value); draw(); });
  $('flip').addEventListener('change', e => { flip = e.target.checked; draw(); });
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeMenu(); });

  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }
    if (mod && k === 'y') { redo(); e.preventDefault(); return; }
    if (mod && e.key === 'Enter') { solve(); e.preventDefault(); return; }
    if (mod || e.altKey) return;
    if (k === 'escape') { if (pending) { pending = null; msg('Stopped.'); draw(); } else { sel = null; setTool('select'); refreshPanel(); } return; }
    if (k === 'delete' || k === 'backspace') { deleteSelected(); e.preventDefault(); return; }
    const map = { v: 'select', n: 'node', m: 'member', s: 'support', l: 'load', d: 'delete' };
    if (map[k]) setTool(map[k]); else if (k === 'f') fitView();
  });
  window.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv.parentElement);
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').catch(() => { });

  restore();
  refreshOptions(); refreshButtons(); refreshPanel(); resize(); msg(HINTS.select);
  window.Frame2D = { get doc() { return doc; }, get results() { return results; }, get view() { return view; }, solve, setTool, fitView, buildExample, loadDoc }; // used by tests
})();
