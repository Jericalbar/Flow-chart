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
    e.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--fill:${n.fill};background:${n.fill};border-color:${n.border};border-width:${n.line}px;font-size:${n.font}px;${n.opacity != null ? `opacity:${Math.max(0, Math.min(100, n.opacity)) / 100};` : ""}`;

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
    let yOff = 40, addedNodes = [], addedLevels = [], addedEdges = [];

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
   PNG flowchart import: OpenCV shape/line detection + Tesseract OCR
   Requires internet on first use to load OpenCV.js and Tesseract.js.
   Detection is best-effort; imported objects remain editable.
   ============================================================ */
function importPng() { $("pngFlowFile").click(); }

function loadScriptOnce(src, test, label) {
  if (test()) return Promise.resolve();
  const existing = [...document.scripts].find(s => s.src === src);
  if (existing) return new Promise((resolve, reject) => {
    existing.addEventListener("load", resolve, { once: true });
    existing.addEventListener("error", reject, { once: true });
  });
  return new Promise((resolve, reject) => {
    const s = document.createElement("script"); s.src = src; s.async = true;
    s.onload = () => test() ? resolve() : reject(new Error(label + " did not initialize"));
    s.onerror = () => reject(new Error("Could not load " + label + ". Check your internet connection."));
    document.head.appendChild(s);
  });
}
async function ensurePngEngines() {
  status("Loading image recognition tools…");
  // OpenCV creates window.cv before its WASM runtime is ready. Wait for both
  // the script and runtime; otherwise PNG import can hang or fail randomly.
  const cvReady = () => !!(window.cv && window.cv.Mat && window.cv.imread);
  if (!cvReady()) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        if (err) reject(err); else resolve();
      };
      const poll = setInterval(() => { if (cvReady()) finish(); }, 100);
      const timeout = setTimeout(() => finish(new Error("OpenCV.js runtime did not initialize. Refresh the page and try again with internet access.")), 60000);
      const src = "https://docs.opencv.org/4.x/opencv.js";
      const existing = [...document.scripts].find(s => s.src === src);
      const onLoad = () => { if (cvReady()) finish(); };
      const onError = () => finish(new Error("Could not load OpenCV.js. Check your internet connection."));
      if (existing) {
        existing.addEventListener("load", onLoad, { once: true });
        existing.addEventListener("error", onError, { once: true });
      } else {
        const script = document.createElement("script");
        script.src = src; script.async = true;
        script.onload = onLoad; script.onerror = onError;
        document.head.appendChild(script);
      }
      // If OpenCV is already present, register the callback as well as polling
      // so we don't miss a runtime-ready event that fires between checks.
      if (window.cv) {
        const previous = window.cv.onRuntimeInitialized;
        window.cv.onRuntimeInitialized = () => {
          if (typeof previous === "function") previous();
          finish();
        };
      }
    });
  }
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js", () => !!window.Tesseract, "Tesseract.js");
}

function contourShapeType(approx, rect, area) {
  const pts = [];
  for (let i = 0; i < approx.rows; i++) pts.push({ x: approx.intAt(i, 0), y: approx.intAt(i, 1) });
  const { width: w, height: h } = rect;
  if (!w || !h) return null;
  if (pts.length === 4) {
    const cx = rect.x + w / 2, cy = rect.y + h / 2;
    const diamond = pts.every(p => Math.abs(Math.abs(p.x - cx) / (w / 2) + Math.abs(p.y - cy) / (h / 2) - 1) < 0.24);
    if (diamond) return "decision";
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const top = pts.filter(p => Math.abs(p.y - Math.min(...ys)) < 5).length;
    const bot = pts.filter(p => Math.abs(p.y - Math.max(...ys)) < 5).length;
    if (top === 2 && bot === 2 && pts.some(p => p.x < rect.x + 2 && p.y > rect.y + 2 && p.y < rect.y + h - 2)) return "data";
    return "process";
  }
  if (pts.length === 6) return "hexagon";
  const circularity = area > 0 ? area / (w * h) : 0;
  if (w / h > 1.5 && h / w < 0.67) return "start";
  if (circularity > 0.62 && w / h > 0.72 && w / h < 1.38) return "circle";
  return "process";
}
async function detectPngFlowchartOCRFallback(file) {
  // OCR-only fallback: never leave the user with just a flat image when OpenCV
  // cannot load or cannot find outlines. Each recognized text line becomes an
  // independent editable process shape that can be moved, resized and renamed.
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js", () => !!window.Tesseract, "Tesseract.js");
  const imgUrl = await new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = imgUrl;
  });
  const scale = Math.min(1, 1800 / img.naturalWidth, 1800 / img.naturalHeight);
  const work = document.createElement("canvas");
  work.width = Math.max(1, Math.round(img.naturalWidth * scale));
  work.height = Math.max(1, Math.round(img.naturalHeight * scale));
  work.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, work.width, work.height);
  status("OpenCV unavailable; extracting editable text boxes with OCR…");
  const worker = await window.Tesseract.createWorker("eng");
  let words = [];
  try {
    const result = await worker.recognize(work);
    words = (result.data.words || []).filter(w => (w.text || "").trim() && (w.confidence == null || w.confidence >= 25)).map(w => ({
      text:w.text.trim(), x0:w.bbox.x0, y0:w.bbox.y0, x1:w.bbox.x1, y1:w.bbox.y1,
      cx:(w.bbox.x0+w.bbox.x1)/2, cy:(w.bbox.y0+w.bbox.y1)/2
    }));
  } finally { await worker.terminate(); }
  const lines=[];
  for (const w of words.sort((a,b)=>a.cy-b.cy || a.x0-b.x0)) {
    let line=lines.find(l=>Math.abs(l.cy-w.cy)<Math.max(10,(l.h+w.y1-w.y0)*.45));
    if(!line){line={cy:w.cy,h:w.y1-w.y0,words:[]};lines.push(line);}
    line.words.push(w); line.cy=line.words.reduce((a,q)=>a+q.cy,0)/line.words.length; line.h=Math.max(line.h,w.y1-w.y0);
  }
  lines.forEach(l=>{l.words.sort((a,b)=>a.x0-b.x0);l.text=l.words.map(w=>w.text).join(" ").replace(/\s+/g," ").trim();l.x0=Math.min(...l.words.map(w=>w.x0));l.x1=Math.max(...l.words.map(w=>w.x1));l.y0=Math.min(...l.words.map(w=>w.y0));l.y1=Math.max(...l.words.map(w=>w.y1));});
  const pxScale=1/scale, offsetX=40, offsetY=40;
  const nodesOut=lines.filter(l=>l.text).map(l=>({
    id:"n"+(counter++),type:"process",x:offsetX+snap(Math.max(0,l.x0-18)*pxScale),y:offsetY+snap(Math.max(0,l.y0-12)*pxScale),
    w:Math.max(100,snap((l.x1-l.x0+36)*pxScale)),h:Math.max(44,snap((l.y1-l.y0+24)*pxScale)),text:l.text,
    fill:"#ffffff",border:"#334155",font:16,line:2
  }));
  return {imgUrl,work,nodes:nodesOut,edges:[],scale:pxScale,imageW:work.width,imageH:work.height,offsetX,offsetY,ocrFallback:true};
}

async function detectPngFlowchart(file) {
  try { await ensurePngEngines(); }
  catch (engineError) {
    console.warn("OpenCV could not initialize; using OCR fallback", engineError);
    const fallback = await detectPngFlowchartOCRFallback(file);
    if (!fallback.nodes.length) throw new Error("Could not detect editable shapes or readable text. Try a higher-resolution PNG with clearer text.");
    return fallback;
  }
  const imgUrl = await new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = imgUrl;
  });
  // Work at a bounded resolution so large screenshots do not exhaust memory.
  const scale = Math.min(1, 1800 / img.naturalWidth, 1800 / img.naturalHeight);
  const work = document.createElement("canvas");
  work.width = Math.max(1, Math.round(img.naturalWidth * scale));
  work.height = Math.max(1, Math.round(img.naturalHeight * scale));
  work.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, work.width, work.height);

  status("Detecting flowchart shapes…");
  const cv = window.cv, srcMat = cv.imread(work), gray = new cv.Mat(), blur = new cv.Mat(), edgesMat = new cv.Mat();
  const contours = new cv.MatVector(), hierarchy = new cv.Mat();
  let detected = [];
  try {
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0);
    cv.Canny(blur, edgesMat, 45, 130);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(edgesMat, edgesMat, cv.MORPH_CLOSE, kernel);
    kernel.delete();
    cv.findContours(edgesMat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i), area = cv.contourArea(cnt), r = cv.boundingRect(cnt);
      if (area < 500 || r.width < 35 || r.height < 24 || r.width > work.width * .92 && r.height > work.height * .92) { cnt.delete(); continue; }
      const peri = cv.arcLength(cnt, true), approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, .025 * peri, true);
      const type = contourShapeType(approx, r, area);
      approx.delete(); cnt.delete();
      if (!type) continue;
      const candidate = { x:r.x, y:r.y, w:r.width, h:r.height, type, area };
      // Suppress duplicate inner/outer contours of the same box.
      const duplicate = detected.find(d => Math.abs(d.x-candidate.x)<7 && Math.abs(d.y-candidate.y)<7 && Math.abs(d.w-candidate.w)<12 && Math.abs(d.h-candidate.h)<12);
      if (!duplicate) detected.push(candidate);
    }
    // Prefer larger contours if duplicate nested detections survived.
    detected = detected.filter((a, i, arr) => !arr.some((b, j) => i !== j && b.area > a.area * 1.08 && b.x <= a.x+5 && b.y <= a.y+5 && b.x+b.w >= a.x+a.w-5 && b.y+b.h >= a.y+a.h-5 && Math.abs(b.w-a.w)<18 && Math.abs(b.h-a.h)<18));
  } finally { srcMat.delete(); gray.delete(); blur.delete(); edgesMat.delete(); contours.delete(); hierarchy.delete(); }

  // OCR is run on the same resized image so its boxes match contour coordinates.
  status("Reading text with OCR…");
  const worker = await window.Tesseract.createWorker("eng");
  let words = [];
  try {
    const result = await worker.recognize(work);
    words = (result.data.words || []).filter(w => (w.text || "").trim() && (w.confidence == null || w.confidence >= 35)).map(w => ({
      text: w.text.trim(), x0:w.bbox.x0, y0:w.bbox.y0, x1:w.bbox.x1, y1:w.bbox.y1,
      cx:(w.bbox.x0+w.bbox.x1)/2, cy:(w.bbox.y0+w.bbox.y1)/2
    }));
  } finally { await worker.terminate(); }

  // Group OCR words into lines using vertical centers.
  const sorted = words.slice().sort((a,b)=>a.cy-b.cy || a.x0-b.x0), lines=[];
  for (const w of sorted) {
    let line = lines.find(l => Math.abs(l.cy-w.cy) < Math.max(8, (l.h+w.y1-w.y0)*.32));
    if (!line) { line={cy:w.cy,h:w.y1-w.y0,words:[]}; lines.push(line); }
    line.words.push(w); line.cy = line.words.reduce((s,q)=>s+q.cy,0)/line.words.length; line.h=Math.max(line.h,w.y1-w.y0);
  }
  lines.forEach(l=>{l.words.sort((a,b)=>a.x0-b.x0); l.text=l.words.map(w=>w.text).join(" ").replace(/\s+/g," ").trim(); l.x0=Math.min(...l.words.map(w=>w.x0)); l.x1=Math.max(...l.words.map(w=>w.x1)); l.y0=Math.min(...l.words.map(w=>w.y0)); l.y1=Math.max(...l.words.map(w=>w.y1)); l.cx=(l.x0+l.x1)/2; l.cy=(l.y0+l.y1)/2;});
  // If contour detection missed all boxes, turn OCR lines into independent editable boxes.
  // This fallback is intentionally safer than silently importing only a flat PNG image.
  if (!detected.length && lines.length) {
    detected = lines.filter(l=>l.text).map(l=>({x:Math.max(0,l.x0-18),y:Math.max(0,l.y0-12),w:Math.max(90,l.x1-l.x0+36),h:Math.max(38,l.y1-l.y0+24),type:"process",area:Math.max(1,(l.x1-l.x0+36)*(l.y1-l.y0+24))}));
  }
  const pxScale = 1 / scale;
  const offsetX=40, offsetY=40;
  const maxW = Math.max(1,...detected.map(s=>s.x+s.w)), maxH = Math.max(1,...detected.map(s=>s.y+s.h),work.height);
  const fitScale = Math.min(1, 1500 / maxW, 1500 / maxH);
  const cvt = v => snap(v * pxScale * fitScale);
  const nodeObjs = detected.map(s => ({
    id:"n"+(counter++), type:s.type, x:offsetX+cvt(s.x), y:offsetY+cvt(s.y),
    w:Math.max(40,cvt(s.w)), h:Math.max(30,cvt(s.h)), text:"", fill:"#ffffff", border:"#334155", font:16, line:2,
    _ocrBox:{x:s.x,y:s.y,w:s.w,h:s.h}
  }));
  const freeLines=[];
  for (const line of lines) {
    const hit = nodeObjs.filter(n => {
      const b=n._ocrBox; return line.cx>=b.x-3 && line.cx<=b.x+b.w+3 && line.cy>=b.y-3 && line.cy<=b.y+b.h+3;
    }).sort((a,b)=>a._ocrBox.w*a._ocrBox.h-b._ocrBox.w*b._ocrBox.h)[0];
    if (hit) hit.text = hit.text ? hit.text+"\n"+line.text : line.text;
    else freeLines.push(line);
  }
  // Text outside a detected shape becomes an editable label box.
  for (const line of freeLines) {
    const n={id:"n"+(counter++),type:"process",x:offsetX+cvt(line.x0-8),y:offsetY+cvt(line.y0-8),w:Math.max(80,cvt(line.x1-line.x0+16)),h:Math.max(35,cvt(line.y1-line.y0+16)),text:line.text,fill:"#ffffff",border:"#ffffff",font:Math.min(24,Math.max(10,Math.round(cvt(line.y1-line.y0)*.8))),line:1};
    nodeObjs.push(n);
  }
  // Keep private OCR bounds until connector detection has finished.

  // Use OpenCV Hough line detection to approximate connectors, then map lines touching two boxes.
  status("Rebuilding connectors…");
  const m = cv.imread(work), g = new cv.Mat(), ed = new cv.Mat(), hough = new cv.Mat();
  try {
    cv.cvtColor(m,g,cv.COLOR_RGBA2GRAY); cv.Canny(g,ed,50,150);
    cv.HoughLinesP(ed,hough,1,Math.PI/180,35,Math.max(20,Math.round(Math.min(work.width,work.height)*.025)),10);
    const segs=[];
    for(let i=0;i<hough.rows;i++) { const x1=hough.data32S[i*4],y1=hough.data32S[i*4+1],x2=hough.data32S[i*4+2],y2=hough.data32S[i*4+3]; if(Math.hypot(x2-x1,y2-y1)>18) segs.push([x1,y1,x2,y2]); }
    const boxes=nodeObjs.filter(n=>n._ocrBox).map(n=>({id:n.id,x:n._ocrBox.x,y:n._ocrBox.y,w:n._ocrBox.w,h:n._ocrBox.h}));
    const links=buildEdgesFromSegments(boxes,segs);
    // buildEdgesFromSegments expects connected segments; Hough output is fragmented, so also infer direct line hits.
    const touches=(seg,b)=>{const tol=7; const inside=(x,y)=>x>=b.x-tol&&x<=b.x+b.w+tol&&y>=b.y-tol&&y<=b.y+b.h+tol; return inside(seg[0],seg[1])||inside(seg[2],seg[3])||inside((seg[0]+seg[2])/2,(seg[1]+seg[3])/2);};
    const inferred=[];
    for(const seg of segs){ const hit=boxes.filter(b=>touches(seg,b)); if(hit.length>=2){ hit.sort((a,b)=>Math.hypot((a.x+a.w/2)-seg[0],(a.y+a.h/2)-seg[1])-Math.hypot((b.x+b.w/2)-seg[0],(b.y+b.h/2)-seg[1])); const a=hit[0],b=hit[hit.length-1]; if(a.id!==b.id) inferred.push({a:a.id,b:b.id}); } }
    const allLinks=[...links,...inferred];
    nodeObjs.forEach(n=>{delete n._ocrBox;});
    return { imgUrl, work, nodes:nodeObjs, edges:allLinks, scale:fitScale*pxScale, imageW:work.width, imageH:work.height, offsetX, offsetY };
  } finally { m.delete(); g.delete(); ed.delete(); hough.delete(); }
}

$("pngFlowFile").onchange = async e => {
  const f=e.target.files[0]; e.target.value="";
  if(!f) return;
  if(!f.type.startsWith("image/")) return alert("Please choose a PNG or image file.");
  const keepReference=confirm("Import PNG as editable objects.\n\nIMPORTANT: the original PNG is only a flat reference image.\nOK = keep it behind the editable objects.\nCancel = do NOT keep the PNG; show reconstructed objects only (recommended).");
  try {
    const result=await detectPngFlowchart(f);
    if(!result.nodes.length) { alert("No clear flowchart shapes or readable text were detected. Try a sharper, higher-contrast PNG."); return status("PNG import found no objects"); }
    saveState();
    // Optional reference image is inserted first so the editable shapes render above it.
    if(keepReference){
      const ref={id:"n"+(counter++),type:"image",x:result.offsetX,y:result.offsetY,w:snap(result.imageW*result.scale),h:snap(result.imageH*result.scale),text:"PNG reference — delete when finished",src:result.imgUrl,fill:"#ffffff",border:"#cbd5e1",font:12,line:1,opacity:24};
      nodes.push(ref);
    }
    const nodeIds=new Set(result.nodes.map(n=>n.id));
    nodes.push(...result.nodes);
    const links=result.edges.filter(ed=>nodeIds.has(ed.a)&&nodeIds.has(ed.b));
    edges.push(...links.filter(ed=>!edges.some(x=>x.a===ed.a&&x.b===ed.b)));
    selected=new Set(result.nodes.map(n=>n.id)); selectedEdge=null; selectedLevel=null;
    render(); fitToScreen();
    status(`PNG imported: ${result.nodes.length} editable objects, ${links.length} connector candidates`);
    alert(`PNG import finished.\nEditable objects: ${result.nodes.length}\nConnector candidates: ${links.length}${result.ocrFallback ? "\n\nNote: OpenCV was unavailable, so OCR text lines were imported as editable process boxes. Shapes and arrows may need manual rebuilding." : ""}\n\nReview the detected shapes, text, and arrows; automatic recognition may need manual correction.`);
  } catch(err) {
    console.error(err);
    alert("PNG import could not finish. The recognition libraries require an internet connection. Details: "+(err.message||err));
    status("PNG import failed");
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
  c.toBlob(blob => { download("flowchart.png", blob); status("PNG exported"); });
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