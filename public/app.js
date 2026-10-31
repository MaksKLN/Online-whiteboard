const socket = io();
console.log(JSON.parse(localStorage.getItem("user")));
socket.on("connect", () => {
  mySocketId = socket.id;
});

const user = JSON.parse(localStorage.getItem("user"));

const params = new URLSearchParams(window.location.search);
const boardId = params.get("id");
const inviteToken = params.get("token");

let userRole = "viewer"; // глобальная переменная роли
let mySocketId = null;

if (!user && !inviteToken) {
  window.location.href = "/";
}

// ---------------- CANVAS ----------------
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

// если зашли по токену — получаем роль из инвайта
async function initBoard() {
  if (inviteToken) {
    const res = await fetch(`/api/invite/${inviteToken}`);
    if (!res.ok) { alert("Ссылка недействительна"); window.location.href = "/"; return; }
    const invite = await res.json();
    userRole = invite.role;
  } else if (user) {
    // получаем роль авторизованного пользователя заранее
    const res = await fetch(`/api/boards/${boardId}/my-role?userId=${user.id}`);
    const data = await res.json();
    userRole = data.role;
  }

  socket.emit("join-board", {
    boardId,
    userId: user?.id || null,
    token: inviteToken || null
  });
}

initBoard();


// ---------------- SIZE ----------------
canvas.width = window.innerWidth;
canvas.height = window.innerHeight - 60;

window.addEventListener("resize", () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - 60;
  redraw();
});

// ---------------- STATE ----------------
let tool = "pan";

let scale = 1;
let offsetX = window.innerWidth / 2;
let offsetY = (window.innerHeight - 60) / 2;

let isDrawing = false;
let isPanning = false;

let currentLineId = null;
let lines = {};

let textInput = null;
let isTypingText = false;

let undoStack = [];
let redoStack = [];

let isErasing = false;

let selectedIds = [];
let isSelecting = false;
let selectionRect = null; // { x, y, w, h } в мировых координатах
let isDraggingSelection = false;
let dragStartX = 0;
let dragStartY = 0;
let selectionBounds = null; // bounds выделенной области

let isDrawingShape = false;
let shapeStartX = 0;
let shapeStartY = 0;
let previewShape = null;

let currentShape = "rect";

let showGrid = true;

const remoteCursors = {}; // { socketId: { x, y, username, color } }
let _latestUsers = [];

let chatOpen = false;
let unreadCount = 0;
let mySocketUsername = null;
let chatHistoryLoaded = false;

function getShapeColor() {
  return document.getElementById("shapeColor")?.value || "#000000";
}

function getShapeSize() {
  return parseInt(document.getElementById("shapeSize")?.value || "2", 10);
}

function getSelectionBounds(ids) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  ids.forEach(id => {
    const obj = lines[id];
    if (!obj) return;

    if (obj.type === "text") {
      const w = obj.text.length * obj.size * 0.6;
      minX = Math.min(minX, obj.x);
      minY = Math.min(minY, obj.y - obj.size);
      maxX = Math.max(maxX, obj.x + w);
      maxY = Math.max(maxY, obj.y);
    }

    if (obj.type === "line") {
      obj.points.forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    }

    if (obj.type === "shape") {
      minX = Math.min(minX, obj.x1, obj.x2);
      minY = Math.min(minY, obj.y1, obj.y2);
      maxX = Math.max(maxX, obj.x1, obj.x2);
      maxY = Math.max(maxY, obj.y1, obj.y2);
    }

  });

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function objectInRect(obj, rect) {
  const r = {
    x1: Math.min(rect.x, rect.x + rect.w),
    y1: Math.min(rect.y, rect.y + rect.h),
    x2: Math.max(rect.x, rect.x + rect.w),
    y2: Math.max(rect.y, rect.y + rect.h),
  };

  if (obj.type === "text") {
    const w = obj.text.length * obj.size * 0.6;
    return obj.x < r.x2 && obj.x + w > r.x1 &&
           obj.y - obj.size < r.y2 && obj.y > r.y1;
  }

  if (obj.type === "line") {
    return obj.points.some(p => p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2);
  }

  if (obj.type === "shape") {
    const minX = Math.min(obj.x1, obj.x2);
    const maxX = Math.max(obj.x1, obj.x2);
    const minY = Math.min(obj.y1, obj.y2);
    const maxY = Math.max(obj.y1, obj.y2);

   return minX < r.x2 && maxX > r.x1 && minY < r.y2 && maxY > r.y1;
  }

  return false;
}

function pointInBounds(x, y, bounds, padding = 10) {
  return x >= bounds.x - padding && x <= bounds.x + bounds.w + padding &&
         y >= bounds.y - padding && y <= bounds.y + bounds.h + padding;
}

// ---------------- HELPERS ----------------
function worldX(x) {
  return (x - offsetX) / scale;
}

function worldY(y) {
  return (y - offsetY) / scale;
}

function getBrushColor() {
  return document.getElementById("colorPicker").value;
}

function getBrushSize() {
  return parseInt(document.getElementById("sizePicker").value, 10);
}

function getShapeFill() {
  return document.getElementById("shapeFill")?.checked || false;
}

// ---------------- TOOL ----------------
function setTool(t, e) {
  if (e) e.stopPropagation();

  selectedIds = [];
  selectionBounds = null;
  selectionRect = null;
  redraw();

  tool = t;

  console.log("TOOL:", tool);

  document.querySelectorAll(".tool").forEach(el =>
    el.classList.remove("active")
  );

  const el = document.querySelector(`[data-tool="${t}"]`);
  if (el) el.classList.add("active");

  const brushPanel = document.getElementById("brushPanel");
  const textPanel = document.getElementById("textPanel");
  const shapesPanel = document.getElementById("shapesPanel");
  shapesPanel.style.display = "none";

  // начала ВСЕ закрываем
  brushPanel.style.display = "none";
  textPanel.style.display = "none";

  if (t === "shapes") {
    shapesPanel.style.display = "flex";
    const rect = el.getBoundingClientRect();
    shapesPanel.style.left = rect.right + 10 + "px";
    // центрируем по вертикали после отображения
    const panelHeight = shapesPanel.offsetHeight;
    shapesPanel.style.top = (rect.top + rect.height / 2 - panelHeight / 2) + "px";
  }

  // DRAW
  if (t === "draw") {
    brushPanel.style.display = "flex";

    const rect = el.getBoundingClientRect();
    brushPanel.style.top = rect.top + "px";
    brushPanel.style.left = rect.right + 10 + "px";
  }

  // TEXT
  if (t === "text") {
    textPanel.style.display = "flex";

    const rect = el.getBoundingClientRect();
    textPanel.style.top = rect.top + "px";
    textPanel.style.left = rect.right + 10 + "px";
  }

  // cursor
  if (tool === "pan") canvas.style.cursor = "grab";
  else if (tool === "draw") canvas.style.cursor = "crosshair";
  else if (tool === "text") canvas.style.cursor = "text";
  else if (tool === "erase") canvas.style.cursor = "crosshair";
  else if (tool === "select") canvas.style.cursor = "grab";
  else if (tool === "shapes") canvas.style.cursor = "crosshair";
  else canvas.style.cursor = "default";
  

  redraw();
}

function getTextColor() {
  return document.getElementById("textColor").value;
}

function getTextSize() {
  return parseInt(document.getElementById("textSize").value, 10);
}

function createTextInput(x, y) {

  if (textInput) textInput.remove();

  const input = document.createElement("input");

  input.style.position = "absolute";
  input.style.left = (x * scale + offsetX) + "px";
  input.style.top = (y * scale + offsetY) + "px";
  input.style.transform = "translate(-0px, 33px)";

  input.style.fontSize = getTextSize() + "px";
  input.style.color = getTextColor();
  input.style.border = "none";
  input.style.outline = "none";
  input.style.background = "transparent";
  input.style.zIndex = 10000;
  input.style.pointerEvents = "auto";
  input.style.padding = "0";
  input.style.margin = "0";
  input.style.fontFamily = "Arial";
  input.style.lineHeight = "1";

  document.body.appendChild(input);
  input.focus({ preventScroll: true });

  isTypingText = true;
  textInput = input;

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commitText(x, y, input.value);
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.body.contains(input)) {
        commitText(x, y, input.value);
      }
    }, 150);
  });
  console.log("CREATE INPUT AT:", x, y);
}

function commitText(x, y, value) {

  if (!textInput) return;

  if (value.trim() !== "") {

    const id = Date.now() + "_" + Math.random();

    const op = {
      type: "add-text",
      id,
      data: {
        x,
        y,
        text: value,
        size: getTextSize(),
        color: getTextColor()
      }
    };

    applyOp(op);
    socket.emit("op", { boardId, op });

    undoStack.push(op);
    redoStack = [];

    socket.emit("add-text", {
      boardId,
      userId: user?.id,
      token: inviteToken || null,
      id,
      x,
      y,
      text: value,
      size: getTextSize(),
      color: getTextColor()
    });

  }

  textInput.remove();
  textInput = null;
  isTypingText = false;

  redraw();
  console.log("COMMIT TEXT:", value);
}

function applyOp(op) {
  if (op.type === "add-line") {
    lines[op.id] = {
      type: "line",
      ...op.data
    };
  }

  if (op.type === "add-text") {
    lines[op.id] = {
      type: "text",
      ...op.data
    };
  }

  if (op.type === "add-shape") {
    lines[op.id] = { type: "shape", ...op.data };
  }
}

canvas.addEventListener("mousedown", () => {
  console.log("canvas click tool =", tool);
});
// ---------------- MOUSE DOWN ----------------
canvas.addEventListener("mousedown", (e) => {

  const x = worldX(e.offsetX);
  const y = worldY(e.offsetY);

  if (tool === "erase") {
    isErasing = true;
    eraseAtPoint(worldX(e.offsetX), worldY(e.offsetY));
    return;
  }

  if (tool === "text") {
    e.preventDefault();
    e.stopPropagation();

    const x = worldX(e.offsetX);
    const y = worldY(e.offsetY);

    createTextInput(x, y);
    return;
  }

  // ---------------- PAN ----------------
  if (tool === "pan") {
    isPanning = true;
    return;
  }

  if (tool === "select") {
    const x = worldX(e.offsetX);
    const y = worldY(e.offsetY);

    // если клик внутри выделения — начинаем перетаскивание
    if (selectedIds.length > 0 && selectionBounds && pointInBounds(x, y, selectionBounds)) {
      isDraggingSelection = true;
      dragStartX = x;
      dragStartY = y;
      return;
    }

    // иначе начинаем новое выделение
    selectedIds = [];
    selectionBounds = null;
    isSelecting = true;
    selectionRect = { x, y, w: 0, h: 0 };
    return;
  }

  if (tool === "shapes") {
    isDrawingShape = true;
    shapeStartX = x;
    shapeStartY = y;
    previewShape = null; // ← добавь
    return;
  }

  // ---------------- DRAW ----------------
  if (tool !== "draw") return;

  isDrawing = true;

  const id = Date.now() + "_" + Math.random();
  currentLineId = id;

  const op = {
    type: "add-line",
    id,
    data: {
      color: getBrushColor(),
      size: getBrushSize(),
      points: [{ x, y }]
    }
  };

  applyOp(op);
  socket.emit("op", { boardId, op });

  undoStack.push(op);
  redoStack = [];

  socket.emit("start-line", {
    boardId,
    userId: user?.id,
    token: inviteToken || null,
    id,
    x,
    y,
    color: getBrushColor(),
    size: getBrushSize()
  });
  console.log("CURRENT TOOL:", tool);
});

function eraseAtPoint(x, y) {
  const radius = 15;

  for (const id in lines) {
    const obj = lines[id];
    if (!obj) continue;

    if (obj.type === "text") {
      const textWidth = (obj.text.length * obj.size * 0.6);
      const textHeight = obj.size;
      const left = obj.x;
      const top = obj.y - textHeight;
      const right = left + textWidth;
      const bottom = obj.y;

      const inside = x >= left - radius && x <= right + radius &&
                     y >= top - radius && y <= bottom + radius;

      if (inside) {
        delete lines[id];
        socket.emit("undo", { boardId, userId: user?.id, token: inviteToken || null, id });
      }
      continue;
    }

    if (obj.type === "shape") {
      const minX = Math.min(obj.x1, obj.x2);
      const maxX = Math.max(obj.x1, obj.x2);
      const minY = Math.min(obj.y1, obj.y2);
      const maxY = Math.max(obj.y1, obj.y2);

      const inside = x >= minX - radius && x <= maxX + radius &&
                     y >= minY - radius && y <= maxY + radius;

      if (inside) {
        delete lines[id];
        socket.emit("undo", { boardId, userId: user?.id, token: inviteToken || null, id });
      }
      continue;
    }

    if (obj.type === "line") {
      for (const p of obj.points) {
        const dx = p.x - x;
        const dy = p.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < radius) {
          delete lines[id];
          socket.emit("undo", { boardId, userId: user?.id, token: inviteToken || null, id });
          break;
        }
      }
    }
  }

  redraw();
}

// ---------------- MOUSE MOVE ----------------
canvas.addEventListener("mousemove", (e) => {

  const now = Date.now();
  if (!canvas._lastCursorSend || now - canvas._lastCursorSend > 30) {
    canvas._lastCursorSend = now;
    socket.emit("cursor-move", { boardId, x: worldX(e.offsetX), y: worldY(e.offsetY) });
  }

  const x = worldX(e.offsetX);
  const y = worldY(e.offsetY);

  if (tool === "erase" && isErasing) {
    eraseAtPoint(x, y);
    return;
  }

  // ---------------- PAN ----------------
  if (isPanning) {
    offsetX += e.movementX;
    offsetY += e.movementY;
    redraw();
    return;
  }

  if (tool === "select") {
    const x = worldX(e.offsetX);
    const y = worldY(e.offsetY);

    if (isDraggingSelection) {
      const dx = x - dragStartX;
      const dy = y - dragStartY;
      dragStartX = x;
      dragStartY = y;

      // перемещаем все выделенные объекты
      selectedIds.forEach(id => {
        const obj = lines[id];
        if (!obj) return;

        if (obj.type === "text") {
          obj.x += dx;
          obj.y += dy;
        }

        if (obj.type === "line") {
          obj.points = obj.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        }

        if (obj.type === "shape") {
          obj.x1 += dx;
          obj.y1 += dy;
          obj.x2 += dx;
          obj.y2 += dy;
        }
      });

      // обновляем bounds
      selectionBounds.x += dx;
      selectionBounds.y += dy;

      redraw();
      return;
    }

    if (isSelecting && selectionRect) {
      selectionRect.w = x - selectionRect.x;
      selectionRect.h = y - selectionRect.y;
      redraw();
      return;
    }
  }

  if (tool === "shapes" && isDrawingShape) {
    previewShape = {
      type: "shape",
      shape: currentShape,
      x1: shapeStartX,
      y1: shapeStartY,
      x2: x,
      y2: y,
      color: getShapeColor(),
      size: getShapeSize(),
      fill: getShapeFill()
    };
    redraw();
    return;
  }

  // ---------------- DRAW ----------------
  if (!isDrawing || tool !== "draw") return;

  const line = lines[currentLineId];
  if (!line) return;

  line.points.push({ x, y });

  socket.emit("draw-point", {
    boardId,
    userId: user?.id,
    token: inviteToken || null,
    id: currentLineId,
    x,
    y
  });

  redraw();
});

canvas.addEventListener("mouseleave", () => {
  socket.emit("cursor-leave", { boardId });
});

// ---------------- MOUSE UP ----------------
canvas.addEventListener("mouseup", (e) => {
  const x = worldX(e.offsetX);
  const y = worldY(e.offsetY);

  isPanning = false;
  isDrawing = false;
  isErasing = false;

  if (currentLineId) {
    socket.emit("end-line", {
      boardId,
      userId: user?.id,
      token: inviteToken || null,
      id: currentLineId
    });
  }

  currentLineId = null;

  if (tool === "select") {
    if (isDraggingSelection) {
      isDraggingSelection = false;

      // сохраняем перемещённые объекты в БД и синхронизируем
      selectedIds.forEach(id => {
        const obj = lines[id];
        if (!obj) return;

        socket.emit("move-object", {
          boardId,
          userId: user?.id || null,
          token: inviteToken || null,
          id,
          obj
        });
      });

      return;
    }

    if (isSelecting && selectionRect) {
      isSelecting = false;

      // находим объекты в рамке
      selectedIds = Object.keys(lines).filter(id => objectInRect(lines[id], selectionRect));

      console.log("all lines:", Object.keys(lines).map(id => lines[id].type));
      console.log("selectionRect:", selectionRect);
      console.log("selectedIds:", selectedIds);

      if (selectedIds.length > 0) {
        selectionBounds = getSelectionBounds(selectedIds);
        console.log("selectionBounds:", selectionBounds);
      }

      selectionRect = null;
      redraw();
    }

    return;
  }

  if (tool === "shapes" && isDrawingShape) {
    console.log("drawing shape:", currentShape);
    isDrawingShape = false;

    if (Math.abs(x - shapeStartX) < 3 && Math.abs(y - shapeStartY) < 3) {
      previewShape = null;
      return;
    }

    const id = Date.now() + "_" + Math.random();
    const obj = {
      type: "shape",
      shape: currentShape,
      x1: shapeStartX,
      y1: shapeStartY,
      x2: x,
      y2: y,
      color: getShapeColor(),
      size: getShapeSize(),
      fill: getShapeFill()
    };

    lines[id] = obj;
    previewShape = null;

    const op = { type: "add-shape", id, data: obj };
    undoStack.push(op);
    redoStack = [];

    socket.emit("add-shape", {
      boardId,
      userId: user?.id || null,
      token: inviteToken || null,
      id,
      ...obj
    });

    redraw();
    return;
  }

  redraw();
});

function drawShape(ctx, obj, isPreview = false) {
  const { shape, x1, y1, x2, y2, color, size, fill } = obj;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);

  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;

  ctx.beginPath();

  if (shape === "line") {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

  } else if (shape === "arrow") {
    drawArrow(ctx, x1, y1, x2, y2, size);

  } else if (shape === "dashed-line") {
    ctx.setLineDash([10 / scale, 5 / scale]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

  } else if (shape === "dashed-arrow") {
    ctx.setLineDash([10 / scale, 5 / scale]);
    drawArrow(ctx, x1, y1, x2, y2, size);
    ctx.setLineDash([]);

  } else if (shape === "rect") {
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    if (fill) ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

  } else if (shape === "square") {
    const side = Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1));
    const sx = x2 > x1 ? x1 : x1 - side;
    const sy = y2 > y1 ? y1 : y1 - side;
    ctx.strokeRect(sx, sy, side, side);
    if (fill) ctx.fillRect(sx, sy, side, side);

  } else if (shape === "circle") {
    const r = Math.min(rx, ry);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (fill) ctx.fill();

  } else if (shape === "ellipse") {
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (fill) ctx.fill();

  } else if (shape === "triangle") {
    ctx.moveTo(cx, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x1, y2);
    ctx.closePath();
    ctx.stroke();
    if (fill) ctx.fill();

  } else if (shape === "diamond") {
    ctx.moveTo(cx, y1);
    ctx.lineTo(x2, cy);
    ctx.lineTo(cx, y2);
    ctx.lineTo(x1, cy);
    ctx.closePath();
    ctx.stroke();
    if (fill) ctx.fill();
  }
}

function drawArrow(ctx, x1, y1, x2, y2, size) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(15, size * 4);

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function undo() {
  console.log("UNDO CLICKED");
  const op = undoStack.pop();
  if (!op) return;

  redoStack.push(op);

  if (op.type === "add-line" || op.type === "add-text" || op.type === "add-shape") {
    delete lines[op.id];

    socket.emit("undo", {
      boardId,
      userId: user?.id,
      token: inviteToken || null,
      id: op.id
    });
  }

  redraw();
}

function redo() {
  console.log("REDO CLICKED");
  const op = redoStack.pop();
  if (!op) return;

  undoStack.push(op);

  applyOp(op);

  socket.emit("redo", {
    boardId,
    userId: user?.id,
    token: inviteToken || null,
    op
  });

  redraw();
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "z") {
    undo();
  }

  if (e.ctrlKey && e.key === "y") {
    redo();
  }
});

// ---------------- ZOOM ----------------
function setZoom(newScale, cx, cy) {

  const prev = scale;
  scale = Math.max(0.2, Math.min(5, newScale));

  if (cx !== undefined) {
    const wx = (cx - offsetX) / prev;
    const wy = (cy - offsetY) / prev;

    offsetX = cx - wx * scale;
    offsetY = cy - wy * scale;
  }

  updateZoom();
  redraw();
}

function zoomIn() {
  setZoom(scale + 0.1, canvas.width / 2, canvas.height / 2);
}

function zoomOut() {
  setZoom(scale - 0.1, canvas.width / 2, canvas.height / 2);
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();

  const delta = e.deltaY < 0 ? 1 : -1;
  setZoom(scale + delta * 0.1, e.offsetX, e.offsetY);

}, { passive: false });

function updateZoom() {
  document.getElementById("zoomValue").innerText =
    Math.round(scale * 100) + "%";
}

// ---------------- RENDER ----------------
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  // сетка
  if (showGrid) {
    const gridSize = 40;
    const left = -offsetX / scale;
    const top = -offsetY / scale;
    const right = left + canvas.width / scale;
    const bottom = top + canvas.height / scale;

    const startX = Math.floor(left / gridSize) * gridSize;
    const startY = Math.floor(top / gridSize) * gridSize;

    // сетка
    ctx.strokeStyle = "#afafaf";
    ctx.lineWidth = 0.5 / scale;
    ctx.setLineDash([]);

    for (let x = startX; x < right; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }

    for (let y = startY; y < bottom; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }

    // главные оси
    ctx.strokeStyle = "#4e4e4e";
    ctx.lineWidth = 1.5 / scale;

    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(0, bottom);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(left, 0);
    ctx.lineTo(right, 0);
    ctx.stroke();
  }

  Object.values(lines).forEach(line => {
    
    if (line.type === "text") {

      ctx.fillStyle = line.color || "#000";
      ctx.font = `${line.size}px Arial`;
      ctx.fillText(line.text, line.x, line.y);

      return;
    }

    if (line.type === "shape") {
      ctx.globalAlpha = 1;
      drawShape(ctx, line);
      return;
    }

    const p = line.points;
    if (p.length < 2) return;

    ctx.beginPath();

    ctx.strokeStyle = line.color || "#000";
    ctx.lineWidth = (line.size || 2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.moveTo(p[0].x, p[0].y);

    for (let i = 1; i < p.length; i++) {
      ctx.lineTo(p[i].x, p[i].y);
    }

    ctx.stroke();
  });

  if (previewShape) {
    ctx.globalAlpha = 0.5;
    drawShape(ctx, previewShape, true);
    ctx.globalAlpha = 1;
  }

  // рамка выделения при рисовании
  if (isSelecting && selectionRect) {
    ctx.setLineDash([6 / scale, 3 / scale]);
    ctx.strokeStyle = "#1565c0";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
    ctx.setLineDash([]);
  }

  // рамка вокруг выделенных объектов
  if (selectedIds.length > 0 && selectionBounds) {
    ctx.setLineDash([6 / scale, 3 / scale]);
    ctx.strokeStyle = "#1565c0";
    ctx.lineWidth = 1.5 / scale;
    const pad = 8 / scale;
    ctx.strokeRect(
      selectionBounds.x - pad,
      selectionBounds.y - pad,
      selectionBounds.w + pad * 2,
      selectionBounds.h + pad * 2
    );
    ctx.setLineDash([]);
  }

  ctx.restore();
  
  for (const sid in remoteCursors) {
    const c = remoteCursors[sid];
    const sx = c.x * scale + offsetX;
    const sy = c.y * scale + offsetY;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // сбрасываем трансформацию — курсоры в экранных координатах

    // стрелка
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx, sy + 16);
    ctx.lineTo(sx + 4, sy + 12);
    ctx.lineTo(sx + 7, sy + 18);
    ctx.lineTo(sx + 9, sy + 17);
    ctx.lineTo(sx + 6, sy + 11);
    ctx.lineTo(sx + 11, sy + 11);
    ctx.closePath();
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1;
    ctx.stroke();

    // бейджик с именем
    ctx.font = "bold 12px Arial";
    const tw = ctx.measureText(c.username).width;
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.roundRect(sx + 12, sy + 14, tw + 10, 20, 4);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.fillText(c.username, sx + 17, sy + 28);

    ctx.restore();
  }
}

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 60%, 50%)`;
}

function renderUsersList(users) {
  const container = document.getElementById("usersListContainer");
  if (!container) return;

  container.innerHTML = "";

  users.forEach(u => {
    const isMe = u.socketId === mySocketId;
    //console.log("user:", u.username, "isMe:", isMe, "userRole:", userRole, "u.userId:", u.userId, "show controls:", userRole === "owner" && !isMe && u.userId);
    const div = document.createElement("div");
    div.className = "user";
    div.style.justifyContent = "space-between";

    const roleLabel = { owner: "Владелец", editor: "Редактор", viewer: "Зритель" };

    div.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <div class="avatar" style="background:${hashColor(u.username)}; display:flex; align-items:center; justify-content:center; color:white; font-weight:bold; font-size:14px;">
          ${u.username.charAt(0).toUpperCase()}
        </div>
        <div>${u.username}${isMe ? " (вы)" : ""}</div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;" id="controls_${u.socketId}">
        ${userRole !== "owner" || isMe
          ? `<span style="font-size:12px; color:#666;">${roleLabel[u.role] || u.role}</span>`
          : ""
        }
      </div>
    `;

    container.appendChild(div);

    if (userRole === "owner" && !isMe) {
      document.getElementById(`controls_${u.socketId}`).innerHTML = `
        <select onchange="changeRole(${u.userId || null}, '${u.socketId}', this.value)" style="font-size:12px; padding:2px;">
          <option value="viewer" ${u.role === "viewer" ? "selected" : ""}>Зритель</option>
          <option value="editor" ${u.role === "editor" ? "selected" : ""}>Редактор</option>
        </select>
        <button onclick="kickUser(${u.userId || null}, '${u.socketId}')" style="font-size:11px; padding:2px 6px; background:#e53935; color:white; border:none; border-radius:4px; cursor:pointer;">✕</button>
       `;
    }

    
  });
}

async function changeRole(targetUserId, targetSocketId, role) {
  await fetch(`/api/boards/${boardId}/users/${targetUserId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, requesterId: user.id, targetSocketId })
  });
}

async function kickUser(targetUserId, targetSocketId) {
  if (targetUserId) {
    await fetch(`/api/boards/${boardId}/users/${targetUserId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterId: user.id })
    });
  } else {
    // гость — кикаем по socketId через сокет
    socket.emit("kick-guest", { boardId, targetSocketId, requesterId: user.id });
  }
}

async function loadChatHistory() {
  const res = await fetch(`/api/boards/${boardId}/chat`);
  const messages = await res.json();
  messages.forEach(m => {
    m.userId = m.user_id;
    appendChatMessage(m, false);
  });
}

function appendChatMessage(msg, isNew = true) {
  const container = document.getElementById("chatMessages");
  const isMe = user ? msg.userId === user.id : msg.username === mySocketUsername;
  console.log("msg.userId:", msg.userId, "user?.id:", user?.id, "msg.username:", msg.username, "mySocketUsername:", mySocketUsername, "isMe:", isMe);

  const time = new Date(msg.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  const div = document.createElement("div");
  div.style.cssText = `
    display:flex;
    flex-direction:column;
    align-items:${isMe ? "flex-end" : "flex-start"};
  `;

  div.innerHTML = `
    ${!isMe ? `<div style="font-size:11px; color:#999; margin-bottom:2px; padding-left:4px;">${msg.username}</div>` : ""}
    <div style="
      max-width:80%;
      padding:8px 12px;
      border-radius:${isMe ? "16px 16px 4px 16px" : "16px 16px 16px 4px"};
      background:${isMe ? "#1565c0" : "#f0f0f0"};
      color:${isMe ? "white" : "#333"};
      font-size:13px;
      line-height:1.4;
      word-break:break-word;
    ">${msg.text}</div>
    <div style="font-size:10px; color:#aaa; margin-top:2px; padding:0 4px;">${time}</div>
  `;

  container.appendChild(div);

  if (isNew) {
    container.scrollTop = container.scrollHeight;
    if (!chatOpen) {
      unreadCount++;
      const badge = document.getElementById("chatBadge");
      badge.style.display = "flex";
      badge.textContent = unreadCount;
    }
  }
}

function sendChatMessage() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat-message", { boardId, text });
  input.value = "";
}

function toggleChat(e) {
  e.stopPropagation();
  const panel = document.getElementById("chatPanel");
  chatOpen = !chatOpen;
  panel.style.display = chatOpen ? "flex" : "none";

  if (chatOpen) {
    unreadCount = 0;
    const badge = document.getElementById("chatBadge");
    badge.style.display = "none";
    badge.textContent = "0";
    const container = document.getElementById("chatMessages");
    container.scrollTop = container.scrollHeight;
  }
}

socket.on("chat-message", (msg) => {
  console.log("new msg:", msg.username, "mySocketUsername:", mySocketUsername, "user:", user);
  appendChatMessage(msg);
});

document.getElementById("chatInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

// ---------------- SOCKET ----------------
socket.on("move-object", ({ id, obj }) => {
  lines[id] = obj;
  redraw();
});

socket.on("add-shape", (data) => {
  const { id, ...shapeData } = data;
  lines[id] = { type: "shape", ...shapeData };
  redraw();
});

socket.on("kicked", () => {
  alert("Вы были удалены с доски");
  window.location.href = user ? "/dashboard.html" : "/";
});

socket.on("init-board", ({ data, role }) => {
  if (data) lines = data;
  userRole = role;

  if (role === "viewer") {
    setTool("pan");
    const tools = ["draw", "text", "erase", "select", "shapes"];
    tools.forEach(t => {
      const el = document.querySelector(`[data-tool="${t}"]`);
      if (el) el.style.display = "none";
    });
    document.querySelector(".history").style.display = "none";
  }

  redraw();
});

socket.on("start-line", (data) => {
  lines[data.id] = {
    color: data.color,
    size: data.size,
    points: [{ x: data.x, y: data.y }]
  };
});

socket.on("draw-point", (data) => {
  const line = lines[data.id];
  if (!line) return;

  line.points.push({ x: data.x, y: data.y });
  redraw();
});

socket.on("end-line", () => {
  redraw();
});

socket.on("add-text", (data) => {
  lines[data.id] = {
    type: "text",
    x: data.x,
    y: data.y,
    text: data.text,
    size: data.size,
    color: data.color
  };

  redraw();
});

socket.on("undo", (data) => {
  delete lines[data.id];
  redraw();
});

socket.on("redo", (data) => {
  const op = data.op;
  if (op.type === "add-text") {
    lines[op.id] = { type: "text", ...op.data };
  } else {
    lines[op.id] = { type: "line", ...op.data };
  }
  redraw();
});

socket.on("users-update", (users) => {
  _latestUsers = users;
  renderUsersList(users);
  const ids = new Set(users.map(u => u.socketId));
  for (const sid in remoteCursors) {
    if (!ids.has(sid)) delete remoteCursors[sid];
  }
  const me = users.find(u => u.socketId === mySocketId);
  if (me) {
    mySocketUsername = me.username;
    if (!chatHistoryLoaded) {
      chatHistoryLoaded = true;
      loadChatHistory();
    }
  }
});

socket.on("role-changed", ({ role }) => {
  userRole = role;

  const tools = ["draw", "text", "erase", "select", "shapes"];

  if (role === "viewer") {
    setTool("pan");
    tools.forEach(t => {
      const el = document.querySelector(`[data-tool="${t}"]`);
      if (el) el.style.display = "none";
    });
    document.querySelector(".history").style.display = "none";
  } else {
    tools.forEach(t => {
      const el = document.querySelector(`[data-tool="${t}"]`);
      if (el) el.style.display = "flex";
    });
    document.querySelector(".history").style.display = "flex";
  }
});

socket.on("cursor-move", ({ socketId, x, y }) => {
  const u = _latestUsers.find(u => u.socketId === socketId);
  if (!u) return;
  remoteCursors[socketId] = { x, y, username: u.username, color: hashColor(u.username) };
  redraw();
});

// ---------------- INIT ----------------
window.onload = () => {
  setTool("pan");
  updateZoom();
};