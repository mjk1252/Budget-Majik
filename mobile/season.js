/* Seasonal theme, South African (Southern Hemisphere) calendar.
 *   Dec = Christmas, Jan-Feb = summer, Mar-May = autumn, Jun-Aug = winter, Sep-Nov = spring (jacaranda).
 * Preview with ?season=xmas|summer|autumn|winter|spring, turn off with ?season=none.
 * Purely cosmetic: sets a class on <html> and adds a light layer of falling bits. */
(function () {
  const root = document.documentElement;
  const SEASONS = { xmas: 1, summer: 1, autumn: 1, winter: 1, spring: 1 };
  let q = null;
  try { q = new URLSearchParams(location.search).get("season"); } catch (e) {}
  if (q === "none") return;
  const m = new Date().getMonth(); // 0 = Jan
  const auto = m === 11 ? "xmas" : m < 2 ? "summer" : m < 5 ? "autumn" : m < 8 ? "winter" : "spring";
  const season = SEASONS[q] ? q : auto;
  root.classList.add("seasonal", "season-" + season);
  if (season === "xmas") root.classList.add("xmas");

  const GLYPHS = {
    xmas: ["❄", "❅", "❆", "•"],
    winter: ["•", "·", "❄"],
    autumn: ["🍂", "🍁"],
    spring: ["🌸", "💮", "🌸"],
    summer: [],
  };
  const glyphs = GLYPHS[season];
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !glyphs.length) return;
  const start = () => {
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
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
