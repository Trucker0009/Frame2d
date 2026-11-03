/*
 influence.js - influence-line calculations built on top of core.js.
 Does not change the solver or the saved document format.

 It moves a unit point load along one member or along the connected member path
 between two nodes and records either a support reaction or an internal action.
*/
(function (root) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.SA2DCore;

  const REACTION_COMPONENTS = new Set(['rx', 'ry', 'mz', 'rn']);
  const SECTION_COMPONENTS = new Set(['N', 'V', 'M']);

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function checkNumber(v, name) {
    if (!Number.isFinite(v)) throw new Error(name + ' must be a finite number.');
  }

  function checkMember(doc, member) {
    if (!Number.isInteger(member) || !doc.members[member]) throw new Error('Moving-load member is invalid.');
  }

  function checkNode(doc, node, name) {
    if (!Number.isInteger(node) || !doc.nodes[node]) throw new Error(name + ' is invalid.');
  }

  function pathBetweenNodes(doc, start, end) {
    checkNode(doc, start, 'Path start node'); checkNode(doc, end, 'Path end node');
    if (start === end) throw new Error('Path start and end nodes must be different.');
    const adj = doc.nodes.map(() => []);
    doc.members.forEach((m, member) => {
      adj[m.i].push({ node: m.j, member, reverse: false });
      adj[m.j].push({ node: m.i, member, reverse: true });
    });
    const prev = new Array(doc.nodes.length).fill(null), seen = new Set([start]), q = [start];
    while (q.length && !seen.has(end)) {
      const n = q.shift();
      for (const e of adj[n]) if (!seen.has(e.node)) { seen.add(e.node); prev[e.node] = { node: n, edge: e }; q.push(e.node); }
    }
    if (!seen.has(end)) throw new Error('No connected member path exists between those nodes.');
    const edges = [];
    for (let n = end; n !== start; n = prev[n].node) edges.push(prev[n].edge);
    edges.reverse();
    let s = 0;
    const segments = edges.map(e => { const length = C.mGeom(doc, doc.members[e.member]).L; const out = { ...e, start: s, length }; s += length; return out; });
    return { segments, total: s };
  }

  function singleMemberPath(doc, member) {
    checkMember(doc, member);
    return { segments: [{ member, reverse: false, start: 0, length: C.mGeom(doc, doc.members[member]).L }], total: C.mGeom(doc, doc.members[member]).L };
  }

  function cleanStructure(doc) {
    const d = clone(doc);
    d.nodeLoads = [];
    d.members.forEach(m => { m.loads = []; });
    return d;
  }

  function reactionValue(res, target) {
    const r = res.reactions[target.node];
    if (!r) throw new Error('Reaction target node is invalid or has no reaction.');
    if (!REACTION_COMPONENTS.has(target.component)) throw new Error('Reaction component must be rx, ry, mz, or rn.');
    const key = target.component === 'rx' ? 'fx' : target.component === 'ry' ? 'fy' : target.component;
    return Number(r[key] || 0);
  }

  function interpolate(xs, ys, x) {
    if (!xs.length || xs.length !== ys.length) throw new Error('The solver returned an invalid member diagram.');
    if (x <= xs[0]) return ys[0];
    const last = xs.length - 1;
    if (x >= xs[last]) return ys[last];
    let i = 1;
    while (i < xs.length && xs[i] < x) i++;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + t * (ys[i] - ys[i - 1]);
  }

  function sectionValue(result, target) {
    if (!Number.isInteger(target.member) || !result.diag[target.member]) throw new Error('Section target member is invalid.');
    if (!SECTION_COMPONENTS.has(target.component)) throw new Error('Section component must be N, V, or M.');
    const d = result.diag[target.member];
    const x = target.x;
    checkNumber(x, 'Section distance');
    if (x < -1e-9 || x > d.x[d.x.length - 1] + 1e-9) throw new Error('Section distance is outside the target member.');
    return interpolate(d.x, d[target.component], Math.max(0, Math.min(d.x[d.x.length - 1], x)));
  }

  function targetValue(result, target) {
    if (!target || typeof target !== 'object') throw new Error('An influence-line target is required.');
    if (target.kind === 'reaction') return reactionValue(result.res, target);
    if (target.kind === 'section') return sectionValue(result, target);
    throw new Error('Target kind must be reaction or section.');
  }

  function positionsFor(doc, member, n) {
    checkNumber(n, 'Sample count');
    if (!Number.isInteger(n) || n < 2) throw new Error('Sample count must be an integer of at least 2.');
    const L = C.mGeom(doc, doc.members[member]).L;
    return Array.from({ length: n }, (_, i) => L * i / (n - 1));
  }

  function pathPositions(path, n) {
    checkNumber(n, 'Sample count');
    if (!Number.isInteger(n) || n < 2) throw new Error('Sample count must be an integer of at least 2.');
    const out = [];
    let si = 0;
    for (let i = 0; i < n; i++) {
      const s = path.total * i / (n - 1);
      while (si < path.segments.length - 1 && s > path.segments[si].start + path.segments[si].length) si++;
      const seg = path.segments[si], local = Math.max(0, Math.min(seg.length, s - seg.start));
      out.push({ x: s, member: seg.member, a: seg.reverse ? seg.length - local : local });
    }
    return out;
  }

  function pathPositionAt(path, s) {
    let si = 0;
    while (si < path.segments.length - 1 && s > path.segments[si].start + path.segments[si].length) si++;
    const seg = path.segments[si], local = Math.max(0, Math.min(seg.length, s - seg.start));
    return { x: s, member: seg.member, a: seg.reverse ? seg.length - local : local };
  }

  function sectionJumpPositions(path, target) {
    if (!target || target.kind !== 'section') return [];
    for (const seg of path.segments) if (seg.member === target.member) {
      const local = seg.reverse ? seg.length - target.x : target.x;
      const eps = Math.max(1e-7, 1e-7 * path.total);
      if (local > eps && local < seg.length - eps) {
        const s = seg.start + local;
        return [
          { ...pathPositionAt(path, s - eps), jumpId: 0, jumpSide: 'before' },
          { ...pathPositionAt(path, s + eps), jumpId: 0, jumpSide: 'after' },
        ];
      }
    }
    return [];
  }

  function calculate(doc, options) {
    if (!doc || !Array.isArray(doc.members)) throw new Error('A valid structure document is required.');
    const o = options || {};
    const clean = cleanStructure(doc);
    const path = o.startNode !== undefined || o.endNode !== undefined
      ? pathBetweenNodes(clean, o.startNode, o.endNode)
      : singleMemberPath(clean, o.movingMember);
    const angle = o.angle === undefined ? 90 : o.angle;
    const magnitude = o.magnitude === undefined ? 1 : o.magnitude;
    checkNumber(angle, 'Moving-load angle');
    checkNumber(magnitude, 'Moving-load magnitude');
    if (magnitude === 0) throw new Error('Moving-load magnitude must not be zero.');
    let positions;
    if (o.positions) {
      if (path.segments.length !== 1) throw new Error('Explicit load positions are only supported for one member.');
      const member = path.segments[0].member;
      positions = o.positions.map(x => { checkNumber(x, 'Load position'); if (x < -1e-9 || x > path.total + 1e-9) throw new Error('Load position is outside the moving-load member.'); return { x: Math.max(0, Math.min(path.total, x)), member, a: Math.max(0, Math.min(path.total, x)) }; });
    } else positions = pathPositions(path, o.samples === undefined ? 101 : o.samples);
    if (!positions.length) throw new Error('At least one load position is required.');
    const jumps = sectionJumpPositions(path, o.target);
    positions.push(...jumps);

    const samples = positions.map(p => {
      const d = clone(clean);
      d.members[p.member].loads.push(C.mkPoint(p.a, magnitude, angle, o.system || 'global'));
      const solved = C.solveDoc(d, o.diagramSamples || 200);
      return { x: p.x, member: p.member, a: p.a, value: targetValue(solved, o.target), jumpId: p.jumpId, jumpSide: p.jumpSide };
    });
    samples.sort((a, b) => a.x - b.x || (a.jumpSide === 'before' ? -1 : a.jumpSide === 'after' ? 1 : 0));
    const jumpResults = [];
    for (const id of new Set(jumps.map(p => p.jumpId))) {
      const before = samples.find(s => s.jumpId === id && s.jumpSide === 'before');
      const after = samples.find(s => s.jumpId === id && s.jumpSide === 'after');
      if (before && after) jumpResults.push({ before, after });
    }
    return {
      movingMember: path.segments[0].member,
      path,
      memberLength: path.total,
      angle,
      magnitude,
      system: o.system || 'global',
      target: clone(o.target),
      samples,
      jumps: jumpResults,
    };
  }

  const api = { calculate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SA2DInfluence = api;
})(typeof self !== 'undefined' ? self : this);
