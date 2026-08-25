/* ============================================================
   FlowChart Studio — core engine
   ============================================================ */
const $ = id => document.getElementById(id);
const wrap = $("wrap"), canvas = $("canvas"), layer = $("layer"), svg = $("svg"), empty = $("empty");

let nodes = [];
let edges = [];              // { a: nodeId, b: nodeId }
let selected = new Set();    // selected node ids
let selectedEdge = null;     // index into edges[]
let zoom = 1;
let hist = [], future = [];
let counter = 1;
let drag = null, resize = null, pan = null, connect = null;
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
  hist.push(JSON.stringify({ nodes, edges, zoom }));
  if (hist.length > 100) hist.shift();
  future = [];
}
function restore(s) {
  const d = JSON.parse(s);
  nodes = d.nodes || []; edges = d.edges || []; zoom = d.zoom || 1;
  selected.clear(); selectedEdge = null;
  render(); setZoom(zoom);
}
function undo() { if (!hist.length) return; future.push(JSON.stringify({ nodes, edges, zoom })); restore(hist.pop()); status("Undo"); }
function redo() { if (!future.length) return; hist.push(JSON.stringify({ nodes, edges, zoom })); restore(future.pop()); status("Redo"); }
function status(t) { $("status").textContent = t; }

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
  layer.innerHTML = "";
  svg.querySelectorAll(".edge,.temp").forEach(x => x.remove());

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
  $("props").classList.toggle("disabled", !n);
  $("footerHint").textContent = selected.size === 0 ? "Nothing selected"
    : selected.size === 1 ? "1 shape selected"
    : `${selected.size} shapes selected`;
  if (!n) return;
  $("pText").value = n.text; $("pW").value = n.w; $("pH").value = n.h;
  $("pX").value = n.x; $("pY").value = n.y;
  $("pFill").value = n.fill; $("pBorder").value = n.border;
  $("pFont").value = n.font; $("pLine").value = n.line;
}
function change(k, v) {
  const n = selected.size === 1 ? get([...selected][0]) : null;
  if (!n) return;
  saveState(); n[k] = v; render(); status("Updated");
}
$("pText").onchange = e => change("text", e.target.value);
$("pW").onchange = e => change("w", Math.max(40, +e.target.value));
$("pH").onchange = e => change("h", Math.max(30, +e.target.value));
$("pX").onchange = e => change("x", +e.target.value);
$("pY").onchange = e => change("y", +e.target.value);
$("pFill").oninput = e => { const n = selected.size === 1 ? get([...selected][0]) : null; if (n) { n.fill = e.target.value; render(); } };
$("pBorder").oninput = e => { const n = selected.size === 1 ? get([...selected][0]) : null; if (n) { n.border = e.target.value; render(); } };
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
    selected.clear(); selectedEdge = null; render();
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
  const minX = Math.min(...nodes.map(n => n.x), wrap.scrollLeft / zoom);
  const maxX = Math.max(...nodes.map(n => n.x + n.w), (wrap.scrollLeft + wrap.clientWidth) / zoom);
  const minY = Math.min(...nodes.map(n => n.y), wrap.scrollTop / zoom);
  const maxY = Math.max(...nodes.map(n => n.y + n.h), (wrap.scrollTop + wrap.clientHeight) / zoom);
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const mw = 160, mh = 110;
  const scale = Math.min(mw / spanX, mh / spanY);

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
  if (!selected.size) return;
  saveState();
  const ns = [...selected].map(id => { const src = get(id); return { ...src, id: "n" + counter++, x: src.x + 20, y: src.y + 20 }; });
  nodes.push(...ns);
  selected = new Set(ns.map(n => n.id));
  render();
  status("Duplicated");
}
function deleteSelection() {
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
function selectAll() { selected = new Set(nodes.map(n => n.id)); selectedEdge = null; render(); status("Selected all"); }

/* ---------------- z-order ---------------- */
function bringToFront() {
  if (!selected.size) return;
  saveState();
  const ids = [...selected];
  const a = nodes.filter(n => ids.includes(n.id)), b = nodes.filter(n => !ids.includes(n.id));
  nodes = [...b, ...a]; render(); status("Brought to front");
}
function sendToBack() {
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
  nodes = []; edges = []; selected.clear(); selectedEdge = null;
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
      nodes = d.nodes || []; edges = d.edges || [];
      counter = nodes.reduce((m, n) => Math.max(m, +String(n.id).replace("n", "") || 0), 0) + 1;
      selected.clear(); selectedEdge = null;
      render(); fitToScreen();
      status("Diagram imported");
    } catch { alert("Couldn't import that file — is it a FlowChart Studio JSON export?"); }
  };
  reader.readAsText(f);
  e.target.value = "";
};
function saveLocal() { localStorage.setItem("flowchartV2", JSON.stringify({ nodes, edges, zoom })); status("Saved locally"); }

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

  const wb = XLSX.utils.book_new();
  const nodesSheet = XLSX.utils.json_to_sheet(nodeRows);
  const edgesSheet = XLSX.utils.json_to_sheet(edgeRows);

  nodesSheet["!cols"] = [
    { wch: 10 }, { wch: 16 }, { wch: 32 }, { wch: 10 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }
  ];
  edgesSheet["!cols"] = [{ wch: 8 }, { wch: 12 }, { wch: 12 }];

  XLSX.utils.book_append_sheet(wb, nodesSheet, "Shapes");
  XLSX.utils.book_append_sheet(wb, edgesSheet, "Connections");

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
  download("flowchart.json", new Blob([JSON.stringify({ nodes, edges }, null, 2)], { type: "application/json" }));
  status("JSON exported");
}
function diagramBounds(pad = 40) {
  if (!nodes.length) return { minX: 0, minY: 0, w: 400, h: 300 };
  const minX = Math.min(...nodes.map(n => n.x)) - pad, minY = Math.min(...nodes.map(n => n.y)) - pad;
  const maxX = Math.max(...nodes.map(n => n.x + n.w)) + pad, maxY = Math.max(...nodes.map(n => n.y + n.h)) + pad;
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
  new: newDiagram, open: openDiagram, save: saveLocal, insertImage: () => insertImage(),
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
  else if (e.key === "Escape") { selected.clear(); selectedEdge = null; render(); }
  else if (e.key === "]") { bringToFront(); }
  else if (e.key === "[") { sendToBack(); }
  else if (e.shiftKey && e.key === "1") { fitToScreen(); }
});

/* ---------------- autosave + boot ---------------- */
setInterval(() => localStorage.setItem("flowchartV2", JSON.stringify({ nodes, edges, zoom })), 5000);

(function boot() {
  const saved = localStorage.getItem("flowchartV2");
  if (saved) {
    try {
      const d = JSON.parse(saved);
      nodes = d.nodes || []; edges = d.edges || []; zoom = d.zoom || 1;
      counter = nodes.reduce((m, n) => Math.max(m, +String(n.id).replace("n", "") || 0), 0) + 1;
    } catch { /* ignore corrupt autosave */ }
  }
  render();
  setZoom(zoom);
})();
