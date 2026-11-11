/* Playful extras and fast-entry helpers for the phone site. Purely visual:
 * it never changes budget data and only watches the DOM app.js produces. */
(function () {
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const xmas = document.documentElement.classList.contains("xmas");
  const SEASON_COLORS = { summer: ["#ffc247", "#ff8a3d", "#7dd3fc", "#ffffff", "#5ef0b6"], autumn: ["#ffa65c", "#e0782d", "#b8392b", "#ffd98a", "#8a5a2b"], winter: ["#9bd9ff", "#6aa6ff", "#ffffff", "#c6e6ff", "#ffd68a"], spring: ["#dcb6ff", "#b07cff", "#ff9ad5", "#ffffff", "#8ae0b0"] };
  const COLORS = SEASON_COLORS[["summer", "autumn", "winter", "spring"].find((s) => document.documentElement.classList.contains("season-" + s))] || (xmas ? ["#ff5a5f", "#6fe3a0", "#ffd76a", "#ffffff", "#2f9e5e", "#d6303a"] : ["#c6f36b", "#5ef0b6", "#ffcf4a", "#ff7ab8", "#9b7bff", "#7dd3fc"]);
  const money = (n) => "R" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ---- confetti burst ---- */
  function burst(x, y, count = 22, spread = 1) {
    if (reduced()) return;
    for (let i = 0; i < count; i++) {
      const bit = document.createElement("span");
      bit.className = "confetti-bit";
      const angle = Math.random() * Math.PI * 2;
      const dist = (50 + Math.random() * 110) * spread;
      bit.style.left = x + "px";
      bit.style.top = y + "px";
      bit.style.background = COLORS[i % COLORS.length];
      bit.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
      bit.style.setProperty("--dx", Math.cos(angle) * dist + "px");
      bit.style.setProperty("--dy", Math.sin(angle) * dist - 60 + "px");
      bit.style.setProperty("--rot", Math.round(Math.random() * 720 - 360) + "deg");
      bit.addEventListener("animationend", () => bit.remove());
      document.body.appendChild(bit);
    }
  }
  const centerOf = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };

  /* ---- "Saved R45.00 · Groceries" toast ---- */
  let toastEl = null;
  let toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth; // restart the pop-in
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }
  function celebrate(x, y, amount, categoryText, count) {
    burst(x, y, count);
    hopMascot();
    if (amount > 0) toast("Saved " + money(amount) + (categoryText ? " · " + categoryText : ""));
  }

  /* ---- mascot: hops on every save, and chats when tapped ---- */
  const mascot = document.querySelector(".brand-mark");
  const SEASON_QUIPS = {
    summer: ["Braai money sorted 🔥", "Sun\u2019s out, budget\u2019s in ☀️", "Ice-cold and under budget 🧊", "Beach days are affordable days 🏖️"],
    autumn: ["Leaf it to me 🍂", "Budget season is cozy season 🍁", "Rusks and a plan ☕", "Your Rands are turning golden 🍂"],
    winter: ["Bundle up, budget on 🧣", "Soup season savings 🍲", "Frosty mornings, healthy balance ❄️", "Keeping the geyser costs low 🔥"],
    spring: ["Jacaranda season! 💜", "Fresh start, fresh budget 🌸", "Blooming balances 🌷", "Purple rain of savings 💜"],
  };
  const seasonKey = ["summer", "autumn", "winter", "spring"].find((s) => document.documentElement.classList.contains("season-" + s));
  const QUIPS = seasonKey ? SEASON_QUIPS[seasonKey] : xmas ? ["Ho ho ho! 🎅", "Merry Budgetmas! 🎄", "Checking your list twice ✨", "Jingle Rands, jingle Rands 🔔", "Gifts: budgeted. Cookies: also budgeted 🍪", "Santa approves this spend 🎁", "Snow much to save! ❄️"] : ["Ka-ching! 💸", "Your Rands are in good hands ✨", "Budget wizard at work 🪄", "Tiny spends, big dreams 🌈", "Looking sharp, boss 😎", "Every cent has a job 💪", "I believe in your budget 💜"];
  let quipIx = Math.floor(Math.random() * QUIPS.length);
  function hopMascot() {
    if (!mascot || reduced()) return;
    mascot.classList.remove("hopping");
    void mascot.offsetWidth;
    mascot.classList.add("hopping");
  }
  if (mascot) {
    mascot.addEventListener("animationend", (e) => { if (e.animationName === "mascotHop") mascot.classList.remove("hopping"); });
    mascot.addEventListener("click", () => { hopMascot(); quipIx = (quipIx + 1) % QUIPS.length; toast(QUIPS[quipIx]); });
  }

  /* ---- tap sparkles on buttons, cards and tabs ---- */
  document.addEventListener("pointerup", (e) => {
    if (reduced() || e.pointerType === "mouse" && e.button !== 0) return;
    const hit = e.target.closest && e.target.closest("button, .stat-card, .cat-row, .tab, .expense-row");
    if (!hit || hit.disabled || hit.id === "qa-add" || hit.id === "modalSave") return;
    burst(e.clientX, e.clientY, 7, 0.45);
  }, { passive: true });

  /* ---- tapping a category / expense emoji floats a little flurry of it ---- */
  document.addEventListener("click", (e) => {
    const emoji = e.target.closest && e.target.closest(".cat-emoji, .expense-emoji");
    if (!emoji || reduced()) return;
    const glyph = emoji.textContent.trim();
    if (!glyph) return;
    const r = emoji.getBoundingClientRect();
    for (let i = 0; i < 4; i++) {
      const el = document.createElement("span");
      el.className = "float-emoji";
      el.textContent = glyph;
      el.style.left = r.left + r.width / 2 + (Math.random() * 30 - 15) + "px";
      el.style.top = r.top + r.height / 2 + "px";
      el.style.setProperty("--dx", Math.round(Math.random() * 60 - 30) + "px");
      el.style.animationDelay = i * 90 + "ms";
      el.addEventListener("animationend", () => el.remove());
      document.body.appendChild(el);
    }
  }, true);

  /* ---- a category that tips over budget shakes its header ---- */
  const catList = document.getElementById("catList");
  if (catList) {
    let prevOver = null;
    let overTimer = 0;
    const overNames = () => {
      const set = new Set();
      catList.querySelectorAll(".cat-row").forEach((row) => {
        if (row.querySelector(".budget-status.over")) {
          const n = row.querySelector(".cat-name");
          if (n) set.add(n.textContent.trim());
        }
      });
      return set;
    };
    if (catList.querySelector(".cat-row")) prevOver = overNames(); // already rendered: that's the baseline
    new MutationObserver(() => {
      clearTimeout(overTimer);
      overTimer = setTimeout(() => {
        const now = overNames();
        if (prevOver && !reduced()) {
          catList.querySelectorAll(".cat-row").forEach((row) => {
            const n = row.querySelector(".cat-name");
            const top = row.querySelector(".cat-top");
            if (n && top && now.has(n.textContent.trim()) && !prevOver.has(n.textContent.trim())) {
              top.classList.add("shake");
              top.addEventListener("animationend", () => top.classList.remove("shake"), { once: true });
              const [x, y] = centerOf(top);
              burst(x, y, 10, 0.6);
            }
          });
        }
        prevOver = now;
      }, 300);
    }).observe(catList, { childList: true, subtree: true });
  }

  /* ---- modal sheet: input hints (pinToViewport below is kept but no longer used) ---- */
  const backdrop = document.getElementById("modalBackdrop");
  const saveBtn = document.getElementById("modalSave");
  const vv = window.visualViewport;
  function pinToViewport() {
    if (!vv) return;
    backdrop.style.top = vv.offsetTop + "px";
    backdrop.style.height = vv.height + "px";
    backdrop.style.bottom = "auto";
  }
  function unpin() {
    backdrop.style.top = backdrop.style.height = backdrop.style.bottom = "";
  }
  function hintInputs() {
    const body = document.getElementById("modalBody");
    if (!body) return;
    body.querySelectorAll("input[type=number]").forEach((el) => {
      el.setAttribute("inputmode", "decimal");
      el.setAttribute("enterkeyhint", "done");
    });
    body.querySelectorAll("input[type=text]").forEach((el) => {
      el.setAttribute("enterkeyhint", "done");
      el.setAttribute("autocomplete", "off");
      el.setAttribute("autocapitalize", "sentences");
    });
  }

  let pending = null;
  if (backdrop && saveBtn) {
    /* Remember what was typed when Save is tapped (expense sheets only). */
    saveBtn.addEventListener("click", () => {
      const title = (document.getElementById("modalTitle") || {}).textContent || "";
      if (!/expense/i.test(title)) return;
      const body = document.getElementById("modalBody");
      const amountEl = body && body.querySelector("input[type=number]");
      const select = body && body.querySelector("select");
      const option = select && select.options[select.selectedIndex];
      const [x, y] = centerOf(saveBtn);
      pending = {
        x, y,
        amount: amountEl ? parseFloat(amountEl.value) || 0 : 0,
        category: option ? option.textContent.replace(/\s+/g, " ").trim() : "",
      };
      setTimeout(() => { pending = null; }, 400);
    }, true);

    new MutationObserver(() => {
      if (!backdrop.hidden) {
        hintInputs();
        // Sheet stays put: the keyboard simply covers the bottom instead of the sheet riding above it.
      } else {
        unpin();
        if (pending) { celebrate(pending.x, pending.y, pending.amount, pending.category, 22); pending = null; }
      }
    }).observe(backdrop, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* ---- quick-add row: the amount box empties when the expense went through ---- */
  const qaAmount = document.getElementById("qa-amount");
  const qaAdd = document.getElementById("qa-add");
  const qaCat = document.getElementById("qa-cat");
  const qaNote = document.getElementById("qa-note");
  if (qaAmount) { qaAmount.setAttribute("inputmode", "decimal"); qaAmount.setAttribute("enterkeyhint", "done"); }
  if (qaNote) { qaNote.setAttribute("enterkeyhint", "done"); qaNote.setAttribute("autocomplete", "off"); }
  function watchQuickAdd() {
    const amount = parseFloat(qaAmount.value);
    if (!(amount > 0)) return;
    const option = qaCat && qaCat.options[qaCat.selectedIndex];
    const category = option ? option.textContent.replace(/\s+/g, " ").trim() : "";
    const [x, y] = centerOf(qaAdd);
    setTimeout(() => { if (qaAmount.value === "") celebrate(x, y, amount, category, 16); }, 150);
  }
  if (qaAdd && qaAmount) {
    qaAdd.addEventListener("click", watchQuickAdd, true);
    [qaAmount, qaNote].forEach((el) => {
      if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") watchQuickAdd(); }, true);
    });
  }

  /* ---- hero numbers pop when the count-up lands ---- */
  ["incomeValue", "spentValue", "cashLeftValue", "bankTargetValue", "freeValue", "freeWithLoansValue"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    let timer = 0;
    el.addEventListener("animationend", () => el.classList.remove("landed"));
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (reduced()) return;
        el.classList.remove("landed");
        void el.offsetWidth; // restart the animation
        el.classList.add("landed");
      }, 140);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
})();
