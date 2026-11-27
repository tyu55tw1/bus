/* 共用 App 外殼元件（公車、生活助手、行事曆共用同一份）
   三份一模一樣：E:\程式相關\公車-plain\web\ui.js（公車）、E:\程式相關\網頁版-plain\web\ui.js（生活助手）、
   E:\程式相關\行事曆\web\ui.js（行事曆）——改一邊要複製到另外兩邊。
   這裡只放通用的東西：分頁、推進新頁（左邊緣右滑返回）、底部抽屜、toast、往下拉重新整理、
   存設定（localStorage）、呼叫 /api、外觀（淺色／深色）、service worker。App 自己的畫面寫在 app.js。
   用法：<div class="app" id="app"> 裡面放 <div class="screen base">（各分頁 .pane ＋ nav.tabs），其他由這裡補上。 */
"use strict";
window.UI = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  let app = null;

  // ── 圖示（線條 SVG，跟樣品一樣） ──
  const P = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    star: '<path fill="currentColor" stroke="none" d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    starO: '<path d="M12 3.6l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    pin: '<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l2-4M16 21l-2-4"/>',
    up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>',
    grip: '<path d="M5 9h14M5 15h14"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chev: '<path d="M9 5l7 7-7 7"/>', swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/>', home: '<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z"/>',
    bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 21v-3M16 21v-3"/><circle cx="8" cy="14.5" r=".6" fill="currentColor"/><circle cx="16" cy="14.5" r=".6" fill="currentColor"/>',
    bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9l3 7"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    cloud: '<path d="M7 18a5 5 0 01-.5-10A6 6 0 0118 9a4.5 4.5 0 01-1 9z"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', nav: '<path d="M3 11l18-8-8 18-2-8z"/>',
    bell: '<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z"/><path d="M10 20a2 2 0 004 0"/>',
  };
  const icon = (n, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;

  // ── 存設定：localStorage 拿不到（私密模式等）就只存在這次 ──
  const mem = {};
  const store = {
    get(k, def = null) {
      let raw = null;
      try { raw = localStorage.getItem(k); } catch (e) { raw = k in mem ? mem[k] : null; }
      if (raw === null || raw === undefined) return def;
      try { return JSON.parse(raw); } catch (e) { return def; }
    },
    set(k, v) {
      const raw = JSON.stringify(v);
      mem[k] = raw;
      try { localStorage.setItem(k, raw); } catch (e) { /* 存不了就這次用 */ }
    },
    raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  };

  // ── 外觀：auto 跟系統、light、dark ──
  function theme(v) {
    if (v !== undefined) store.set("ui.theme", v);
    const t = store.get("ui.theme", "auto");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    return t;
  }

  // ── 呼叫 /api ──
  class ApiError extends Error {
    constructor(msg, busy) { super(msg); this.busy = busy || 0; }
  }
  async function api(name, params = null, body = undefined, timeout = 30000) {
    const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")) : "";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    let r;
    try {
      r = await fetch(`api/${name}${qs}`, body === undefined ? {signal: ctl.signal} :
        {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal: ctl.signal});
    } catch (e) {
      throw new ApiError(e.name === "AbortError" ? "等太久了，請稍後再試" : "連不上電腦（網路或伺服器沒開）");
    } finally { clearTimeout(t); }
    let j;
    try { j = await r.json(); } catch (e) { throw new ApiError(`伺服器回應怪怪的（HTTP ${r.status}）`); }
    if (!j.ok) throw new ApiError(j.busy ? "資料來源忙線，10 秒後再試" : (j.error || "讀取失敗"), j.busy);
    return j.data;
  }
  // 錯誤 → 白話；忙線的話 10 秒後自動再試一次（retry 是要重跑的函式）
  function errHtml(e, retry) {
    const id = "r" + Math.random().toString(36).slice(2, 8);
    if (retry && e && e.busy) setTimeout(() => { const el = document.getElementById(id); if (el && el.isConnected) retry(); }, 10000);
    return `<div class="note${e && e.busy ? "" : " bad"}" id="${id}">${esc(e && e.message || e)}${retry && !(e && e.busy) ?
      ` <button class="textbtn" data-retry>再試一次</button>` : ""}</div>`;
  }
  function bindRetry(el, retry) { $$("[data-retry]", el).forEach(b => b.onclick = retry); }

  // ── 資料也存一份在電腦（2026-11-13）：iPhone 會清掉我的助手 iframe 裡的 localStorage（關掉再開，自選股、常用都不見），
  //    所以每次改了 1 秒後把整份送到電腦（/api/state，statestore.py），手機那份不見了或比較舊就用電腦那份。
  //    rev＝最後修改的時間（毫秒），跟最後同步時間一起存在 localStorage「key.sync」；電腦只收比它那份新的。
  //    opt：key（例 life.v1）、get()＝目前整份資料、put(data)＝換成電腦那份（App 自己重畫）。
  //    回傳 {ready（第一次問完電腦的 Promise，從舊版匯入要等它）, touch()（存了就叫）, at()（最後同步時間，毫秒）}
  function cloud({key, get, put}) {
    const RK = key + ".sync";
    const had = store.raw(key) !== null;   // 這次打開時手機上原本有沒有資料
    const meta = Object.assign({rev: 0, at: 0}, had ? store.get(RK, {}) : {});
    // fresh：手機原本沒資料又連不上電腦 → 先不送（免得把空的蓋到電腦上）；pre：問完電腦前就存過
    let ready = false, fresh = false, pre = false, dirty = false, busy = false, timer = null;
    const keep = () => store.set(RK, meta);
    const later = ms => { clearTimeout(timer); timer = setTimeout(push, ms); };
    function adopt(d) { meta.rev = +d.rev || 0; meta.at = Date.now(); dirty = pre = false; keep(); put(d.data); }
    async function push() {
      clearTimeout(timer); timer = null;
      if (!ready || fresh || busy || !dirty) return;
      busy = true;
      const rev = meta.rev;
      try {
        const d = await api("state", null, {data: get(), rev}, 15000);
        if (d.accepted) { meta.at = Date.now(); if (meta.rev === rev) dirty = false; keep(); }
        else if (d.data) adopt(d);   // 電腦那份比較新（別的分頁、主畫面 App 改過）：用電腦的
      } catch (e) { /* 連不上電腦：下次改、切回來或 1 分鐘後再送 */ }
      busy = false;
      if (dirty) later(meta.rev !== rev ? 1000 : 60000);
    }
    function touch() {
      if (!ready) { pre = true; return; }
      if (fresh) return;
      meta.rev = Math.max(Date.now(), meta.rev + 1); dirty = true; keep();
      later(1000);
    }
    async function sync() {
      let d;
      try { d = await api("state", {has: ready || had ? 1 : 0, inframe: window.top !== window.self ? 1 : 0}, undefined, 8000); }
      catch (e) { if (!ready) { fresh = !had; ready = true; } return false; }
      ready = true; fresh = false;
      const srv = +d.rev || 0;
      if (d.data && srv > meta.rev) adopt(d);   // 手機沒有、或比電腦舊 → 用電腦那份
      else if ((had || pre || dirty || store.raw(key) !== null) && (!d.data || srv < meta.rev || pre || !meta.rev)) {
        meta.rev = Math.max(meta.rev, srv + 1, pre || !meta.rev ? Date.now() : 0); dirty = true; pre = false; keep(); push();   // 手機比較新 → 送給電腦
      } else if (d.data) { meta.at = Date.now(); keep(); }
      return true;
    }
    document.addEventListener("visibilitychange", () => {
      if (!ready) return;
      if (document.visibilityState === "visible") { if (dirty) push(); else sync(); }
      else if (dirty && !fresh && navigator.sendBeacon) {   // 改完馬上關掉 App：等不到 1 秒，用 beacon 先送
        try { navigator.sendBeacon("api/state", JSON.stringify({data: get(), rev: meta.rev})); } catch (e) { /* 下次打開再送 */ }
      }
    });
    return {ready: sync(), touch, at: () => meta.at};
  }

  // ── 分頁 ──
  // defs: [{id, label, icon}]；每個分頁的內容是 .pane[data-tab=id]
  function tabs(defs, onSwitch, first) {
    const base = $(".screen.base", app);
    const nav = document.createElement("nav");
    nav.className = "tabs";
    nav.setAttribute("role", "tablist");
    nav.style.setProperty("--n", defs.length);
    nav.innerHTML = defs.map(d => `<button role="tab" data-tab="${d.id}" aria-selected="false">${icon(d.icon)}${esc(d.label)}</button>`).join("");
    base.appendChild(nav);
    const fit = () => app.style.setProperty("--tabs-h", nav.offsetHeight + "px");
    new ResizeObserver(fit).observe(nav);
    let cur = null;
    function show(id) {
      if (!defs.some(d => d.id === id)) id = defs[0].id;
      $$(".pane", base).forEach(p => { p.hidden = p.dataset.tab !== id; });
      $$("button", nav).forEach(b => b.setAttribute("aria-selected", b.dataset.tab === id));
      const again = cur === id;
      cur = id;
      store.set("ui.tab", id);
      onSwitch && onSwitch(id, again);
    }
    nav.onclick = e => { const b = e.target.closest("button[data-tab]"); if (b) { while (stack().length > 1) pop(true); show(b.dataset.tab); } };
    show(first || store.get("ui.tab", defs[0].id));
    fit();
    return {show, get current() { return cur; }};
  }

  // ── 推進新頁（從右邊滑入）＋左邊緣往右滑返回 ──
  // 大螢幕（≥720 寬，ui.css 同一條）：推進頁開在右邊、左邊清單留著（app 加 .split）；
  // 在左邊清單點另一項 → 右邊換成新的那頁（不疊起來）；在右邊頁裡點的才疊上去。
  const WIDE = window.matchMedia("(min-width: 720px)");
  let tapScreen = null;   // 最後一次點的是哪一層（左邊清單＝.base）
  const stack = () => $$(".screen", app).filter(s => !s._gone);   // _gone＝已經按返回、正在滑走的那層不算
  const split = () => app.classList.toggle("split", stack().length > 1);
  function push(html, opt = {}) {
    if (WIDE.matches && tapScreen && tapScreen.classList.contains("base") && tapScreen.isConnected)
      while (stack().length > 1) pop(true);
    const all = stack();
    const under = all[all.length - 1];
    const s = document.createElement("div");
    s.className = "screen push";
    s.innerHTML = html;
    s._onPop = opt.onPop;
    app.insertBefore(s, $(".dim", app));
    requestAnimationFrame(() => requestAnimationFrame(() => { s.classList.add("in"); under.classList.add("under"); }));
    $$(".back", s).forEach(b => b.onclick = () => pop());
    let x0 = null, dx = 0;
    s.addEventListener("touchstart", e => { const t = e.touches[0]; if (t.clientX - s.getBoundingClientRect().left < 28) { x0 = t.clientX; dx = 0; s.style.transition = "none"; } }, {passive: true});
    s.addEventListener("touchmove", e => { if (x0 === null) return; dx = Math.max(0, e.touches[0].clientX - x0); s.style.transform = `translateX(${dx}px)`; }, {passive: true});
    s.addEventListener("touchend", () => { if (x0 === null) return; s.style.transition = ""; s.style.transform = ""; if (dx > 90) pop(); x0 = null; dx = 0; });
    split();
    return s;
  }
  function pop(now) {
    const ss = stack();
    if (ss.length < 2) return;
    const top = ss[ss.length - 1], under = ss[ss.length - 2];
    top.classList.remove("in"); under.classList.remove("under");
    top._gone = true;   // 動畫中還在畫面上，但已經不算一層（連按兩次返回才不會又關到同一頁）
    top._onPop && top._onPop();
    if (now) top.remove(); else setTimeout(() => top.remove(), 330);
    split();
  }
  const topScreen = () => { const ss = stack(); return ss[ss.length - 1]; };
  // 安卓 App 外殼的返回鍵先問這個：有抽屜關抽屜、有推進頁退一頁，回 true；都沒有回 false（外殼自己決定關掉 App）
  function back() {
    if ($(".sheet.on", app)) { closeSheet(); return true; }
    if (stack().length > 1) { pop(); return true; }
    return false;
  }

  // ── 底部抽屜 ──
  let sheetClose = null;
  function sheet(title, html, onClose) {
    const sh = $(".sheet", app), dim = $(".dim", app);
    sh.innerHTML = `<div class="grab"></div><div class="sh-title"><span>${esc(title)}</span>
      <button class="iconbtn press" data-close aria-label="關閉">${icon("x")}</button></div><div class="sh-body">${html}</div>`;
    sheetClose = onClose || null;
    $("[data-close]", sh).onclick = closeSheet;
    sh.setAttribute("aria-label", title);
    requestAnimationFrame(() => { dim.classList.add("on"); sh.classList.add("on"); });
    // 往下拖抽屜把手可以關掉
    let y0 = null;
    const g = $(".grab", sh);
    g.ontouchstart = e => { y0 = e.touches[0].clientY; };
    g.ontouchmove = e => { if (y0 !== null && e.touches[0].clientY - y0 > 60) { y0 = null; closeSheet(); } };
    return $(".sh-body", sh);
  }
  function closeSheet() {
    const sh = $(".sheet", app);
    if (!sh.classList.contains("on")) return;
    $(".dim", app).classList.remove("on"); sh.classList.remove("on");
    const f = sheetClose; sheetClose = null; f && f();
  }

  let tt;
  function toast(t) {
    const el = $(".toast", app);
    el.textContent = t; el.classList.add("on");
    clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), 2200);
  }

  // ── 往下拉重新整理：scroll 最上面放一個 .ptr（放在 scroll 自己底下，內容重畫不會把它洗掉） ──
  function ptr(scroll, onRefresh) {
    const el = document.createElement("div");
    el.className = "ptr";
    el.innerHTML = `<span><span class="spin"></span>更新中…</span>`;
    scroll.prepend(el);
    let y0 = null, busy = false;
    scroll.addEventListener("touchstart", e => { if (scroll.scrollTop <= 0 && !busy) y0 = e.touches[0].clientY; }, {passive: true});
    scroll.addEventListener("touchmove", e => {
      if (y0 === null) return;
      if (e.touches[0].clientY - y0 > 70) { y0 = null; run(); }
    }, {passive: true});
    scroll.addEventListener("touchend", () => { y0 = null; });
    async function run() {
      busy = true; el.classList.add("on");
      // 至少轉 0.6 秒，資料很快回來時也看得出有更新
      try { await Promise.all([onRefresh(), new Promise(r => setTimeout(r, 600))]); } finally { el.classList.remove("on"); busy = false; }
    }
    return run;
  }

  // 「N 秒前更新」
  function ago(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 10 ? "剛剛更新" : s < 60 ? `${s} 秒前更新` : `${Math.floor(s / 60)} 分鐘前更新`;
  }

  function init(root) {
    app = root;
    theme();
    if (!$(".dim", app)) app.insertAdjacentHTML("beforeend", `<div class="dim"></div><div class="sheet" role="dialog"></div><div class="toast" role="status" aria-live="polite"></div>`);
    $(".dim", app).onclick = closeSheet;
    app.addEventListener("pointerdown", e => { tapScreen = e.target.closest(".screen"); }, true);
    document.addEventListener("keydown", e => { if (e.key === "Escape") { if ($(".sheet.on", app)) closeSheet(); else pop(); } });
  }

  // service worker：只快取外殼（資料不快取）；只有 https 或 localhost 能用
  function registerSW(path = "sw.js") {
    if (!("serviceWorker" in navigator) || !(location.protocol === "https:" || location.hostname === "localhost")) return;
    window.addEventListener("load", () => navigator.serviceWorker.register(path).catch(() => {}));
  }

  return {$, $$, esc, icon, store, theme, api, errHtml, bindRetry, cloud, tabs, push, pop, topScreen, back, sheet, closeSheet, toast, ptr, ago, init, registerSW};
})();
