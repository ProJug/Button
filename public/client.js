(function () {
  const pressBtn = document.getElementById("pressBtn");
  const totalEl = document.getElementById("total");
  const mineEl = document.getElementById("mine");
  const lb = document.getElementById("leaderboard");
  const nameInput = document.getElementById("nameInput");
  const saveNameBtn = document.getElementById("saveName");
  const nameSaved = document.getElementById("nameSaved");
  const toast = document.getElementById("toast");
  const logoutBtn = document.getElementById("logoutBtn");
  const userArea = document.getElementById("userArea");
  const nameBox = document.getElementById("nameBox");
  const pressHint = document.getElementById("pressHint");

  // Auth state is server-driven only. No more anonymous presses.
  let authUser = null;

  async function loadMe() {
    try {
      const r = await fetch("/api/me");
      const data = await r.json();
      if (data?.user) {
        authUser = data.user;
        userArea.innerHTML = `<a href="/profile.html">${escapeHtml(authUser.display_name || authUser.email || "You")}</a>`;
        logoutBtn.hidden = false;
        if (pressBtn) {
          pressBtn.disabled = false;
          pressBtn.removeAttribute("title");
        }
        if (pressHint) pressHint.style.display = "none";
        if (nameBox) nameBox.hidden = false;
      } else {
        authUser = null;
        userArea.innerHTML = `<a href="/login.html">Log in</a> <a class="btn-link" href="/signup.html">Sign up</a>`;
        logoutBtn.hidden = true;
        if (pressBtn) {
          pressBtn.disabled = true;
          pressBtn.title = "Log in to press";
        }
        if (pressHint) pressHint.style.display = "";
        if (nameBox) nameBox.hidden = true;
      }
    } catch {}
  }

  loadMe();

  const socket = io();
  socket.on("connect", () => {
    socket.emit("hello", {}); // server figures auth from cookie
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
    if (typeof mine === "number") mineEl.textContent = mine.toLocaleString();
  });

  socket.on("error_msg", (msg) => showToast(msg || "Error."));

  pressBtn?.addEventListener("click", () => {
    if (pressBtn.disabled) return showToast("Log in to press.");
    socket.emit("press");
  });

  saveNameBtn?.addEventListener("click", () => {
    if (!authUser) return showToast("Log in first.");
    const newName = nameInput.value.trim();
    socket.emit("set_name", newName);
    nameSaved.textContent = "Saved.";
    setTimeout(() => (nameSaved.textContent = ""), 1200);
  });

  logoutBtn?.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location = "/";
  });

  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 1500);
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }
})();
