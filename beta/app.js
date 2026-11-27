// 公車手機版（2026-11-27 起，第 1 步：設定＋金鑰＋從電腦版搬常用站牌、家／公司）
// 程式放 GitHub Pages（公開）；TDX 金鑰和常用資料只存在這支手機的 localStorage。
// TDX 的資料 API 對瀏覽器預檢（OPTIONS）回 401、沒有 CORS 標頭，網頁不能自己查 → 由安卓外殼 BusBridge 代查（見 設計.md）。
"use strict";
const VERSION = "手機版 0.7";
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

// ════════════ 常用的即時到站（照電腦版 busapi.api_fav：同一個縣市一次查完，省 TDX 額度） ════════════
const ETA_STATUS = {1: "尚未發車", 2: "交管不停靠", 3: "末班車已過", 4: "今日未營運"};
const busPath = (kind, city) => city === "InterCity" ? `v2/Bus/${kind}/InterCity` : `v2/Bus/${kind}/City/${city}`;
const LIVE = {t: null, err: "", busy: false, eta: {}};   // eta：「站牌|路線」→ TDX 到站原始資料

// 一筆公車到站 → {m 分鐘或 null, s 狀態 now/soon/""/off, t 文字}（電腦版 _eta＋eta_text）
function etaOf(e) {
  if (!e) return {m: null, s: "off", t: "暫無到站資料"};
  const sec = e.EstimateTime, stat = e.StopStatus ?? 0;
  if (sec != null && !stat) {
    const m = Math.floor(sec / 60);
    return {m, s: sec < 60 ? "now" : m <= 3 ? "soon" : "", t: sec < 60 ? "進站中" : `${m} 分`};
  }
  const nb = String(e.NextBusTime || "").slice(11, 16);
  return {m: null, s: "off", t: nb ? `${ETA_STATUS[stat] || ""} 下一班約 ${nb}`.trim() : ETA_STATUS[stat] || "沒有即時資料"};
}

// 同一站同一條路線有時有好幾筆（不同班次／業者）：有預估時間的優先、最快到的優先；先比子路線，再比方向
function favEta(f) {
  const c = (LIVE.eta[f.stop + "|" + f.route] || []).slice()
    .sort((a, b) => (a.EstimateTime == null) - (b.EstimateTime == null) || (a.EstimateTime || 0) - (b.EstimateTime || 0));
  return etaOf((f.sub && c.find(x => x.SubRouteUID === f.sub)) || c.find(x => (x.Direction ?? 0) === (f.dir ?? 0)) ||
    // 晚上常對不上（TDX 回 Direction 255）：只借「末班車已過」這類狀態，不借分鐘數（可能是對向的車）
    c.find(x => x.StopStatus && x.EstimateTime == null));
}

// ════════════ 時刻表補「下一班 hh:mm」（電腦版 _fav_bus：即時資料沒有分鐘數時才用；每條路線快取 6 小時） ════════════
const SCHED = {};   // 「縣市|路線」→ {t, rows}
const WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hmMin = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);

// 這個常用今天在這一站、晚於現在的第一班（只用時刻表裡有這一站的；子路線先比 sub 再比方向）
function schedNext(f) {
  const rows = SCHED[f.city + "|" + f.route]?.rows;
  if (!rows) return null;
  const now = new Date(), nowM = now.getHours() * 60 + now.getMinutes(), wd = WEEK[now.getDay()];
  const subs = (f.sub && rows.filter(x => x.SubRouteUID === f.sub).length) ? rows.filter(x => x.SubRouteUID === f.sub)
    : rows.filter(x => (x.Direction ?? 0) === (f.dir ?? 0));
  // 台南等只有起點站發車時間：照電腦版 board_times，用「第幾站 × 2 分鐘」推估到這一站（標「約」）
  const seq = ((f.sub && SCHED[f.city + "|" + f.route].stops?.find(x => x.SubRouteUID === f.sub)) ||
    SCHED[f.city + "|" + f.route].stops?.find(x => (x.Direction ?? 0) === (f.dir ?? 0)))?.Stops || [];
  const idx = seq.findIndex(s => s.StopUID === f.stop || (f.name && s.StopName?.Zh_tw === f.name));
  const exact = [], firsts = [];
  for (const x of subs) for (const t of x.Timetables || []) {
    if ((t.ServiceDay || {})[wd] === 0) continue;
    const sts = t.StopTimes || [];
    const s = sts.find(s => s.StopUID === f.stop);
    const v = s && (s.ArrivalTime || s.DepartureTime), v0 = sts[0] && (sts[0].DepartureTime || sts[0].ArrivalTime);
    if (v) exact.push(hmMin(v)); else if (v0) firsts.push(hmMin(v0));
  }
  let times = exact, about = "";
  if (exact.length < firsts.length) {
    if (idx < 0) return null;   // 找不到這一站就不猜
    times = firsts.map(t => t + idx * 2); about = idx ? "約 " : "";
  }
  const m = times.filter(t => t > nowM && t < 1440).sort((a, b) => a - b)[0];
  return m == null ? null : about + String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

async function refreshSched(favs) {
  for (const f of favs) {
    const k = f.city + "|" + f.route;
    if (SCHED[k] && Date.now() - SCHED[k].t < 6 * 3600e3) continue;
    if (favEta(f).m != null) continue;   // 有即時分鐘數就不用查
    try {
      const q = `?$filter=RouteName/Zh_tw eq '${f.route}'&$format=JSON`, nap = () => new Promise(r => setTimeout(r, 1500));
      await nap();   // 查太快 TDX 會回 429
      const rows = await tdx(busPath("Schedule", f.city) + q);
      await nap();
      SCHED[k] = {t: Date.now(), rows, stops: await tdx(busPath("StopOfRoute", f.city) + q)};
    } catch (e) { SCHED[k] = {t: Date.now() - 5.5 * 3600e3, rows: null}; }   // 失敗半小時後再試
  }
}

async function refreshLive() {
  const favs = DB.data.favs.filter(f => f.t === "bus" && f.city && f.stop);
  if (!favs.length || LIVE.busy || !window.BusBridge || !DB.settings.tdxId) return;
  LIVE.busy = true;
  const byCity = {};
  favs.forEach(f => (byCity[f.city] = byCity[f.city] || new Set()).add(f.stop));
  const eta = {}, errs = [];
  for (const [city, uids] of Object.entries(byCity)) {
    const flt = [...uids].sort().map(u => `StopUID eq '${u}'`).join(" or ");
    try {
      for (const e of await tdx(`${busPath("EstimatedTimeOfArrival", city)}?$filter=${flt}&$format=JSON`)) {
        const k = e.StopUID + "|" + (e.RouteName?.Zh_tw ?? "");
        (eta[k] = eta[k] || []).push(e);
      }
    } catch (e) { errs.push(e.message); }
  }
  LIVE.busy = false;
  if (errs.length && !Object.keys(eta).length) LIVE.err = errs[0];   // 全部失敗就保留上一次的資料
  else { LIVE.eta = eta; LIVE.err = errs[0] || ""; LIVE.t = new Date(); }
  renderFav();
  if (LIVE.t) { await refreshSched(favs); renderFav(); }
}

// ════════════ 附近（手機定位 → 300 公尺內的站牌 → 每站經過的公車幾分到；照電腦版 nearby_stops＋nearby_board） ════════════
const NEAR = {busy: false, err: "", groups: null, t: null};

function here() {
  return new Promise((ok, bad) => {
    if (!navigator.geolocation) return bad(new Error("這支手機不能定位"));
    navigator.geolocation.getCurrentPosition(p => ok(p.coords), e => bad(new Error(e.code === 1 ? "沒有允許定位（到手機設定開公車 App 的位置權限）" : "定位不到，等一下再試")),
      {enableHighAccuracy: true, timeout: 15000, maximumAge: 30000});
  });
}

function meters(a, b, c, d) {   // 兩點距離（公尺）
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

async function findNear() {
  if (NEAR.busy) return;
  NEAR.busy = true; NEAR.err = ""; renderNear();
  try {
    const p = await here();
    const lat = p.latitude.toFixed(5), lon = p.longitude.toFixed(5);
    const stops = (await tdx(`advanced/v2/Bus/Stop/NearBy?$spatialFilter=nearby(${lat}, ${lon}, 300)&$select=StopUID,StopName,StopPosition,City&$format=JSON`))
      .map(s => ({uid: s.StopUID, name: s.StopName?.Zh_tw ?? "", city: s.City,
        m: meters(+lat, +lon, s.StopPosition?.PositionLat ?? +lat, s.StopPosition?.PositionLon ?? +lon)}))
      .filter(s => s.uid && s.city).sort((a, b) => a.m - b.m).slice(0, 24);
    const byCity = {};
    stops.forEach(s => (byCity[s.city] = byCity[s.city] || []).push(s.uid));
    const eta = {};
    for (const [city, uids] of Object.entries(byCity)) {
      for (const e of await tdx(`${busPath("EstimatedTimeOfArrival", city)}?$filter=${uids.map(u => `StopUID eq '${u}'`).join(" or ")}&$format=JSON`))
        (eta[e.StopUID] = eta[e.StopUID] || []).push(e);
    }
    // 同名、距離差不多的站牌（對向、不同業者）併成一組；每組裡同一條路線同一個方向只留最快的
    const groups = [];
    for (const s of stops) {
      let g = groups.find(x => x.name === s.name && Math.abs(x.m - s.m) < 150);
      if (!g) groups.push(g = {name: s.name, m: s.m, buses: {}});
      for (const e of eta[s.uid] || []) {
        const k = (e.RouteName?.Zh_tw ?? "") + "|" + (e.Direction ?? 0);
        const v = etaOf(e);
        const old = g.buses[k];
        if (!old || (v.m != null && (old.m == null || v.m < old.m)))
          g.buses[k] = {...v, route: e.RouteName?.Zh_tw ?? "", dir: e.Direction ?? 0, city: s.city, stop: s.uid, sub: e.SubRouteUID};
      }
    }
    NEAR.groups = groups.filter(g => Object.keys(g.buses).length).slice(0, 8);
    await routeEnds(NEAR.groups.flatMap(g => Object.values(g.buses)));
    NEAR.t = new Date();
  } catch (e) {
    NEAR.err = e.message;
  }
  NEAR.busy = false;
  renderNear();
}

// 路線的起訖站（「往哪裡」用）：去程往終點、返程往起點；同縣市一次查、記在記憶體（路線很少變）。查不到就不顯示，不影響到站時間
const ENDS = {};   // 「縣市|路線」→ [起點, 終點]
async function routeEnds(buses) {
  const need = {};
  buses.forEach(b => { if (b.route && !ENDS[b.city + "|" + b.route]) (need[b.city] = need[b.city] || new Set()).add(b.route); });
  for (const [city, rs] of Object.entries(need)) {
    const flt = [...rs].map(r => `RouteName/Zh_tw eq '${r.replace(/'/g, "''")}'`).join(" or ");
    try {
      for (const r of await tdx(`${busPath("Route", city)}?$filter=${flt}&$select=RouteName,DepartureStopNameZh,DestinationStopNameZh&$format=JSON`))
        ENDS[city + "|" + (r.RouteName?.Zh_tw ?? "")] = [r.DepartureStopNameZh, r.DestinationStopNameZh];
    } catch (e) { /* 查太頻繁等：這次先不顯示往哪裡 */ }
  }
  buses.forEach(b => {
    const e = ENDS[b.city + "|" + b.route];
    b.to = e ? (b.dir === 1 ? e[0] : e[1]) || "" : "";
  });
}

// 附近的路線加到常用（同一站牌、同一條路線、同一個方向算同一個；再按一次拿掉）
const isFav = b => DB.data.favs.some(f => f.t === "bus" && f.stop === b.stop && f.route === b.route && (f.dir ?? 0) === b.dir);
function toggleFav(g, b) {
  const i = DB.data.favs.findIndex(f => f.t === "bus" && f.stop === b.stop && f.route === b.route && (f.dir ?? 0) === b.dir);
  if (i >= 0) DB.data.favs.splice(i, 1);
  else DB.data.favs.push({t: "bus", city: b.city, stop: b.stop, route: b.route, name: g.name, sub: b.sub, dir: b.dir, to: b.to || ""});
  save();
  renderNear();
  renderFav();
  if (i < 0) refreshLive();
  toast(i >= 0 ? `拿掉了：${b.route}` : `加到常用：${b.route} ${g.name}`);
}

function renderNear() {
  let h = `<div class="card"><h3>📍 附近站牌</h3><p class="muted">用手機定位找 300 公尺內的站牌和經過的公車。</p>` +
    `<button class="primary" data-act="near" ${NEAR.busy ? "disabled" : ""}>${NEAR.busy ? "查詢中…" : NEAR.groups ? "🔄 重新整理" : "📍 找附近站牌"}</button>` +
    (NEAR.err ? `<p class="muted">查不到：${esc(NEAR.err)}</p>` : "") +
    (NEAR.t ? `<p class="muted small-t">${NEAR.t.toLocaleTimeString("zh-TW", {hour12: false})} 更新</p>` : "") + `</div>`;
  if (NEAR.groups && !NEAR.groups.length) h += `<div class="card"><p class="muted">300 公尺內沒有找到有公車資料的站牌。</p></div>`;
  (NEAR.groups || []).forEach((g, gi) => {
    const bs = Object.entries(g.buses).sort(([, a], [, b]) => (a.m == null) - (b.m == null) || (a.m ?? 0) - (b.m ?? 0) || a.route.localeCompare(b.route, "zh-Hant"));
    h += `<div class="card"><h3>🚏 ${esc(g.name)} <span class="sub">約 ${g.m} 公尺</span></h3>` +
      bs.map(([k, b]) => `<div class="row"><span class="eta ${b.s}">${esc(b.t)}</span><span><b>${esc(b.route)}</b>` +
        (b.to ? ` <span class="sub">往 ${esc(b.to)}</span>` : "") + `</span>` +
        `<button class="star dot" data-act="addfav" data-g="${gi}" data-k="${esc(k)}" title="加到常用">${isFav(b) ? "⭐" : "☆"}</button></div>`).join("") + `</div>`;
  });
  $("#pane-near").innerHTML = h;
}

// ════════════ 畫面 ════════════
function favRow(f) {
  if (f.t !== "bus") {
    return `<div class="row"><span>${esc(f.label || f.name)}</span><span class="d">${esc(KIND[f.kind] ?? "")}</span></div>`;
  }
  const e = LIVE.t ? favEta(f) : {s: "off", t: "…"};
  const nx = LIVE.t && e.m == null && !/下一班/.test(e.t) && schedNext(f);
  if (nx) e.t = (e.t === "暫無到站資料" || e.t === "沒有即時資料" ? "" : e.t + " ") + "下一班 " + nx;
  return `<div class="row"><span class="eta ${e.s}">${esc(e.t)}</span><span><b>${esc(f.route)}</b> ${esc(f.name)}` +
    (f.to ? `<br><span class="sub">往 ${esc(f.to)}</span>` : "") + `</span></div>`;
}

function renderFav() {
  const D = DB.data;
  let h = "";
  if (!D.favs.length) {
    h += `<div class="card hint"><h3>還沒有常用</h3><p class="muted">到 ⚙️ 設定按「從電腦版搬過來」，把電腦版的常用站牌、家／公司複製到手機。</p></div>`;
  } else {
    let note = "";
    if (!window.BusBridge) note = "要在公車 App 裡才查得到到站時間。";
    else if (!DB.settings.tdxId) note = "先到 ⚙️ 設定輸入 TDX 金鑰，才查得到到站時間。";
    else if (LIVE.err) note = "查不到：" + LIVE.err;
    const at = LIVE.t ? LIVE.t.toLocaleTimeString("zh-TW", {hour12: false}) + " 更新・每 30 秒自動更新" : "";
    h += `<div class="card"><h3>⭐ 常用</h3>` + D.favs.map(favRow).join("") +
      `<p class="muted small-t">${esc(note || at)}${note && at ? "（" + esc(at) + "）" : ""}</p>` +
      `<p class="muted small-t">火車時刻之後幾步（第 3 步）才會做。</p></div>`;
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
  renderNear();
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
    refreshLive();
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
    refreshLive();
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
  if (act === "near") return findNear();
  if (act === "addfav") {
    const g = NEAR.groups?.[+b.dataset.g], bus = g?.buses[b.dataset.k];
    return bus && toggleFav(g, bus);
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
refreshLive();
// 每 30 秒自動更新（跟電腦版一樣）；App 在背景或不在常用頁就不查，省 TDX 額度
setInterval(() => { if (!document.hidden && document.body.dataset.tab === "fav") refreshLive(); }, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
