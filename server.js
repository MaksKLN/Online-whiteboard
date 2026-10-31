const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: process.env.DB_HOST || "localhost",
  database: "postgres",
  password: "1029",
  port: 5432,
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const bcrypt = require("bcrypt");

const crypto = require("crypto");

app.use(express.static("public"));

// хранение досок в памяти
const boards = {};
const boardUsers = {}; // { boardId: [ { socketId, userId, username, role } ] }

async function loadBoard(boardId) {
  //console.log("loadBoard called, boardId =", boardId, typeof boardId);
  
  const res = await pool.query(
    "SELECT data FROM board_data WHERE board_id = $1",
    [parseInt(boardId)]
  );

  //console.log("loadBoard rows =", res.rows.length, res.rows[0]);

  if (res.rows.length === 0) return {};

  return res.rows[0].data || {};
}

async function saveBoard(boardId, data) {
  await pool.query(
    `INSERT INTO board_data (board_id, data)
     VALUES ($1, $2)
     ON CONFLICT (board_id)
     DO UPDATE SET data = $2`,
    [parseInt(boardId), data] // ← добавь parseInt
  );
}

// Проверка роли — работает и для авторизованных и для гостей по токену
async function getRole(boardId, userId, token, socketId) {
  // сначала смотрим в памяти — там актуальная роль
  if (boardUsers[boardId] && socketId) {
    const cached = boardUsers[boardId].find(u => u.socketId === socketId);
    if (cached) return cached.role;
  }

  if (userId) {
    const res = await pool.query(
      "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
      [parseInt(boardId), userId]
    );
    return res.rows[0]?.role || null;
  }

  if (token) {
    const res = await pool.query(
      "SELECT role FROM invites WHERE token=$1 AND board_id=$2",
      [token, parseInt(boardId)]
    );
    return res.rows[0]?.role || null;
  }

  return null;
}

io.on("connection", (socket) => {

  socket.on("join-board", async ({ boardId, userId, token }) => {
    socket.join(boardId);

    if (!boards[boardId]) {
      boards[boardId] = await loadBoard(boardId);
    }

    let role = "viewer";

    if (userId) {
      // авторизованный пользователь
      const res = await pool.query(
        "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
        [parseInt(boardId), userId]
      );
      if (res.rows[0]) role = res.rows[0].role;
    } else if (token) {
      // гость по ссылке
      const res = await pool.query(
        "SELECT role FROM invites WHERE token=$1 AND board_id=$2",
        [token, parseInt(boardId)]
      );
      if (res.rows[0]) role = res.rows[0].role;
    }

    if (!boardUsers[boardId]) boardUsers[boardId] = [];

    boardUsers[boardId] = boardUsers[boardId].filter(u => u.socketId !== socket.id);
    boardUsers[boardId].push({
      socketId: socket.id,
      userId: userId || null,
      username: userId ? (await pool.query("SELECT username FROM users WHERE id=$1", [userId])).rows[0]?.username : ("Гость_" + Math.floor(Math.random() * 9000 + 1000)),
      role,
      token: token || null
    });

    // отправляем всем в комнате обновлённый список
    io.to(boardId).emit("users-update", boardUsers[boardId]);

    // при отключении
    socket.on("disconnect", () => {
      for (const boardId in boardUsers) {
        boardUsers[boardId] = boardUsers[boardId].filter(u => u.socketId !== socket.id);
        io.to(boardId).emit("users-update", boardUsers[boardId]);
      }
    });

    socket.emit("init-board", { data: boards[boardId], role });
  });

  socket.on("start-line", async (data) => {
    const { boardId, userId, token, id, x, y, color, size } = data;

    const role = await getRole(boardId, userId, token, socket.id);
    if (!role || role === "viewer") return;

    if (!boards[boardId]) boards[boardId] = {};

    boards[boardId][id] = {
      type: "line",
      color,
      size,
      points: [{ x, y }]
    };

    await saveBoard(boardId, boards[boardId]);

    socket.to(boardId).emit("start-line", data);
  });

  socket.on("draw-point", async (data) => {
    const { boardId, userId, token, id, x, y } = data;

    const role = await getRole(boardId, userId, token, socket.id);
    if (!role || role === "viewer") return;

    if (boards[boardId]?.[id]) {
      boards[boardId][id].points.push({ x, y });

      await saveBoard(boardId, boards[boardId]);
    }

    socket.to(boardId).emit("draw-point", data);
  });

  socket.on("end-line", (data) => {
    socket.to(data.boardId).emit("end-line", data);
  });

  socket.on("add-text", async (data) => {
    const { boardId, userId, token, id, x, y, text, size, color } = data;

    const role = await getRole(boardId, userId, token, socket.id);
    if (!role || role === "viewer") return;

    if (!boards[boardId]) boards[boardId] = {};

    boards[boardId][id] = {
      type: "text",
      x,
      y,
      text,
      size,
      color
    };

    await saveBoard(boardId, boards[boardId]);

    socket.to(boardId).emit("add-text", data);
  });

  socket.on("undo", async (data) => {
    const { boardId, userId, token, id } = data;

    const role = await getRole(boardId, userId, token, socket.id);
    if (!role || role === "viewer") return;

    if (boards[boardId]) {
      delete boards[boardId][id];

      await saveBoard(boardId, boards[boardId]);
    }

    socket.to(boardId).emit("undo", data);
  });

  socket.on("redo", async (data) => {
    const { boardId, userId, token, op } = data;

    const role = await getRole(boardId, userId, token, socket.id);
    if (!role || role === "viewer") return;

    if (!boards[boardId]) boards[boardId] = {};

    boards[boardId][op.id] = {
      type: op.type === "add-text" ? "text" : "line",
      ...op.data
    };

    await saveBoard(boardId, boards[boardId]);

    socket.to(boardId).emit("redo", data);
  });

  socket.on("kick-guest", async ({ boardId, targetSocketId, requesterId }) => {
    const self = await pool.query(
      "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
      [boardId, requesterId]
    );
    if (self.rows[0]?.role !== "owner") return;

    // находим токен гостя и удаляем из БД
    if (boardUsers[boardId]) {
      const target = boardUsers[boardId].find(u => u.socketId === targetSocketId);
      if (target?.token) {
        await pool.query("DELETE FROM invites WHERE token=$1", [target.token]);
      }
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit("kicked");
      targetSocket.disconnect();
    }
  });

  socket.on("move-object", async (data) => {
    const { boardId, userId, token, id, obj } = data;

    const role = await getRole(boardId, userId, token, socket.id);
    if (!role || role === "viewer") return;

    if (boards[boardId]) {
      boards[boardId][id] = obj;
      await saveBoard(boardId, boards[boardId]);
    }

    socket.to(boardId).emit("move-object", { id, obj });
  });

  socket.on("add-shape", async (data) => {
    const { boardId, userId, token, id, ...shapeData } = data;

    const role = await getRole(boardId, userId, token, socket.id);
    if (!role || role === "viewer") return;

    if (!boards[boardId]) boards[boardId] = {};
    boards[boardId][id] = { type: "shape", ...shapeData };

    await saveBoard(boardId, boards[boardId]);
    socket.to(boardId).emit("add-shape", data);
  });

  socket.on("cursor-move", ({ boardId, x, y }) => {
    socket.to(boardId).emit("cursor-move", { socketId: socket.id, x, y });
  });

  socket.on("cursor-leave", ({ boardId }) => {
    socket.to(boardId).emit("cursor-leave", { socketId: socket.id });
  });

  socket.on("chat-message", async ({ boardId, text }) => {
    const userEntry = boardUsers[boardId]?.find(u => u.socketId === socket.id);
    if (!userEntry || !text?.trim()) return;

    const result = await pool.query(
      "INSERT INTO chat_messages (board_id, user_id, username, text) VALUES ($1, $2, $3, $4) RETURNING id, created_at",
      [parseInt(boardId), userEntry.userId || null, userEntry.username, text.trim()]
    );

    const msg = {
      id: result.rows[0].id,
      username: userEntry.username,
      userId: userEntry.userId,
      text: text.trim(),
      created_at: result.rows[0].created_at
    };

    io.to(boardId).emit("chat-message", msg);
  });
  
});

app.use(express.json());

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
      [username, hash] // ← hash, не password
    );

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: "User exists" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query(
    "SELECT * FROM users WHERE username = $1",
    [username]
  );

  const user = result.rows[0];

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, user.password_hash); // ← после получения user

  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json({
    id: user.id,
    username: user.username
  });
});

// Создать доску
app.post("/api/boards", async (req, res) => {
  const { title, userId } = req.body;

  if (!title || !userId) {
    return res.status(400).json({ error: "title and userId required" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO boards (title, owner_id) VALUES ($1, $2) RETURNING *",
      [title, userId]
    );

    const board = result.rows[0];

    // Автоматически назначаем создателя владельцем
    await pool.query(
      "INSERT INTO board_users (board_id, user_id, role) VALUES ($1, $2, 'owner')",
      [board.id, userId]
    );

    res.json(board);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create board" });
  }
});

// Получить доски пользователя
app.get("/api/boards", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }

  try {
    const result = await pool.query(
      `SELECT b.*, bu.role, u.username as owner_name
       FROM boards b
       JOIN board_users bu ON bu.board_id = b.id
       JOIN users u ON u.id = b.owner_id
       WHERE bu.user_id = $1
       ORDER BY b.updated_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch boards" });
  }
});

// Переименовать доску
app.patch("/api/boards/:id", async (req, res) => {
  const { title, userId } = req.body;
  const boardId = req.params.id;

  // проверяем что пользователь — владелец
  const check = await pool.query(
    "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, userId]
  );
  if (!check.rows[0] || check.rows[0].role !== "owner") {
    return res.status(403).json({ error: "Forbidden" });
  }

  await pool.query("UPDATE boards SET title=$1, updated_at=NOW() WHERE id=$2", [title, boardId]);
  res.json({ success: true });
});

// Удалить доску
app.delete("/api/boards/:id", async (req, res) => {
  const { userId } = req.body;
  const boardId = req.params.id;

  const check = await pool.query(
    "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, userId]
  );
  if (!check.rows[0] || check.rows[0].role !== "owner") {
    return res.status(403).json({ error: "Forbidden" });
  }

  await pool.query("DELETE FROM boards WHERE id=$1", [boardId]);
  res.json({ success: true });
});

app.post("/api/boards/:id/invite", async (req, res) => {
  const { username, role, userId } = req.body;
  const boardId = req.params.id;

  const self = await pool.query(
    "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, userId]
  );
  const selfRole = self.rows[0]?.role;
  if (!selfRole || selfRole === "viewer") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const target = await pool.query(
    "SELECT id FROM users WHERE username=$1", [username]
  );
  if (!target.rows[0]) {
    return res.status(404).json({ error: "Пользователь не найден" });
  }
  const targetId = target.rows[0].id;

  if (targetId === parseInt(userId)) {
    return res.status(400).json({ error: "Нельзя пригласить себя" });
  }

  // проверяем что уже не на доске
  const already = await pool.query(
    "SELECT id FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, targetId]
  );
  if (already.rows[0]) {
    return res.status(400).json({ error: "Пользователь уже имеет доступ" });
  }

  // проверяем что уже нет pending приглашения
  const pending = await pool.query(
    "SELECT id FROM notifications WHERE board_id=$1 AND user_id=$2 AND status='pending'",
    [boardId, targetId]
  );
  if (pending.rows[0]) {
    return res.status(400).json({ error: "Приглашение уже отправлено" });
  }

  const inviterName = (await pool.query(
    "SELECT username FROM users WHERE id=$1", [userId]
  )).rows[0]?.username;

  await pool.query(
    "INSERT INTO notifications (user_id, board_id, role, from_username) VALUES ($1, $2, $3, $4)",
    [targetId, boardId, role, inviterName]
  );

  // уведомляем через сокет если пользователь онлайн
  io.emit("notification", { userId: targetId });

  res.json({ success: true });
});

// Сгенерировать ссылку-приглашение
app.post("/api/boards/:id/invite-link", async (req, res) => {
  const { role, userId } = req.body;
  const boardId = req.params.id;

  // проверяем права
  const self = await pool.query(
    "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, userId]
  );
  if (!self.rows[0] || self.rows[0].role === "viewer") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const token = crypto.randomBytes(16).toString("hex");

  await pool.query(
    "INSERT INTO invites (board_id, token, role) VALUES ($1, $2, $3)",
    [boardId, token, role]
  );

  res.json({ token });
});

// Получить инфо по токену (без авторизации)
app.get("/api/invite/:token", async (req, res) => {
  const { token } = req.params;

  const result = await pool.query(
    `SELECT i.board_id, i.role, b.title
     FROM invites i
     JOIN boards b ON b.id = i.board_id
     WHERE i.token = $1`,
    [token]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "Ссылка недействительна" });
  }

  res.json(result.rows[0]);
});

app.patch("/api/boards/:boardId/users/:userId", async (req, res) => {
  const { role, requesterId, targetSocketId } = req.body;
  const { boardId, userId } = req.params;

  const self = await pool.query(
    "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, requesterId]
  );
  if (self.rows[0]?.role !== "owner") {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (userId !== "null") {
    // авторизованный — обновляем в БД
    await pool.query(
      "UPDATE board_users SET role=$1 WHERE board_id=$2 AND user_id=$3",
      [role, boardId, userId]
    );
  }

  // обновляем роль в памяти сервера
  if (boardUsers[boardId]) {
    const target = boardUsers[boardId].find(u =>
      userId !== "null" ? u.userId === parseInt(userId) : u.socketId === targetSocketId
    );
    if (target) target.role = role;

    // отправляем обновлённый список всем на доске
    io.to(boardId).emit("users-update", boardUsers[boardId]);

    // уведомляем самого пользователя о смене роли
    const targetSocketIdFinal = target?.socketId || targetSocketId;
    const targetSocket = io.sockets.sockets.get(targetSocketIdFinal);
    if (targetSocket) {
      targetSocket.emit("role-changed", { role });
    }
  }

    // если гость — обновляем роль в invites по socketId
  if (userId === "null" && targetSocketId) {
    const target = boardUsers[boardId]?.find(u => u.socketId === targetSocketId);
    if (target?.token) {
      await pool.query(
        "UPDATE invites SET role=$1 WHERE token=$2",
        [role, target.token]
      );
    }
  }

  res.json({ success: true });
});

app.delete("/api/boards/:boardId/users/:userId", async (req, res) => {
  const { requesterId } = req.body;
  const { boardId, userId } = req.params;

  const self = await pool.query(
    "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, requesterId]
  );
  if (self.rows[0]?.role !== "owner") {
    return res.status(403).json({ error: "Forbidden" });
  }

  await pool.query(
    "DELETE FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, userId]
  );

  // находим сокет кикнутого пользователя и отключаем
  if (boardUsers[boardId]) {
    const target = boardUsers[boardId].find(u => u.userId === parseInt(userId));
    if (target) {
      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket) {
        targetSocket.emit("kicked");
        targetSocket.disconnect();
      }
    }
  }

  res.json({ success: true });
});

app.get("/api/boards/:id/my-role", async (req, res) => {
  const { userId } = req.query;
  const boardId = req.params.id;

  const result = await pool.query(
    "SELECT role FROM board_users WHERE board_id=$1 AND user_id=$2",
    [boardId, userId]
  );

  res.json({ role: result.rows[0]?.role || "viewer" });
});

// получить уведомления пользователя
app.get("/api/notifications", async (req, res) => {
  const { userId } = req.query;

  const result = await pool.query(
    `SELECT n.id, n.role, n.from_username, n.created_at, b.title as board_title
     FROM notifications n
     JOIN boards b ON b.id = n.board_id
     WHERE n.user_id=$1 AND n.status='pending'
     ORDER BY n.created_at DESC`,
    [userId]
  );

  res.json(result.rows);
});

// принять приглашение
app.post("/api/notifications/:id/accept", async (req, res) => {
  const { userId } = req.body;

  const notif = await pool.query(
    "SELECT * FROM notifications WHERE id=$1 AND user_id=$2 AND status='pending'",
    [req.params.id, userId]
  );
  if (!notif.rows[0]) return res.status(404).json({ error: "Не найдено" });

  const { board_id, role } = notif.rows[0];

  await pool.query(
    `INSERT INTO board_users (board_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (board_id, user_id) DO UPDATE SET role=$3`,
    [board_id, userId, role]
  );

  await pool.query(
    "UPDATE notifications SET status='accepted' WHERE id=$1",
    [req.params.id]
  );

  // уведомляем через сокет — доска появится мгновенно на дашборде
  io.emit("board-accepted", { userId: parseInt(userId) });

  res.json({ success: true, boardId: board_id });
});

// отклонить приглашение
app.post("/api/notifications/:id/decline", async (req, res) => {
  const { userId } = req.body;

  const notif = await pool.query(
    "SELECT id FROM notifications WHERE id=$1 AND user_id=$2 AND status='pending'",
    [req.params.id, userId]
  );
  if (!notif.rows[0]) return res.status(404).json({ error: "Не найдено" });

  await pool.query(
    "UPDATE notifications SET status='declined' WHERE id=$1",
    [req.params.id]
  );

  res.json({ success: true });
});

app.get("/api/boards/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT title FROM boards WHERE id=$1",
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(result.rows[0]);
});

app.get("/api/boards/:id/chat", async (req, res) => {
  const result = await pool.query(
    "SELECT id, user_id, username, text, created_at FROM chat_messages WHERE board_id=$1 ORDER BY created_at ASC LIMIT 200",
    [req.params.id]
  );
  res.json(result.rows);
});

server.listen(3000, () => {
  console.log("http://localhost:3000");
});