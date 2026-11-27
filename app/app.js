// 公車手機版（2026-11-27 起，第 1 步：設定＋金鑰＋從電腦版搬常用站牌、家／公司）
// 程式放 GitHub Pages（公開）；TDX 金鑰和常用資料只存在這支手機的 localStorage。
// TDX 的資料 API 對瀏覽器預檢（OPTIONS）回 401、沒有 CORS 標頭，網頁不能自己查 → 由安卓外殼 BusBridge 代查（見 設計.md）。
"use strict";
const VERSION = "手機版 1.1";
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
      bs.map(([k, b]) => `<div class="row"><span class="eta ${b.s}">${esc(b.t)}</span><span><button class="link" data-act="nroute" data-g="${gi}" data-k="${esc(k)}"><b>${esc(b.route)}</b></button>` +
        (b.to ? ` <span class="sub">往 ${esc(b.to)}</span>` : "") + `</span>` +
        `<button class="star dot" data-act="addfav" data-g="${gi}" data-k="${esc(k)}" title="加到常用">${isFav(b) ? "⭐" : "☆"}</button></div>`).join("") + `</div>`;
  });
  $("#pane-near").innerHTML = h;
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
async function openRoute(city, route, dir, hl, sub) {
  document.body.dataset.tab = "route";
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === "route"));
  RT.cur = {city, route, subs: null, si: 0, hl, eta: [], bus: [], t: null, err: "", busy: true};
  renderRoute();
  const cur = RT.cur;
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
  renderRoute(true);
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

function renderRoute(scroll) {
  const opts = Object.entries(CITIES).map(([n, c]) => `<option value="${c}" ${c === RT.city ? "selected" : ""}>${n}</option>`).join("");
  let h = `<div class="card"><h3>🔍 查路線</h3><div class="trow"><select id="rt-city"><option value="">選縣市</option>${opts}</select>` +
    `<input type="text" id="rt-q" placeholder="路線號碼，例如 2、紅3、綠幹線" value="${esc(RT.q)}" autocomplete="off"></div>`;
  if (RT.busy) h += `<p class="muted">查路線清單中…</p>`;
  if (RT.err) h += `<p class="muted">查不到：${esc(RT.err)}</p>`;
  if (RT.names) {
    const q = RT.q.trim().replace(/台/g, "臺");
    const hit = q ? RT.names.filter(n => n.includes(q)).sort((a, b) => (b === q) - (a === q) || !b.startsWith(q) - !a.startsWith(q)) : [];
    h += q ? (hit.length ? `<div class="chips">` + hit.slice(0, 40).map(n => `<button class="small" data-act="route" data-r="${esc(n)}">${esc(n)}</button>`).join("") +
      `</div>` + (hit.length > 40 ? `<p class="muted small-t">還有 ${hit.length - 40} 條，打多一點字</p>` : "") : `<p class="muted">沒有「${esc(q)}」這條路線</p>`)
      : `<p class="muted small-t">這個縣市有 ${RT.names.length} 條路線，打號碼找。</p>`;
  }
  h += `</div>`;
  const cur = RT.cur;
  if (cur) {
    const cn = Object.keys(CITIES).find(n => CITIES[n] === cur.city) || cur.city;
    h += `<div class="card"><h3>🚌 ${esc(cur.route)} <span class="sub">${esc(cn)}</span></h3>`;
    if (cur.busy) h += `<p class="muted">查站牌中…</p>`;
    if (cur.err) h += `<p class="muted">查不到：${esc(cur.err)}</p>`;
    if (cur.subs?.length) {
      const sub = cur.subs[cur.si];
      if (cur.subs.length > 1) h += `<div class="chips">` + cur.subs.map((s, i) =>
        `<button class="small ${i === cur.si ? "on" : ""}" data-act="sub" data-i="${i}">${esc(s.label)}</button>`).join("") + `</div>`;
      const tm = subTimes(cur.city, cur.route, sub);
      if (tm) h += `<p class="muted">🕒 ${esc(tm)}</p>`;
      const buses = cur.bus.filter(b => (sub.sub && b.SubRouteUID ? b.SubRouteUID === sub.sub : (b.Direction ?? 0) === sub.dir));
      h += `<div class="stops">` + sub.stops.map((s, i) => {
        const e = cur.t ? stopEta(s, sub) : {s: "off", t: "…"};
        const here = buses.filter(b => b.StopUID === s.uid).map(b => `🚌${esc(b.PlateNumb || "")}`).join(" ");
        return `<div class="row stop${s.uid === cur.hl ? " hl" : ""}"><span class="eta ${e.s}">${esc(e.t)}</span>` +
          `<span><span class="sn">${i + 1}</span> ${esc(s.name)}${here ? ` <span class="bus">${here}</span>` : ""}</span></div>`;
      }).join("") + `</div>`;
      h += `<p class="muted small-t">${cur.t ? cur.t.toLocaleTimeString("zh-TW", {hour12: false}) + " 更新・每 30 秒自動更新・🚌 是公車現在的位置" : "查到站中…"}</p>`;
    }
    h += `</div>`;
  }
  const keep = document.activeElement?.id === "rt-q" ? document.activeElement.selectionStart : null;
  $("#pane-route").innerHTML = h;
  if (keep != null) { const i = $("#rt-q"); i.focus(); i.setSelectionRange(keep, keep); }
  if (scroll) $("#pane-route .stop.hl")?.scrollIntoView({block: "center"});
}

// ════════════ 畫面 ════════════
function favRow(f) {
  if (f.t === "rail" || f.t === "metro") return railFavRow(f);   // rail.js
  if (f.t !== "bus") {
    return `<div class="row"><span>${esc(f.label || f.name)}</span><span class="d">${esc(KIND[f.kind] ?? "")}</span></div>`;
  }
  const e = LIVE.t ? favEta(f) : {s: "off", t: "…"};
  const nx = LIVE.t && e.m == null && !/下一班/.test(e.t) && schedNext(f);
  if (nx) e.t = (e.t === "暫無到站資料" || e.t === "沒有即時資料" ? "" : e.t + " ") + "下一班 " + nx;
  return `<button class="row full" data-act="froute" data-i="${DB.data.favs.indexOf(f)}"><span class="eta ${e.s}">${esc(e.t)}</span><span><b>${esc(f.route)}</b> ${esc(f.name)}` +
    (f.to ? `<br><span class="sub">往 ${esc(f.to)}</span>` : "") + `</span></button>`;
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
      `<p class="muted small-t">${esc(note || at)}${note && at ? "（" + esc(at) + "）" : ""}</p></div>`;
  }
  const pl = [["🏠 家", D.home], ["🏢 公司", D.work]].filter(([, p]) => p && p.name);
  if (pl.length) h += `<div class="card"><h3>📍 地點</h3>` + pl.map(([n, p]) => `<div class="row"><span>${n}</span><span class="d">${esc(p.name)}</span></div>`).join("") + `</div>`;
  $("#fav-list").innerHTML = h;
}

function renderSet() {
  const S = DB.settings;
  let h = `<div class="card"><h3>🔑 TDX 金鑰</h3><p class="muted">只存在這支手機，不會上傳。到 TDX 會員中心「API 金鑰」複製。</p>` +
    `<label>Client ID<input type="text" id="tdx-id" autocomplete="off" value="${esc(S.tdxId)}"></label>` +
    `<label>Client Secret<input type="password" id="tdx-sec" autocomplete="off" value="${esc(S.tdxSecret)}"></label>` +
    `<div class="btns"><button class="primary" data-act="savekey">存起來</button><button data-act="testkey">測試連線</button></div></div>`;
  h += aiSetCard();   // ai.js
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
  renderTrip();   // trip.js
  renderAi();     // ai.js
  renderFav();
  renderNear();
  renderRoute();
  renderRail();
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
    if (tab.dataset.tab === "rail" && !RAIL.mode) railMode(["tra", "thsr", "metro"].includes(DB.data.railMode) ? DB.data.railMode : "tra");
    if (tab.dataset.tab === "route" && !RT.city && !RT.cur) pickCity(DB.data.city || DB.data.favs.find(f => f.city)?.city || "Tainan");
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
  if (act === "nroute") {
    const g = NEAR.groups?.[+b.dataset.g], bus = g?.buses[b.dataset.k];
    return bus && openRoute(bus.city, bus.route, bus.dir, bus.stop, bus.sub);
  }
  if (act === "froute") {
    const f = DB.data.favs[+b.dataset.i];
    return f && f.t === "bus" && f.city && openRoute(f.city, f.route, f.dir ?? 0, f.stop, f.sub);
  }
  if (act === "route") return openRoute(RT.city, b.dataset.r);
  if (act === "sub") { RT.cur.si = +b.dataset.i; return renderRoute(); }
  // 問 AI（ai.js）
  if (act === "aiopen" || act === "aiclose") { AI.open = act === "aiopen"; renderAi(); if (AI.open) $("#ai-q")?.focus(); return; }
  if (act === "aisend") { const t = $("#ai-q").value; $("#ai-q").value = ""; return aiAsk(t); }
  if (act === "aiclear") { AI.msgs = []; AI.hist = []; return renderAi(); }
  if (act === "aibtn") return aiBtn(+b.dataset.j);
  if (act === "savegem") { DB.settings.gemKey = $("#gem-key").value.trim(); save(); renderAi(); return toast("存好了"); }
  // 想去哪（trip.js）
  if (act === "tsearch") return tripSearch();
  if (act === "tfrom") { TRIP.from = b.dataset.k; TRIP.q = $("#tp-q").value; return renderTrip(); }
  if (act === "tquick") { const p = DB.data[b.dataset.k]; return tripGo({name: b.dataset.k === "home" ? "家" : "公司", lat: +p.lat, lon: +p.lon}); }
  if (act === "tplace") { const p = DB.data.places[+b.dataset.i]; return p && tripGo({name: p.name, lat: +p.lat, lon: +p.lon}); }
  if (act === "tpick") { const p = TRIP.cands?.[+b.dataset.i]; return p && tripGo(p); }
  if (act === "tsave") return savePlace();
  // 火車（rail.js）
  if (act === "rmode") return railMode(b.dataset.m);
  if (act === "rswap") { const o = $("#rl-o"), d = $("#rl-d"); [o.value, d.value] = [d.value, o.value]; return; }
  if (act === "rday") { RAIL.day = +b.dataset.d; RAIL.after = $("#rl-after")?.value || ""; const r = DB.data.rail[RAIL.mode]; r.o = $("#rl-o").value; r.d = $("#rl-d").value; return renderRail(); }
  if (act === "rfind") return railFind();
  if (act === "rtrain") return railTrain(b.dataset.no);
  if (act === "rfav") return toggleRailFav();
  if (act === "mfav") return toggleMetroFav();
  if (act === "frail") { const f = DB.data.favs[+b.dataset.i]; return f && openRailFav(f); }
  if (act === "import") { toast("搬資料中…"); return window.BusBridge.importOld(); }
  if (act === "wipe") {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "再按一次就清掉"; return; }
    localStorage.removeItem(KEY);
    DB = load();
    render();
    return toast("清掉了");
  }
});

document.addEventListener("change", ev => {
  const id = ev.target.id;
  if (id === "rt-city" && ev.target.value) pickCity(ev.target.value);
  if (id === "mt-op") { railSet().metroOp = ev.target.value; save(); railMode("metro"); }
  if (id === "mt-st" && ev.target.value) metroLook();
});
document.addEventListener("keydown", ev => {
  if (ev.key !== "Enter") return;
  if (ev.target.id === "tp-q") tripSearch();
  if (ev.target.id === "ai-q") { const t = ev.target.value; ev.target.value = ""; aiAsk(t); }
});
document.addEventListener("input", ev => { if (ev.target.id === "rt-q") { RT.q = ev.target.value; renderRoute(); } });

document.body.dataset.tab = "fav";
$("#beta").hidden = !IS_BETA;
render();
refreshLive();
// 每 30 秒自動更新（跟電腦版一樣）；App 在背景或不在常用頁就不查，省 TDX 額度
setInterval(() => {
  if (document.hidden) return;
  if (document.body.dataset.tab === "fav") refreshLive();
  if (document.body.dataset.tab === "route") refreshRoute();
  if (document.body.dataset.tab === "rail") { if (RAIL.mode === "metro") metroLook(); else if (RAIL.list?.today && !document.activeElement?.id?.startsWith("rl-")) renderRail(); }
}, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
