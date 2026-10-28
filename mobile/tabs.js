/* Bottom tab bar for the phone layout. It only drives controls that already
 * exist (Insights toggle, Log expense), so app.js needs no knowledge of it. */
(function () {
  const bar = document.getElementById("tabbar");
  if (!bar) return;
  const insightsView = document.getElementById("insightsView");
  const tabs = [...bar.querySelectorAll(".tab")];
  const insightsOpen = () => !insightsView.hidden;

  function setActive(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  }
  function closeInsights() {
    if (insightsOpen()) document.getElementById("insightsBtn").click();
  }
  function current() {
    if (insightsOpen()) return "insights";
    const panel = document.getElementById("expenseList").closest(".panel");
    return panel.getBoundingClientRect().top < window.innerHeight * 0.45 ? "expenses" : "budget";
  }

  bar.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tab]");
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === "add") return document.getElementById("quickLogBtn").click();
    if (tab === "insights") {
      if (!insightsOpen()) document.getElementById("insightsBtn").click();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      closeInsights();
      const target = tab === "expenses" ? document.getElementById("expenseList").closest(".panel") : document.body;
      requestAnimationFrame(() => {
        if (tab === "expenses") target.scrollIntoView({ behavior: "smooth", block: "start" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }
    setActive(tab);
  });

  window.addEventListener("scroll", () => setActive(current()), { passive: true });
  new MutationObserver(() => setActive(current())).observe(insightsView, { attributes: true, attributeFilter: ["hidden"] });
})();
