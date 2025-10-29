(function () {
  const pressBtn = document.getElementById("pressBtn");
  const totalEl = document.getElementById("total");
  const mineEl = document.getElementById("mine");
  const lb = document.getElementById("leaderboard");
  const nameInput = document.getElementById("nameInput");
  const saveNameBtn = document.getElementById("saveName");
  const nameSaved = document.getElementById("nameSaved");
  const toast = document.getElementById("toast");

  const KEY_ID = "clicker:userId";
  const KEY_NAME = "clicker:name";

  function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    // fallback: terrible, but fine for old browsers
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  let userId = localStorage.getItem(KEY_ID);
  if (!userId) {
    userId = uuid();
    localStorage.setItem(KEY_ID, userId);
  }

  let name = localStorage.getItem(KEY_NAME) || "";
  nameInput.value = name;

  const socket = io();

  socket.on("connect", () => {
    socket.emit("hello", { userId, name });
  });

  socket.on("stats", ({ total, mine, top }) => {
    if (typeof total === "number") totalEl.textContent = total.toLocaleString();
    if (typeof mine === "number") mineEl.textContent = mine.toLocaleString();
    if (Array.isArray(top)) {
      lb.innerHTML = "";
      top.forEach((row, idx) => {
        const li = document.createElement("li");
        const nameSpan = document.createElement("span");
        nameSpan.className = "name";
        nameSpan.textContent = `${idx + 1}. ${row.name}`;
        const scoreSpan = document.createElement("span");
        scoreSpan.className = "score";
        scoreSpan.textContent = row.clicks.toLocaleString();
        li.appendChild(nameSpan);
        li.appendChild(scoreSpan);
        lb.appendChild(li);
      });
    }
  });

  socket.on("you", ({ mine }) => {
    if (typeof mine === "number") {
      mineEl.textContent = mine.toLocaleString();
    }
  });

  socket.on("error_msg", (msg) => {
    showToast(msg || "Error.");
  });

  pressBtn.addEventListener("click", () => {
    socket.emit("press");
  });

  saveNameBtn.addEventListener("click", () => {
    const newName = nameInput.value.trim();
    name = newName;
    localStorage.setItem(KEY_NAME, name);
    socket.emit("set_name", name);
    nameSaved.textContent = "Saved.";
    setTimeout(() => (nameSaved.textContent = ""), 1200);
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 1500);
  }
})();
