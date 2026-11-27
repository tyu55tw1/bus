// 公車手機版（2026-11-27 起，第 1 步：設定＋金鑰＋從電腦版搬常用站牌、家／公司）
// 程式放 GitHub Pages（公開）；TDX 金鑰和常用資料只存在這支手機的 localStorage。
// TDX 的資料 API 對瀏覽器預檢（OPTIONS）回 401、沒有 CORS 標頭，網頁不能自己查 → 由安卓外殼 BusBridge 代查（見 設計.md）。
"use strict";
const VERSION = "手機版 0.1";
const KEY = "busphone.v1";   // 同一個網域還有行事曆（calphone.v1）、之後的生活助手，名字別撞
const IS_BETA = location.pathname.includes("/beta/");
const KIND = {tra: "台鐵", thsr: "高鐵", metro: "捷運", bus: ""};   // 電腦版 favs 的 kind
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

// ════════════ 資料（只在手機） ════════════
function fix(d) {
  d = d && typeof d === "object" ? d : {};
  d.settings = d.settings || {};
  d.data = d.data || {};   // 跟電腦版 state.json 的 data 同一個樣子（favs、home、work、trips、places、rail…）
  if (!Array.isArray(d.data.favs)) d.data.favs = [];
  return d;
}
function load() {
  try { return fix(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (e) { return fix({}); }
}
let DB = load();
function save() {
  localStorage.setItem(KEY, JSON.stringify(DB));
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// ════════════ TDX（由 App 代查） ════════════
// tdx("v2/Bus/Route/City/Taipei?$top=1") → JSON；App 查完呼叫 window.onTdx(id, 文字, 錯誤)
const waiting = {};
let seq = 0;
function tdx(path) {
  if (!window.BusBridge) return Promise.reject(new Error("要在公車 App 裡才查得到（瀏覽器不能直接查 TDX）"));
  const {tdxId, tdxSecret} = DB.settings;
  if (!tdxId || !tdxSecret) return Promise.reject(new Error("先到 ⚙️ 設定輸入 TDX 金鑰"));
  const id = String(++seq);
  return new Promise((ok, bad) => {
    waiting[id] = {ok, bad, t: setTimeout(() => { delete waiting[id]; bad(new Error("查太久了，等一下再試")); }, 30000)};
    BusBridge.tdx(id, path, tdxId, tdxSecret);
  });
}
window.onTdx = function (id, text, err) {
  const w = waiting[id];
  if (!w) return;
  delete waiting[id];
  clearTimeout(w.t);
  if (err) return w.bad(new Error(err));
  try { w.ok(JSON.parse(text)); } catch (e) { w.bad(new Error("資料格式不對")); }
};

// ════════════ 畫面 ════════════
function renderFav() {
  const D = DB.data;
  let h = "";
  if (!D.favs.length) {
    h += `<div class="card hint"><h3>還沒有常用</h3><p class="muted">到 ⚙️ 設定按「從電腦版搬過來」，把電腦版的常用站牌、家／公司複製到手機。</p></div>`;
  } else {
    h += `<div class="card"><h3>⭐ 常用</h3>` + D.favs.map(f =>
      `<div class="row"><span>${esc(f.label || f.name)}</span><span class="d">${esc(KIND[f.kind] ?? f.kind ?? "")}</span></div>`).join("") +
      `<p class="muted small-t">到站時間下一步（第 2 步）才會做。</p></div>`;
  }
  const pl = [["🏠 家", D.home], ["🏢 公司", D.work]].filter(([, p]) => p && p.name);
  if (pl.length) h += `<div class="card"><h3>📍 地點</h3>` + pl.map(([n, p]) => `<div class="row"><span>${n}</span><span class="d">${esc(p.name)}</span></div>`).join("") + `</div>`;
  $("#pane-fav").innerHTML = h;
}

function renderSet() {
  const S = DB.settings;
  let h = `<div class="card"><h3>🔑 TDX 金鑰</h3><p class="muted">只存在這支手機，不會上傳。到 TDX 會員中心「API 金鑰」複製。</p>` +
    `<label>Client ID<input type="text" id="tdx-id" autocomplete="off" value="${esc(S.tdxId)}"></label>` +
    `<label>Client Secret<input type="password" id="tdx-sec" autocomplete="off" value="${esc(S.tdxSecret)}"></label>` +
    `<div class="btns"><button class="primary" data-act="savekey">存起來</button><button data-act="testkey">測試連線</button></div></div>`;
  h += `<div class="card"><h3>📥 從電腦版搬過來</h3>`;
  if (window.BusBridge) {
    h += `<p class="muted">手機要開 Tailscale、電腦要開著。會把電腦版的常用站牌、家／公司、常去地點、火車設定複製到手機（電腦版不會動）。</p>` +
      `<button class="primary" data-act="import">📥 從電腦版搬過來</button>`;
  } else {
    h += `<p class="muted">要在公車 App 裡才能搬（網頁不能跨網域拿電腦版的資料）。</p>`;
  }
  if (DB.data.imported) h += `<p class="muted small-t">上次搬：${esc(DB.data.imported)}</p>`;
  h += `</div>`;
  h += `<div class="card"><h3>ℹ️ 關於</h3><p class="muted">公車 ${VERSION}${IS_BETA ? "（測試版）" : ""}・程式放在網路上、打開時自動更新；` +
    `金鑰、常用站牌只存在手機，不會上傳。</p>` +
    `<div class="btns"><a class="btn" href="${IS_BETA ? "../app/" : "../beta/"}">${IS_BETA ? "回正式版" : "打開測試版"}</a>` +
    `<button class="danger" data-act="wipe">清除手機裡的資料</button></div></div>`;
  $("#pane-set").innerHTML = h;
}

function render() {
  renderFav();
  renderSet();
}

// 從電腦版搬：安卓外殼（BusBridge）在背景拿 電腦版 /api/state（{data, rev, at}），拿到後呼叫 window.onImport(文字, 錯誤)
window.onImport = function (text, err) {
  if (err) { toast("搬不過來：" + err, 5000); return; }
  try {
    const st = JSON.parse(text);
    const d = st && st.ok !== undefined ? st.data : st;   // 電腦版 API 外面包一層 {ok, data}
    if (!d || !d.data || typeof d.data !== "object") throw new Error("電腦版還沒有資料");
    const data = {...d.data};
    delete data.dev;   // 推播裝置是電腦版提醒用的；手機版提醒之後改手機自己查（第 5 步）
    data.imported = new Date().toLocaleString("zh-TW", {hour12: false});
    DB.data = data;
    DB = fix(DB);
    save();
    render();
    toast(`搬好了：常用 ${DB.data.favs.length} 個`);
  } catch (e) {
    toast("搬不過來：" + e.message, 5000);
  }
};

document.addEventListener("click", async ev => {
  const tab = ev.target.closest(".tabs button");
  if (tab) {
    document.body.dataset.tab = tab.dataset.tab;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b === tab));
    return;
  }
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "savekey") {
    DB.settings.tdxId = $("#tdx-id").value.trim();
    DB.settings.tdxSecret = $("#tdx-sec").value.trim();
    save();
    return toast("存好了");
  }
  if (act === "testkey") {
    try {
      await tdx("v2/Bus/Route/City/Taipei?$top=1&$format=JSON");
      toast("連得上 TDX ✅");
    } catch (e) {
      toast("連不上：" + e.message, 5000);
    }
    return;
  }
  if (act === "import") { toast("搬資料中…"); return window.BusBridge.importOld(); }
  if (act === "wipe") {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "再按一次就清掉"; return; }
    localStorage.removeItem(KEY);
    DB = load();
    render();
    return toast("清掉了");
  }
});

document.body.dataset.tab = "fav";
$("#beta").hidden = !IS_BETA;
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
