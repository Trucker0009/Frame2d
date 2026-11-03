/*
 core.js - document logic for the 2D frame app (no drawing code, so it can be tested without a browser).
 The "doc" is plain JSON:
   { nodes:[{x,y}], members:[{i,j,E,A,I,truss,hingeStart,hingeEnd,loads:[]}],
     supports:{ nodeIndex:{rx,ry,rr,kx,ky,kr,dx,dy,dr} }, nodeLoads:[{node,F,ang,mz,fx,fy}] }
 Load angle convention (copied from SW FEA): the angle is the direction the arrow COMES FROM,
 measured counter-clockwise from +x.  90 deg pushes down, 180 deg pushes right, 270 up, 0 left.
   force = ( -F cos(ang), -F sin(ang) )
*/
(function (root) {
  'use strict';
  const Solver = (typeof module !== 'undefined' && module.exports) ? require('./solver2d.js') : root.Solver2D;
  const EPS = 1e-9;

  function newDoc() { return { nodes: [], members: [], supports: {}, nodeLoads: [] }; }

  function trig(deg) {
    const r = deg * Math.PI / 180, q = v => Math.abs(v) < 1e-12 ? 0 : Math.round(v * 1e12) / 1e12;
    return [q(Math.cos(r)), q(Math.sin(r))];
  }
  function dirVec(F, ang) { const [c, s] = trig(ang); return [-F * c + 0, -F * s + 0]; }

  function recalcLoad(ld) {
    if (ld.kind === 'point') { [ld.fx, ld.fy] = dirVec(ld.F, ld.ang); }
    else if (ld.kind === 'dist') { [ld.fx1, ld.fy1] = dirVec(ld.w1, ld.ang); [ld.fx2, ld.fy2] = dirVec(ld.w2, ld.ang); }
    return ld;
  }
  function recalcNodeLoad(nl) { [nl.fx, nl.fy] = dirVec(nl.F, nl.ang); return nl; }
  const mkPoint = (a, F, ang, system) => recalcLoad({ kind: 'point', a, F, ang, system: system || 'global' });
  const mkDist = (a, b, w1, w2, ang, system) => recalcLoad({ kind: 'dist', a, b, w1, w2, ang, system: system || 'global' });
  const mkNodeLoad = (node, F, ang, mz) => recalcNodeLoad({ node, F, ang, mz: mz || 0 });

  function mGeom(doc, m) {
    const a = doc.nodes[m.i], b = doc.nodes[m.j];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    return { L, c: L ? dx / L : 1, s: L ? dy / L : 0 };
  }
  // distance t along member k (from start) of the projection of (x,y), and the perpendicular distance
  function projectOnMember(doc, k, x, y) {
    const m = doc.members[k], a = doc.nodes[m.i], g = mGeom(doc, m);
    const t = (x - a.x) * g.c + (y - a.y) * g.s;
    return { t, dist: Math.hypot(x - (a.x + g.c * t), y - (a.y + g.s * t)), L: g.L };
  }

  function findNode(doc, x, y) {
    return doc.nodes.findIndex(n => Math.hypot(n.x - x, n.y - y) <= 1e-7 * (1 + Math.abs(x) + Math.abs(y)));
  }

  // Add a node at (x,y) (or return the existing one). If it lies inside a member, that member is split there.
  function addNodeAt(doc, x, y) {
    let idx = findNode(doc, x, y);
    if (idx >= 0) return idx;
    doc.nodes.push({ x, y }); idx = doc.nodes.length - 1;
    const n = doc.members.length;
    for (let k = 0; k < n; k++) {
      const p = projectOnMember(doc, k, x, y), tol = 1e-7 * (1 + p.L);
      if (p.L > 0 && p.dist < tol && p.t > tol && p.t < p.L - tol) splitMember(doc, k, p.t, idx);
    }
    return idx;
  }

  function splitMember(doc, k, s, nn) {
    const m = doc.members[k], L = mGeom(doc, m).L;
    const m2 = { i: nn, j: m.j, E: m.E, A: m.A, I: m.I, truss: m.truss, hingeStart: false, hingeEnd: m.hingeEnd, loads: [] };
    const old = m.loads; m.loads = []; m.j = nn; m.hingeEnd = false;
    for (const ld of old) {
      if (ld.kind === 'point') {
        if (ld.a <= s + EPS) m.loads.push(ld); else { ld.a -= s; m2.loads.push(ld); }
      } else {
        const a0 = ld.a ?? 0, b0 = ld.b ?? L;
        if (b0 <= a0) continue;
        const w = x => ld.w1 + (ld.w2 - ld.w1) * (x - a0) / (b0 - a0);
        if (a0 < s - EPS) { const e = Math.min(b0, s); m.loads.push(mkDist(a0, e, ld.w1, w(e), ld.ang, ld.system)); }
        if (b0 > s + EPS) { const st = Math.max(a0, s); m2.loads.push(mkDist(st - s, b0 - s, w(st), ld.w2, ld.ang, ld.system)); }
      }
    }
    doc.members.push(m2);
  }

  function deleteNode(doc, n) {
    doc.members = doc.members.filter(m => m.i !== n && m.j !== n);
    const re = i => i > n ? i - 1 : i;
    doc.members.forEach(m => { m.i = re(m.i); m.j = re(m.j); });
    const sup = {};
    for (const [k, v] of Object.entries(doc.supports)) { const i = +k; if (i !== n) sup[re(i)] = v; }
    doc.supports = sup;
    doc.nodeLoads = doc.nodeLoads.filter(l => l.node !== n);
    doc.nodeLoads.forEach(l => { l.node = re(l.node); });
    doc.nodes.splice(n, 1);
  }
  function deleteMember(doc, k) { doc.members.splice(k, 1); }

  function addMember(doc, i, j, p) {
    if (i === j) return { error: 'Start and end are the same node.' };
    if (doc.members.some(m => (m.i === i && m.j === j) || (m.i === j && m.j === i))) return { error: 'There is already a member between these two nodes.' };
    doc.members.push({ i, j, E: p.E, A: p.A, I: p.I, truss: !!p.truss, hingeStart: false, hingeEnd: false, loads: [] });
    return { index: doc.members.length - 1 };
  }

  function nodeHinged(doc, n) {
    let any = false, all = true;
    for (const m of doc.members) {
      if (m.i === n) { any = true; if (!m.hingeStart && !m.truss) all = false; }
      if (m.j === n) { any = true; if (!m.hingeEnd && !m.truss) all = false; }
    }
    return any && all;
  }
  function setNodeHinge(doc, n, on) {
    for (const m of doc.members) { if (m.i === n) m.hingeStart = on; if (m.j === n) m.hingeEnd = on; }
  }

  const SUPPORT_PRESETS = {
    pin: { rx: true, ry: true },
    roller: { ry: true },          // restrains y only: slides horizontally
    rollerV: { rx: true },         // restrains x only: slides vertically
    fixed: { rx: true, ry: true, rr: true },
  };
  function supportKind(s) {
    if (!s) return 'none';
    if (typeof s.ang === 'number' && !s.rx && !s.ry) return 'inclined';   // roller on a sloping surface
    const spring = s.kx || s.ky || s.kr, settle = s.dx || s.dy || s.dr;
    if (!s.rx && !s.ry && !s.rr && !spring) return 'none';
    if (!spring && !settle) {
      if (s.rx && s.ry && s.rr) return 'fixed';
      if (s.rx && s.ry && !s.rr) return 'pin';
      if (!s.rx && s.ry && !s.rr) return 'roller';
      if (s.rx && !s.ry && !s.rr) return 'rollerV';
    }
    return 'custom';
  }

  function buildModel(doc) {
    const m = new Solver.Model();
    doc.nodes.forEach(n => m.addNode(n.x, n.y));
    doc.members.forEach(mm => {
      const k = m.addMember(mm.i, mm.j, { E: mm.E, A: mm.A, I: mm.I, type: mm.truss ? 'truss' : 'frame', hingeStart: mm.hingeStart, hingeEnd: mm.hingeEnd });
      for (const ld of mm.loads) m.addMemberLoad(k, ld);
    });
    for (const [n, s] of Object.entries(doc.supports)) m.setSupport(Number(n), s);
    for (const nl of doc.nodeLoads) m.addNodalLoad(nl.node, { fx: nl.fx, fy: nl.fy, mz: nl.mz });
    return m;
  }

  function niceError(e) {
    return String((e && e.message) || e).replace(/node (\d+)/g, (_, d) => 'node N' + (+d + 1));
  }

  function solveDoc(doc, nDiag = 100) {
    if (!doc.members.length) throw new Error('Add at least one member first.');
    const used = new Set();
    doc.members.forEach(m => { used.add(m.i); used.add(m.j); });
    for (const l of doc.nodeLoads) if (!used.has(l.node)) throw new Error('Node N' + (l.node + 1) + ' has a load but no member is attached to it.');
    doc.members.forEach((m, k) => {
      if (!(m.E > 0) || !(m.A > 0) || (!m.truss && !(m.I > 0))) throw new Error('Member M' + (k + 1) + ': E, A and I must be positive numbers.');
    });
    const model = buildModel(doc);
    const res = model.solve();
    const bad = res.u.some(u => !isFinite(u.ux) || !isFinite(u.uy) || !isFinite(u.rz));
    if (bad) throw new Error('The result is not a finite number. Check E, A, I and the supports.');
    const diag = doc.members.map((_, k) => model.memberDiagram(k, nDiag));
    return { model, res, diag };
  }

  function equilibriumCheck(doc, res) {
    let F = 0, Mo = 0;
    for (const l of doc.nodeLoads) { F += Math.hypot(l.fx || 0, l.fy || 0); Mo += Math.abs(l.mz || 0); }
    doc.members.forEach(m => {
      const L = mGeom(doc, m).L;
      for (const ld of m.loads) {
        if (ld.kind === 'point') F += Math.hypot(ld.fx, ld.fy);
        else F += Math.max(Math.hypot(ld.fx1, ld.fy1), Math.hypot(ld.fx2, ld.fy2)) * ((ld.b ?? L) - (ld.a ?? 0));
      }
    });
    let R = 0;
    for (const r of Object.values(res.reactions)) R += Math.abs(r.fx) + Math.abs(r.fy) + Math.abs(r.mz);
    const size = 1 + Math.max(0, ...doc.nodes.map(n => Math.abs(n.x) + Math.abs(n.y)));
    const scale = (F + R) * size + Mo;
    const e = res.equilibrium, worst = Math.max(Math.abs(e.fx), Math.abs(e.fy), Math.abs(e.mz));
    return { ok: worst <= 1e-6 * scale + 1e-9, worst, fx: e.fx, fy: e.fy, mz: e.mz };
  }

  const api = {
    newDoc, trig, dirVec, recalcLoad, recalcNodeLoad, mkPoint, mkDist, mkNodeLoad, mGeom, projectOnMember, findNode,
    addNodeAt, splitMember, deleteNode, deleteMember, addMember, nodeHinged, setNodeHinge,
    SUPPORT_PRESETS, supportKind, buildModel, solveDoc, niceError, equilibriumCheck,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SA2DCore = api;
})(typeof self !== 'undefined' ? self : this);
