/*
 solver2d.js - 2D frame/truss solver (direct stiffness, Euler-Bernoulli beams). Any consistent units.

 API
   const m = new Solver2D.Model();
   n = m.addNode(x, y)
   k = m.addMember(i, j, {E, A, I, type:'frame'|'truss', hingeStart, hingeEnd})
   m.setHinge(node, on=true)                 // releases rotation of ALL members meeting at the node
   m.setSupport(node, {ang,                  // INCLINED ROLLER: ang = direction of the sloping surface in degrees, ccw from +x
                                             //   (only if rx and ry are not set). Restrains displacement normal to the surface;
                                             //   reactions[node].rn = reaction normal to the surface. dn = optional settlement along the normal.
                       rx, ry, rr,           // restrained x / y / rotation (booleans)
                       kx, ky, kr,           // optional spring stiffness (force/length, moment/rad)
                       dx, dy, dr})          // optional settlement of restrained dofs
   m.addNodalLoad(node, {fx, fy, mz})        // global axes, mz counter-clockwise +
   m.addMemberLoad(k, {kind:'point', a, fx, fy, system:'global'|'local'})            // a = distance from start node
   m.addMemberLoad(k, {kind:'dist', a, b, fx1, fy1, fx2, fy2, system})               // per unit member length, linear from a to b
                                                                                    // (a,b default 0..L; fx2/fy2 default fx1/fy1)
   const res = m.solve()                     // throws Error on unstable structure / bad input
   res.u[node]         = {ux, uy, rz}
   res.reactions[node] = {fx, fy, mz}        // force applied TO the structure by the support (global axes)
   res.members[k]      = {L, c, s, N1, V1, M1, N2, V2, M2, uL, ...}   // internal forces at start (1) and end (2)
   res.equilibrium     = {fx, fy, mz}        // should all be ~0
   m.memberDiagram(k, n=200) -> {x[], N[], V[], M[], u[], v[], theta[], X[], Y[], dX[], dY[], stats}
   m.toJSON() / Model.fromJSON(obj)          // save / open

 Sign convention (member local axis x from start node to end node, local y = 90 deg counter-clockwise from x)
   N: tension +.   V: sum of local-y forces to the left of the cut (up +).   M: sagging +  (tension on the -y side).
   u, v: local axial / transverse displacement; dX, dY: displacement in global axes. theta: rotation, ccw +.
*/
(function (root) {
  'use strict';

  const GL_X = [0, 0.5384693101056831, -0.5384693101056831, 0.9061798459386640, -0.9061798459386640];
  const GL_W = [0.5688888888888889, 0.4786286704993665, 0.4786286704993665, 0.2369268850561891, 0.2369268850561891];
  const EPS = 1e-9;

  const zeros = (n, m) => Array.from({ length: n }, () => new Array(m).fill(0));

  function matMul(A, B) {
    const n = A.length, m = B[0].length, p = B.length;
    const C = zeros(n, m);
    for (let i = 0; i < n; i++) for (let k = 0; k < p; k++) {
      const a = A[i][k];
      if (a !== 0) for (let j = 0; j < m; j++) C[i][j] += a * B[k][j];
    }
    return C;
  }
  const transpose = (A) => A[0].map((_, j) => A.map(r => r[j]));
  const matVec = (A, v) => A.map(r => r.reduce((s, a, j) => s + a * v[j], 0));

  // Gaussian elimination with partial pivoting. Returns {x} or {fail: columnIndex}.
  function solveLinear(A, b) {
    const n = b.length;
    let scale = 0;
    for (const row of A) for (const v of row) scale = Math.max(scale, Math.abs(v));
    const M = A.map((r, i) => [...r, b[i]]);
    for (let k = 0; k < n; k++) {
      let p = k;
      for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
      if (Math.abs(M[p][k]) <= 1e-11 * scale) return { fail: k };
      if (p !== k) { const t = M[k]; M[k] = M[p]; M[p] = t; }
      for (let i = k + 1; i < n; i++) {
        const f = M[i][k] / M[k][k];
        if (f !== 0) for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = M[i][n];
      for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return { x };
  }

  function localK(E, A, I, L) {
    const a = E * A / L, b = 12 * E * I / L ** 3, c = 6 * E * I / L ** 2, d = 4 * E * I / L, e = 2 * E * I / L;
    return [
      [a, 0, 0, -a, 0, 0],
      [0, b, c, 0, -b, c],
      [0, c, d, 0, -c, e],
      [-a, 0, 0, a, 0, 0],
      [0, -b, -c, 0, b, -c],
      [0, c, e, 0, -c, d],
    ];
  }

  function rotMatrix(c, s) {
    return [
      [c, s, 0, 0, 0, 0], [-s, c, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0],
      [0, 0, 0, c, s, 0], [0, 0, 0, -s, c, 0], [0, 0, 0, 0, 0, 1],
    ];
  }

  // Equivalent nodal loads (loads applied TO the nodes), local axes, from local member loads.
  function eqLoads(L, ll) {
    const f = [0, 0, 0, 0, 0, 0];
    for (const p of ll.pts) {
      const a = p.a, b = L - a;
      f[0] += p.px * b / L;
      f[3] += p.px * a / L;
      f[1] += p.py * b * b * (3 * a + b) / L ** 3;
      f[4] += p.py * a * a * (a + 3 * b) / L ** 3;
      f[2] += p.py * a * b * b / (L * L);
      f[5] -= p.py * a * a * b / (L * L);
    }
    for (const d of ll.dists) {
      const len = d.b - d.a;
      if (len <= 0) continue;
      for (let k = 0; k < 5; k++) {
        const x = d.a + (GL_X[k] + 1) * len / 2, w = GL_W[k] * len / 2, t = (x - d.a) / len;
        const p = d.p1 + (d.p2 - d.p1) * t, q = d.q1 + (d.q2 - d.q1) * t, xi = x / L;
        const H1 = 1 - 3 * xi * xi + 2 * xi ** 3, H2 = L * (xi - 2 * xi * xi + xi ** 3);
        const H3 = 3 * xi * xi - 2 * xi ** 3, H4 = L * (-xi * xi + xi ** 3);
        f[0] += w * p * (1 - xi); f[3] += w * p * xi;
        f[1] += w * q * H1; f[2] += w * q * H2; f[4] += w * q * H3; f[5] += w * q * H4;
      }
    }
    return f;
  }

  // Static condensation of released dofs (rel = list of local dof indices).
  function condense(k, f, rel) {
    if (!rel.length) return { kc: k, fc: f };
    const n = rel.length;
    const krr = rel.map(r => rel.map(c => k[r][c]));
    let inv;
    if (n === 1) inv = [[1 / krr[0][0]]];
    else {
      const det = krr[0][0] * krr[1][1] - krr[0][1] * krr[1][0];
      inv = [[krr[1][1] / det, -krr[0][1] / det], [-krr[1][0] / det, krr[0][0] / det]];
    }
    const kc = zeros(6, 6), fc = f.slice();
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        let s = 0;
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) s += k[i][rel[a]] * inv[a][b] * k[rel[b]][j];
        kc[i][j] = k[i][j] - s;
      }
      let s = 0;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) s += k[i][rel[a]] * inv[a][b] * f[rel[b]];
      fc[i] = f[i] - s;
    }
    for (const r of rel) { for (let i = 0; i < 6; i++) { kc[r][i] = 0; kc[i][r] = 0; } fc[r] = 0; }
    if (n === 2) { kc[1][1] = 0; kc[1][4] = 0; kc[4][1] = 0; kc[4][4] = 0; } // pin-pin bar: no transverse stiffness
    return { kc, fc };
  }

  class Model {
    constructor() { this.nodes = []; this.members = []; this.supports = {}; this.nodalLoads = {}; this.result = null; }

    addNode(x, y) { this.nodes.push({ x, y }); return this.nodes.length - 1; }

    addMember(i, j, p = {}) {
      if (i === j) throw new Error('Member start and end nodes are the same');
      if (!this.nodes[i] || !this.nodes[j]) throw new Error('Member refers to a missing node');
      this.members.push({
        i, j, E: p.E ?? 1, A: p.A ?? 1, I: p.I ?? 1,
        truss: p.type === 'truss', hingeStart: !!p.hingeStart, hingeEnd: !!p.hingeEnd, loads: [],
      });
      return this.members.length - 1;
    }

    setHinge(node, on = true) {
      for (const m of this.members) { if (m.i === node) m.hingeStart = on; if (m.j === node) m.hingeEnd = on; }
    }

    setSupport(node, s) { if (s) this.supports[node] = { ...s }; else delete this.supports[node]; }

    addNodalLoad(node, l) {
      const c = this.nodalLoads[node] || (this.nodalLoads[node] = { fx: 0, fy: 0, mz: 0 });
      c.fx += l.fx || 0; c.fy += l.fy || 0; c.mz += l.mz || 0;
    }

    addMemberLoad(k, load) {
      if (!this.members[k]) throw new Error('Load refers to a missing member');
      this.members[k].loads.push({ ...load });
    }

    toJSON() { return JSON.parse(JSON.stringify({ nodes: this.nodes, members: this.members, supports: this.supports, nodalLoads: this.nodalLoads })); }
    static fromJSON(o) {
      const m = new Model();
      m.nodes = o.nodes || []; m.members = o.members || []; m.supports = o.supports || {}; m.nodalLoads = o.nodalLoads || {};
      return m;
    }

    geom(m) {
      const a = this.nodes[m.i], b = this.nodes[m.j];
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 1e-12) throw new Error('Zero-length member');
      return { L, c: dx / L, s: dy / L };
    }

    localLoads(m, g) {
      const pts = [], dists = [];
      const toLocal = (fx, fy, sys) => sys === 'local' ? [fx, fy] : [fx * g.c + fy * g.s, -fx * g.s + fy * g.c];
      for (const ld of m.loads) {
        if (ld.kind === 'point') {
          const a = ld.a ?? 0;
          if (a < -EPS || a > g.L + EPS) throw new Error('Point load is outside the member');
          const [px, py] = toLocal(ld.fx || 0, ld.fy || 0, ld.system);
          pts.push({ a: Math.min(Math.max(a, 0), g.L), px, py });
        } else if (ld.kind === 'dist') {
          const a = ld.a ?? 0, b = ld.b ?? g.L;
          if (a < -EPS || b > g.L + EPS || b < a) throw new Error('Distributed load range is outside the member');
          const [p1, q1] = toLocal(ld.fx1 || 0, ld.fy1 || 0, ld.system);
          const [p2, q2] = toLocal(ld.fx2 ?? ld.fx1 ?? 0, ld.fy2 ?? ld.fy1 ?? 0, ld.system);
          dists.push({ a: Math.max(a, 0), b: Math.min(b, g.L), p1, p2, q1, q2 });
        } else throw new Error('Unknown member load kind: ' + ld.kind);
      }
      return { pts, dists };
    }

    solve() {
      const nN = this.nodes.length, nD = 3 * nN;
      if (!this.members.length) throw new Error('No members in the model');

      // active dofs
      const active = new Array(nD).fill(false);
      const pre = this.members.map((m) => {
        const g = this.geom(m), ll = this.localLoads(m, g);
        const rel = [];
        if (m.truss || m.hingeStart) rel.push(2);
        if (m.truss || m.hingeEnd) rel.push(5);
        const k = localK(m.E, m.A, m.I, g.L), f = eqLoads(g.L, ll);
        const { kc, fc } = condense(k, f, rel);
        const T = rotMatrix(g.c, g.s);
        active[3 * m.i] = active[3 * m.i + 1] = active[3 * m.j] = active[3 * m.j + 1] = true;
        if (!rel.includes(2)) active[3 * m.i + 2] = true;
        if (!rel.includes(5)) active[3 * m.j + 2] = true;
        return { g, ll, rel, k, f, kc, fc, T };
      });

      // supports
      const incl = {};   // inclined roller nodes: {c,s} = direction cosines of the sloping surface
      const restrained = new Array(nD).fill(false), prescribed = new Array(nD).fill(0), spring = new Array(nD).fill(0);
      for (const [ns, s] of Object.entries(this.supports)) {
        const n = Number(ns);
        if (!this.nodes[n]) continue;
        let flags = [s.rx, s.ry, s.rr], settle = [s.dx, s.dy, s.dr], ks = [s.kx, s.ky, s.kr];
        if (typeof s.ang === 'number' && isFinite(s.ang) && !s.rx && !s.ry) {
          // inclined roller: the node's x/y dofs are rotated so that local x' runs along the surface and local y' is
          // normal to it. Only the normal displacement is restrained (y'). Optional: dn = settlement along the normal.
          const r = s.ang * Math.PI / 180;
          incl[n] = { c: Math.cos(r), s: Math.sin(r) };
          flags = [false, true, s.rr]; settle = [0, s.dn, s.dr]; ks = [0, 0, s.kr];
        }
        for (let d = 0; d < 3; d++) {
          if (flags[d]) { restrained[3 * n + d] = true; prescribed[3 * n + d] = settle[d] || 0; }
          else if (ks[d]) spring[3 * n + d] = ks[d];
        }
      }

      // assemble
      const K = zeros(nD, nD), Fn = new Array(nD).fill(0), Feq = new Array(nD).fill(0);
      for (const [ns, l] of Object.entries(this.nodalLoads)) {
        const n = Number(ns);
        if (!this.nodes[n]) continue;
        if (l.mz && !active[3 * n + 2] && !restrained[3 * n + 2]) throw new Error('Moment applied at node ' + n + ' which has no rotational stiffness (hinge / truss-only node)');
        Fn[3 * n] += l.fx; Fn[3 * n + 1] += l.fy; Fn[3 * n + 2] += l.mz;
      }
      this.members.forEach((m, mi) => {
        const p = pre[mi], dofs = [3 * m.i, 3 * m.i + 1, 3 * m.i + 2, 3 * m.j, 3 * m.j + 1, 3 * m.j + 2];
        const Kg = matMul(transpose(p.T), matMul(p.kc, p.T));
        const Fg = matVec(transpose(p.T), p.fc);
        for (let a = 0; a < 6; a++) {
          Feq[dofs[a]] += Fg[a];
          for (let b = 0; b < 6; b++) K[dofs[a]][dofs[b]] += Kg[a][b];
        }
      });
      for (let d = 0; d < nD; d++) if (active[d] && !restrained[d]) K[d][d] += spring[d];

      // rotate the dofs of inclined-roller nodes into (along-surface, normal) axes: K' = R K R^T, F' = R F
      const FnS = Fn.slice(), FeS = Feq.slice();
      for (const [ns, q] of Object.entries(incl)) {
        const a = 3 * Number(ns), b = a + 1, c = q.c, sn = q.s;
        for (let j = 0; j < nD; j++) { const ka = K[a][j], kb = K[b][j]; K[a][j] = c * ka + sn * kb; K[b][j] = -sn * ka + c * kb; }
        for (let i = 0; i < nD; i++) { const ka = K[i][a], kb = K[i][b]; K[i][a] = c * ka + sn * kb; K[i][b] = -sn * ka + c * kb; }
        for (const F of [FnS, FeS]) { const fa = F[a], fb = F[b]; F[a] = c * fa + sn * fb; F[b] = -sn * fa + c * fb; }
      }

      // solve
      const free = [];
      for (let d = 0; d < nD; d++) if (active[d] && !restrained[d]) free.push(d);
      const u = new Array(nD).fill(0);
      for (let d = 0; d < nD; d++) if (restrained[d]) u[d] = prescribed[d];
      if (free.length) {
        const A = free.map(i => free.map(j => K[i][j]));
        const rhs = free.map(i => {
          let s = FnS[i] + FeS[i];
          for (let j = 0; j < nD; j++) if (restrained[j] && u[j] !== 0) s -= K[i][j] * u[j];
          return s;
        });
        const sol = solveLinear(A, rhs);
        if (sol.fail !== undefined) {
          const node = Math.floor(free[sol.fail] / 3);
          throw new Error('Unstable structure (mechanism): check supports, hinges and connections, possibly near node ' + node);
        }
        free.forEach((d, i) => { u[d] = sol.x[i]; });
      }

      // rotate inclined-roller displacements back to global axes
      for (const [ns, q] of Object.entries(incl)) {
        const a = 3 * Number(ns), b = a + 1, ua = u[a], ub = u[b];
        u[a] = q.c * ua - q.s * ub; u[b] = q.s * ua + q.c * ub;
      }

      // member end forces, reactions
      const sumF = new Array(nD).fill(0);
      const members = this.members.map((m, mi) => {
        const p = pre[mi], dofs = [3 * m.i, 3 * m.i + 1, 3 * m.i + 2, 3 * m.j, 3 * m.j + 1, 3 * m.j + 2];
        const uL = matVec(p.T, dofs.map(d => u[d]));
        if (p.rel.length) { // recover released rotations
          const n = p.rel.length;
          const rhs = p.rel.map(r => { let s = p.f[r]; for (let c = 0; c < 6; c++) if (!p.rel.includes(c)) s -= p.k[r][c] * uL[c]; return s; });
          const krr = p.rel.map(r => p.rel.map(c => p.k[r][c]));
          let x;
          if (n === 1) x = [rhs[0] / krr[0][0]];
          else {
            const det = krr[0][0] * krr[1][1] - krr[0][1] * krr[1][0];
            x = [(krr[1][1] * rhs[0] - krr[0][1] * rhs[1]) / det, (-krr[1][0] * rhs[0] + krr[0][0] * rhs[1]) / det];
          }
          p.rel.forEach((r, i) => { uL[r] = x[i]; });
        }
        const fL = matVec(p.k, uL).map((v, i) => v - p.f[i]); // forces on member by joints
        for (const r of p.rel) fL[r] = 0;
        const fG = matVec(transpose(p.T), fL);
        for (let a = 0; a < 6; a++) sumF[dofs[a]] += fG[a];
        const res = { L: p.g.L, c: p.g.c, s: p.g.s, E: m.E, A: m.A, I: m.I, uL, fL, ll: p.ll, rel: p.rel };
        const e1 = this._internal(res, 0, 1), e2 = this._internal(res, p.g.L, -1);
        Object.assign(res, { N1: e1.N, V1: e1.V, M1: e1.M, N2: e2.N, V2: e2.V, M2: e2.M });
        return res;
      });

      const R = sumF.map((v, d) => v - Fn[d]);
      const reactions = {};
      for (let n = 0; n < nN; n++) {
        const has = restrained[3 * n] || restrained[3 * n + 1] || restrained[3 * n + 2] || spring[3 * n] || spring[3 * n + 1] || spring[3 * n + 2];
        if (has) {
          reactions[n] = { fx: R[3 * n], fy: R[3 * n + 1], mz: R[3 * n + 2] };
          if (incl[n]) reactions[n].rn = -incl[n].s * R[3 * n] + incl[n].c * R[3 * n + 1]; // component normal to the surface
        }
      }
      // global equilibrium check: support reactions + nodal loads + member loads (as equivalent nodal loads)
      const eq = { fx: 0, fy: 0, mz: 0 };
      for (let n = 0; n < nN; n++) {
        const Rx = restrained[3 * n] || spring[3 * n] || incl[n] ? R[3 * n] : 0;
        const Ry = restrained[3 * n + 1] || spring[3 * n + 1] ? R[3 * n + 1] : 0;
        const Rm = restrained[3 * n + 2] || spring[3 * n + 2] ? R[3 * n + 2] : 0;
        const fx = Rx + Fn[3 * n] + Feq[3 * n], fy = Ry + Fn[3 * n + 1] + Feq[3 * n + 1], mz = Rm + Fn[3 * n + 2] + Feq[3 * n + 2];
        eq.fx += fx; eq.fy += fy; eq.mz += mz + this.nodes[n].x * fy - this.nodes[n].y * fx;
      }

      this.result = {
        u: this.nodes.map((_, n) => ({ ux: u[3 * n], uy: u[3 * n + 1], rz: u[3 * n + 2] })),
        reactions, members, equilibrium: eq,
      };
      return this.result;
    }

    // internal forces at distance x from start; side = -1 (just before x) or +1 (just after x) for point loads at x
    _internal(r, x, side) {
      const [Fx1, Fy1, M1] = [r.fL[0], r.fL[1], r.fL[2]];
      let N = -Fx1, V = Fy1, M = Fy1 * x - M1;
      for (const p of r.ll.pts) {
        if (x > p.a + EPS || (side > 0 && x > p.a - EPS)) { N -= p.px; V += p.py; M += p.py * (x - p.a); }
      }
      for (const d of r.ll.dists) {
        const len = d.b - d.a;
        if (len <= 0 || x <= d.a) continue;
        const t = Math.min(x, d.b), l = t - d.a;
        const gq = (d.q2 - d.q1) / len, gp = (d.p2 - d.p1) / len;
        const Wq = d.q1 * l + gq * l * l / 2, Wp = d.p1 * l + gp * l * l / 2;
        N -= Wp; V += Wq;
        M += (x - t) * Wq + d.q1 * l * l / 2 + gq * l ** 3 / 6;
      }
      return { N, V, M };
    }

    memberDiagram(k, n = 200) {
      if (!this.result) throw new Error('Call solve() first');
      const r = this.result.members[k], m = this.members[k], L = r.L;
      const pointAt = r.ll.pts.map(p => p.a).filter(a => a > EPS && a < L - EPS);
      const edges = [];
      for (const d of r.ll.dists) for (const e of [d.a, d.b]) if (e > EPS && e < L - EPS) edges.push(e);
      const all = pointAt.concat(edges);
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const x = L * i / n;
        if (all.some(a => Math.abs(a - x) < 1e-9 * L)) continue;
        pts.push({ x, side: i === n ? -1 : 1 });
      }
      for (const a of pointAt) { pts.push({ x: a, side: -1 }); pts.push({ x: a, side: 1 }); }
      for (const a of edges) if (!pointAt.some(b => Math.abs(a - b) < 1e-9 * L)) pts.push({ x: a, side: 1 });
      pts.sort((p, q) => p.x - q.x || p.side - q.side);

      // Between consecutive points M and N are polynomials of degree <= 3, so 3-point Gauss integration is exact.
      const G3 = [[-Math.sqrt(0.6), 5 / 9], [0, 8 / 9], [Math.sqrt(0.6), 5 / 9]];
      const EI = m.E * m.I, EA = m.E * m.A;
      const out = { x: [], N: [], V: [], M: [], u: [], v: [], theta: [], X: [], Y: [], dX: [], dY: [] };
      const a0 = this.nodes[m.i];
      let th = r.uL[2], v = r.uL[1], u = r.uL[0], prevX = null;
      for (const p of pts) {
        if (prevX !== null && p.x > prevX) {
          const x0 = prevX, h = (p.x - x0) / 2, mid = x0 + h;
          let dth = 0, dv = 0, du = 0;
          for (const [g, w] of G3) {
            const s = mid + g * h, f = this._internal(r, s, 1);
            dth += w * h * f.M / EI;
            dv += w * h * (p.x - s) * f.M / EI;
            du += w * h * f.N / EA;
          }
          v += th * (2 * h) + dv; th += dth; u += du;
        }
        prevX = p.x;
        const f = this._internal(r, p.x, p.side);
        out.x.push(p.x); out.N.push(f.N); out.V.push(f.V); out.M.push(f.M);
        out.u.push(u); out.v.push(v); out.theta.push(th);
        out.X.push(a0.x + r.c * p.x); out.Y.push(a0.y + r.s * p.x);
        out.dX.push(r.c * u - r.s * v); out.dY.push(r.s * u + r.c * v);
      }
      const ext = (arr) => {
        let mx = -Infinity, mn = Infinity, xm = 0, xn = 0;
        arr.forEach((val, i) => { if (val > mx) { mx = val; xm = out.x[i]; } if (val < mn) { mn = val; xn = out.x[i]; } });
        return { max: mx, xMax: xm, min: mn, xMin: xn };
      };
      out.stats = { N: ext(out.N), V: ext(out.V), M: ext(out.M), v: ext(out.v) };
      return out;
    }
  }

  const api = { Model };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Solver2D = api;
})(typeof self !== 'undefined' ? self : this);
