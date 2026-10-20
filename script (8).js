/* ============================================================
   FlowChart Studio — core engine
   ============================================================ */
const $ = id => document.getElementById(id);
const wrap = $("wrap"), canvas = $("canvas"), backgroundLayer = $("backgroundLayer"), layer = $("layer"), svg = $("svg"), empty = $("empty");

let nodes = [];
let levels = []; // editable background bands / levels
let edges = [];              // { a: nodeId, b: nodeId }
let selected = new Set();    // selected node ids
let selectedEdge = null;     // index into edges[]
let selectedLevel = null;      // selected background level id
let zoom = 1;
let hist = [], future = [];
let counter = 1;
let drag = null, resize = null, levelDrag = null, levelResize = null, pan = null, connect = null;
let clipboard = null;
let gridOn = true, minimapOn = true;

// shape definitions: [label, defaultWidth, defaultHeight]
const D = {
  start:   ["Start / End", 150, 70],
  process: ["Process", 150, 70],
  decision:["Decision", 110, 110],
  data:    ["Data", 150, 70],
  document:["Document", 150, 75],
  database:["Database", 150, 75],
  circle:  ["Circle", 80, 80],
  hexagon: ["Hexagon", 145, 75],
  parallelogram: ["Data", 150, 70],
  image:   ["Image", 160, 120]
};

/* ---------------- geometry helpers ---------------- */
function snap(v) { return Math.round(v / 10) * 10; }
function pt(e) {
  const r = wrap.getBoundingClientRect();
  return { x: (e.clientX - r.left + wrap.scrollLeft) / zoom, y: (e.clientY - r.top + wrap.scrollTop) / zoom };
}
function get(id) { return nodes.find(n => n.id === id); }
function center(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }
function side(n, s) {
  return s === "t" ? { x: n.x + n.w / 2, y: n.y }
       : s === "r" ? { x: n.x + n.w, y: n.y + n.h / 2 }
       : s === "b" ? { x: n.x + n.w / 2, y: n.y + n.h }
       : { x: n.x, y: n.y + n.h / 2 };
}
function near(n, p) {
  const opts = ["t", "r", "b", "l"].map(s => [s, side(n, s)]);
  opts.sort((A, B) => Math.hypot(A[1].x - p.x, A[1].y - p.y) - Math.hypot(B[1].x - p.x, B[1].y - p.y));
  return opts[0][0];
}
function extend(p, s, amt) {
  return s === "t" ? { x: p.x, y: p.y - amt }
       : s === "b" ? { x: p.x, y: p.y + amt }
       : s === "l" ? { x: p.x - amt, y: p.y }
       : { x: p.x + amt, y: p.y };
}
/* Single-edge orthogonal path (used when nodes are not in clear parent/child hierarchy) */
function edgePath(a, b) {
  const aIsAbove = (a.y + a.h) <= b.y + 8;
  const bIsAbove = (b.y + b.h) <= a.y + 8;
  let p1, p2, midY;
  if (aIsAbove) {
    p1 = side(a, "b"); p2 = side(b, "t");
    midY = Math.round((p1.y + p2.y) / 2);
    return `M ${p1.x} ${p1.y} L ${p1.x} ${midY} L ${p2.x} ${midY} L ${p2.x} ${p2.y}`;
  }
  if (bIsAbove) {
    p1 = side(a, "t"); p2 = side(b, "b");
    midY = Math.round((p1.y + p2.y) / 2);
    return `M ${p1.x} ${p1.y} L ${p1.x} ${midY} L ${p2.x} ${midY} L ${p2.x} ${p2.y}`;
  }
  const sA = near(a, center(b)), sB = near(b, center(a));
  p1 = side(a, sA); p2 = side(b, sB);
  if (Math.abs(p2.x - p1.x) > Math.abs(p2.y - p1.y)) {
    const midX = Math.round((p1.x + p2.x) / 2);
    return `M ${p1.x} ${p1.y} L ${midX} ${p1.y} L ${midX} ${p2.y} L ${p2.x} ${p2.y}`;
  }
  midY = Math.round((p1.y + p2.y) / 2);
  return `M ${p1.x} ${p1.y} L ${p1.x} ${midY} L ${p2.x} ${midY} L ${p2.x} ${p2.y}`;
}

/**
 * Build org-chart style paths: shared horizontal bar under each parent.
 * Returns array of { d, edgeIndexes } for SVG paths (no junction circles).
 */
function buildOrgPaths() {
  // Group children by parent (parent = upper node in a top-down edge)
  const groups = new Map(); // parentId -> [{ child, edgeIdx }]
  const leftover = [];      // edge indexes that are not top-down

  edges.forEach((ed, idx) => {
    const a = get(ed.a), b = get(ed.b);
    if (!a || !b) return;
    const aAbove = (a.y + a.h) <= b.y + 8;
    const bAbove = (b.y + b.h) <= a.y + 8;
    if (aAbove) {
      if (!groups.has(ed.a)) groups.set(ed.a, []);
      groups.get(ed.a).push({ child: b, edgeIdx: idx });
    } else if (bAbove) {
      if (!groups.has(ed.b)) groups.set(ed.b, []);
      groups.get(ed.b).push({ child: a, edgeIdx: idx });
    } else {
      leftover.push(idx);
    }
  });

  const paths = [];

  // Shared horizontal bars for each parent group
  groups.forEach((kids, parentId) => {
    const parent = get(parentId);
    if (!parent || !kids.length) return;
    const pBottom = side(parent, "b");
    // midY: halfway between parent bottom and the highest child top
    const childTops = kids.map(k => side(k.child, "t").y);
    const midY = Math.round((pBottom.y + Math.min(...childTops)) / 2);

    const childCentersX = kids.map(k => side(k.child, "t").x);
    const minX = Math.min(pBottom.x, ...childCentersX);
    const maxX = Math.max(pBottom.x, ...childCentersX);

    // Vertical from parent down to bar
    paths.push({ d: `M ${pBottom.x} ${pBottom.y} L ${pBottom.x} ${midY}`, edgeIndexes: kids.map(k => k.edgeIdx) });
    // Shared horizontal bar
    if (minX !== maxX) {
      paths.push({ d: `M ${minX} ${midY} L ${maxX} ${midY}`, edgeIndexes: kids.map(k => k.edgeIdx) });
    }
    // Vertical drop to each child
    kids.forEach(k => {
      const ct = side(k.child, "t");
      paths.push({ d: `M ${ct.x} ${midY} L ${ct.x} ${ct.y}`, edgeIndexes: [k.edgeIdx] });
    });
  });

  // Non-hierarchical edges (sideways etc.)
  leftover.forEach(idx => {
    const ed = edges[idx];
    const a = get(ed.a), b = get(ed.b);
    if (!a || !b) return;
    paths.push({ d: edgePath(a, b), edgeIndexes: [idx] });
  });

  return paths;
}

/* ---------------- history ---------------- */
function saveState() {
  hist.push(JSON.stringify({ nodes, levels, edges, zoom }));
  if (hist.length > 100) hist.shift();
  future = [];
}
function restore(s) {
  const d = JSON.parse(s);
  nodes = d.nodes || []; levels = d.levels || []; edges = d.edges || []; zoom = d.zoom || 1;
  selected.clear(); selectedEdge = null;
  render(); setZoom(zoom);
}
function undo() { if (!hist.length) return; future.push(JSON.stringify({ nodes, levels, edges, zoom })); restore(hist.pop()); status("Undo"); }
function redo() { if (!future.length) return; hist.push(JSON.stringify({ nodes, levels, edges, zoom })); restore(future.pop()); status("Redo"); }
function status(t) { $("status").textContent = t; }

/* ---------------- editable level backgrounds ---------------- */
const LEVEL_COLORS = ["#d1d5db", "#fff200", "#7cb342", "#93c5fd", "#f9a8d4", "#c4b5fd"];

function getLevel(id) { return levels.find(l => l.id === id); }
function nextLevelId() { return "l" + (levels.reduce((m, l) => Math.max(m, +String(l.id).replace("l", "") || 0), 0) + 1); }

function addLevel(x, y, extra = {}) {
  saveState();
  const idx = levels.length;
  const level = {
    id: nextLevelId(),
    x: snap(x - 500),
    y: snap(y - 90),
    w: 1000,
    h: 180,
    text: extra.text || `Level ${idx + 1}`,
    fill: extra.fill || LEVEL_COLORS[idx % LEVEL_COLORS.length],
    border: extra.border || "#64748b",
    opacity: extra.opacity == null ? 82 : extra.opacity
  };
  levels.push(level);
  selected.clear();
  selectedEdge = null;
  selectedLevel = level.id;
  render();
  status("Level background added");
}

function startLevelDrag(e, id) {
  if (e.button !== 0) return;
  const l = getLevel(id);
  if (!l) return;
  selected.clear();
  selectedEdge = null;
  selectedLevel = id;
  render();
  saveState();
  const p = pt(e);
  levelDrag = { x: p.x, y: p.y, id };
  document.addEventListener("pointermove", moveLevelDrag);
  document.addEventListener("pointerup", endLevelDrag, { once: true });
}

function moveLevelDrag(e) {
  if (!levelDrag) return;
  const l = getLevel(levelDrag.id);
  if (!l) return;
  const p = pt(e), dx = snap(p.x - levelDrag.x), dy = snap(p.y - levelDrag.y);
  if (dx === 0 && dy === 0) return;
  l.x += dx; l.y += dy;
  levelDrag.x = p.x; levelDrag.y = p.y;
  render();
  status("Moving level");
}

function endLevelDrag() {
  document.removeEventListener("pointermove", moveLevelDrag);
  levelDrag = null;
  status("Level moved");
}

function startLevelResize(e, id, corner) {
  e.stopPropagation();
  const l = getLevel(id);
  if (!l) return;
  selected.clear();
  selectedEdge = null;
  selectedLevel = id;
  saveState();
  levelResize = { id, corner, start: pt(e), l: { ...l } };
  document.addEventListener("pointermove", moveLevelResize);
  document.addEventListener("pointerup", endLevelResize, { once: true });
}

function moveLevelResize(e) {
  if (!levelResize) return;
  const r = levelResize, p = pt(e), l = getLevel(r.id), o = r.l;
  if (!l) return;
  const dx = p.x - r.start.x, dy = p.y - r.start.y;
  if (r.corner === 1) l.w = Math.max(120, snap(o.w + dx));
  else if (r.corner === 2) l.h = Math.max(70, snap(o.h + dy));
  else if (r.corner === 3) { l.x = snap(o.x + dx); l.w = Math.max(120, snap(o.w - dx)); }
  else { l.y = snap(o.y + dy); l.h = Math.max(70, snap(o.h - dy)); }
  render();
}

function endLevelResize() {
  document.removeEventListener("pointermove", moveLevelResize);
  levelResize = null;
  status("Level resized");
}

/* ---------------- create / connect ---------------- */
function add(type, x, y, extra = {}) {
  saveState();
  const d = D[type] || D.process;
  const node = {
    id: "n" + counter++,
    type,
    x: snap(x - d[1] / 2),
    y: snap(y - d[2] / 2),
    w: d[1],
    h: d[2],
    text: extra.text != null ? extra.text : d[0],
    fill: "#ffffff",
    border: "#334155",
    font: 16,
    line: 2,
    ...extra
  };
  // Image nodes: use natural size if provided
  if (type === "image" && extra.naturalW && extra.naturalH) {
    const maxW = 280, maxH = 200;
    let w = extra.naturalW, h = extra.naturalH;
    if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
    if (h > maxH) { w = Math.round(w * maxH / h); h = maxH; }
    node.w = snap(w); node.h = snap(h);
    node.x = snap(x - node.w / 2);
    node.y = snap(y - node.h / 2);
  }
  nodes.push(node);
  selected = new Set([node.id]);
  selectedEdge = null;
  selectedLevel = null;
  render();
  status(type === "image" ? "Image added" : "Shape added");
}
function connectTo(a, b) {
  if (a === b || edges.some(e => e.a === a && e.b === b)) return;
  saveState();
  edges.push({ a, b });
  render();
  status("Connected");
}

/* ---------------- insert image ---------------- */
let pendingImagePos = null; // {x,y} when dropping image from palette
function insertImage(atX, atY) {
  pendingImagePos = (atX != null && atY != null) ? { x: atX, y: atY } : null;
  $("imageFile").click();
}
$("imageFile").onchange = e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !f.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const src = reader.result;
    const img = new Image();
    img.onload = () => {
      const pos = pendingImagePos || {
        x: (wrap.scrollLeft + wrap.clientWidth / 2) / zoom,
        y: (wrap.scrollTop + wrap.clientHeight / 2) / zoom
      };
      pendingImagePos = null;
      add("image", pos.x, pos.y, {
        text: f.name.replace(/\.[^.]+$/, "") || "Image",
        src,
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight
      });
    };
    img.src = src;
  };
  reader.readAsDataURL(f);
};

/* ---------------- render ---------------- */
function render() {
  backgroundLayer.innerHTML = "";
  layer.innerHTML = "";
  svg.querySelectorAll(".edge,.temp").forEach(x => x.remove());

  levels.forEach(l => {
    const e = document.createElement("div");
    e.className = `level-bg ${selectedLevel === l.id ? "selected" : ""}`;
    e.dataset.id = l.id;
    e.style.cssText = `left:${l.x}px;top:${l.y}px;width:${l.w}px;height:${l.h}px;background:${l.fill};border-color:${l.border};opacity:${Math.max(0, Math.min(100, l.opacity ?? 82)) / 100}`;
    const t = document.createElement("div");
    t.className = "level-title";
    t.textContent = l.text || "";
    t.onclick = ev => { ev.stopPropagation(); selected.clear(); selectedEdge = null; selectedLevel = l.id; render(); };
    e.append(t);

    ["h-t","h-r","h-b","h-l"].forEach((s, i) => {
      const h = document.createElement("span");
      h.className = `level-handle ${s}`;
      h.onpointerdown = ev => startLevelResize(ev, l.id, i);
      e.append(h);
    });
    e.onpointerdown = ev => {
      if (ev.target.classList.contains("level-handle") || ev.target.closest(".level-title")) return;
      startLevelDrag(ev, l.id);
    };
    backgroundLayer.append(e);
  });

  nodes.forEach(n => {
    const e = document.createElement("div");
    e.className = `node ${n.type} ${selected.has(n.id) ? "selected" : ""}`;
    e.dataset.id = n.id;
    e.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--fill:${n.fill};background:${n.fill};border-color:${n.border};border-width:${n.line}px;font-size:${n.font}px`;

    if (n.type === "image" && n.src) {
      const img = document.createElement("img");
      img.className = "node-img";
      img.src = n.src;
      img.draggable = false;
      img.alt = n.text || "Image";
      e.append(img);
      // Optional caption under image (small, editable)
      if (n.text) {
        const t = document.createElement("div");
        t.className = "txt img-caption";
        t.textContent = n.text;
        t.onclick = x => { x.stopPropagation(); startInlineEdit(n, t); };
        e.append(t);
      }
    } else {
      const t = document.createElement("div");
      t.className = "txt";
      t.textContent = n.text;
      t.onclick = x => { x.stopPropagation(); startInlineEdit(n, t); };
      e.append(t);
    }

    ["t", "r", "b", "l"].forEach(s => {
      const p = document.createElement("span");
      p.className = `port ${s}`;
      p.onpointerdown = x => startConnect(x, n.id, s);
      e.append(p);
    });
    ["h-t", "h-r", "h-b", "h-l"].forEach((s, i) => {
      const h = document.createElement("span");
      h.className = `handle ${s}`;
      h.onpointerdown = x => startResize(x, n.id, i);
      e.append(h);
    });

    e.onpointerdown = x => startDrag(x, n.id);
    layer.append(e);
  });

  buildOrgPaths().forEach(seg => {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.classList.add("edge");
    if (selectedEdge !== null && seg.edgeIndexes.includes(selectedEdge)) p.classList.add("selected");
    p.setAttribute("d", seg.d);
    p.style.pointerEvents = "stroke";
    p.onclick = ev => {
      ev.stopPropagation();
      selectedEdge = seg.edgeIndexes[0];
      selected.clear();
      render();
    };
    svg.append(p);
  });

  empty.style.display = nodes.length ? "none" : "block";
  props();
  renderMinimap();
}

/* ---------------- drag ---------------- */
function startDrag(e, id) {
  // Don't start drag when clicking text (so inline rename can work) or ports/handles
  if (e.target.classList.contains("port") || e.target.classList.contains("handle") || e.target.closest(".txt")) return;
  if (e.button !== 0) return;

  // Keep an existing multi-selection when dragging one of its selected shapes.
  // This makes Ctrl+A -> drag any selected shape move everything together.
  if (e.shiftKey) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
  } else if (!selected.has(id)) {
    selected = new Set([id]);
  }

  selectedEdge = null;
  selectedLevel = null;
  render();
  saveState();

  const p = pt(e);
  drag = { x: p.x, y: p.y, ids: [...selected] };
  document.addEventListener("pointermove", moveDrag);
  document.addEventListener("pointerup", endDrag, { once: true });
}
function moveDrag(e) {
  if (!drag) return;
  const p = pt(e), dx = snap(p.x - drag.x), dy = snap(p.y - drag.y);
  if (dx === 0 && dy === 0) return;
  drag.ids.forEach(id => { const n = get(id); n.x += dx; n.y += dy; });
  drag.x = p.x; drag.y = p.y;
  render();
  status("Moving");
}
function endDrag() { document.removeEventListener("pointermove", moveDrag); drag = null; status("Moved"); }

/* ---------------- resize ---------------- */
function startResize(e, id, corner) {
  e.stopPropagation();
  if (!selected.has(id)) selected = new Set([id]);
  saveState();
  resize = { id, corner, start: pt(e), n: { ...get(id) } };
  document.addEventListener("pointermove", moveResize);
  document.addEventListener("pointerup", endResize, { once: true });
}
function moveResize(e) {
  const r = resize, p = pt(e), n = get(r.id), dx = p.x - r.start.x, dy = p.y - r.start.y, o = r.n;
  if (r.corner === 1) { n.w = Math.max(40, snap(o.w + dx)); }
  else if (r.corner === 2) { n.h = Math.max(30, snap(o.h + dy)); }
  else if (r.corner === 3) { n.x = snap(o.x + dx); n.w = Math.max(40, snap(o.w - dx)); }
  else { n.y = snap(o.y + dy); n.h = Math.max(30, snap(o.h - dy)); }
  render();
}
function endResize() { document.removeEventListener("pointermove", moveResize); resize = null; status("Resized"); }

/* ---------------- connect ---------------- */
function startConnect(e, id, s) {
  e.stopPropagation();
  const n = get(id);
  connect = { id, start: side(n, s) };
  const mv = x => drawTemp(x);
  const up = x => {
    document.removeEventListener("pointermove", mv);
    document.removeEventListener("pointerup", up);
    const target = x.target.closest(".node");
    if (target) connectTo(id, target.dataset.id); else render();
    connect = null;
  };
  document.addEventListener("pointermove", mv);
  document.addEventListener("pointerup", up);
}
function drawTemp(e) {
  if (!connect) return;
  svg.querySelectorAll(".temp").forEach(x => x.remove());
  const p = pt(e);
  const l = document.createElementNS("http://www.w3.org/2000/svg", "path");
  l.classList.add("temp");
  l.setAttribute("d", `M ${connect.start.x} ${connect.start.y} L ${p.x} ${p.y}`);
  svg.append(l);
}

/* ---------------- text edit (click-to-edit, inline) ---------------- */
function startInlineEdit(n, textEl) {
  if (textEl.classList.contains("editing")) return;
  selected = new Set([n.id]); selectedEdge = null;
  textEl.classList.add("editing");
  textEl.contentEditable = "true";
  textEl.spellcheck = false;
  // Show multi-line text while editing
  textEl.textContent = n.text || "";

  textEl.focus();
  const range = document.createRange();
  range.selectNodeContents(textEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = commit => {
    textEl.contentEditable = "false";
    textEl.classList.remove("editing");
    textEl.removeEventListener("blur", onBlur);
    textEl.removeEventListener("keydown", onKey);
    textEl.removeEventListener("pointerdown", stop);
    if (commit) {
      // innerText keeps line breaks from Alt+Enter / Shift+Enter
      const val = (textEl.innerText || textEl.textContent || "").replace(/\r\n/g, "\n").trimEnd();
      if (val !== n.text) { saveState(); n.text = val; }
    }
    render();
  };
  const onBlur = () => finish(true);
  const onKey = e => {
    e.stopPropagation();
    // Enter alone = save; Alt+Enter or Shift+Enter = new line (text at bottom)
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      textEl.blur();
    } else if (e.key === "Enter" && (e.shiftKey || e.altKey)) {
      e.preventDefault();
      document.execCommand("insertLineBreak"); // inserts a line break
    } else if (e.key === "Escape") {
      e.preventDefault();
      textEl.textContent = n.text;
      textEl.blur();
    }
  };
  const stop = e => e.stopPropagation();
  textEl.addEventListener("blur", onBlur);
  textEl.addEventListener("keydown", onKey);
  textEl.addEventListener("pointerdown", stop);
}

/* ---------------- properties panel ---------------- */
function props() {
  const n = selected.size === 1 ? get([...selected][0]) : null;
  const l = selectedLevel ? getLevel(selectedLevel) : null;
  const active = n || l;

  $("props").classList.toggle("disabled", !active);
  $("footerHint").textContent = n ? (selected.size === 1 ? "1 shape selected" : `${selected.size} shapes selected`)
    : l ? "Level background selected"
    : selected.size > 1 ? `${selected.size} shapes selected` : "Nothing selected";
  if (!active) return;

  $("pText").value = active.text || "";
  $("pW").value = active.w;
  $("pH").value = active.h;
  $("pX").value = active.x;
  $("pY").value = active.y;
  $("pFill").value = active.fill;
  $("pBorder").value = active.border;

  const isLevel = !!l && !n;
  $("pOpacity").value = isLevel ? (active.opacity ?? 82) : 100;
  $("pOpacity").disabled = !isLevel;
  $("pFont").disabled = isLevel;
  $("pLine").disabled = isLevel;
  $("pFont").value = isLevel ? "" : active.font;
  $("pLine").value = isLevel ? "" : active.line;
}

function change(k, v) {
  const n = selected.size === 1 ? get([...selected][0]) : null;
  const l = selectedLevel ? getLevel(selectedLevel) : null;
  const target = n || l;
  if (!target) return;
  saveState();
  target[k] = v;
  render();
  status("Updated");
}

$("pText").onchange = e => change("text", e.target.value);
$("pW").onchange = e => change("w", Math.max(40, +e.target.value));
$("pH").onchange = e => change("h", Math.max(30, +e.target.value));
$("pX").onchange = e => change("x", +e.target.value);
$("pY").onchange = e => change("y", +e.target.value);
$("pFill").oninput = e => change("fill", e.target.value);
$("pBorder").oninput = e => change("border", e.target.value);
$("pOpacity").oninput = e => {
  const l = selectedLevel ? getLevel(selectedLevel) : null;
  if (!l) return;
  l.opacity = Math.max(0, Math.min(100, +e.target.value));
  render();
};
$("pFont").onchange = e => change("font", +e.target.value);
$("pLine").onchange = e => change("line", +e.target.value);

/* ---------------- drag shapes from palette ---------------- */
document.querySelectorAll(".item").forEach(i => i.ondragstart = e => e.dataTransfer.setData("type", i.dataset.type));
wrap.ondragover = e => e.preventDefault();
wrap.ondrop = e => {
  e.preventDefault();
  const type = e.dataTransfer.getData("type");
  if (!type) return;
  const p = pt(e);
  if (type === "image") insertImage(p.x, p.y);
  else if (type === "level") addLevel(p.x, p.y);
  else add(type, p.x, p.y);
};

/* ---------------- pan / empty-space click ---------------- */
wrap.onpointerdown = e => {
  if (e.target !== wrap && e.target !== canvas) return;
  if (e.button === 1 || e.shiftKey) {
    pan = { x: e.clientX, y: e.clientY, sx: wrap.scrollLeft, sy: wrap.scrollTop };
    document.addEventListener("pointermove", movePan);
    document.addEventListener("pointerup", endPan, { once: true });
  } else {
    selected.clear(); selectedEdge = null; selectedLevel = null; render();
  }
};
function movePan(e) { wrap.scrollLeft = pan.sx - (e.clientX - pan.x); wrap.scrollTop = pan.sy - (e.clientY - pan.y); }
function endPan() { document.removeEventListener("pointermove", movePan); pan = null; }

/* ---------------- zoom ---------------- */
function setZoom(z) {
  zoom = Math.min(2.5, Math.max(.25, z));
  canvas.style.transform = `scale(${zoom})`;
  $("zoom").textContent = Math.round(zoom * 100) + "%";
  render();
}
function fitToScreen() {
  if (!nodes.length) return setZoom(1);
  const minX = Math.min(...nodes.map(n => n.x)), maxX = Math.max(...nodes.map(n => n.x + n.w));
  const minY = Math.min(...nodes.map(n => n.y)), maxY = Math.max(...nodes.map(n => n.y + n.h));
  const r = wrap.getBoundingClientRect();
  setZoom(Math.min(1.4, Math.max(.35, Math.min((r.width - 80) / (maxX - minX + 100), (r.height - 80) / (maxY - minY + 100)))));
  wrap.scrollLeft = Math.max(0, minX * zoom - 40);
  wrap.scrollTop = Math.max(0, minY * zoom - 40);
}

/* ---------------- minimap ---------------- */
function renderMinimap() {
  const box = $("miniNodes");
  box.innerHTML = "";
  if (!nodes.length) { $("miniView").style.display = "none"; return; }
  const minX = Math.min(...nodes.map(n => n.x), ...levels.map(l => l.x), wrap.scrollLeft / zoom);
  const maxX = Math.max(...nodes.map(n => n.x + n.w), ...levels.map(l => l.x + l.w), (wrap.scrollLeft + wrap.clientWidth) / zoom);
  const minY = Math.min(...nodes.map(n => n.y), ...levels.map(l => l.y), wrap.scrollTop / zoom);
  const maxY = Math.max(...nodes.map(n => n.y + n.h), ...levels.map(l => l.y + l.h), (wrap.scrollTop + wrap.clientHeight) / zoom);
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const mw = 160, mh = 110;
  const scale = Math.min(mw / spanX, mh / spanY);

  levels.forEach(l => {
    const s = document.createElement("span");
    s.className = "mini-level";
    s.style.left = ((l.x - minX) * scale) + "px";
    s.style.top = ((l.y - minY) * scale) + "px";
    s.style.width = Math.max(2, l.w * scale) + "px";
    s.style.height = Math.max(2, l.h * scale) + "px";
    s.style.background = l.fill;
    s.style.opacity = Math.max(0, Math.min(100, l.opacity ?? 82)) / 100;
    box.append(s);
  });

  nodes.forEach(n => {
    const s = document.createElement("span");
    s.style.left = ((n.x - minX) * scale) + "px";
    s.style.top = ((n.y - minY) * scale) + "px";
    s.style.width = Math.max(2, n.w * scale) + "px";
    s.style.height = Math.max(2, n.h * scale) + "px";
    box.append(s);
  });

  const mv = $("miniView");
  mv.style.display = "block";
  mv.style.left = ((wrap.scrollLeft / zoom - minX) * scale) + "px";
  mv.style.top = ((wrap.scrollTop / zoom - minY) * scale) + "px";
  mv.style.width = Math.max(4, (wrap.clientWidth / zoom) * scale) + "px";
  mv.style.height = Math.max(4, (wrap.clientHeight / zoom) * scale) + "px";

  $("minimap")._map = { minX, minY, scale };
}
$("minimap").onclick = e => {
  const m = $("minimap")._map;
  if (!m) return;
  const r = $("minimap").getBoundingClientRect();
  const localX = e.clientX - r.left, localY = e.clientY - r.top;
  const worldX = localX / m.scale + m.minX, worldY = localY / m.scale + m.minY;
  wrap.scrollLeft = worldX * zoom - wrap.clientWidth / 2;
  wrap.scrollTop = worldY * zoom - wrap.clientHeight / 2;
  renderMinimap();
};

/* ---------------- clipboard: cut / copy / paste / duplicate ---------------- */
function copySelection() {
  if (!selected.size) return;
  const ids = [...selected];
  const copiedNodes = nodes.filter(n => ids.includes(n.id)).map(n => ({ ...n }));
  const copiedEdges = edges.filter(e => ids.includes(e.a) && ids.includes(e.b)).map(e => ({ ...e }));
  clipboard = { nodes: copiedNodes, edges: copiedEdges };
  status("Copied");
}
function pasteClipboard() {
  if (!clipboard || !clipboard.nodes.length) return;
  saveState();
  const idMap = {};
  const newNodes = clipboard.nodes.map(n => {
    const id = "n" + counter++;
    idMap[n.id] = id;
    return { ...n, id, x: n.x + 24, y: n.y + 24 };
  });
  const newEdges = clipboard.edges.map(e => ({ a: idMap[e.a], b: idMap[e.b] }));
  nodes.push(...newNodes);
  edges.push(...newEdges);
  selected = new Set(newNodes.map(n => n.id));
  clipboard = { nodes: newNodes.map(n => ({ ...n })), edges: newEdges.map(e => ({ ...e })) };
  render();
  status("Pasted");
}
function cutSelection() { copySelection(); deleteSelection(); status("Cut"); }
function duplicateSelection() {
  if (selectedLevel) {
    const src = getLevel(selectedLevel);
    if (!src) return;
    saveState();
    const copy = { ...src, id: nextLevelId(), x: src.x + 20, y: src.y + 20, text: `${src.text || "Level"} copy` };
    levels.push(copy);
    selectedLevel = copy.id;
    render();
    status("Level duplicated");
    return;
  }
  if (!selected.size) return;
  saveState();
  const ns = [...selected].map(id => { const src = get(id); return { ...src, id: "n" + counter++, x: src.x + 20, y: src.y + 20 }; });
  nodes.push(...ns);
  selected = new Set(ns.map(n => n.id));
  render();
  status("Duplicated");
}
function deleteSelection() {
  if (selectedLevel) {
    const l = getLevel(selectedLevel);
    if (!l) return;
    saveState();
    levels = levels.filter(x => x.id !== selectedLevel);
    selectedLevel = null;
    render();
    status("Level deleted");
    return;
  }
  if (selectedEdge !== null) {
    saveState();
    edges.splice(selectedEdge, 1);
    selectedEdge = null;
    render();
    status("Edge deleted");
    return;
  }
  if (!selected.size) return;
  saveState();
  const ids = [...selected];
  nodes = nodes.filter(n => !ids.includes(n.id));
  edges = edges.filter(e => !ids.includes(e.a) && !ids.includes(e.b));
  selected.clear();
  render();
  status("Deleted");
}
function selectAll() { selected = new Set(nodes.map(n => n.id)); selectedEdge = null; selectedLevel = null; render(); status("Selected all"); }

/* ---------------- z-order ---------------- */
function bringToFront() {
  if (selectedLevel) return status("Level is already behind shapes");
  if (!selected.size) return;
  saveState();
  const ids = [...selected];
  const a = nodes.filter(n => ids.includes(n.id)), b = nodes.filter(n => !ids.includes(n.id));
  nodes = [...b, ...a]; render(); status("Brought to front");
}
function sendToBack() {
  if (selectedLevel) return;
  if (!selected.size) return;
  saveState();
  const ids = [...selected];
  const a = nodes.filter(n => ids.includes(n.id)), b = nodes.filter(n => !ids.includes(n.id));
  nodes = [...a, ...b]; render(); status("Sent to back");
}
function bringForward() {
  if (selected.size !== 1) return bringToFront();
  saveState();
  const id = [...selected][0], i = nodes.findIndex(n => n.id === id);
  if (i < nodes.length - 1) { [nodes[i], nodes[i + 1]] = [nodes[i + 1], nodes[i]]; }
  render(); status("Brought forward");
}
function sendBackward() {
  if (selected.size !== 1) return sendToBack();
  saveState();
  const id = [...selected][0], i = nodes.findIndex(n => n.id === id);
  if (i > 0) { [nodes[i], nodes[i - 1]] = [nodes[i - 1], nodes[i]]; }
  render(); status("Sent backward");
}

/* ---------------- align / distribute ---------------- */
function selNodes() { return nodes.filter(n => selected.has(n.id)); }
function alignLeft() { const s = selNodes(); if (s.length < 2) return; saveState(); const minX = Math.min(...s.map(n => n.x)); s.forEach(n => n.x = minX); render(); status("Aligned left"); }
function alignRight() { const s = selNodes(); if (s.length < 2) return; saveState(); const maxR = Math.max(...s.map(n => n.x + n.w)); s.forEach(n => n.x = maxR - n.w); render(); status("Aligned right"); }
function alignCenterH() { const s = selNodes(); if (s.length < 2) return; saveState(); const minX = Math.min(...s.map(n => n.x)), maxX = Math.max(...s.map(n => n.x + n.w)), c = (minX + maxX) / 2; s.forEach(n => n.x = c - n.w / 2); render(); status("Aligned center"); }
function alignTop() { const s = selNodes(); if (s.length < 2) return; saveState(); const minY = Math.min(...s.map(n => n.y)); s.forEach(n => n.y = minY); render(); status("Aligned top"); }
function alignBottom() { const s = selNodes(); if (s.length < 2) return; saveState(); const maxB = Math.max(...s.map(n => n.y + n.h)); s.forEach(n => n.y = maxB - n.h); render(); status("Aligned bottom"); }
function alignMiddle() { const s = selNodes(); if (s.length < 2) return; saveState(); const minY = Math.min(...s.map(n => n.y)), maxY = Math.max(...s.map(n => n.y + n.h)), c = (minY + maxY) / 2; s.forEach(n => n.y = c - n.h / 2); render(); status("Aligned middle"); }
function distributeH() {
  const s = selNodes(); if (s.length < 3) return status("Select 3+ shapes to distribute");
  saveState();
  s.sort((a, b) => a.x - b.x);
  const totalW = s.reduce((sum, n) => sum + n.w, 0);
  const span = (s.at(-1).x + s.at(-1).w) - s[0].x;
  const gap = (span - totalW) / (s.length - 1);
  let x = s[0].x;
  s.forEach(n => { n.x = snap(x); x += n.w + gap; });
  render(); status("Distributed horizontally");
}
function distributeV() {
  const s = selNodes(); if (s.length < 3) return status("Select 3+ shapes to distribute");
  saveState();
  s.sort((a, b) => a.y - b.y);
  const totalH = s.reduce((sum, n) => sum + n.h, 0);
  const span = (s.at(-1).y + s.at(-1).h) - s[0].y;
  const gap = (span - totalH) / (s.length - 1);
  let y = s[0].y;
  s.forEach(n => { n.y = snap(y); y += n.h + gap; });
  render(); status("Distributed vertically");
}

/* ---------------- file: new / open / save ---------------- */
function newDiagram() {
  if (nodes.length && !confirm("Start a new diagram? Unsaved changes will be lost.")) return;
  saveState();
  nodes = []; levels = []; edges = []; selected.clear(); selectedEdge = null; selectedLevel = null;
  render(); status("New diagram");
}
function openDiagram() { $("file").click(); }
$("file").onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      saveState();
      nodes = d.nodes || []; levels = d.levels || []; edges = d.edges || [];
      counter = nodes.reduce((m, n) => Math.max(m, +String(n.id).replace("n", "") || 0), 0) + 1;
      selected.clear(); selectedEdge = null;
      render(); fitToScreen();
      status("Diagram imported");
    } catch { alert("Couldn't import that file — is it a FlowChart Studio JSON export?"); }
  };
  reader.readAsText(f);
  e.target.value = "";
};
function saveLocal() { localStorage.setItem("flowchartV2", JSON.stringify({ nodes, levels, edges, zoom })); status("Saved locally"); }

/* ============================================================
   PDF import
   1) PDF exported by FlowChart Studio  -> full diagram restored (exact, editable)
   2) Any other PDF                      -> vector boxes become shapes, text goes
                                            inside them, touching lines become connections
   ============================================================ */
const PDF_TAG = "FCSTUDIO:";
const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
function importPdf() { $("pdfFile").click(); }

function rgbHex(c) {
  if (!c) return null;
  return "#" + [c[0], c[1], c[2]].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function uniqPts(p) {
  const out = p.slice();
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1.5) out.pop();
  return out;
}

/* Walk the page drawing operators -> closed shapes + line segments (viewport coordinates) */
async function extractVectors(page, vp) {
  const OPS = pdfjsLib.OPS, U = pdfjsLib.Util;
  const ol = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0], fillC = [0, 0, 0], strokeC = [0, 0, 0];
  const stack = [], shapes = [], segs = [];
  let subs = [];

  const tp = (x, y) => {
    const px = ctm[0] * x + ctm[2] * y + ctm[4], py = ctm[1] * x + ctm[3] * y + ctm[5];
    return vp.convertToViewportPoint(px, py);
  };
  const newSub = p => { const s = { pts: [p], closed: false, lines: 0, curves: 0, rect: false }; subs.push(s); return s; };
  const last = () => subs[subs.length - 1];

  const paint = (fill, stroke, close) => {
    subs.forEach(s => {
      if (close) s.closed = true;
      const p = s.pts;
      if (p.length < 2) return;
      const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      const closed = s.closed || s.rect ||
        (p.length > 3 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1.5);

      if (closed) {
        // thin filled bar = a drawn line
        if (Math.min(w, h) <= 3 && Math.max(w, h) >= 6) {
          if (w >= h) segs.push([x, y + h / 2, x + w, y + h / 2]);
          else segs.push([x + w / 2, y, x + w / 2, y + h]);
          return;
        }
        // real shape (ignore arrowheads / tiny bits / full-page background)
        if (w >= 24 && h >= 16 && !(w > vp.width * 0.92 && h > vp.height * 0.92)) {
          shapes.push({
            x, y, w, h, pts: uniqPts(p), lines: s.lines, curves: s.curves, rect: s.rect,
            fill: fill ? rgbHex(fillC) : null, stroke: stroke ? rgbHex(strokeC) : null
          });
        }
        return;
      }
      if (stroke) {
        for (let i = 1; i < p.length; i++) {
          const a = p[i - 1], b = p[i];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 1) segs.push([a[0], a[1], b[0], b[1]]);
        }
      }
    });
    subs = [];
  };

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ctm: ctm.slice(), fillC, strokeC }); break;
      case OPS.restore: if (stack.length) ({ ctm, fillC, strokeC } = stack.pop()); break;
      case OPS.transform: ctm = U.transform(ctm, a); break;
      case OPS.setFillRGBColor: fillC = a; break;
      case OPS.setStrokeRGBColor: strokeC = a; break;
      case OPS.constructPath: {
        const ops = a[0], c = a[1];
        let k = 0;
        ops.forEach(op => {
          if (op === OPS.moveTo) { newSub(tp(c[k], c[k + 1])); k += 2; }
          else if (op === OPS.lineTo) {
            const q = tp(c[k], c[k + 1]); k += 2;
            const s = last(); if (s) { s.pts.push(q); s.lines++; } else newSub(q);
          }
          else if (op === OPS.curveTo) {
            const q = tp(c[k + 4], c[k + 5]); k += 6;
            const s = last(); if (s) { s.pts.push(q); s.curves++; }
          }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
            const q = tp(c[k + 2], c[k + 3]); k += 4;
            const s = last(); if (s) { s.pts.push(q); s.curves++; }
          }
          else if (op === OPS.closePath) { const s = last(); if (s) s.closed = true; }
          else if (op === OPS.rectangle) {
            const x = c[k], y = c[k + 1], w = c[k + 2], h = c[k + 3]; k += 4;
            const s = newSub(tp(x, y));
            s.pts.push(tp(x + w, y), tp(x + w, y + h), tp(x, y + h));
            s.rect = true; s.closed = true;
          }
        });
        break;
      }
      case OPS.stroke: paint(false, true, false); break;
      case OPS.closeStroke: paint(false, true, true); break;
      case OPS.fill: case OPS.eoFill: paint(true, false, true); break;
      case OPS.fillStroke: case OPS.eoFillStroke: paint(true, true, true); break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: paint(true, true, true); break;
      case OPS.endPath: subs = []; break;
    }
  }
  return { shapes, segs };
}

function dedupeShapes(list) {
  const out = [];
  list.forEach(s => {
    const d = out.find(o => Math.abs(o.x - s.x) < 2 && Math.abs(o.y - s.y) < 2 && Math.abs(o.w - s.w) < 2 && Math.abs(o.h - s.h) < 2);
    if (d) { d.fill = d.fill || s.fill; d.stroke = d.stroke || s.stroke; }
    else out.push(s);
  });
  return out;
}

function classifyShape(s) {
  const { x, y, w, h, pts } = s;
  if (s.curves) {
    if (!s.lines) return (w / h < 1.25 && h / w < 1.25) ? "circle" : "start";
    return "start";
  }
  if (s.rect) return "process";
  const tx = w * 0.08, ty = h * 0.08;
  if (pts.length === 4) {
    const mids = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
    if (mids.every(m => pts.some(p => Math.abs(p[0] - m[0]) <= tx && Math.abs(p[1] - m[1]) <= ty))) return "decision";
    const top = pts.filter(p => Math.abs(p[1] - y) <= ty), bot = pts.filter(p => Math.abs(p[1] - (y + h)) <= ty);
    if (top.length === 2 && bot.length === 2) {
      const straight = pts.every(p => Math.abs(p[0] - x) <= tx || Math.abs(p[0] - (x + w)) <= tx);
      return straight ? "process" : "data";
    }
    return "process";
  }
  if (pts.length === 6) return "hexagon";
  return "process";
}

async function extractText(page, vp) {
  const tc = await page.getTextContent();
  return tc.items.filter(i => i.str && i.str.trim()).map(i => {
    const q = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
    const h = Math.abs(i.height) || Math.abs(i.transform[3]) || 10;
    return { s: i.str, x: q[0], y: q[1], w: i.width, h };
  });
}

/* text items -> lines (same baseline) */
function groupLines(items) {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  sorted.forEach(it => {
    const ln = lines.find(l => Math.abs(l.y - it.y) < Math.max(it.h, l.h) * 0.5);
    if (ln) { ln.parts.push(it); ln.h = Math.max(ln.h, it.h); }
    else lines.push({ y: it.y, h: it.h, parts: [it] });
  });
  lines.forEach(l => {
    l.parts.sort((a, b) => a.x - b.x);
    l.text = l.parts.map(x => x.s).join(" ").replace(/\s+/g, " ").trim();
    l.x1 = l.parts[0].x;
    l.x2 = Math.max(...l.parts.map(x => x.x + x.w));
  });
  return lines.sort((a, b) => a.y - b.y);
}
/* lines -> paragraph-like blocks */
function groupBlocks(lines) {
  const blocks = [];
  lines.forEach(l => {
    const b = blocks.find(b => {
      const lastL = b.lines[b.lines.length - 1];
      return (l.y - lastL.y) < Math.max(l.h, lastL.h) * 1.8 && l.x1 < b.x2 + 20 && l.x2 > b.x1 - 20;
    });
    if (b) { b.lines.push(l); b.x1 = Math.min(b.x1, l.x1); b.x2 = Math.max(b.x2, l.x2); b.y2 = l.y; b.h = Math.max(b.h, l.h); }
    else blocks.push({ lines: [l], x1: l.x1, x2: l.x2, y1: l.y - l.h, y2: l.y, h: l.h });
  });
  return blocks;
}

/* touching line segments form a "net"; the shapes a net touches get connected */
function buildEdgesFromSegments(boxes, segs) {
  const out = [];
  if (!segs.length || boxes.length < 2) return out;
  segs = segs.slice(0, 4000);
  const tol = 3, boxTol = 5, n = segs.length, par = segs.map((_, i) => i);
  const find = i => par[i] === i ? i : (par[i] = find(par[i]));
  const dseg = (px, py, s) => {
    const x1 = s[0], y1 = s[1], dx = s[2] - x1, dy = s[3] - y1, L = dx * dx + dy * dy;
    let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = segs[i], b = segs[j];
      if (dseg(a[0], a[1], b) <= tol || dseg(a[2], a[3], b) <= tol || dseg(b[0], b[1], a) <= tol || dseg(b[2], b[3], a) <= tol) {
        par[find(i)] = find(j);
      }
    }
  }
  const comps = new Map();
  segs.forEach((s, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(s); });

  const inBox = (px, py, b) => px >= b.x - boxTol && px <= b.x + b.w + boxTol && py >= b.y - boxTol && py <= b.y + b.h + boxTol;
  const seen = new Set();
  const addEdge = (a, b) => { const k = a + ">" + b; if (a !== b && !seen.has(k)) { seen.add(k); out.push({ a, b }); } };

  comps.forEach(comp => {
    const touched = boxes.filter(b => comp.some(s => inBox(s[0], s[1], b) || inBox(s[2], s[3], b)));
    if (touched.length < 2) return;
    touched.sort((p, q) => (p.y + p.h / 2) - (q.y + q.h / 2) || p.x - q.x);
    const topY = touched[0].y + touched[0].h / 2;
    const tops = touched.filter(t => Math.abs(t.y + t.h / 2 - topY) < 12);
    const rest = touched.filter(t => !tops.includes(t));
    if (rest.length) tops.forEach(a => rest.forEach(b => addEdge(a.id, b.id)));
    else {
      tops.sort((p, q) => p.x - q.x);
      for (let k = 1; k < tops.length; k++) addEdge(tops[k - 1].id, tops[k].id);
    }
  });
  return out;
}

$("pdfFile").onchange = async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (!window.pdfjsLib) return alert("PDF import needs an internet connection (pdf.js loads from a CDN).");
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  status("Reading PDF…");
  try {
    const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;

    // 1) PDF made by FlowChart Studio -> exact editable restore
    const meta = await pdf.getMetadata().catch(() => null);
    const kw = (meta && meta.info && meta.info.Keywords) || "";
    if (kw.startsWith(PDF_TAG)) {
      const d = JSON.parse(decodeURIComponent(escape(atob(kw.slice(PDF_TAG.length)))));
      saveState();
      nodes = d.nodes || []; levels = d.levels || []; edges = d.edges || [];
      counter = nodes.reduce((m, n) => Math.max(m, +String(n.id).replace("n", "") || 0), 0) + 1;
      selected.clear(); selectedEdge = null; selectedLevel = null;
      render(); fitToScreen();
      return status("PDF restored as an editable diagram");
    }

    // 2) Any other PDF -> detect shapes, text and connections
    const withImage = confirm("Also place each PDF page as a background image (for tracing)?\n\nOK = yes, Cancel = editable shapes only");
    saveState();
    const X0 = 40;
    let yOff = 40, addedNodes = [], addedLevels = [], addedEdges = [], rasterAsk = null;

    for (let p = 1; p <= pdf.numPages; p++) {
      status(`Reading PDF page ${p}/${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });

      if (withImage) {
        const rv = page.getViewport({ scale: 1.5 });
        const c = document.createElement("canvas");
        c.width = rv.width; c.height = rv.height;
        await page.render({ canvasContext: c.getContext("2d"), viewport: rv }).promise;
        addedNodes.push({
          id: "n" + counter++, type: "image", x: snap(X0), y: snap(yOff),
          w: snap(vp.width), h: snap(vp.height), text: "",
          src: c.toDataURL("image/jpeg", 0.85),
          fill: "#ffffff", border: "#cbd5e1", font: 12, line: 1
        });
      }

      const items = await extractText(page, vp);
      let vec = { shapes: [], segs: [] };
      try { vec = await extractVectors(page, vp); } catch (err) { console.warn("Vector scan failed", err); }
      const all = dedupeShapes(vec.shapes);

      // scanned page (no text, no vector shapes) -> OCR + shape detection on a rendered image
      if (!items.length && !all.length) {
        if (rasterAsk === null) rasterAsk = confirm("This PDF page looks like a scan (no text or shapes inside).\n\nConvert it with OCR + shape detection? (needs internet)");
        if (rasterAsk) {
          const sc = 1500 / Math.max(vp.width, vp.height), rv = page.getViewport({ scale: sc });
          const c = document.createElement("canvas");
          c.width = Math.round(rv.width); c.height = Math.round(rv.height);
          const g = c.getContext("2d");
          g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: g, viewport: rv }).promise;
          const big = document.createElement("canvas"), rb = page.getViewport({ scale: 3000 / Math.max(vp.width, vp.height) });
          big.width = Math.round(rb.width); big.height = Math.round(rb.height);
          const gb = big.getContext("2d");
          gb.fillStyle = "#ffffff"; gb.fillRect(0, 0, big.width, big.height);
          await page.render({ canvasContext: gb, viewport: rb }).promise;
          const r = await rasterToDiagram(c, X0, yOff, big);
          addedNodes.push(...r.nodes); addedLevels.push(...r.levels); addedEdges.push(...r.edges);
          yOff += c.height + 60;
          continue;
        }
      }

      // big rectangles that contain other shapes = level backgrounds
      const inside = (o, s) => o.x >= s.x - 2 && o.y >= s.y - 2 && o.x + o.w <= s.x + s.w + 2 && o.y + o.h <= s.y + s.h + 2;
      const lvlShapes = all.filter(s => {
        if (!(s.rect || (!s.curves && s.pts.length === 4))) return false;
        const kids = all.filter(o => o !== s && inside(o, s));
        return kids.length >= 2 || (kids.length === 1 && s.w * s.h > 3 * kids[0].w * kids[0].h);
      });
      const nodeShapes = all.filter(s => !lvlShapes.includes(s));
      nodeShapes.forEach(s => s.items = []);
      lvlShapes.forEach(s => s.items = []);

      // give every text item to the smallest shape that contains it
      const free = [];
      items.forEach(it => {
        const cx = it.x + it.w / 2, cy = it.y - it.h / 2;
        const hit = nodeShapes.filter(s => cx >= s.x - 2 && cx <= s.x + s.w + 2 && cy >= s.y - 2 && cy <= s.y + s.h + 2)
          .sort((a, b) => a.w * a.h - b.w * b.h)[0];
        if (hit) return hit.items.push(it);
        const lv = lvlShapes.filter(s => cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h)
          .sort((a, b) => a.w * a.h - b.w * b.h)[0];
        if (lv) return lv.items.push(it);
        free.push(it);
      });

      const boxes = [];

      lvlShapes.forEach((s, i) => {
        addedLevels.push({
          id: "L" + p + "_" + i, // renamed below
          x: snap(X0 + s.x), y: snap(yOff + s.y), w: Math.max(120, snap(s.w)), h: Math.max(70, snap(s.h)),
          text: groupLines(s.items).map(l => l.text).join(" "),
          fill: s.fill || LEVEL_COLORS[i % LEVEL_COLORS.length],
          border: s.stroke || "#64748b",
          opacity: 82
        });
      });

      nodeShapes.forEach(s => {
        const lines = groupLines(s.items);
        const avgH = s.items.length ? s.items.reduce((m, it) => m + it.h, 0) / s.items.length : 16;
        const node = {
          id: "n" + counter++, type: classifyShape(s),
          x: snap(X0 + s.x), y: snap(yOff + s.y),
          w: Math.max(40, snap(s.w)), h: Math.max(30, snap(s.h)),
          text: lines.map(l => l.text).join("\n"),
          fill: s.fill || "#ffffff", border: s.stroke || "#334155",
          font: Math.min(24, Math.max(10, Math.round(avgH * 0.9))), line: 2
        };
        addedNodes.push(node);
        boxes.push({ id: node.id, x: X0 + s.x, y: yOff + s.y, w: s.w, h: s.h });
      });

      // text outside any shape -> plain label boxes
      const noShapes = !nodeShapes.length;
      groupBlocks(groupLines(free)).forEach(b => {
        const w = Math.max(80, snap(b.x2 - b.x1 + 24)), h = Math.max(40, snap(b.y2 - b.y1 + 20));
        const node = {
          id: "n" + counter++, type: "process",
          x: snap(X0 + b.x1 - 12), y: snap(yOff + b.y1 - 10), w, h,
          text: b.lines.map(l => l.text).join("\n"),
          fill: "#ffffff", border: noShapes ? "#334155" : "#ffffff", line: noShapes ? 2 : 1,
          font: Math.min(24, Math.max(10, Math.round(b.h * 0.9)))
        };
        addedNodes.push(node);
      });

      // connections from lines that touch shapes
      const segs = vec.segs.map(s => [X0 + s[0], yOff + s[1], X0 + s[2], yOff + s[3]]);
      buildEdgesFromSegments(boxes, segs).forEach(ed => addedEdges.push(ed));

      yOff += vp.height + 60;
    }

    if (!addedNodes.length && !addedLevels.length) {
      return alert("Nothing could be read from this PDF. It may be a scanned image (no text or vector shapes).");
    }

    addedLevels.forEach(l => { l.id = nextLevelId(); levels.push(l); });
    nodes.push(...addedNodes);
    edges.push(...addedEdges.filter(ed => !edges.some(x => x.a === ed.a && x.b === ed.b)));
    selected.clear(); selectedEdge = null; selectedLevel = null;
    render(); fitToScreen();
    status(`PDF imported: ${addedNodes.length} shapes, ${addedEdges.length} connections, ${addedLevels.length} levels`);
  } catch (err) {
    console.error(err);
    alert("Couldn't read that PDF.");
  }
};

/* ============================================================
   Image (PNG / scanned PDF) -> editable diagram
   OCR (Tesseract.js, loaded on demand) + shape detection + connection detection
   ============================================================ */
const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
function loadScript(src) {
  return new Promise((res, rej) => {
    const el = document.createElement("script");
    el.src = src; el.onload = res; el.onerror = () => rej(new Error("Couldn't load " + src));
    document.head.append(el);
  });
}
async function ocrCanvas(cv) {
  if (!window.Tesseract) { status("Loading OCR engine…"); await loadScript(TESS_URL); }
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: m => { if (m.status === "recognizing text") status("OCR " + Math.round(m.progress * 100) + "%"); else if (m.status) status("OCR: " + m.status); }
  });
  let data;
  try {
    // 11 = sparse text: best for diagrams where text is scattered inside boxes
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    data = (await worker.recognize(cv)).data;
  } finally { try { await worker.terminate(); } catch (_) { /* ignore */ } }
  let words = data.words;
  if (!words || !words.length) {
    words = [];
    (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => (l.words || []).forEach(w => words.push(w)))));
  }
  return words
    .filter(w => w.text && w.text.trim() && (w.confidence == null || w.confidence > 30))
    .map(w => ({ s: w.text.trim(), x: w.bbox.x0, y: w.bbox.y1, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 }));
}

/* Pure pixel logic (no DOM): px = RGBA array of a W x H image, words = OCR words */
function rasterCore(W, H, px, words, X0, Y0) {
  const N = W * H, TOL = 60;
  const lab = new Int32Array(N), stack = new Int32Array(N), regs = new Map();
  let nl = 0, r0 = 0, g0 = 0, b0 = 0, L = 0, sp = 0;
  const push = k => {
    if (lab[k]) return;
    const p = k * 4;
    if (Math.abs(px[p] - r0) + Math.abs(px[p + 1] - g0) + Math.abs(px[p + 2] - b0) <= TOL) { lab[k] = L; stack[sp++] = k; }
  };
  // 1) split the picture into flat-colour regions
  for (let i = 0; i < N; i++) {
    if (lab[i]) continue;
    r0 = px[i * 4]; g0 = px[i * 4 + 1]; b0 = px[i * 4 + 2]; L = ++nl; lab[i] = L; sp = 0; stack[sp++] = i;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, border = false;
    while (sp) {
      const j = stack[--sp], x = j % W, y = (j / W) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x > 0) push(j - 1); if (x < W - 1) push(j + 1); if (y > 0) push(j - W); if (y < H - 1) push(j + W);
    }
    if (area >= 40) regs.set(L, { x0, y0, x1, y1, area, border, c: [r0, g0, b0] });
  }
  let bgL = 0, bgA = 0;
  regs.forEach((r, l) => { if (r.border && r.area > bgA) { bgA = r.area; bgL = l; } });
  const bgC = bgL ? regs.get(bgL).c : [255, 255, 255];
  const bgDist = p => Math.abs(px[p] - bgC[0]) + Math.abs(px[p + 1] - bgC[1]) + Math.abs(px[p + 2] - bgC[2]);

  // 2) enclosed, box-like regions = shapes
  const cands = [];
  regs.forEach((r, l) => {
    if (l === bgL || r.border) return;
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    if (w < 30 || h < 20 || (w > W * 0.92 && h > H * 0.92)) return;
    const ratio = r.area / (w * h);
    if (ratio < 0.42) return;
    const at = (fx, fy) => lab[Math.round(r.y0 + fy * (h - 1)) * W + Math.round(r.x0 + fx * (w - 1))] === l;
    const at2 = (fx, fy) => {
      const sx = fx < .5 ? 1 : -1, sy = fy < .5 ? 1 : -1;
      const x = Math.round(r.x0 + fx * (w - 1)), y = Math.round(r.y0 + fy * (h - 1));
      return lab[y * W + x] === l || lab[(y + sy) * W + x + sx] === l;
    };
    const tc = [at2(.02, .02), at2(.98, .02), at2(.98, .98), at2(.02, .98)];
    const t4 = tc.filter(Boolean).length;
    let type = "process";
    if (t4 === 4) type = "process";
    else if (t4 === 2 && ((tc[1] && tc[3]) || (tc[0] && tc[2]))) type = "data";
    else {
      const n4 = [at(.12, .12), at(.88, .12), at(.88, .88), at(.12, .88)].filter(Boolean).length;
      if (n4 === 4) type = "start";
      else if (n4 === 0) type = ratio < 0.65 ? "decision" : at(.25, .05) ? "hexagon" : (w / h < 1.25 && h / w < 1.25 ? "circle" : "start");
    }
    cands.push({ L: l, x: r.x0, y: r.y0, w, h, type, c: r.c, items: [] });
  });
  // drop regions that sit on exactly the same box as a bigger one
  cands.sort((a, b) => b.w * b.h - a.w * a.h);
  for (let i = cands.length - 1; i > 0; i--) {
    const s = cands[i];
    if (cands.slice(0, i).some(o => Math.abs(o.x - s.x) < 5 && Math.abs(o.y - s.y) < 5 && Math.abs(o.w - s.w) < 8 && Math.abs(o.h - s.h) < 8)) cands.splice(i, 1);
  }
  const inside = (o, s) => o.x >= s.x - 3 && o.y >= s.y - 3 && o.x + o.w <= s.x + s.w + 3 && o.y + o.h <= s.y + s.h + 3;
  const isLevel = s => {
    if (s.type !== "process" && s.type !== "start") return false;
    const kids = cands.filter(o => o !== s && inside(o, s));
    const biggest = kids.reduce((m, k) => Math.max(m, k.w * k.h), 0);
    return kids.length >= 2 || (kids.length === 1 && s.w * s.h > 3 * biggest);
  };
  const lvls = cands.filter(isLevel), nds = cands.filter(c => !lvls.includes(c));

  // 3) OCR words -> into the smallest shape that contains them
  const free = [];
  words.forEach(wd => {
    const cx = wd.x + wd.w / 2, cy = wd.y - wd.h / 2;
    const inb = s => cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h;
    const pick = arr => arr.filter(inb).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    const s = pick(nds) || pick(lvls);
    if (s) s.items.push(wd); else free.push(wd);
  });

  const edgeColor = s => {
    for (let d = 1; d <= 6; d++) {
      const x = Math.max(0, s.x - d), y = Math.min(H - 1, s.y + (s.h >> 1)), p = (y * W + x) * 4;
      if (bgDist(p) > 60) return rgbHex([px[p], px[p + 1], px[p + 2]]);
    }
    return null;
  };

  const outNodes = [], outLevels = [], outEdges = [];
  lvls.forEach((s, i) => {
    outLevels.push({
      id: "", x: snap(X0 + s.x - 2), y: snap(Y0 + s.y - 2),
      w: Math.max(120, snap(s.w + 4)), h: Math.max(70, snap(s.h + 4)),
      text: groupLines(s.items).map(l => l.text).join(" "),
      fill: rgbHex(s.c), border: edgeColor(s) || "#64748b", opacity: 82
    });
  });
  nds.forEach(s => {
    const lines = groupLines(s.items);
    const avgH = s.items.length ? s.items.reduce((m, it) => m + it.h, 0) / s.items.length : 14;
    s.id = "n" + counter++;
    outNodes.push({
      id: s.id, type: s.type,
      x: snap(X0 + s.x - 2), y: snap(Y0 + s.y - 2),
      w: Math.max(40, snap(s.w + 4)), h: Math.max(30, snap(s.h + 4)),
      text: lines.map(l => l.text).join("\n"),
      fill: rgbHex(s.c), border: edgeColor(s) || "#334155",
      font: Math.min(24, Math.max(10, Math.round(avgH * 1.05))), line: 2
    });
  });
  // text that is not inside any shape -> label boxes
  groupBlocks(groupLines(free)).forEach(b => {
    outNodes.push({
      id: "n" + counter++, type: "process",
      x: snap(X0 + b.x1 - 12), y: snap(Y0 + b.y1 - 10),
      w: Math.max(80, snap(b.x2 - b.x1 + 24)), h: Math.max(40, snap(b.y2 - b.y1 + 20)),
      text: b.lines.map(l => l.text).join("\n"),
      fill: "#ffffff", border: nds.length ? "#ffffff" : "#334155", line: nds.length ? 1 : 2,
      font: Math.min(24, Math.max(10, Math.round(b.h * 1.05)))
    });
  });

  // 4) connections: leftover ink (not shapes / text / level borders) that touches 2+ shapes
  if (nds.length >= 2) {
    const ink = new Uint8Array(N);
    const candL = new Set(cands.map(c => c.L));
    for (let i = 0; i < N; i++) {
      const l = lab[i];
      if (l === bgL || candL.has(l)) continue;
      if (bgDist(i * 4) > 90) ink[i] = 1;
    }
    const clear = (a, b, c, d) => {
      for (let y = Math.max(0, b); y <= Math.min(H - 1, d); y++) for (let x = Math.max(0, a); x <= Math.min(W - 1, c); x++) ink[y * W + x] = 0;
    };
    nds.forEach(s => clear(s.x - 8, s.y - 8, s.x + s.w + 8, s.y + s.h + 8));
    lvls.forEach(s => {
      clear(s.x - 8, s.y - 8, s.x + s.w + 8, s.y + 4); clear(s.x - 8, s.y + s.h - 4, s.x + s.w + 8, s.y + s.h + 8);
      clear(s.x - 8, s.y - 8, s.x + 4, s.y + s.h + 8); clear(s.x + s.w - 4, s.y - 8, s.x + s.w + 8, s.y + s.h + 8);
    });
    words.forEach(wd => clear(wd.x - 3, wd.y - wd.h - 3, wd.x + wd.w + 3, wd.y + 3));

    const comp = new Int32Array(N), csize = [0];
    let nc = 0;
    for (let i = 0; i < N; i++) {
      if (!ink[i] || comp[i]) continue;
      nc++; comp[i] = nc; sp = 0; stack[sp++] = i;
      let size = 0;
      while (sp) {
        const j = stack[--sp], x = j % W, y = (j / W) | 0;
        size++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const k = yy * W + xx;
          if (ink[k] && !comp[k]) { comp[k] = nc; stack[sp++] = k; }
        }
      }
      csize.push(size);
    }
    const touch = new Map();
    nds.forEach(s => {
      const ax0 = s.x - 16, ay0 = s.y - 16, ax1 = s.x + s.w + 16, ay1 = s.y + s.h + 16;
      const bx0 = s.x - 8, by0 = s.y - 8, bx1 = s.x + s.w + 8, by1 = s.y + s.h + 8;
      for (let y = Math.max(0, ay0); y <= Math.min(H - 1, ay1); y++) {
        for (let x = Math.max(0, ax0); x <= Math.min(W - 1, ax1); x++) {
          if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) { x = bx1; continue; }
          const c = comp[y * W + x];
          if (c && csize[c] >= 12) { if (!touch.has(c)) touch.set(c, new Set()); touch.get(c).add(s); }
        }
      }
    });
    const seen = new Set();
    const addEdge = (a, b) => { const k = a + ">" + b; if (a !== b && !seen.has(k)) { seen.add(k); outEdges.push({ a, b }); } };
    touch.forEach(set => {
      if (set.size < 2) return;
      const arr = [...set].sort((p, q) => (p.y + p.h / 2) - (q.y + q.h / 2) || p.x - q.x);
      const topY = arr[0].y + arr[0].h / 2;
      const tops = arr.filter(t => Math.abs(t.y + t.h / 2 - topY) < 12), rest = arr.filter(t => !tops.includes(t));
      if (rest.length) tops.forEach(a => rest.forEach(b => addEdge(a.id, b.id)));
      else { tops.sort((p, q) => p.x - q.x); for (let k = 1; k < tops.length; k++) addEdge(tops[k - 1].id, tops[k].id); }
    });
  }
  return { nodes: outNodes, levels: outLevels, edges: outEdges };
}

async function rasterToDiagram(cv, X0, Y0, ocrCv) {
  let words = await ocrCanvas(ocrCv || cv);
  if (ocrCv) {
    const k = cv.width / ocrCv.width;
    words = words.map(w => ({ s: w.s, x: w.x * k, y: w.y * k, w: w.w * k, h: w.h * k }));
  }
  status(`OCR read ${words.length} words. Detecting shapes…`);
  if (!words.length) alert("The OCR didn't find any text in this image, so the shapes will be empty. The text may be too small or blurry.");
  await new Promise(r => setTimeout(r, 30));
  return rasterCore(cv.width, cv.height, cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data, words, X0, Y0);
}
function fileToCanvas(f, minSide = 1200, maxSide = 1800) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(f), img = new Image();
    img.onload = () => {
      const m = Math.max(img.naturalWidth, img.naturalHeight);
      const k = m > maxSide ? maxSide / m : m < minSide ? minSide / m : 1;
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c);
    };
    img.onerror = () => rej(new Error("Couldn't open image"));
    img.src = url;
  });
}
function nextFreeY() {
  const ys = [...nodes.map(n => n.y + n.h), ...levels.map(l => l.y + l.h)];
  return ys.length ? Math.max(...ys) + 60 : 40;
}
function applyRaster(r) {
  saveState();
  r.levels.forEach(l => { l.id = nextLevelId(); levels.push(l); });
  nodes.push(...r.nodes);
  edges.push(...r.edges.filter(ed => !edges.some(x => x.a === ed.a && x.b === ed.b)));
  selected.clear(); selectedEdge = null; selectedLevel = null;
  render(); fitToScreen();
  status(`Converted: ${r.nodes.length} shapes, ${r.edges.length} connections, ${r.levels.length} levels`);
}

/* ============================================================
   PNG import
   1) PNG exported by FlowChart Studio -> full diagram restored (editable)
   2) Any other PNG                     -> placed as an image shape (trace over it)
   ============================================================ */
const PNG_KEY = "FlowChartStudio";
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngAddText(png, key, text) {
  const enc = s => Uint8Array.from(s, ch => ch.charCodeAt(0) & 255);
  const type = enc("tEXt"), data = enc(key + "\0" + text);
  const body = new Uint8Array(4 + data.length);
  body.set(type, 0); body.set(data, 4);
  const chunk = new Uint8Array(12 + data.length), dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(body, 4);
  dv.setUint32(8 + data.length, crc32(body));
  const cut = png.length - 12; // insert right before IEND
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, cut), 0);
  out.set(chunk, cut);
  out.set(png.subarray(cut), cut + chunk.length);
  return out;
}
function pngReadText(png, key) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const dec = new TextDecoder("latin1");
  let p = 8;
  while (p + 12 <= png.length) {
    const len = dv.getUint32(p);
    const type = dec.decode(png.subarray(p + 4, p + 8));
    if (type === "tEXt") {
      const s = dec.decode(png.subarray(p + 8, p + 8 + len));
      const z = s.indexOf("\0");
      if (z > 0 && s.slice(0, z) === key) return s.slice(z + 1);
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return null;
}
function importPng() { $("pngFile").click(); }
$("pngFile").onchange = async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    const payload = pngReadText(buf, PNG_KEY);
    if (payload) {
      const d = JSON.parse(decodeURIComponent(escape(atob(payload))));
      saveState();
      nodes = d.nodes || []; levels = d.levels || []; edges = d.edges || [];
      counter = nodes.reduce((m, n) => Math.max(m, +String(n.id).replace("n", "") || 0), 0) + 1;
      selected.clear(); selectedEdge = null; selectedLevel = null;
      render(); fitToScreen();
      return status("PNG restored as an editable diagram");
    }
    // Not made by FlowChart Studio -> convert to editable shapes (OCR) or add as an image shape
    if (confirm("This PNG has no editable data.\n\nOK = convert it to editable shapes + text (OCR, needs internet)\nCancel = just place it as an image")) {
      try {
        const cv = await fileToCanvas(f);
        const big = await fileToCanvas(f, 2400, 4000);
        const Y0 = nextFreeY();
        const r = await rasterToDiagram(cv, 40, Y0, big);
        if (!r.nodes.length && !r.levels.length) return alert("Couldn't detect any shapes or text in this image.");
        if (confirm("Keep the original image behind the shapes as a reference?\n(You can delete it later.)")) {
          r.nodes.unshift({ id: "n" + counter++, type: "image", x: 40, y: snap(Y0), w: cv.width, h: cv.height, text: "",
            src: cv.toDataURL("image/jpeg", 0.85), fill: "#ffffff", border: "#cbd5e1", font: 12, line: 1 });
        }
        return applyRaster(r);
      } catch (err) {
        console.error(err);
        return alert("Conversion failed (" + err.message + "). Check your internet connection and try again.");
      }
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result, img = new Image();
      img.onload = () => add("image", (wrap.scrollLeft + wrap.clientWidth / 2) / zoom, (wrap.scrollTop + wrap.clientHeight / 2) / zoom, {
        text: f.name.replace(/\.[^.]+$/, "") || "Image", src, naturalW: img.naturalWidth, naturalH: img.naturalHeight
      });
      img.src = src;
    };
    reader.readAsDataURL(f);
    status("PNG placed as an image");
  } catch (err) {
    console.error(err);
    alert("Couldn't read that PNG.");
  }
};

/* ---------------- Excel export ---------------- */
function exportExcel() {
  if (!nodes.length) return status("Nothing to export");
  if (!window.XLSX) {
    alert("Excel export needs an internet connection because the XLSX library is loaded from a CDN.");
    return;
  }

  const nodeRows = nodes.map(n => ({
    ID: n.id,
    Type: n.type,
    Text: n.text || "",
    X: n.x,
    Y: n.y,
    Width: n.w,
    Height: n.h,
    Fill: n.fill,
    Border: n.border,
    Font: n.font,
    Line: n.line
  }));

  const edgeRows = edges.map((e, i) => ({
    ID: i + 1,
    From: e.a,
    To: e.b
  }));

  const levelRows = levels.map(l => ({
    ID: l.id,
    Name: l.text || "",
    X: l.x,
    Y: l.y,
    Width: l.w,
    Height: l.h,
    Fill: l.fill,
    Border: l.border,
    Opacity: l.opacity ?? 82
  }));

  const wb = XLSX.utils.book_new();
  const nodesSheet = XLSX.utils.json_to_sheet(nodeRows);
  const edgesSheet = XLSX.utils.json_to_sheet(edgeRows);
  const levelsSheet = XLSX.utils.json_to_sheet(levelRows);

  nodesSheet["!cols"] = [
    { wch: 10 }, { wch: 16 }, { wch: 32 }, { wch: 10 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }
  ];
  edgesSheet["!cols"] = [{ wch: 8 }, { wch: 12 }, { wch: 12 }];

  XLSX.utils.book_append_sheet(wb, nodesSheet, "Shapes");
  XLSX.utils.book_append_sheet(wb, edgesSheet, "Connections");
  XLSX.utils.book_append_sheet(wb, levelsSheet, "Levels");

  XLSX.writeFile(wb, "flowchart.xlsx");
  status("Excel exported");
}

/* ---------------- export ---------------- */
function download(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function exportJson() {
  download("flowchart.json", new Blob([JSON.stringify({ nodes, levels, edges }, null, 2)], { type: "application/json" }));
  status("JSON exported");
}
function diagramBounds(pad = 40) {
  if (!nodes.length && !levels.length) return { minX: 0, minY: 0, w: 400, h: 300 };
  const xs = [...nodes.map(n => n.x), ...levels.map(l => l.x)];
  const ys = [...nodes.map(n => n.y), ...levels.map(l => l.y)];
  const xe = [...nodes.map(n => n.x + n.w), ...levels.map(l => l.x + l.w)];
  const ye = [...nodes.map(n => n.y + n.h), ...levels.map(l => l.y + l.h)];
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xe) + pad, maxY = Math.max(...ye) + pad;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}
// Rough shape geometry shared by SVG + PNG exporters (visual approximation of the CSS shapes)
function shapeGeom(n) {
  const { x, y, w, h } = n;
  switch (n.type) {
    case "circle": return { kind: "ellipse", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
    case "decision": return { kind: "poly", pts: [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]] };
    case "hexagon": return { kind: "poly", pts: [[x + w * .2, y], [x + w * .8, y], [x + w, y + h / 2], [x + w * .8, y + h], [x + w * .2, y + h], [x, y + h / 2]] };
    case "data": case "parallelogram": { const k = h * .22; return { kind: "poly", pts: [[x + k, y], [x + w, y], [x + w - k, y + h], [x, y + h]] }; }
    case "start": return { kind: "rect", rx: h / 2 };
    case "document": return { kind: "rect", rx: 10 };
    case "database": return { kind: "rect", rx: Math.min(w, h) * .18 };
    default: return { kind: "rect", rx: 4 };
  }
}
function exportSvg() {
  const b = diagramBounds();
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}" font-family="Inter,Arial,sans-serif">`];
  parts.push(`<rect x="0" y="0" width="${b.w}" height="${b.h}" fill="#ffffff"/>`);
  levels.forEach(l => {
    const x = l.x - b.minX, y = l.y - b.minY;
    const opacity = Math.max(0, Math.min(100, l.opacity ?? 82)) / 100;
    parts.push(`<rect x="${x}" y="${y}" width="${l.w}" height="${l.h}" fill="${l.fill}" fill-opacity="${opacity}" stroke="${l.border}" stroke-width="1.5"/>`);
    if (l.text) parts.push(`<text x="${x + l.w / 2}" y="${y + 28}" text-anchor="middle" font-size="16" font-family="Inter,Arial,sans-serif" fill="#1a2233">${String(l.text).replace(/&/g,"&amp;").replace(/</g,"&lt;")}</text>`);
  });
  // Temporarily shift nodes for org-path generation in export space
  const off = { x: -b.minX, y: -b.minY };
  const orig = nodes.map(n => ({ x: n.x, y: n.y }));
  nodes.forEach(n => { n.x += off.x; n.y += off.y; });
  buildOrgPaths().forEach(seg => {
    parts.push(`<path d="${seg.d}" fill="none" stroke="#94a3b8" stroke-width="1.75"/>`);
  });
  nodes.forEach((n, i) => { n.x = orig[i].x; n.y = orig[i].y; });
  nodes.forEach(n => {
    const off = { x: -b.minX, y: -b.minY };
    const nx = n.x + off.x, ny = n.y + off.y;
    if (n.type === "image" && n.src) {
      parts.push(`<rect x="${nx}" y="${ny}" width="${n.w}" height="${n.h}" fill="#f8fafc" stroke="${n.border}" stroke-width="${n.line}" rx="4"/>`);
      parts.push(`<image href="${n.src}" x="${nx}" y="${ny}" width="${n.w}" height="${n.h}" preserveAspectRatio="xMidYMid slice"/>`);
      if (n.text) {
        parts.push(`<rect x="${nx}" y="${ny + n.h - 18}" width="${n.w}" height="18" fill="rgba(255,255,255,0.9)"/>`);
        parts.push(`<text x="${nx + n.w / 2}" y="${ny + n.h - 6}" font-size="11" fill="#1a2233" text-anchor="middle">${escapeXml(n.text)}</text>`);
      }
      return;
    }
    const g = shapeGeom({ ...n, x: nx, y: ny });
    const style = `fill="${n.fill}" stroke="${n.border}" stroke-width="${n.line}"`;
    if (g.kind === "ellipse") parts.push(`<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}" ${style}/>`);
    else if (g.kind === "poly") parts.push(`<polygon points="${g.pts.map(p => p.join(",")).join(" ")}" ${style}/>`);
    else parts.push(`<rect x="${nx}" y="${ny}" width="${n.w}" height="${n.h}" rx="${g.rx}" ${style}/>`);
    // Multi-line label support
    const lines = String(n.text || "").split("\n");
    const lineH = n.font * 1.35;
    const startY = ny + n.h / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => {
      parts.push(`<text x="${nx + n.w / 2}" y="${startY + i * lineH}" font-size="${n.font}" fill="#1a2233" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`);
    });
  });
  parts.push("</svg>");
  download("flowchart.svg", new Blob(parts, { type: "image/svg+xml" }));
  status("SVG exported");
}
function escapeXml(s) { return String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])); }

function buildExportCanvas(scale = 2) {
  const b = diagramBounds();
  const c = document.createElement("canvas");
  c.width = Math.max(1, b.w * scale); c.height = Math.max(1, b.h * scale);
  const ctx = c.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, b.w, b.h);
  const off = { x: -b.minX, y: -b.minY };

  levels.forEach(l => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(100, l.opacity ?? 82)) / 100;
    ctx.fillStyle = l.fill;
    ctx.strokeStyle = l.border;
    ctx.lineWidth = 1.5;
    ctx.fillRect(l.x + off.x, l.y + off.y, l.w, l.h);
    ctx.strokeRect(l.x + off.x, l.y + off.y, l.w, l.h);
    ctx.globalAlpha = 1;
    if (l.text) {
      ctx.fillStyle = "#1a2233";
      ctx.font = "16px Inter, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(l.text, l.x + off.x + l.w / 2, l.y + off.y + 10, l.w - 20);
    }
    ctx.restore();
  });

  const origPos = nodes.map(n => ({ x: n.x, y: n.y }));
  nodes.forEach(n => { n.x += off.x; n.y += off.y; });
  buildOrgPaths().forEach(seg => {
    const path2d = new Path2D(seg.d);
    ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1.75; ctx.stroke(path2d);
  });
  nodes.forEach((n, i) => { n.x = origPos[i].x; n.y = origPos[i].y; });

  nodes.forEach(n => {
    const nn = { ...n, x: n.x + off.x, y: n.y + off.y };
    if (n.type === "image" && n.src) {
      ctx.fillStyle = "#f8fafc";
      ctx.strokeStyle = n.border;
      ctx.lineWidth = n.line;
      ctx.beginPath();
      roundRect(ctx, nn.x, nn.y, nn.w, nn.h, 4);
      ctx.fill(); ctx.stroke();
      // Draw image from DOM if present, else try data URL
      const domImg = layer.querySelector(`.node[data-id="${n.id}"] .node-img`);
      if (domImg && domImg.complete) {
        ctx.drawImage(domImg, nn.x, nn.y, nn.w, nn.h);
      } else {
        try {
          const tmp = new Image();
          tmp.src = n.src;
          if (tmp.complete) ctx.drawImage(tmp, nn.x, nn.y, nn.w, nn.h);
        } catch (_) { /* skip */ }
      }
      if (n.text) {
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(nn.x, nn.y + nn.h - 18, nn.w, 18);
        ctx.fillStyle = "#1a2233";
        ctx.font = "11px Inter, Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.text, nn.x + nn.w / 2, nn.y + nn.h - 9, nn.w - 8);
      }
      return;
    }
    const g = shapeGeom(nn);
    ctx.fillStyle = n.fill; ctx.strokeStyle = n.border; ctx.lineWidth = n.line;
    ctx.beginPath();
    if (g.kind === "ellipse") ctx.ellipse(g.cx, g.cy, Math.max(g.rx, 1), Math.max(g.ry, 1), 0, 0, Math.PI * 2);
    else if (g.kind === "poly") { g.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); }
    else roundRect(ctx, nn.x, nn.y, nn.w, nn.h, g.rx);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#1a2233"; ctx.font = `${n.font}px Inter, Arial, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const lines = String(n.text || "").split("\n");
    const lineH = n.font * 1.35;
    const startY = nn.y + nn.h / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, nn.x + nn.w / 2, startY + i * lineH, nn.w - 16);
    });
  });

  return { canvas: c, bounds: b };
}
function exportPng() {
  const { canvas: c } = buildExportCanvas(2);
  c.toBlob(async blob => {
    let out = blob;
    try {
      // Embed the editable diagram inside the PNG so "Import PNG" can restore it exactly
      const buf = new Uint8Array(await blob.arrayBuffer());
      const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ nodes, levels, edges }))));
      out = new Blob([pngAddText(buf, PNG_KEY, payload)], { type: "image/png" });
    } catch (err) { console.warn("Couldn't embed diagram data in PNG", err); }
    download("flowchart.png", out);
    status("PNG exported");
  });
}
function exportPdf() {
  if (!nodes.length) return status("Nothing to export");
  if (!window.jspdf) { alert("PDF export needs an internet connection (it loads a small PDF library from a CDN the first time)."); return; }
  const { canvas: c, bounds: b } = buildExportCanvas(2);
  const imgData = c.toDataURL("image/png");
  const { jsPDF } = window.jspdf;
  const orientation = b.w >= b.h ? "landscape" : "portrait";
  const pdf = new jsPDF({ orientation, unit: "px", format: [Math.max(b.w, 1), Math.max(b.h, 1)] });
  pdf.addImage(imgData, "PNG", 0, 0, b.w, b.h);
  // Embed the editable diagram inside the PDF so "Import PDF" can restore it exactly
  pdf.setProperties({ keywords: PDF_TAG + btoa(unescape(encodeURIComponent(JSON.stringify({ nodes, levels, edges })))) });
  pdf.save("flowchart.pdf");
  status("PDF exported");
}
function exportDoc() {
  if (!nodes.length) return status("Nothing to export");
  const { canvas: c } = buildExportCanvas(2);
  const imgData = c.toDataURL("image/png");
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Flowchart</title></head>
<body><h2 style="font-family:Calibri,Arial,sans-serif">Flowchart</h2>
<img src="${imgData}" style="max-width:100%"/></body></html>`;
  download("flowchart.doc", new Blob(["\ufeff", html], { type: "application/msword" }));
  status("Word document exported");
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawArrowHead(ctx, a, b) {
  const sB = near(b, center(a));
  const tip = side(b, sB);
  const back = extend(tip, sB, -9);
  const perp = (sB === "t" || sB === "b") ? { x: 5, y: 0 } : { x: 0, y: 5 };
  ctx.fillStyle = "#64748b";
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(back.x + perp.x, back.y + perp.y);
  ctx.lineTo(back.x - perp.x, back.y - perp.y);
  ctx.closePath();
  ctx.fill();
}

/* ---------------- view toggles ---------------- */
function toggleGrid() { gridOn = !gridOn; wrap.classList.toggle("no-grid", !gridOn); status(gridOn ? "Grid on" : "Grid off"); }
function toggleMinimap() { minimapOn = !minimapOn; $("minimap").classList.toggle("hidden", !minimapOn); status(minimapOn ? "Minimap on" : "Minimap off"); }

/* ---------------- actions registry (wires menu + toolbar buttons) ---------------- */
const actions = {
  new: newDiagram, open: openDiagram, importPdf, importPng, save: saveLocal, insertImage: () => insertImage(),
  exportJson, exportExcel, exportSvg, exportPng, exportPdf, exportDoc,
  undo, redo, cut: cutSelection, copy: copySelection, paste: pasteClipboard,
  duplicate: duplicateSelection, selectAll, delete: deleteSelection,
  zoomIn: () => setZoom(zoom + .1), zoomOut: () => setZoom(zoom - .1),
  zoomActual: () => setZoom(1), fit: fitToScreen,
  toggleGrid, toggleMinimap,
  bringFront: bringToFront, bringForward, sendBackward, sendBack: sendToBack,
  alignLeft, alignCenterH, alignRight, alignTop, alignMiddle, alignBottom,
  distributeH, distributeV
};
document.querySelectorAll("[data-action]").forEach(btn => {
  btn.addEventListener("click", () => {
    closeMenus();
    const fn = actions[btn.dataset.action];
    if (fn) fn();
  });
});

/* ---------------- dropdown menus ---------------- */
function closeMenus() {
  document.querySelectorAll(".menu-dropdown.open").forEach(d => d.classList.remove("open"));
  document.querySelectorAll(".menu-trigger.active").forEach(b => b.classList.remove("active"));
}
document.querySelectorAll(".menu-trigger").forEach(btn => {
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const dd = document.querySelector(`.menu-dropdown[data-dropdown="${btn.dataset.menu}"]`);
    const isOpen = dd.classList.contains("open");
    closeMenus();
    if (!isOpen) { dd.classList.add("open"); btn.classList.add("active"); }
  });
  btn.addEventListener("mouseenter", () => {
    const anyOpen = document.querySelector(".menu-dropdown.open");
    if (!anyOpen) return;
    closeMenus();
    const dd = document.querySelector(`.menu-dropdown[data-dropdown="${btn.dataset.menu}"]`);
    dd.classList.add("open"); btn.classList.add("active");
  });
});
document.addEventListener("click", closeMenus);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });

/* ---------------- search filter ---------------- */
$("search").oninput = e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll(".item").forEach(i => i.style.display = i.textContent.toLowerCase().includes(q) ? "flex" : "none");
};

/* ---------------- keyboard shortcuts ---------------- */
document.addEventListener("keydown", e => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
    || !!document.activeElement?.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  if (typing) return;   // let the browser / contentEditable handle keys while editing text
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((mod && e.key.toLowerCase() === "y") || (mod && e.shiftKey && e.key.toLowerCase() === "z")) { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelection(); }
  else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectAll(); }
  else if (mod && e.key.toLowerCase() === "c") { copySelection(); }
  else if (mod && e.key.toLowerCase() === "x") { e.preventDefault(); cutSelection(); }
  else if (mod && e.key.toLowerCase() === "v") { pasteClipboard(); }
  else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveLocal(); }
  else if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newDiagram(); }
  else if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); openDiagram(); }
  else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(zoom + .1); }
  else if (mod && e.key === "-") { e.preventDefault(); setZoom(zoom - .1); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (e.key === "Escape") { selected.clear(); selectedEdge = null; selectedLevel = null; render(); }
  else if (e.key === "]") { bringToFront(); }
  else if (e.key === "[") { sendToBack(); }
  else if (e.shiftKey && e.key === "1") { fitToScreen(); }
});

/* ---------------- autosave + boot ---------------- */
setInterval(() => localStorage.setItem("flowchartV2", JSON.stringify({ nodes, levels, edges, zoom })), 5000);

(function boot() {
  const saved = localStorage.getItem("flowchartV2");
  if (saved) {
    try {
      const d = JSON.parse(saved);
      nodes = d.nodes || []; levels = d.levels || []; edges = d.edges || []; zoom = d.zoom || 1;
      counter = nodes.reduce((m, n) => Math.max(m, +String(n.id).replace("n", "") || 0), 0) + 1;
    } catch { /* ignore corrupt autosave */ }
  }
  render();
  setZoom(zoom);
})();
