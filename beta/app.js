// 公車手機版（2026-11-27 起，第 1 步：設定＋金鑰＋從電腦版搬常用站牌、家／公司）
// 程式放 GitHub Pages（公開）；TDX 金鑰和常用資料只存在這支手機的 localStorage。
// TDX 的資料 API 對瀏覽器預檢（OPTIONS）回 401、沒有 CORS 標頭，網頁不能自己查 → 由安卓外殼 BusBridge 代查（見 設計.md）。
"use strict";
const VERSION = "手機版 1.8";
const KEY = "busphone.v1";   // 同一個網域還有行事曆（calphone.v1）、之後的生活助手，名字別撞
const IS_BETA = location.pathname.includes("/beta/");
const KIND = {tra: "台鐵", thsr: "高鐵", metro: "捷運", bus: ""};   // 電腦版 favs 的 kind
const $ = (s, el = document) => el.querySelector(s);
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

// 1.4 起外殼用電腦版的 ui.js（分頁、推進頁、抽屜、toast）
const icon = UI.icon;
const toast = msg => UI.toast(msg);

// ════════════ 錯誤＋撞到上限倒數（1.4） ════════════
// TDX／Gemini 回 429：顯示「…N 秒後自動重查」＋「現在重查」，每秒往下數，到 0 自動重查一次。
// 秒數：外殼 1.5 起錯誤訊息帶「（N 秒）」（讀 RateLimit-Reset／Retry-After）；舊外殼沒有就 60 秒
const RETRY = {}, WAITS = {};   // key → 重查的函式；key → 倒數到幾點（毫秒）
function busySecs(e) {
  const m = String(e?.message ?? e ?? "");
  if (!/頻繁|429|限流|額度暫時用完/.test(m)) return 0;
  const n = m.match(/（(\d+) 秒）/);
  return n ? Math.max(1, +n[1]) : 60;
}
function errBox(key, e, retry) {
  const msg = String(e?.message ?? e ?? "").replace(/（\d+ 秒）|，等幾秒再試/g, "");
  if (retry) RETRY[key] = retry;
  const s = busySecs(e);
  if (s && retry) {
    if (!WAITS[key]) WAITS[key] = Date.now() + s * 1000;
    const left = Math.max(0, Math.ceil((WAITS[key] - Date.now()) / 1000));
    return `<div class="note wait" data-wait="${key}"><span>${esc(msg)}，<b data-n>${left}</b> 秒後自動重查</span>` +
      `<button class="textbtn press" data-act="retry" data-k="${key}">現在重查</button></div>`;
  }
  return `<div class="note bad">${esc(msg)}${retry ? ` <button class="textbtn press" data-act="retry" data-k="${key}">再試一次</button>` : ""}</div>`;
}
function retryNow(key) {
  delete WAITS[key];
  document.querySelectorAll(`[data-wait="${key}"], .note.bad:has([data-k="${key}"])`).forEach(el => { el.innerHTML = `<span><span class="spin"></span>重查中…</span>`; });
  const f = RETRY[key];
  if (f) f();
}
setInterval(() => {
  for (const [k, until] of Object.entries(WAITS)) {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    document.querySelectorAll(`[data-wait="${k}"] [data-n]`).forEach(b => { b.textContent = left; });
    if (!left) retryNow(k);
  }
}, 1000);

// ════════════ TDX（由 App 代查） ════════════
// tdx("v2/Bus/Route/City/Taipei?$top=1") → JSON；App 查完呼叫 window.onTdx(id, 文字, 錯誤)
const waiting = {};
let seq = 0, tdxLine = Promise.resolve();
const nap = ms => new Promise(r => setTimeout(r, ms));
// 常用、附近、路線同時在查很容易 429：全部排隊、一次一個、間隔 1.2 秒；碰到「查太頻繁」等 6 秒、再等 15 秒各試一次
function tdx(path) {
  const again = ms => e => /頻繁|429/.test(e.message) ? nap(ms).then(() => tdx1(path)) : Promise.reject(e);
  const run = tdxLine.then(() => tdx1(path)).catch(again(6000)).catch(again(15000));
  tdxLine = run.catch(() => {}).then(() => nap(1200));
  return run;
}
function tdx1(path) {
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
  const mine = (f.sub && c.some(x => x.SubRouteUID === f.sub)) ? c.filter(x => x.SubRouteUID === f.sub) : c.filter(x => (x.Direction ?? 0) === (f.dir ?? 0));
  const e = etaOf(mine[0] ||
    // 晚上常對不上（TDX 回 Direction 255）：只借「末班車已過」這類狀態，不借分鐘數（可能是對向的車）
    c.find(x => x.StopStatus && x.EstimateTime == null));
  // 同一站同一條路線有第二筆預估（下一班）：電腦版卡片下面的「下一班 N 分」
  const n2 = mine[1]?.EstimateTime;
  if (e.m != null && n2 != null && !mine[1].StopStatus) e.nextM = Math.floor(n2 / 60);
  return e;
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
  const trains = DB.data.favs.some(f => f.t === "rail" || f.t === "metro");
  if ((!favs.length && !trains) || LIVE.busy || !window.BusBridge || !DB.settings.tdxId) return;
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
  if (errs.length && !Object.keys(eta).length) LIVE.err = errs[0];   // 全部失敗就保留上一次的資料
  else { LIVE.eta = eta; LIVE.err = errs[0] || ""; LIVE.t = new Date(); }
  renderFav();
  if (trains) { await refreshRailFavs(); renderFav(); }   // 火車、捷運（rail.js）
  LIVE.busy = false;
  if (LIVE.t && favs.length) { await refreshSched(favs); renderFav(); }
}

// ════════════ 附近（手機定位 → 300 公尺內的站牌 → 每站經過的公車幾分到；照電腦版 nearby_stops＋nearby_board） ════════════
const NEAR = {busy: false, err: "", groups: null, t: null, r: 300, home: false};

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

async function findNear(home) {
  if (NEAR.busy) return;
  if (home !== undefined) NEAR.home = home;
  NEAR.busy = true; NEAR.err = ""; renderNear();
  try {
    const H = DB.data.home;
    const p = NEAR.home && H?.lat ? {latitude: +H.lat, longitude: +H.lon} : await here();
    const lat = p.latitude.toFixed(5), lon = p.longitude.toFixed(5);
    const stops = (await tdx(`advanced/v2/Bus/Stop/NearBy?$spatialFilter=nearby(${lat}, ${lon}, ${NEAR.r})&$select=StopUID,StopName,StopPosition,City&$format=JSON`))
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
    NEAR.groups = groups.filter(g => Object.keys(g.buses).length).slice(0, 12);
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

// 畫面照電腦版 renderNear／nearStopsHtml／openStop（站牌卡片 → 推進站牌頁）
const nearBuses = g => Object.entries(g.buses).sort(([, a], [, b]) => (a.m == null) - (b.m == null) || (a.m ?? 0) - (b.m ?? 0) || a.route.localeCompare(b.route, "zh-Hant"));
function renderNear() {
  const body = $("#near-body");
  if (!body) return;
  const H = DB.data.home;
  $("#near-sub").textContent = NEAR.t || NEAR.busy ? (NEAR.home ? "我家附近" : "我的位置附近") : "站牌和公車";
  let h = `<div class="row" style="gap:8px;margin-bottom:4px"><button class="btn press" data-act="near" style="flex:1">${icon("pin")}用我的位置</button>` +
    (H?.lat ? `<button class="btn ghost press" data-act="nearhome" style="flex:1">${icon("home")}我家附近</button>` : "") + `</div>`;
  if (NEAR.busy) h += `<div class="cap"><span class="spin"></span>${NEAR.home ? "查我家附近…" : "定位、查附近站牌中…（最多約 15 秒）"}</div>`;
  if (NEAR.err) h += /定位|權限/.test(NEAR.err) ? `<div class="note bad">${esc(NEAR.err)}</div>` : errBox("near", NEAR.err, () => findNear());
  if (NEAR.groups || NEAR.busy) {
    h += `<div class="label"><span>附近站牌</span><span class="chips">${[200, 300, 500, 800].map(r =>
      `<button class="chip press" style="padding:3px 9px;font-size:12px" aria-pressed="${r === NEAR.r}" data-act="nearr" data-r="${r}">${r}m</button>`).join("")}</span></div>`;
    if (!NEAR.groups) h += `<div class="list"><div class="skel"></div><div class="skel"></div></div>`;
    else if (!NEAR.groups.length) h += `<div class="note">${NEAR.r} 公尺內沒有公車站牌，把範圍調大一點試試。</div>`;
    else h += `<div class="list">` + NEAR.groups.map((g, gi) => {
      const bs = nearBuses(g);
      return `<button class="card stopcard press" data-act="nstop" data-g="${gi}"><div class="h"><b>${esc(g.name)}</b><span>${g.m} 公尺・走路 ${Math.max(1, Math.round(g.m / 70))} 分</span></div>` +
        bs.slice(0, 4).map(([, b]) => `<div class="mini"><span class="l">${badge(b.route, "sm")}<span>${b.to ? "往 " + esc(b.to) : ""}</span></span>` +
          `<span class="r ${b.s}">${esc(b.m == null && b.s !== "now" ? offWord(b.t) : b.t)}</span></div>`).join("") +
        (bs.length > 4 ? `<div class="small muted">還有 ${bs.length - 4} 條路線 →</div>` : "") + `</button>`;
    }).join("") + `</div>`;
    if (NEAR.t) h += `<div class="upd">${NEAR.t.toLocaleTimeString("zh-TW", {hour12: false})} 更新・按上面的按鈕重新整理</div>`;
  } else if (!NEAR.err) {
    h += `<div class="empty"><div class="big">📍</div><b>看看附近有什麼車</b><p>按「用我的位置」：列出附近站牌每條公車還有幾分到。</p></div>`;
  }
  body.innerHTML = h;
  if (STOP.g) drawStop();
}

// 站牌頁（推進）：這站所有路線幾分，可以 ☆
const STOP = {g: null, s: null};
function openStop(gi) {
  STOP.g = NEAR.groups?.[gi];
  if (!STOP.g) return;
  STOP.name = STOP.g.name;
  STOP.s = UI.push(`<header class="top"><button class="back">${icon("back")}附近</button><h1 class="center">${esc(STOP.g.name)}</h1><span style="width:60px"></span></header>
    <div class="scroll"><div class="small muted" style="margin:0 2px 8px">${STOP.g.m} 公尺・點路線看沿途站牌，按 ☆ 加入常用</div><div data-body></div>
    <div class="cap">回「附近」按按鈕可以重新整理</div></div>`, {onPop: () => { STOP.g = null; STOP.s = null; }});
  drawStop();
}
function drawStop() {
  const s = STOP.s;
  if (!s || !s.isConnected) return;
  const g = NEAR.groups?.find(x => x.name === STOP.name) || STOP.g;
  STOP.g = g;
  const gi = NEAR.groups ? NEAR.groups.indexOf(g) : -1;
  $("[data-body]", s).innerHTML = `<div class="cardlist">` + nearBuses(g).map(([k, b]) => {
    const on = isFav(b);
    return `<div class="rrow"><button class="press" data-act="nroute" data-g="${gi}" data-k="${esc(k)}" style="display:contents">${badge(b.route, "sm")}` +
      `<span class="w"><b>${b.to ? "往 " + esc(b.to) : esc(b.route)}</b><span>${esc(b.route)}</span></span>${etaHtml(b, "", "sm")}</button>` +
      `<button class="starbtn press${on ? " on" : ""}" data-act="addfav" data-g="${gi}" data-k="${esc(k)}" aria-label="${on ? "從常用移除" : "加入常用"}">${icon(on ? "star" : "starO")}</button></div>`;
  }).join("") + `</div>`;
}

// ════════════ 查路線（照電腦版 api_route＋api_route_live：整條路線每站幾分、公車在哪一站） ════════════
// 路線名稱清單一個縣市一天查一次（存手機，不是個人資料）；打開一條路線查 StopOfRoute 一次，之後每 30 秒查到站＋公車位置 2 次
const CITIES = {"臺北市": "Taipei", "新北市": "NewTaipei", "桃園市": "Taoyuan", "臺中市": "Taichung", "臺南市": "Tainan",
  "高雄市": "Kaohsiung", "基隆市": "Keelung", "新竹市": "Hsinchu", "新竹縣": "HsinchuCounty", "苗栗縣": "MiaoliCounty",
  "彰化縣": "ChanghuaCounty", "南投縣": "NantouCounty", "雲林縣": "YunlinCounty", "嘉義市": "Chiayi", "嘉義縣": "ChiayiCounty",
  "屏東縣": "PingtungCounty", "宜蘭縣": "YilanCounty", "花蓮縣": "HualienCounty", "臺東縣": "TaitungCounty",
  "金門縣": "KinmenCounty", "澎湖縣": "PenghuCounty", "連江縣": "LienchiangCounty", "公路客運（國道／跨縣市）": "InterCity"};
const RKEY = "busphone.routes";   // 縣市 → {t, names}
const RT = {city: "", q: "", names: null, busy: false, err: "", cur: null};   // cur：{city, route, subs, si, hl, eta, bus, t, err}
const routeQ = r => `$filter=RouteName/Zh_tw eq '${r.replace(/'/g, "''")}'&$format=JSON`;

async function loadNames(city) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(RKEY) || "{}"); } catch (e) { /* 壞掉就重查 */ }
  if (all[city] && Date.now() - all[city].t < 86400e3) return all[city].names;
  const names = [...new Set((await tdx(busPath("Route", city) + "?$select=RouteName&$format=JSON")).map(x => x.RouteName?.Zh_tw).filter(Boolean))]
    .sort((a, b) => !/^\d/.test(a) - !/^\d/.test(b) || a.length - b.length || a.localeCompare(b, "zh-Hant"));
  all[city] = {t: Date.now(), names};
  localStorage.setItem(RKEY, JSON.stringify(all));
  return names;
}

async function pickCity(city) {
  RT.city = city; RT.names = null; RT.err = ""; RT.busy = true; renderRoute();
  try { RT.names = await loadNames(city); } catch (e) { RT.err = e.message; }
  RT.busy = false; renderRoute();
}

// 打開一條路線；dir／hl（站牌 UID）是從附近、常用點過來時用的：選那個方向、標出那一站
async function openRoute(city, route, dir, hl, sub, from) {
  const cur = RT.cur = {city, route, subs: null, si: 0, hl, eta: [], bus: [], t: null, err: "", busy: true};
  // 電腦版 openRoute：推進頁（大螢幕開在右邊）
  cur.s = UI.push(`<header class="top"><button class="back">${icon("back")}${esc(from || "返回")}</button><span class="grow"></span>
      <button class="iconbtn press" data-act="rstar" aria-label="加入常用"></button></header>
    <div class="scroll"><div data-body></div></div>`, {onPop: () => { if (RT.cur === cur) RT.cur = null; renderFav(); }});
  renderRoute();
  try {
    cur.raw = await tdx(busPath("StopOfRoute", city) + "?" + routeQ(route));
    const subs = cur.raw.filter(r => (r.Stops || []).length);
    const names = subs.map(r => r.SubRouteName?.Zh_tw || r.RouteName?.Zh_tw || route);
    cur.subs = subs.map((r, i) => {
      const last = r.Stops[r.Stops.length - 1]?.StopName?.Zh_tw || "";
      return {sub: r.SubRouteUID, dir: r.Direction ?? 0, last,
        label: names.filter(n => n === names[i]).length === 1 && names.length > 1 && names[i] !== route ? names[i] : `往 ${last}`,
        stops: r.Stops.map(s => ({uid: s.StopUID, name: s.StopName?.Zh_tw || ""}))};
    });
    const has = s => !hl || s.stops.some(x => x.uid === hl);
    const i = cur.subs.findIndex(s => sub && s.sub === sub && has(s));
    const j = i >= 0 ? i : cur.subs.findIndex(s => (dir == null || s.dir === dir) && has(s));
    cur.si = Math.max(0, j >= 0 ? j : cur.subs.findIndex(has));
    if (!cur.subs.length) cur.err = "查不到這條路線的站牌";
  } catch (e) { cur.err = e.message; }
  cur.busy = false;
  if (RT.cur !== cur) return;
  renderRoute();
  setTimeout(() => { const m = cur.s && $(".stop.mine", cur.s); if (m) $(".scroll", cur.s).scrollTop = m.offsetTop - 160; }, 380);
  if (!cur.subs?.length) return;
  await refreshRoute();
  // 首末班、班距（電腦版 api_route）：時刻表跟常用共用快取，6 小時內不重查
  const k = city + "|" + route;
  if (!SCHED[k]?.rows || Date.now() - SCHED[k].t > 6 * 3600e3) {
    try { SCHED[k] = {t: Date.now(), rows: await tdx(busPath("Schedule", city) + "?" + routeQ(route)), stops: cur.raw}; } catch (e) { /* 沒有時刻表就不顯示 */ }
  }
  if (RT.cur === cur) renderRoute();
}

// 這個子路線今天起點站的首班、末班、班距（只有班距的路線例如台北 307 用 Frequencys）
function subTimes(city, route, sub) {
  const rows = SCHED[city + "|" + route]?.rows;
  if (!rows) return "";
  const wd = WEEK[new Date().getDay()];
  const mine = rows.filter(x => sub.sub && x.SubRouteUID === sub.sub);
  const use = mine.length ? mine : rows.filter(x => (x.Direction ?? 0) === sub.dir);
  const times = [], heads = [];
  for (const x of use) {
    for (const t of x.Timetables || []) {
      if ((t.ServiceDay || {})[wd] === 0) continue;
      const s0 = (t.StopTimes || [])[0], v = s0 && (s0.DepartureTime || s0.ArrivalTime);
      if (v) times.push(v.slice(0, 5));
    }
    for (const f of x.Frequencys || []) if ((f.ServiceDay || {})[wd] !== 0) heads.push(f);
  }
  times.sort();
  if (heads.length) {
    const lo = Math.min(...heads.map(f => f.MinHeadwayMins || 99)), hi = Math.max(...heads.map(f => f.MaxHeadwayMins || 0));
    const st = heads.map(f => f.StartTime).sort()[0], en = heads.map(f => f.EndTime).sort().pop();
    return `${st}～${en}・` + (lo === hi ? `約 ${lo} 分一班` : `約 ${lo}～${hi} 分一班`);
  }
  if (!times.length) return "";
  const gap = times.length >= 3 ? Math.round((hmMin(times[times.length - 1]) - hmMin(times[0])) / (times.length - 1)) : 0;
  return `首班 ${times[0]}・末班 ${times[times.length - 1]}・` + (gap && gap < 90 ? `平均約 ${gap} 分一班` : `一天 ${times.length} 班`);
}

async function refreshRoute() {
  const cur = RT.cur;
  if (!cur || !cur.subs?.length || cur.live) return;
  cur.live = true;
  try {
    cur.eta = await tdx(busPath("EstimatedTimeOfArrival", cur.city) + "?" + routeQ(cur.route));
    cur.t = new Date(); cur.err = "";
    if (RT.cur === cur) renderRoute();   // 到站時間先顯示，公車位置晚一點補
    try { cur.bus = await tdx(busPath("RealTimeNearStop", cur.city) + "?" + routeQ(cur.route)); } catch (e) { /* 留上一次的位置 */ }
  } catch (e) { cur.err = e.message; }
  cur.live = false;
  if (RT.cur === cur) renderRoute();
}

// 一站的到站：同子路線優先、再同方向；都對不上只借「末班車已過」這類狀態（跟常用一樣）
function stopEta(s, sub) {
  const c = RT.cur.eta.filter(e => e.StopUID === s.uid)
    .sort((a, b) => (a.EstimateTime == null) - (b.EstimateTime == null) || (a.EstimateTime || 0) - (b.EstimateTime || 0));
  return etaOf((sub.sub && c.find(x => x.SubRouteUID === sub.sub)) || c.find(x => (x.Direction ?? 0) === sub.dir) ||
    c.find(x => x.StopStatus && x.EstimateTime == null));
}

// 查路線分頁（電腦版 renderSearch：上面「公車路線／路線規劃（A 到 B）」切換；路線規劃＝trip.js 的想去哪）
const cityName = c => (Object.keys(CITIES).find(n => CITIES[n] === c) || c || "選縣市").replace(/（.*）/, "");
function renderSearch() {
  const body = $("#search-body");
  if (!body.firstChild) {
    body.innerHTML = `<div class="seg" style="margin-bottom:12px"><button data-act="smode" data-m="route">公車路線</button><button data-act="smode" data-m="plan">路線規劃（A 到 B）</button></div>
      <div id="rt-box"><div class="row" style="margin-bottom:10px"><button class="chip press" data-act="rtcity" aria-pressed="true" id="rt-city"></button><span class="small muted">點這裡換縣市</span></div>
        <div class="field">${icon("search")}<input type="search" id="rt-q" placeholder="打號碼或名字，例如：綠、紅3、藍幹" aria-label="搜尋路線" autocomplete="off"></div>
        <div id="rt-res"></div></div>
      <div id="trip-box" hidden></div>`;
    $("#rt-q").value = RT.q;
  }
  const plan = RT.mode === "plan";
  body.querySelectorAll("[data-act=smode]").forEach(b => b.setAttribute("aria-pressed", (b.dataset.m === "plan") === plan));
  $("#rt-box").hidden = plan; $("#trip-box").hidden = !plan;
  $("#rt-city").textContent = cityName(RT.city) + " ▾";
  let h = "";
  if (RT.busy) h += `<div class="cap"><span class="spin"></span>讀路線清單…</div>`;
  if (RT.err) h += errBox("names", RT.err, () => pickCity(RT.city));
  if (RT.names) {
    const q = RT.q.trim().replace(/台/g, "臺");
    const hit = q ? RT.names.filter(n => n.includes(q)).sort((a, b) => (b === q) - (a === q) || !b.startsWith(q) - !a.startsWith(q)) : [];
    if (!q) h += `<div class="cap">${esc(cityName(RT.city))}有 ${RT.names.length} 條路線，打號碼或名字找</div>`;
    else if (!hit.length) h += `<div class="note">沒有「${esc(q)}」這條路線</div>`;
    else h += `<div class="cardlist" style="margin-top:12px">` + hit.slice(0, 40).map(n =>
      `<button class="rowlink press" data-act="route" data-r="${esc(n)}"><span class="row">${badge(n)}<span class="w"><b>${esc(n)}</b></span></span>${icon("chev", "chev")}</button>`).join("") + `</div>` +
      (hit.length > 40 ? `<div class="cap">還有 ${hit.length - 40} 條，打多一點字</div>` : "");
  }
  $("#rt-res").innerHTML = h;
}

// 路線頁（推進，電腦版 openRoute 的 draw＋paintLive）
function renderRoute() {
  if ($("#search-body")) renderSearch();
  const cur = RT.cur;
  if (!cur || !cur.s || !cur.s.isConnected) return;
  const body = $("[data-body]", cur.s);
  let h = "";
  const sub = cur.subs?.[cur.si];
  h += `<div class="rhead">${badge(cur.route, "lg")}<div><div class="t">${sub ? "往 " + esc(sub.last) : esc(cur.route)}</div>` +
    `<div class="s">${esc(cityName(cur.city))}${sub ? "・" + esc(subTimes(cur.city, cur.route, sub) || "沒有時刻表") : cur.busy ? "・讀取路線…" : ""}</div></div></div>`;
  if (cur.busy) h += `<div class="skel"></div>`;
  if (cur.err) h += errBox("route", cur.err, () => cur.subs?.length ? refreshRoute() : (UI.pop(), openRoute(cur.city, cur.route, null, cur.hl, null)));
  if (sub) {
    if (cur.subs.length > 1) h += `<div class="chips scrollx" style="margin-bottom:12px">` + cur.subs.map((s, i) =>
      `<button class="chip press" aria-pressed="${i === cur.si}" data-act="sub" data-i="${i}">${esc(cur.subs.length === 2 ? (i === 0 ? "去程" : "回程") + "・往 " + s.last : s.label)}</button>`).join("") + `</div>`;
    const k = sub.stops.findIndex(s => s.uid === cur.hl);
    h += `<div class="card" style="padding:12px 14px">${k >= 0 ? `<b>你的站：${esc(sub.stops[k].name)}</b><span class="muted small">（第 ${k + 1} 站）</span>` : `<b>點下面的站名，選你要上車的站</b>`}
      <div class="small muted">${k >= 0 ? "按右上 ☆ 可以加入／移除常用・點別的站可以換" : "選好後按右上 ☆ 就會加進常用"}</div></div>`;
    const buses = cur.bus.filter(b => (sub.sub && b.SubRouteUID ? b.SubRouteUID === sub.sub : (b.Direction ?? 0) === sub.dir));
    h += `<div class="label"><span>沿途站牌</span><span>${cur.t ? cur.t.toLocaleTimeString("zh-TW", {hour12: false}) + " 更新・紅色是公車位置" : "讀到站時間…"}</span></div>`;
    h += `<div class="card"><div class="line">` + sub.stops.map((s, i) => {
      const e = cur.t ? stopEta(s, sub) : null;
      const bus = buses.find(b => b.StopUID === s.uid);
      return `<button class="stop${i === k ? " mine" : ""}" data-act="rstop" data-i="${i}">` +
        (bus ? `<span class="busm" title="${esc(bus.PlateNumb || "")}">車</span>` : "") +
        `<span class="nm">${esc(s.name)}${i === k ? "<small>你在這</small>" : ""}</span>` +
        `<span class="e${e && e.s ? " " + e.s : ""}">${e ? esc(e.m == null && e.s !== "now" ? offWord(e.t) : e.t) : "…"}</span></button>`;
    }).join("") + `</div></div><div class="cap">開著這頁每 30 秒更新</div>`;
  }
  body.innerHTML = h;
  const st = $("[data-act=rstar]", cur.s), it = routeFavItem(), on = it && isFav(it);
  st.innerHTML = icon(on ? "star" : "starO");
  st.style.color = on ? "var(--led)" : "";
}
function routeFavItem() {
  const cur = RT.cur, sub = cur?.subs?.[cur.si], s = sub?.stops.find(x => x.uid === cur.hl);
  return s ? {city: cur.city, stop: s.uid, route: cur.route, dir: sub.dir, sub: sub.sub, to: sub.last, name: s.name} : null;
}

// ════════════ 畫面（1.4 起照電腦版 公車-plain\web\app.js 的 HTML 和 class） ════════════
// 路線色塊：綠／紅／藍／橘／棕／黃開頭的用那個顏色（電腦版 badgeCls）
function badgeCls(r) {
  r = String(r || "");
  return /^紅/.test(r) ? "red" : /^藍/.test(r) ? "blue" : /^橘/.test(r) ? "orange" : /^棕/.test(r) ? "brown" : /^黃/.test(r) ? "yellow" : "";
}
const shortRoute = r => String(r || "").replace(/\s.*$/, "").slice(0, 6);
const badge = (r, size = "") => `<span class="badge ${badgeCls(r)} ${size}">${esc(shortRoute(r))}</span>`;
// 狀態文字縮短：「尚未發車 下一班約 05:50」→「未發車」
function offWord(t) {
  t = String(t || "");
  return /末班/.test(t) ? "末班已過" : /尚未發車/.test(t) ? "未發車" : /未營運/.test(t) ? "今日停駛" : /交管/.test(t) ? "不停靠" : /暫無|沒有/.test(t) ? "暫無資料" : t.slice(0, 5);
}
function etaHtml(e, then, cls = "") {
  const th = then ? `<div class="then">${esc(then)}</div>` : "";
  if (!e) return `<span class="eta off ${cls}"><span class="n">…</span>${th}</span>`;
  if (e.s === "now") return `<span class="eta now ${cls}"><span class="n">進站中</span>${th}</span>`;
  if (e.m === null || e.m === undefined) return `<span class="eta off ${cls}"><span class="n">${esc(offWord(e.t))}</span>${th}</span>`;
  return `<span class="eta ${e.s === "soon" ? "soon" : ""} ${cls}"><span class="n num">${e.m}<small>分</small></span>${th}</span>`;
}
const delayHtml = d => d === null || d === undefined ? "" : d ? ` <span class="bad-t">晚 ${d} 分</span>` : ` <span class="ok-t">準點</span>`;
const walkOf = x => x.walk ?? DB.data.walk ?? 3;

function greet() {
  const h = new Date().getHours();
  $("#greet").textContent = h < 10 ? "早安・通勤時間" : h < 17 ? "午安" : h < 20 ? "晚安・下班時間" : "晚安";
}

// 公車卡片下面那一行：有分鐘數→下一班 N 分；沒有→時刻表的下一班
function busThen(f, e) {
  if (e.m != null) return e.nextM != null ? `下一班 ${e.nextM} 分` : "";
  const nx = schedNext(f);
  if (nx) return `下一班 ${nx}`;
  const nb = String(e.t).match(/下一班約 (\d\d:\d\d)/);
  return nb ? `下一班約 ${nb[1]}` : "";
}

function favCard(f, i) {
  let b, who, sub, eta, dl = "";
  if (f.t === "bus") {
    const e = LIVE.t ? favEta(f) : null;
    b = badge(f.route); who = f.alias || f.name; sub = `往 ${f.to || ""}${f.alias ? `・${f.name}` : ""}`;
    eta = etaHtml(e, e ? busThen(f, e) : "");
  } else if (f.t === "rail") {
    const tra = (f.kind || "tra") === "tra", x = FAVX.get(f), n = x?.trains?.[0];
    b = `<span class="badge ${tra ? "tra" : "hsr"}">${tra ? "台鐵" : "高鐵"}</span>`;
    who = f.alias || `${f.on} → ${f.dn}`;
    if (n) {
      const m = minsTo(n.dep);
      sub = `${n.type ? n.type + " " : ""}${n.no} 次・${n.arr} 到`;
      eta = m <= 0 ? `<span class="eta now"><span class="n">快開了</span><div class="then">${esc(n.dep)} 開</div></span>` :
        `<span class="eta ${m <= 5 ? "soon" : ""}"><span class="n num">${m >= 100 ? Math.floor(m / 60) + "<small>時</small>" : m + "<small>分</small>"}</span><div class="then">${esc(n.dep)} 開</div></span>`;
      dl = delayHtml(n.delay);
    } else if (x?.trains) { sub = "今天沒有車了"; eta = `<span class="eta off"><span class="n">明天再查</span></span>`; }
    else { sub = x?.err ? (busySecs(x.err) ? "查太頻繁，倒數完自動重查" : "查不到：" + x.err.replace(/（\d+ 秒）/, "")) : f.alias ? `${f.on} → ${f.dn}` : "查詢中…"; eta = etaHtml(x?.err ? {m: null, t: "暫無資料"} : null); }
  } else if (f.t === "metro") {
    const x = FAVX.get(f), r = x?.rows?.[0];
    b = `<span class="badge metro">捷運</span>`; who = f.alias || f.name;
    sub = r ? x.rows.slice(0, 2).map(y => `${y.dest} ${y.t}`).join("・") : x?.err ? (busySecs(x.err) ? "查太頻繁，倒數完自動重查" : "查不到：" + x.err.replace(/（\d+ 秒）/, "")) : x ? "目前沒有即時資料" : "查詢中…";
    eta = r && r.m != null ? (r.m === 0 ? `<span class="eta now"><span class="n">進站中</span></span>` :
      `<span class="eta ${r.m <= 3 ? "soon" : ""}"><span class="n num">${r.m}<small>分</small></span><div class="then">${esc(r.dest)}</div></span>`) : etaHtml(x ? {m: null, t: "暫無資料"} : null);
  } else if (f.t === "bike") {
    b = `<span class="badge bike">YouBike</span>`; who = f.alias || f.name; sub = "手機版還不能查 YouBike";
    eta = etaHtml({m: null, t: "暫無資料"});
  } else return "";
  return `<button class="card fav press" data-act="fav" data-i="${i}">${b}<span class="who"><b>${esc(who)}${rmHas(f) ? icon("bell", "bell") : ""}</b><span>${esc(sub)}${dl}</span></span>${eta}</button>`;
}
// 這個常用有沒有開快到提醒（remind.js 存的提醒用站牌＋路線認）
function rmHas(f) {
  try { return f.t === "bus" && typeof rmList === "function" && rmList().some(r => r.stop === f.stop && r.route === f.route); } catch (e) { return false; }
}

// 最上面的大卡片：第一個公車的下一班＋白話建議（電腦版 hintHtml）
function hintHtml() {
  const i = DB.data.favs.findIndex(x => x.t === "bus");
  if (i < 0) return "";
  const x = DB.data.favs[i], e = LIVE.t ? favEta(x) : null;
  const title = `<b>${esc(shortRoute(x.route))}・${esc(x.alias || x.name)}</b>`;
  if (!e) return `<button class="hint press" data-act="fav" data-i="${i}"><div class="big word">…</div><p>${title}<br>${window.BusBridge && DB.settings.tdxId ? "讀取中…" : "還查不到到站時間"}</p></button>`;
  const walk = walkOf(x);
  let big, msg;
  if (e.m != null || e.s === "now") {
    big = e.s === "now" ? `<div class="big word">進站中</div>` : `<div class="big">${e.m}<small>分</small></div>`;
    const left = (e.m ?? 0) - walk;
    if (left >= 1) msg = `走過去 ${walk} 分鐘，${left <= 2 ? "現在出門剛好" : `再等 ${left} 分鐘出門就好`}`;
    else if (e.nextM != null) msg = `走過去 ${walk} 分鐘，這班來不及了，搭下一班 ${e.nextM} 分`;
    else msg = `走過去 ${walk} 分鐘，這班來不及了`;
  } else {
    big = `<div class="big word">${esc(offWord(e.t))}</div>`;
    const nx = schedNext(x);
    if (/末班/.test(e.t)) msg = "今天的車都開走了";
    else if (/未營運/.test(e.t)) msg = "今天沒有營運";
    else if (/尚未發車/.test(e.t)) msg = nx ? `下一班還沒從起點發車，時刻表推算約 ${nx} 到，走過去 ${walk} 分鐘` : "下一班還沒從起點發車，發車後就會顯示幾分到";
    else if (nx) msg = `下一班約 ${nx}（時刻表推算），走過去 ${walk} 分鐘`;
    else msg = "現在沒有到站資料，可能還沒發車或末班已過";
  }
  return `<button class="hint press" data-act="fav" data-i="${i}">${big}<p>${title}<br>${esc(msg)}</p></button>`;
}

const whereHtml = () => `<div class="whererow"><button class="where press" data-act="where">${icon("nav")}想去哪？</button>` +
  `<button class="askai press" data-act="aiopen">💬<span>問 AI</span></button></div>`;

function renderFav() {
  greet();
  const body = $("#fav-body"), D = DB.data;
  if (!D.favs.length) {
    body.innerHTML = whereHtml() + `<div class="empty"><div class="big">⭐</div><b>還沒有常用的站</b>
      <p>加了之後，一打開就看到下一班幾分到。<br>查到路線或站牌後按 ☆ 就會加進來。</p>
      <div class="btns" style="justify-content:center"><button class="btn press" data-act="go" data-go="search">${icon("search")}查路線</button>
      <button class="btn ghost press" data-act="go" data-go="near">${icon("pin")}附近</button>
      <button class="btn ghost press" data-act="go" data-go="rail">${icon("train")}火車</button></div></div>
      <div class="cap">電腦版有加過常用？<button class="textbtn" data-act="set">到設定「從電腦版搬過來」</button></div>`;
    return;
  }
  let note = "";
  if (!window.BusBridge) note = `<div class="note">要在公車 App 裡才查得到到站時間。</div>`;
  else if (!DB.settings.tdxId) note = `<div class="note">先按右上齒輪輸入 TDX 金鑰，才查得到到站時間。</div>`;
  else if (LIVE.err) note = errBox("fav", LIVE.err, () => refreshLive());
  else {   // 1.7（2026-11-28 使用者：台鐵那列只寫「查太頻繁」沒倒數）：常用裡火車／捷運撞到上限也顯示倒數
    const busy = D.favs.map(f => FAVX.get(f)?.err).find(m => m && busySecs(m));
    if (busy) note = errBox("fav", busy, () => refreshLive());
    else delete WAITS.fav;
  }
  body.innerHTML = whereHtml() + `<div id="hint-box">${hintHtml()}</div>
    <div class="label"><span>我的站牌</span><span id="fav-age">${LIVE.t ? UI.ago(LIVE.t.getTime()) : ""}</span></div>${note}
    <div class="list${LIVE.err ? " stale" : ""}" id="fav-list">${D.favs.map(favCard).join("")}</div>
    <div class="upd">往下拉可以重新整理・每 30 秒自動更新・長按公車可以設快到提醒</div>`;
}

// 長按公車卡片（0.55 秒）→ 快到提醒；放開前手指移動（捲動）就取消（電腦版 bindFav）
let pressT = null, longHit = false;
document.addEventListener("pointerdown", ev => {
  const c = ev.target.closest(".card.fav[data-i]");
  longHit = false; clearTimeout(pressT);
  const f = c && DB.data.favs[+c.dataset.i];
  if (f && f.t === "bus") pressT = setTimeout(() => { longHit = true; openRemind(f); }, 550);
});
["pointerup", "pointercancel", "pointermove"].forEach(n => document.addEventListener(n, ev => { if (n !== "pointermove" || Math.abs(ev.movementY) > 3) clearTimeout(pressT); }));
document.addEventListener("contextmenu", ev => { if (ev.target.closest(".card.fav")) ev.preventDefault(); });

function openFav(f) {
  if (!f) return;
  if (f.t === "bus" && f.city) openRoute(f.city, f.route, f.dir ?? 0, f.stop, f.sub, "常用");
  else if (f.t === "rail" || f.t === "metro") { TABS.show("rail"); openRailFav(f); }
  else if (f.t === "bike") toast(`${f.name}：手機版還不能查 YouBike`);
}

// ── 編輯常用（推進頁）：拖曳或上下移排序、刪除、改顯示名稱和走路分鐘（電腦版 openEdit） ──
function favLabel(x) {
  return x.t === "bus" ? `${x.route} 往 ${x.to || ""}・${x.name}` : x.t === "rail" ? `${x.kind === "thsr" ? "高鐵" : "台鐵"} ${x.on} → ${x.dn}` :
    x.t === "bike" ? `YouBike ${x.name}` : x.t === "metro" ? `${x.opname || "捷運"} ${x.name}` : (x.label || "");
}
function openEdit() {
  let dirty = false;
  const s = UI.push(`<header class="top"><button class="back">${icon("back")}常用</button><h1 class="center">編輯常用</h1><button class="textbtn press" data-done>完成</button></header>
    <div class="scroll"><div class="cap" style="margin:0 0 10px">按住左邊 ☰ 拖曳排序（或用 ▲▼）・名稱可以改成好記的・第一個公車會顯示在最上面的大卡片・🔔 快到時跳通知</div>
    <div class="cardlist" data-list></div><div data-empty></div></div>`, {onPop: () => { renderFav(); if (dirty) refreshLive(); }});
  $("[data-done]", s).onclick = () => UI.pop();
  const list = $("[data-list]", s), F = DB.data.favs;
  function draw() {
    if (!F.length) { list.hidden = true; $("[data-empty]", s).innerHTML = `<div class="empty"><b>常用清單是空的</b><p>到「查路線」「附近」「火車」按 ☆ 加入。</p></div>`; return; }
    list.innerHTML = F.map((x, i) => `<div class="erow" data-i="${i}">
      <button class="grip" aria-label="拖曳排序">${icon("grip")}</button>
      <div class="mid"><input class="nm" value="${esc(x.alias || "")}" placeholder="${esc(x.t === "rail" ? `${x.on} → ${x.dn}` : x.name || "")}" aria-label="顯示名稱">
        <div class="sub">${esc(favLabel(x))}</div>
        ${x.t === "bus" ? `<div class="stepper">走到站牌<button data-w="-1" aria-label="少 1 分">−</button><b>${walkOf(x)}</b><button data-w="1" aria-label="多 1 分">＋</button>分鐘</div>
          <button class="chip press remchip" aria-pressed="${rmHas(x)}" data-rem>${icon("bell")}${rmHas(x) ? "已設快到提醒" : "快到時提醒我"}</button>` : ""}</div>
      <div class="acts"><button data-mv="-1" aria-label="往上移"${i ? "" : " disabled"}>${icon("up")}</button>
        <button class="del" data-del aria-label="刪除">${icon("trash")}</button>
        <button data-mv="1" aria-label="往下移"${i < F.length - 1 ? "" : " disabled"}>${icon("down")}</button></div></div>`).join("");
    list.querySelectorAll(".erow").forEach(row => {
      const i = +row.dataset.i, x = F[i];
      $(".erow[data-i='" + i + "'] input", s).onchange = e => { const v = e.target.value.trim(); if (v) x.alias = v; else delete x.alias; save(); };
      row.querySelectorAll("[data-w]").forEach(b => b.onclick = () => { x.walk = Math.max(0, Math.min(30, walkOf(x) + +b.dataset.w)); save(); row.querySelector(".stepper b").textContent = x.walk; });
      row.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => move(i, i + +b.dataset.mv));
      const rb = row.querySelector("[data-rem]"); if (rb) rb.onclick = () => openRemind(x);
      row.querySelector("[data-del]").onclick = () => {
        const it = F.splice(i, 1)[0]; save(); dirty = true; draw();
        toast(`已刪除：${favLabel(it)}`);
      };
      grip(row);
    });
  }
  function move(a, b) {
    if (b < 0 || b >= F.length) return;
    const [it] = F.splice(a, 1); F.splice(b, 0, it); save(); draw();
  }
  function grip(row) {   // 拖曳：手指按住 ☰ 上下移，放開就照新位置排
    const h = row.querySelector(".grip");
    h.onpointerdown = e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const rows = [...list.querySelectorAll(".erow")], from = rows.indexOf(row);
      const tops = rows.map(r => r.getBoundingClientRect()), y0 = e.clientY;
      let to = from;
      row.classList.add("drag");
      h.onpointermove = ev => {
        const dy = ev.clientY - y0;
        row.style.transform = `translateY(${dy}px)`;
        const mid = tops[from].top + tops[from].height / 2 + dy;
        to = tops.findIndex(t => mid < t.top + t.height); if (to < 0) to = rows.length - 1;
      };
      h.onpointerup = h.onpointercancel = () => {
        h.onpointermove = h.onpointerup = h.onpointercancel = null;
        row.classList.remove("drag"); row.style.transform = "";
        if (to !== from) move(from, to);
      };
    };
  }
  draw();
}

// ── 設定（推進頁，電腦版 openSettings；TDX、Gemini 金鑰、從電腦版搬過來是手機版才有的） ──
let SET = null;
// 1.6（2026-11-28 使用者）：設定頁要指紋或螢幕鎖密碼才能進（外殼 1.6 的 BusBridge.auth）；驗過 5 分鐘內再進不用再驗；舊外殼沒有 auth 就不鎖
let authAt = 0, authWant = false;
const needAuth = () => !!(window.BusBridge && BusBridge.auth) && Date.now() - authAt > 5 * 60000;
window.onAuth = function (ok) {
  if (!ok) { authWant = false; return UI.toast("沒有驗證成功，設定還是鎖著"); }
  authAt = Date.now();
  if (authWant) { authWant = false; openSettings(); }
};
function openSettings() {
  if (needAuth()) { authWant = true; return BusBridge.auth("打開公車設定"); }
  authAt = Date.now();
  SET = UI.push(`<header class="top"><button class="back">${icon("back")}常用</button><h1 class="center">設定</h1><span style="width:60px"></span></header>
    <div class="scroll"><div data-body></div></div>`, {onPop: () => { SET = null; authAt = Date.now(); renderFav(); refreshLive(); }});
  renderSet();
}
function renderSet() {
  if (!SET || !SET.isConnected) return;
  const S = DB.settings, D = DB.data, th = UI.store.get("ui.theme", "auto");
  let u = {};
  try { u = JSON.parse(localStorage.getItem(AI_KEY) || "{}"); } catch (e) { /* 沒有 */ }
  $("[data-body]", SET).innerHTML = `<div class="label"><span>查詢</span></div><div class="cardlist">
      <button class="setrow press" data-act="rtcity"><span class="w"><b>城市</b><span>查路線預設的縣市</span></span><span class="v">${esc(cityName(RT.city || D.city))}${icon("chev")}</span></button>
      <div class="setrow"><span class="w"><b>走到站牌預設幾分鐘</b><span>大卡片用來算幾點出門（每個常用站可以另外設）</span></span>
        <span class="stepper"><button data-act="walk" data-w="-1" aria-label="少 1 分">−</button><b>${walkOf({})}</b><button data-act="walk" data-w="1" aria-label="多 1 分">＋</button></span></div>
    </div>
    <div class="label"><span>TDX 金鑰（查公車、火車用）</span></div><div class="cardlist">
      <div class="setrow col"><span class="w"><span>只存在這支手機，不會上傳。到 TDX 會員中心「API 金鑰」複製。</span></span>
        <div class="field"><input type="text" id="tdx-id" autocomplete="off" placeholder="Client ID" value="${esc(S.tdxId)}"></div>
        <div class="field"><input type="password" id="tdx-sec" autocomplete="off" placeholder="Client Secret" value="${esc(S.tdxSecret)}"></div>
        <div class="btns" style="margin:0"><button class="btn sm press" data-act="savekey">存起來</button><button class="btn sm ghost press" data-act="testkey">測試連線</button></div></div>
    </div>
    <div class="label"><span>Gemini 金鑰（問 AI 用）</span></div><div class="cardlist">
      <div class="setrow col"><span class="w"><span>只存在這支手機，不會上傳。到 aistudio.google.com「Get API key」免費申請。今天問了 ${u.day === dayIso(0) ? u.n : 0} 句（一天最多 ${AI_PER_DAY} 句）。</span></span>
        <div class="field"><input type="password" id="gem-key" autocomplete="off" placeholder="API 金鑰" value="${esc(S.gemKey)}"></div>
        <div class="btns" style="margin:0"><button class="btn sm press" data-act="savegem">存起來</button><button class="btn sm ghost press" data-act="testgem">測試金鑰</button></div>
        <span class="small muted" id="gem-test">測試金鑰不會用掉每天的問 AI 次數。</span></div>
    </div>
    <div class="label"><span>通知</span></div><div class="cardlist">
      <button class="setrow press" data-act="remind"><span class="w"><b>公車快到提醒</b><span>剩幾分鐘到你的站時跳通知（也可以在常用卡片長按）</span></span><span class="v">${typeof rmList === "function" && rmList().length ? rmList().length + " 個" : "還沒有"}${icon("chev")}</span></button>
    </div>
    <div class="label"><span>外觀</span></div>
    <div class="seg">${[["auto", "跟手機"], ["light", "淺色"], ["dark", "深色"]].map(([v, t]) => `<button aria-pressed="${th === v}" data-act="theme" data-v="${v}">${t}</button>`).join("")}</div>
    <div class="label"><span>資料</span></div><div class="cardlist">
      <button class="setrow press" data-act="import"><span class="w"><b>從電腦版搬過來</b><span>${window.BusBridge ? "手機要開 Tailscale、電腦要開著；把常用站牌、家／公司、常去地點、火車設定複製到手機（電腦版不會動）" : "要在公車 App 裡才能搬"}</span></span><span class="v">${D.imported ? esc(String(D.imported).replace(/:\d\d$/, "")) : "還沒搬"}${icon("chev")}</span></button>
      <a class="setrow press" href="${IS_BETA ? "../app/" : "../beta/"}" style="color:inherit;text-decoration:none"><span class="w"><b>${IS_BETA ? "回正式版" : "打開測試版"}</b><span>${IS_BETA ? "現在開的是測試版" : "先試新功能（資料共用）"}</span></span><span class="v">${icon("chev")}</span></a>
      <button class="setrow press" data-act="wipe"><span class="w"><b style="color:var(--hot)">清除手機裡的資料</b><span>金鑰、常用、家／公司都會刪掉</span></span><span class="v">${icon("trash")}</span></button>
    </div>
    <div class="cap" style="text-align:left">程式放在網路上、打開時自動更新；金鑰、常用站牌只存在手機，不會上傳。</div>
    <div class="cap">版本 公車${esc(VERSION)}${IS_BETA ? "（測試版）" : ""}${window.BusBridge?.ver ? "・App " + esc(BusBridge.ver()) : ""}<br>資料來源：交通部 TDX</div>`;
}

// 選縣市（電腦版 pickCity：底部抽屜方塊）
function cityPicker() {
  UI.sheet("選城市", `<div class="tiles">${Object.entries(CITIES).map(([n, c]) =>
    `<button class="tile press" aria-pressed="${c === RT.city}" data-act="citypick" data-c="${c}">${esc(n.replace(/（.*）/, ""))}</button>`).join("")}</div>`);
}

// ── 問 AI、快到提醒：推進頁，裡面沿用 ai.js／remind.js 的畫面 ──
function openAi() {
  AI.open = true;
  UI.push(`<header class="top"><button class="back">${icon("back")}常用</button><h1 class="center">問 AI</h1><span style="width:60px"></span></header>
    <div class="scroll chat" id="ai-box"></div>
    <div class="chatbar"><input type="text" id="ai-q" placeholder="想問什麼？例如：去成大醫院" autocomplete="off" enterkeyhint="send"><button class="btn press" data-act="aisend">送出</button></div>`, {onPop: () => { AI.open = false; }});
  renderAi();
  $("#ai-q")?.focus();
}
function openRemind(f) {
  if (f) {
    const i = rmBusFavs().indexOf(f);
    if (i >= 0) { RM.fav = i; RM.open = true; }
  }
  if (!$("#remind-box")) UI.push(`<header class="top"><button class="back">${icon("back")}返回</button><h1 class="center">快到提醒</h1><span style="width:60px"></span></header>
    <div class="scroll"><div id="remind-box"></div></div>`, {onPop: () => { RM.open = false; renderFav(); renderSet(); }});
  renderRemind();
}
// 想去哪＝查路線分頁的「路線規劃（A 到 B）」
function showPlan() {
  while (UI.topScreen() && !UI.topScreen().classList.contains("base")) UI.pop(true);
  RT.mode = "plan";
  TABS.show("search");
  renderTrip();
  setTimeout(() => $("#tp-q")?.focus(), 50);
}

function render() {
  renderFav();
  renderNear();
  renderSearch();
  renderTrip();   // trip.js
  renderRail();   // rail.js
  renderAi();     // ai.js（問 AI 頁開著才有）
  renderRemind(); // remind.js（提醒頁開著才有）
  renderSet();
  renderRoute();
}

// 從電腦版搬：安卓外殼（BusBridge）在背景拿 電腦版 /api/state（{data, rev, at}），拿到後呼叫 window.onImport(文字, 錯誤)
window.onImport = function (text, err) {
  if (err) { toast("搬不過來：" + err); return; }
  try {
    const st = JSON.parse(text);
    const d = st && st.ok !== undefined ? st.data : st;   // 電腦版 API 外面包一層 {ok, data}
    if (!d || !d.data || typeof d.data !== "object") throw new Error("電腦版還沒有資料");
    const data = {...d.data};
    delete data.dev;   // 推播裝置是電腦版提醒用的；手機版提醒是手機自己查（第 5 步）
    data.imported = new Date().toLocaleString("zh-TW", {hour12: false});
    DB.data = data;
    DB = fix(DB);
    save();
    render();
    refreshLive();
    toast(`搬好了：常用 ${DB.data.favs.length} 個`);
  } catch (e) {
    toast("搬不過來：" + e.message);
  }
};

document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "fav") { if (longHit) { longHit = false; return; } return openFav(DB.data.favs[+b.dataset.i]); }
  if (act === "go") return TABS.show(b.dataset.go);
  if (act === "set") return openSettings();
  if (act === "retry") return retryNow(b.dataset.k);
  if (act === "where") return showPlan();
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
      toast("連不上：" + e.message.replace(/（\d+ 秒）/, ""));
    }
    return;
  }
  if (act === "walk") { DB.data.walk = Math.max(0, Math.min(30, walkOf({}) + +b.dataset.w)); save(); return renderSet(); }
  if (act === "theme") { UI.theme(b.dataset.v); return renderSet(); }
  if (act === "remind") return openRemind();
  // 附近
  if (act === "near") return findNear(false);
  if (act === "nearhome") return findNear(true);
  if (act === "nearr") { NEAR.r = +b.dataset.r; NEAR.groups = null; return findNear(); }
  if (act === "nstop") return openStop(+b.dataset.g);
  if (act === "addfav") {
    const g = NEAR.groups?.[+b.dataset.g], bus = g?.buses[b.dataset.k];
    if (bus) { toggleFav(g, bus); drawStop(); }
    return;
  }
  if (act === "nroute") {
    const g = NEAR.groups?.[+b.dataset.g], bus = g?.buses[b.dataset.k];
    return bus && openRoute(bus.city, bus.route, bus.dir, bus.stop, bus.sub, "站牌");
  }
  // 查路線
  if (act === "smode") { RT.mode = b.dataset.m; return renderSearch(); }
  if (act === "rtcity") return cityPicker();
  if (act === "citypick") { UI.closeSheet(); DB.data.city = b.dataset.c; save(); renderSet(); return pickCity(b.dataset.c); }
  if (act === "route") return openRoute(RT.city, b.dataset.r, null, null, null, "查路線");
  if (act === "sub") { RT.cur.si = +b.dataset.i; if (!RT.cur.subs[RT.cur.si].stops.some(s => s.uid === RT.cur.hl)) RT.cur.hl = null; return renderRoute(); }
  if (act === "rstop") { const sub = RT.cur?.subs?.[RT.cur.si]; if (sub) { RT.cur.hl = sub.stops[+b.dataset.i].uid; renderRoute(); } return; }
  if (act === "rstar") {
    const it = routeFavItem();
    if (!it) return toast("先點你要上車的站，再按 ☆");
    toggleFav({name: it.name}, it);
    return renderRoute();
  }
  // 快到提醒（remind.js）
  if (act === "rmopen" || act === "rmcancel") { RM.open = act === "rmopen"; return renderRemind(); }
  if (act === "rmadd") { rmAdd(); renderFav(); return; }
  if (act === "rmdel") { rmDel(b.dataset.id); renderFav(); return; }
  if (act === "rmfav") { RM.fav = +b.dataset.i; return renderRemind(); }
  if (act === "rmmin") { RM.min = +b.dataset.m; return renderRemind(); }
  if (act === "rmkind") { RM.kind = b.dataset.k; return renderRemind(); }
  if (act === "rmday") { const d = +b.dataset.d; RM.days = RM.days.includes(d) ? RM.days.filter(x => x !== d) : [...RM.days, d]; return renderRemind(); }
  if (act === "rmbat") return BusBridge.openBattery();
  // 問 AI（ai.js）
  if (act === "aiopen") return openAi();
  if (act === "aisugg") return aiAsk(b.dataset.t);
  if (act === "aisend") { const t = $("#ai-q").value; $("#ai-q").value = ""; return aiAsk(t); }
  if (act === "aiclear") { AI.msgs = []; AI.hist = []; AI.retry = null; return renderAi(); }
  if (act === "aibtn") return aiBtn(+b.dataset.j);
  if (act === "testgem") return testGemKey();
  if (act === "savegem") { DB.settings.gemKey = $("#gem-key").value.trim(); save(); renderAi(); return toast("存好了"); }
  // 想去哪（trip.js）
  if (act === "tsearch") return tripSearch();
  if (act === "tfrom") return tripFrom(b.dataset.k);
  if (act === "tquick") { const p = DB.data[b.dataset.k]; return tripGo({name: b.dataset.k === "home" ? "家" : "公司", lat: +p.lat, lon: +p.lon}); }
  if (act === "tplace") { const p = DB.data.places[+b.dataset.i]; return p && tripGo({name: p.name, addr: p.addr || "", lat: +p.lat, lon: +p.lon}); }
  if (act === "tpick") { const p = TRIP.cands?.[+b.dataset.i]; return p && tripGo(p); }
  if (act === "tsave") return savePlace();
  if (act === "tpark") return loadPark();
  // 火車（rail.js）
  if (act === "rmode") return railMode(b.dataset.m);
  if (act === "rswap") { const r = railSet().rail[RAIL.mode]; [r.o, r.d] = [r.d, r.o]; save(); return renderRail(); }
  if (act === "rday") { RAIL.day = +b.dataset.d; return renderRail(); }
  if (act === "rnow") { RAIL.after = ""; return renderRail(); }
  if (act === "rpick") return railPick(b.dataset.p);
  if (act === "stpick") return railPicked(b.dataset.w, b.dataset.id, b.dataset.n);
  if (act === "mtop") { railSet().metroOp = b.dataset.op; save(); return railMode("metro"); }
  if (act === "rfind") return railFind();
  if (act === "rtrain") return railTrain(b.dataset.no);
  if (act === "rfav") return toggleRailFav();
  if (act === "mfav") return toggleMetroFav();
  if (act === "frail") { const f = DB.data.favs[+b.dataset.i]; return f && openRailFav(f); }
  if (act === "import") {
    if (!window.BusBridge) return toast("要在公車 App 裡才能搬");
    toast("搬資料中…"); return window.BusBridge.importOld();
  }
  if (act === "wipe") {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.querySelector("b").textContent = "再按一次就清掉"; return; }
    localStorage.removeItem(KEY);
    DB = load();
    render();
    UI.pop();
    return toast("清掉了");
  }
});

document.addEventListener("change", ev => {
  const id = ev.target.id;
  if (id === "rl-after") { RAIL.after = ev.target.value; renderRail(); }
});
document.addEventListener("keydown", ev => {
  if (ev.key !== "Enter") return;
  if (ev.target.id === "tp-q") tripSearch();
  if (ev.target.id === "ai-q") { const t = ev.target.value; ev.target.value = ""; aiAsk(t); }
});
document.addEventListener("input", ev => { if (ev.target.id === "rt-q") { RT.q = ev.target.value; renderSearch(); } });

// ── 啟動 ──
UI.init($("#app"));
$("#beta").hidden = !IS_BETA;
$("#btn-set").innerHTML = icon("gear");
$("#btn-set").onclick = openSettings;
$("#btn-edit").onclick = openEdit;
RT.mode = "route";
const TABS = UI.tabs([
  {id: "fav", label: "常用", icon: "star"},
  {id: "near", label: "附近", icon: "pin"},
  {id: "search", label: "查路線", icon: "search"},
  {id: "rail", label: "火車", icon: "train"},
], id => {
  if (id === "rail" && !RAIL.mode) railMode(["tra", "thsr", "metro"].includes(DB.data.railMode) ? DB.data.railMode : "tra");
  if (id === "search" && !RT.city) pickCity(DB.data.city || DB.data.favs.find(f => f.city)?.city || "Tainan");
  if (id === "fav") refreshLive();
}, "fav");
UI.ptr($("#fav-scroll"), () => refreshLive());
render();
refreshLive();
// 每 30 秒自動更新（跟電腦版一樣）；App 在背景或不在那一頁就不查，省 TDX 額度
setInterval(() => {
  if (document.hidden) return;
  const top = UI.topScreen();
  if (RT.cur && top === RT.cur.s) return refreshRoute();
  if (!top.classList.contains("base")) return;
  if (TABS.current === "fav") refreshLive();
  if (TABS.current === "rail") { if (RAIL.mode === "metro") metroLook(); else if (RAIL.list?.today && !document.activeElement?.id?.startsWith("rl-")) renderRail(); }
}, 30000);
setInterval(() => { const a = $("#fav-age"); if (a && LIVE.t) a.textContent = UI.ago(LIVE.t.getTime()); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshLive(); renderRemind(); } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
