/* Playful extras and fast-entry helpers for the phone site. Purely visual:
 * it never changes budget data and only watches the DOM app.js produces. */
(function () {
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const COLORS = ["#c6f36b", "#5ef0b6", "#ffcf4a", "#ff7ab8", "#9b7bff", "#7dd3fc"];
  const money = (n) => "R" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ---- confetti burst ---- */
  function burst(x, y, count = 22) {
    if (reduced()) return;
    for (let i = 0; i < count; i++) {
      const bit = document.createElement("span");
      bit.className = "confetti-bit";
      const angle = Math.random() * Math.PI * 2;
      const dist = 50 + Math.random() * 110;
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
    if (amount > 0) toast("Saved " + money(amount) + (categoryText ? " · " + categoryText : ""));
  }

  /* ---- modal sheet: keep Save above the on-screen keyboard + input hints ---- */
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
        pinToViewport();
        if (vv) { vv.addEventListener("resize", pinToViewport); vv.addEventListener("scroll", pinToViewport); }
      } else {
        if (vv) { vv.removeEventListener("resize", pinToViewport); vv.removeEventListener("scroll", pinToViewport); }
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
