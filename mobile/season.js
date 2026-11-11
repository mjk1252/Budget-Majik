/* Seasonal theme, South African (Southern Hemisphere) calendar, following the
 * month shown in the app header (so browsing to December gives Christmas).
 *   Dec = Christmas, Jan-Feb = summer, Mar-May = autumn, Jun-Aug = winter, Sep-Nov = spring (jacaranda).
 * Before the app has rendered a month label it falls back to today's date.
 * Preview with ?season=xmas|summer|autumn|winter|spring (pins it, ignores browsing); ?season=none turns it off.
 * Purely cosmetic: sets classes on <html> and adds a light layer of falling bits. */
(function () {
  const root = document.documentElement;
  const SEASONS = ["xmas", "summer", "autumn", "winter", "spring"];
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  let q = null;
  try { q = new URLSearchParams(location.search).get("season"); } catch (e) {}
  if (q === "none") return;
  const pinned = SEASONS.indexOf(q) >= 0 ? q : null;
  const seasonOfMonth = (m) => (m === 11 ? "xmas" : m < 2 ? "summer" : m < 5 ? "autumn" : m < 8 ? "winter" : "spring");

  const GLYPHS = {
    xmas: ["❄", "❅", "❆", "•"],
    winter: ["•", "·", "❄"],
    autumn: ["🍂", "🍁"],
    spring: ["🌸", "💮", "🌸"],
    summer: [],
  };
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function monthShown() {
    const el = document.getElementById("monthLabel");
    const word = el && el.textContent.trim().split(/\s+/)[0].toLowerCase();
    const i = MONTHS.indexOf(word);
    return i >= 0 ? i : new Date().getMonth();
  }

  function rebuildSnow(season) {
    const old = document.querySelector(".snow");
    if (old) old.remove();
    const glyphs = GLYPHS[season];
    if (reduced() || !glyphs.length || !document.body) return;
    const layer = document.createElement("div");
    layer.className = "snow";
    layer.setAttribute("aria-hidden", "true");
    const emoji = season === "autumn" || season === "spring";
    for (let i = 0; i < (emoji ? 14 : 26); i++) {
      const f = document.createElement("span");
      f.className = "snowflake";
      f.textContent = glyphs[i % glyphs.length];
      f.style.left = Math.random() * 100 + "%";
      f.style.fontSize = (emoji ? 12 : 8) + Math.random() * (emoji ? 8 : 12) + "px";
      f.style.animationDuration = 9 + Math.random() * 11 + "s";
      f.style.animationDelay = -Math.random() * 18 + "s";
      f.style.setProperty("--drift", Math.round(Math.random() * 80 - 40) + "px");
      f.style.setProperty("--o", (0.35 + Math.random() * 0.5).toFixed(2));
      layer.appendChild(f);
    }
    document.body.appendChild(layer);
  }

  let current = null;
  function apply() {
    const season = pinned || seasonOfMonth(monthShown());
    if (season === current) return;
    current = season;
    SEASONS.forEach((s) => root.classList.remove("season-" + s));
    root.classList.remove("xmas");
    root.classList.add("seasonal", "season-" + season);
    if (season === "xmas") root.classList.add("xmas");
    rebuildSnow(season);
  }

  function init() {
    apply();
    const label = document.getElementById("monthLabel");
    if (label && !pinned) new MutationObserver(apply).observe(label, { childList: true, characterData: true, subtree: true });
  }
  // Set the class straight away (no flash), then re-check once the DOM exists.
  root.classList.add("seasonal", "season-" + (pinned || seasonOfMonth(new Date().getMonth())));
  if (pinned === "xmas" || (!pinned && new Date().getMonth() === 11)) root.classList.add("xmas");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
