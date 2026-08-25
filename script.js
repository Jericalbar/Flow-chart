// --- STATE MANAGEMENT ---
const state = {
  nodes: [],
  edges: [],
  selectedNodeIds: new Set(),
  selectedEdgeId: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  isRowBandsVisible: false,
  rowColors: ['#111111', '#4472C4', '#2E7D32', '#D84315', '#6A1B9A'], // Dynamic colors per level
  draggingNode: null,
  dragOffset: { x: 0, y: 0 },
  connectingNode: null,
  tempLine: null
};

// --- DOM ELEMENTS ---
const canvas = document.getElementById('canvas');
const layer = document.getElementById('layer');
const rowLayer = document.getElementById('rowLayer');
const svg = document.getElementById('svg');
const wrap = document.getElementById('wrap');
const pText = document.getElementById('pText');
const pW = document.getElementById('pW');
const pH = document.getElementById('pH');
const pX = document.getElementById('pX');
const pY = document.getElementById('pY');
const pFill = document.getElementById('pFill');
const pBorder = document.getElementById('pBorder');
const props = document.getElementById('props');
const footerHint = document.getElementById('footerHint');

// --- DYNAMIC ROW BANDS GENERATOR (AUTOMATIC PER LEVEL) ---
function updateRowBands() {
  rowLayer.innerHTML = '';
  if (!state.isRowBandsVisible || state.nodes.length === 0) return;

  // 1. Group nodes by Y-position (Level detection)
  const margin = 60; // Threshold para sa parehong level
  const sortedNodes = [...state.nodes].sort((a, b) => a.y - b.y);
  const levels = [];

  sortedNodes.forEach(node => {
    let level = levels.find(l => Math.abs(l.y - node.y) < margin);
    if (!level) {
      level = { y: node.y, nodes: [] };
      levels.push(level);
    }
    level.nodes.push(node);
  });

  // Sort levels top to bottom
  levels.sort((a, b) => a.y - b.y);

  // 2. Render bands per level
  levels.forEach((level, index) => {
    let minY = Infinity, maxY = -Infinity;
    let minX = Infinity, maxX = -Infinity;

    level.nodes.forEach(n => {
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y + n.h);
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x + n.w);
    });

    const paddingY = 25;
    const paddingX = 40;
    const band = document.createElement('div');
    band.className = 'rowBand';

    const bandColor = state.rowColors[index % state.rowColors.length];
    band.style.position = 'absolute';
    band.style.top = `${minY - paddingY}px`;
    band.style.left = `${Math.max(20, minX - paddingX)}px`;
    band.style.width = `${(maxX - minX) + (paddingX * 2)}px`;
    band.style.height = `${(maxY - minY) + (paddingY * 2)}px`;
    band.style.backgroundColor = bandColor;
    band.style.borderRadius = '28px';
    band.style.zIndex = '0';

    rowLayer.appendChild(band);
  });
}

// --- RENDER FUNCTION ---
function render() {
  // Render Nodes
  layer.innerHTML = '';
  state.nodes.forEach(node => {
    const el = document.createElement('div');
    el.className = `node ${node.type} ${state.selectedNodeIds.has(node.id) ? 'selected' : ''}`;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.w}px`;
    el.style.height = `${node.h}px`;
    if (node.fill) el.style.backgroundColor = node.fill;
    if (node.border) el.style.borderColor = node.border;

    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = node.text || '';
    el.appendChild(txt);

    // Event listeners for dragging and selection
    el.addEventListener('mousedown', (e) => onNodeMouseDown(e, node));

    layer.appendChild(el);
  });

  // Hide empty state message if nodes exist
  const empty = document.getElementById('empty');
  if (empty) empty.style.display = state.nodes.length > 0 ? 'none' : 'block';

  // Update properties panel & row bands
  updatePropertiesPanel();
  updateRowBands();
}

// --- NODE MOUSE EVENTS ---
function onNodeMouseDown(e, node) {
  e.stopPropagation();
  if (!e.shiftKey) {
    state.selectedNodeIds.clear();
  }
  state.selectedNodeIds.add(node.id);
  state.draggingNode = node;
  state.dragOffset = {
    x: e.clientX - node.x,
    y: e.clientY - node.y
  };
  render();
}

window.addEventListener('mousemove', (e) => {
  if (state.draggingNode) {
    state.draggingNode.x = e.clientX - state.dragOffset.x;
    state.draggingNode.y = e.clientY - state.dragOffset.y;
    render();
  }
});

window.addEventListener('mouseup', () => {
  state.draggingNode = null;
});

// --- PROPERTIES PANEL UPDATE ---
function updatePropertiesPanel() {
  if (state.selectedNodeIds.size === 1) {
    const selectedId = Array.from(state.selectedNodeIds)[0];
    const node = state.nodes.find(n => n.id === selectedId);
    if (node) {
      props.classList.remove('disabled');
      pText.value = node.text || '';
      pW.value = node.w;
      pH.value = node.h;
      pX.value = node.x;
      pY.value = node.y;
      pFill.value = node.fill || '#ffffff';
      pBorder.value = node.border || '#334155';
      footerHint.textContent = `Selected: ${node.type} (${node.id})`;
      return;
    }
  }
  props.classList.add('disabled');
  footerHint.textContent = 'Nothing selected';
}

// Bind Property Inputs
pText.addEventListener('input', () => {
  const selectedId = Array.from(state.selectedNodeIds)[0];
  const node = state.nodes.find(n => n.id === selectedId);
  if (node) { node.text = pText.value; render(); }
});

pW.addEventListener('input', () => {
  const node = state.nodes.find(n => n.id === Array.from(state.selectedNodeIds)[0]);
  if (node) { node.w = parseInt(pW.value) || 50; render(); }
});

pH.addEventListener('input', () => {
  const node = state.nodes.find(n => n.id === Array.from(state.selectedNodeIds)[0]);
  if (node) { node.h = parseInt(pH.value) || 30; render(); }
});

pFill.addEventListener('input', () => {
  const node = state.nodes.find(n => n.id === Array.from(state.selectedNodeIds)[0]);
  if (node) { node.fill = pFill.value; render(); }
});

pBorder.addEventListener('input', () => {
  const node = state.nodes.find(n => n.id === Array.from(state.selectedNodeIds)[0]);
  if (node) { node.border = pBorder.value; render(); }
});

// --- DRAG & DROP FROM PALETTE ---
document.querySelectorAll('.palette .item').forEach(item => {
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('type', item.dataset.type);
  });
});

wrap.addEventListener('dragover', (e) => e.preventDefault());

wrap.addEventListener('drop', (e) => {
  e.preventDefault();
  const type = e.dataTransfer.getData('type');
  if (!type) return;

  const rect = canvas.getBoundingClientRect();
  const newNode = {
    id: Date.now().toString(),
    type: type,
    x: e.clientX - rect.left - 60,
    y: e.clientY - rect.top - 30,
    w: type === 'decision' ? 100 : 120,
    h: type === 'decision' ? 60 : 60,
    text: type.charAt(0).toUpperCase() + type.slice(1),
    fill: '#ffffff',
    border: '#334155'
  };

  state.nodes.push(newNode);
  state.selectedNodeIds.clear();
  state.selectedNodeIds.add(newNode.id);
  render();
});

// --- TOGGLE ROW BANDS FUNCTION ---
function toggleRowBands() {
  state.isRowBandsVisible = !state.isRowBandsVisible;
  document.body.classList.toggle('show-row-bands', state.isRowBandsVisible);
  updateRowBands();
}

// --- INITIALIZATION & DEFAULT SETUP ---
document.addEventListener('DOMContentLoaded', () => {
  // Bind Action Buttons
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'toggleRowBands') toggleRowBands();
      if (action === 'delete') {
        state.nodes = state.nodes.filter(n => !state.selectedNodeIds.has(n.id));
        state.selectedNodeIds.clear();
        render();
      }
    });
  });

  // Default Sample Nodes for Testing
  state.nodes = [
    { id: '1', type: 'start', x: 280, y: 50, w: 140, h: 50, text: 'Start Process' },
    { id: '2', type: 'process', x: 80, y: 170, w: 120, h: 60, text: 'Process 1' },
    { id: '3', type: 'process', x: 290, y: 170, w: 120, h: 60, text: 'Process 2' },
    { id: '4', type: 'process', x: 500, y: 170, w: 120, h: 60, text: 'Process 3' },
    { id: '5', type: 'process', x: 180, y: 310, w: 120, h: 60, text: 'Sub-Process 1' },
    { id: '6', type: 'process', x: 410, y: 310, w: 120, h: 60, text: 'Sub-Process 2' }
  ];

  render();
});
