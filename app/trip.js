// 公車手機版・🧭 想去哪（第 4 步，2026-11-28）：打地點 → 大眾運輸走法（最快到／最少轉乘／最少走路）＋走路、計程車估價、Google 地圖
// 照電腦版 trip.py（api_places、api_trip、taxi）和 transit.py（plan、parse_route）。地點搜尋用 OpenStreetMap（網頁直接查，有 CORS）；
// 路線規劃是 TDX maas/routing，由 App 代查（外殼 1.3 起認得 maas/ 開頭）。用 app.js 的 tdx()、here()、meters()、DB…
"use strict";
const TRIP = {q: "", from: "here", cands: null, busy: false, err: "", dest: null, res: null};
const WALK_NEAR = 1200, NO_TRANSIT = 800, WALK_M_MIN = 70;   // 跟電腦版一樣
const nq = s => String(s || "").replace(/\s+/g, "").replace(/台/g, "臺").toLowerCase();

// ── 地點候選（電腦版 api_places：Nominatim 先找起點附近，再 Photon、全台；同名 80 公尺內只留一筆、名字有打的字排前面）──
async function nomi(q, ll) {
  const p = new URLSearchParams({q, format: "jsonv2", limit: 12, countrycodes: "tw", "accept-language": "zh-TW"});
  if (ll) { p.set("viewbox", `${ll[1] - .25},${ll[0] + .25},${ll[1] + .25},${ll[0] - .25}`); p.set("bounded", 1); }
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?" + p);
    return (r.ok ? await r.json() : []).map(x => {
      const parts = String(x.display_name || "").split(",").map(s => s.trim());
      const name = x.name || parts[0];
      const keep = (parts[0] === name ? parts.slice(1) : parts).filter(s => s && s !== "臺灣" && !/^\d{3,6}$/.test(s) && !/(里|村)$/.test(s));
      return {name, addr: keep.reverse().join(""), lat: +x.lat, lon: +x.lon};
    });
  } catch (e) { return []; }
}
async function photon(q, ll) {
  try {
    const r = await fetch("https://photon.komoot.io/api/?" + new URLSearchParams({q, limit: 15, lat: ll ? ll[0] : 23.7, lon: ll ? ll[1] : 121.0}));
    return ((r.ok ? await r.json() : {}).features || []).filter(f => (f.properties?.countrycode || "TW") === "TW").map(f => {
      const p = f.properties || {}, [lon, lat] = f.geometry.coordinates;
      const street = (p.street || "") + (p.housenumber ? p.housenumber + "號" : "");
      const addr = [p.city || p.state, p.district, street].filter(Boolean).join("");
      return {name: p.name || street || addr, addr, lat, lon};
    });
  } catch (e) { return []; }
}
async function findPlaces(q, ll) {
  const m = q.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m) return [{name: `座標 ${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, addr: "", lat: +m[1], lon: +m[2]}];
  const rows = [...(ll ? await nomi(q, ll) : []), ...await photon(q, ll), ...await nomi(q, null)];
  const out = [];
  for (const p of rows) {
    if (out.some(x => x.name === p.name && meters(x.lat, x.lon, p.lat, p.lon) < 80)) continue;
    out.push({...p, dist: ll ? meters(ll[0], ll[1], p.lat, p.lon) : null});
  }
  const k = nq(q), hit = p => nq(p.name).includes(k) || (nq(p.name).length >= 2 && k.includes(nq(p.name)));
  return out.sort((a, b) => hit(b) - hit(a) || (a.dist ?? 0) - (b.dist ?? 0)).slice(0, 12);
}

// ── 起點 ──
async function tripOrigin() {
  const D = DB.data;
  if (TRIP.from === "home" && D.home?.lat) return {name: "家", lat: +D.home.lat, lon: +D.home.lon};
  if (TRIP.from === "work" && D.work?.lat) return {name: "公司", lat: +D.work.lat, lon: +D.work.lon};
  const p = await here();
  return {name: "目前位置", lat: p.latitude, lon: p.longitude};
}

// ── 計程車估算（電腦版 trip.taxi，2026-11-20 查的費率；畫面一律標「估算」）──
const NORTH = {base: 85, step: 200, wait: 60, night: ["add", 20], name: "北北基"};
const TAXI = {Taipei: NORTH, NewTaipei: NORTH, Keelung: NORTH,
  Taoyuan: {base: 90, step: 200, wait: 80, night: null, name: "桃園市"},
  Taichung: {base: 85, step: 200, wait: 60, night: ["add", 20], name: "臺中市"},
  Tainan: {base: 85, step: 200, wait: 100, night: ["pct", .2], name: "臺南市"},
  Kaohsiung: {base: 85, step: 200, wait: 100, night: ["pct", .2], name: "高雄市"}};
const TAXI_DEF = {base: 100, step: 200, wait: 100, night: ["pct", .2], name: "", guess: true};
// 大概在哪個縣市（只用來挑計程車費率）：離幾個市中心 30 公里內就算那裡；其他用一般費率
const CENTERS = [["Taipei", 25.04, 121.53], ["NewTaipei", 25.01, 121.46], ["Keelung", 25.13, 121.74], ["Taoyuan", 24.99, 121.30],
  ["Taichung", 24.15, 120.67], ["Tainan", 23.0, 120.22], ["Kaohsiung", 22.63, 120.30]];
function cityGuess(lat, lon) {
  const c = CENTERS.map(([k, a, b]) => [k, meters(lat, lon, a, b)]).sort((x, y) => x[1] - y[1])[0];
  return c[1] < 30000 ? c[0] : "";
}
function taxi(o, d) {
  const rule = TAXI[cityGuess(o.lat, o.lon)] || TAXI_DEF;
  const straight = meters(o.lat, o.lon, d.lat, d.lon), road = Math.max(straight * 1.35, straight + 200);
  const kmh = road < 5000 ? 22 : road < 15000 ? 28 : 40, mins = road / 1000 / kmh * 60 + 2;
  let fare = rule.base + Math.ceil(Math.max(0, road - 1250) / rule.step) * 5 + Math.floor(mins * .15 * 60 / rule.wait) * 5;
  const h = new Date().getHours(), night = h >= 23 || h < 6;
  if (night && rule.night) fare = rule.night[0] === "add" ? fare + rule.night[1] : fare * (1 + rule.night[1]);
  const r5 = x => Math.round(x / 5) * 5;
  return {km: (road / 1000).toFixed(1), min: Math.max(3, Math.round(mins)), lo: r5(fare * .9), hi: r5(fare * 1.2), night,
    rule: `${rule.name || "一般"}費率：起程 1.25 公里 ${rule.base} 元、每 ${rule.step} 公尺 5 元、慢速${rule.wait === 60 ? "每分鐘" : `每 ${rule.wait} 秒`} 5 元` +
      (rule.night ? (rule.night[0] === "add" ? `、夜間每趟加 ${rule.night[1]} 元` : "、夜間加 2 成") : ""), guess: !!rule.guess};
}
const gmaps = (o, d, mode) => `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lon}&destination=${d.lat},${d.lon}&travelmode=${mode}`;

// ── 大眾運輸（TDX maas/routing，一次要 5 個方案，自己挑最快到／最少轉乘／最少走路）──
function legMode(sec) {
  if (sec.type === "pedestrian") return ["walk", "🚶", "走路"];
  if (sec.type === "waiting") return ["wait", "⏳", "等車"];
  // 實際看到的值（11/28）：pedestrian、waiting、TRA、Bus、HighwayBus（國道客運，別被 high 當成高鐵）
  const m = String(sec.transport?.mode || sec.transport?.category || "").toLowerCase();
  if (/highwaybus|intercity|coach/.test(m)) return ["bus", "🚌", "客運"];
  if (/high|thsr|hsr/.test(m)) return ["thsr", "🚄", "高鐵"];
  if (/light|lrt|tram/.test(m)) return ["lrt", "🚊", "輕軌"];
  if (/metro|subway|mrt/.test(m)) return ["metro", "🚇", "捷運"];
  if (/tra|rail|train/.test(m)) return ["tra", "🚆", "台鐵"];
  if (/bus/.test(m)) return ["bus", "🚌", "公車"];
  if (/ferry/.test(m)) return ["ferry", "⛴️", "渡輪"];
  return ["other", "🚏", "搭車"];
}
const hm = s => String(s || "").slice(11, 16);
function parseRoute(r) {
  const legs = (r.sections || []).map(s => {
    const [kind, emoji, label] = legMode(s), t = s.transport || {};
    const still = kind === "walk" || kind === "wait";
    const loc = s.departure?.place?.location;
    return {kind, emoji, label, agency: s.agency?.name || "", line: still ? "" : String(t.shortName || t.name || (kind === "thsr" ? "高鐵" : "")),
      head: still ? "" : t.headsign || "", start: s.departure?.time, end: s.arrival?.time,
      long: still ? "" : String(t.longName || ""), ll: loc && typeof loc.lat === "number" ? [loc.lat, loc.lng] : null,
      min: Math.round((s.travelSummary?.duration || 0) / 60), m: Math.round(s.travelSummary?.length || 0),
      from: s.departure?.place?.name || "", to: s.arrival?.place?.name || ""};
  });
  const ride = legs.filter(l => l.kind !== "walk" && l.kind !== "wait");
  // 第一段要搭的車、在那之前要走幾分鐘（電腦版 trip._first_ride）：出門倒數用
  const fi = legs.indexOf(ride[0]), first = ride[0] || null;
  const before = legs.slice(0, Math.max(fi, 0)).filter(l => l.kind === "walk").reduce((a, l) => a + l.min, 0);
  return {start: r.start_time, end: r.end_time, min: Math.round((r.travel_time || 0) / 60), legs, first, before,
    transfers: Number.isInteger(r.transfers) ? r.transfers : Math.max(ride.length - 1, 0),
    walk: legs.filter(l => l.kind === "walk").reduce((a, l) => a + l.min, 0),
    summary: ride.map(l => `${l.emoji} ${l.line && !l.line.includes(l.label) ? l.label + " " + l.line : l.line || l.label}`).join(" ➜ ") || "🚶 走路"};
}
function pickPlans(rs) {
  if (!rs.length) return [];
  const fin = r => r.end + "|" + r.start, by = f => rs.slice().sort((a, b) => f(a) - f(b) || fin(a).localeCompare(fin(b)))[0];
  const picks = [["最快到", by(() => 0)], ["最少轉乘", by(r => r.transfers)], ["最少走路", by(r => r.walk)]];
  const out = [];
  for (const [tag, r] of picks) { const o = out.find(x => x.r === r); if (o) o.tags.push(tag); else out.push({r, tags: [tag]}); }
  return out.map(x => ({...x.r, tags: x.tags, key: `${x.r.start}|${x.r.summary}`}));
}
const p2 = n => String(n).padStart(2, "0");
const isoMin = t => `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}T${p2(t.getHours())}:${p2(t.getMinutes())}`;
async function plans(o, d, when, all, again) {   // when：幾點出發（Date，不給＝現在＋1 分；問 AI 會給）；all：不挑、全部方案（問 AI 最晚一班用）
  const t = when || new Date(Date.now() + 60e3), dep = isoMin(t) + ":00", t0 = Date.now();
  const q = `origin=${o.lat.toFixed(6)},${o.lon.toFixed(6)}&destination=${d.lat.toFixed(6)},${d.lon.toFixed(6)}&gc=0.5&top=5&transit=3,4,5,6` +
    `&transfer_time=5,40&first_mile_mode=0&first_mile_time=15&last_mile_mode=0&last_mile_time=15&depart=${dep}`;
  let j;
  try { j = await tdx("maas/routing?" + q); } catch (e) {
    if (/HTTP (Error )?40[04]/.test(e.message)) {   // 40001：這兩個地點之間查不到大眾運輸
      // 1.8：429 排隊等太久，查詢的出發時間已經過了（TDX 20001 也是 400，外殼分不出來）→ 用現在的時間重查一次
      if (!again && t.getTime() - Date.now() < 15e3 && Date.now() - t0 > 40e3) return plans(o, d, when && when > new Date() ? when : null, all, true);
      return [];
    }
    throw e;
  }
  if (j.result !== "success") return [];
  const rs = ((j.data || {}).routes || []).map(parseRoute).filter(r => r.start && r.end);
  // TDX 偶爾混進已經開走的車（電腦版 11/20 碰過）：濾掉出發比查詢時間早的；全部都是才照原樣給
  const now = isoMin(new Date(t.getTime() - 60e3));
  const ok = rs.filter(r => r.start.slice(0, 16) >= now);
  return all ? (ok.length ? ok : rs) : pickPlans(ok.length ? ok : rs);
}

// ════════════ 1.8（2026-11-28）：出門倒數、搭到車站再叫車、停車場（照電腦版 openTrip／trip.py，TDX 由 App 代查）════════════
const nz = s => String(s || "").replace(/\s+/g, "").replace(/台/g, "臺");
const minHm = m => `${p2(Math.floor(m / 60) % 24)}:${p2(Math.floor(m % 60))}`;
const minsNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const GO = {live: {}, combo: null, comboErr: null, park: null, ticks: 0};   // live：方案 key → 第一班公車即時到站

// 某個點在哪個縣市（TDX 代碼，公車、停車場共用）：附近站牌的 City；同一個點記在記憶體
const CITYAT = {};
async function busCityAt(lat, lon) {
  const k = lat.toFixed(4) + "," + lon.toFixed(4);
  if (k in CITYAT) return CITYAT[k];
  for (const r of [300, 2000]) {
    const rows = await tdx(`advanced/v2/Bus/Stop/NearBy?$spatialFilter=nearby(${lat.toFixed(5)}, ${lon.toFixed(5)}, ${r})&$select=StopUID,StopPosition,City&$top=30&$format=JSON`);
    const c = rows.filter(s => s.City && s.City !== "InterCity")
      .map(s => [s.City, meters(lat, lon, s.StopPosition?.PositionLat ?? lat, s.StopPosition?.PositionLon ?? lon)]).sort((a, b) => a[1] - b[1])[0];
    if (c) return (CITYAT[k] = c[0]);
  }
  return (CITYAT[k] = "");
}
// 路線的站序＋時刻表（跟常用的時刻表共用 app.js 的 SCHED 快取，6 小時）
async function routeRaw(city, route) {
  const k = city + "|" + route, c = SCHED[k];
  if (c?.rows && c.stops && Date.now() - c.t < 6 * 3600e3) return c;
  const q = `?$filter=RouteName/Zh_tw eq '${route.replace(/'/g, "''")}'&$format=JSON`;
  const stops = await tdx(busPath("StopOfRoute", city) + q);
  const rows = stops.length ? await tdx(busPath("Schedule", city) + q) : [];
  return (SCHED[k] = {t: Date.now(), rows, stops});
}
// 上車站今天每一班的時間（電腦版 board_times）：找方向（子路線名稱＝規劃的 longName 最好，其次終點、站名）→ 找上車站 → 時刻表；
// 台南等只有起點站發車時間：用「這次規劃的上車時間 − 對應那班的發車時間」推估（標「約」）
// only：指定子路線（問 AI 的公車到站用，沒有規劃時刻 → 推估直接用「第幾站 × 2 分」）
function boardInfo(raw, f, only) {
  const subs = only ? [only] : (raw?.stops || []).filter(r => r.Stops?.length);
  if (!subs.length) return null;
  const want = nz(f.long), head = nz(f.head), sn = nz(f.from);
  const score = r => {
    const name = nz(r.SubRouteName?.Zh_tw || r.RouteName?.Zh_tw), names = r.Stops.map(s => nz(s.StopName?.Zh_tw));
    return (want && name === want ? 4 : 0) + (head && name.endsWith(head) ? 2 : 0) + (names.includes(sn) ? 3 : 0) - (want && name.includes("小巴") && !want.includes("小巴") ? 1 : 0);
  };
  const sub = subs.reduce((a, b) => score(b) > score(a) ? b : a), seq = sub.Stops;
  let k = seq.findIndex(s => nz(s.StopName?.Zh_tw) === sn);
  if (k < 0 && f.ll) {
    const d = seq.map(s => meters(f.ll[0], f.ll[1], s.StopPosition?.PositionLat ?? 0, s.StopPosition?.PositionLon ?? 0));
    k = d.indexOf(Math.min(...d));
    if (d[k] > 300) k = -1;   // 超過約 300 公尺就算對不上
  }
  if (k < 0) return null;
  const stop = seq[k], dir = sub.Direction ?? 0, sid = sub.SubRouteUID;
  const all = raw.rows || [], rows = all.filter(x => x.SubRouteUID === sid).length ? all.filter(x => x.SubRouteUID === sid) : all.filter(x => (x.Direction ?? 0) === dir);
  const wd = WEEK[new Date().getDay()], exact = [], firsts = [];
  for (const x of rows) for (const t of x.Timetables || []) {
    if ((t.ServiceDay || {})[wd] === 0) continue;
    const sts = t.StopTimes || [], hit = sts.find(s => s.StopUID === stop.StopUID);
    const v = hit && (hit.ArrivalTime || hit.DepartureTime), v0 = sts[0] && (sts[0].DepartureTime || sts[0].ArrivalTime);
    if (v) exact.push(v.slice(0, 5)); else if (v0) firsts.push(hmMin(v0));
  }
  let times = [], approx = false;
  if (exact.length && exact.length >= firsts.length) times = [...new Set(exact)].sort();
  else if (firsts.length) {
    const fs = [...new Set(firsts)].sort((a, b) => a - b), board = f.hm ? hmMin(f.hm) : null;
    let off = 0;
    if (k && board == null) { off = k * 2; approx = true; }
    else if (k) {
      const expect = k * 2, c = fs.filter(t => board - t >= 0 && board - t <= 150);   // 平均每站約 2 分鐘
      off = c.length ? board - c.reduce((a, t) => Math.abs(board - t - expect) < Math.abs(board - a - expect) ? t : a) : Math.round(expect);
      approx = true;
    }
    times = fs.map(t => t + off).filter(t => t < 1440).map(minHm);
  }
  return {uid: stop.StopUID, dir, sid, name: stop.StopName?.Zh_tw || f.from, route: sub.RouteName?.Zh_tw || f.line, times, approx};
}
// 第一班公車在上車站幾分到（電腦版 api_trip_live）
async function firstLive(f) {
  if (!f.ll || !f.line) return {live: false};
  let city = await busCityAt(f.ll[0], f.ll[1]), raw = city ? await routeRaw(city, f.line) : null;
  if (!raw?.stops?.length) { city = "InterCity"; raw = await routeRaw(city, f.line); }   // 國道、跨縣市客運在公路客運底下
  const info = boardInfo(raw, f);
  if (!info) return {live: false, why: "TDX 的站牌資料裡對不到這個上車站"};
  const c = (await tdx(`${busPath("EstimatedTimeOfArrival", city)}?$filter=StopUID eq '${info.uid}'&$format=JSON`))
    .filter(e => nz(e.RouteName?.Zh_tw) === nz(info.route))
    .sort((a, b) => (a.EstimateTime == null) - (b.EstimateTime == null) || (a.EstimateTime || 0) - (b.EstimateTime || 0));
  const e = etaOf((info.sid && c.find(x => x.SubRouteUID === info.sid)) || c.find(x => (x.Direction ?? 0) === info.dir));
  const cur = minsNow();
  return {live: e.m != null, m: e.m, t: e.t, stop: {name: info.name}, times: info.times.filter(t => hmMin(t) >= cur - 1).slice(0, 4), approx: info.approx};
}
// 出門倒數：有即時到站用即時（車到站 − 走到站）；沒有即時就用上車站時刻表裡「還趕得上的下一班」；都沒有才用規劃的時刻（電腦版 goInfo）
function goInfo(p) {
  const f = p.first; if (!f) return null;
  const lv = GO.live[p.key], nowM = minsNow(), fhm = hm(f.start);
  let board = hmMin(fhm), src = "plan";
  if (board < nowM - 600) board += 1440;   // 過半夜
  if (lv && lv.live && lv.m != null) { board = lv.nowAt + lv.m; src = "live"; }
  else if (lv && lv.times && lv.times.length) {
    const t = lv.times.map(hmMin).find(m => m - p.before >= nowM - 1);
    if (t !== undefined && (board - p.before < nowM - 1 || Math.abs(t - board) <= 3)) { board = t; src = "sched"; }
  }
  const leave = board - p.before;
  return {left: Math.floor(leave - nowM + 0.001), leave, board, src, arr: hmMin(hm(p.end)) + Math.max(0, board - hmMin(fhm)), lv};
}
function paintGo() {
  const R = TRIP.res, box = $("#trip-res");
  if (!R?.plans?.length || !box) return;
  R.plans.forEach((p, i) => {
    const card = box.querySelector(`.trip[data-k="${i}"]`); if (!card) return;
    const g = goInfo(p), f = p.first, lv = GO.live[p.key];
    const go = card.querySelector("[data-go]"), fb = card.querySelector("[data-fb]");
    if (!g) { go.innerHTML = `<div class="big">現在出發</div>`; fb.textContent = "全程走路"; return; }
    go.innerHTML = g.left >= 1 ? `<div class="big">再<b>${g.left}</b>分鐘出門</div><div class="at">${minHm(Math.round(g.leave) % 1440)} 出門</div>` :
      g.left >= -1 ? `<div class="big now">現在出門</div><div class="at">走 ${p.before} 分到${esc(f.from)}</div>` :
      `<div class="big late">這班可能趕不上了</div><div class="at">${g.src === "live" ? "看下一班" : "按上面的起點再規劃一次"}</div>`;
    const em = `${f.emoji} ${f.label}`, line = f.line && !f.line.includes(f.label) ? f.line : "", fhm = hm(f.start);
    if (f.kind !== "bus") fb.innerHTML = `${em} ${esc(line)}・時刻表 <b>${esc(fhm)}</b> 從「${esc(f.from)}」開`;
    else if (!lv || lv.loading) fb.innerHTML = `${em} ${esc(line)}・<span class="spin"></span>查即時到站…`;
    else if (lv.err) fb.innerHTML = `${em} ${esc(line)}・${busySecs(lv.err) ? "即時到站忙線，稍後自動再查" : "即時到站查不到"}（時刻表 ${esc(fhm)} 到「${esc(f.from)}」）`;
    else if (g.src === "live") {
      const m = Math.max(0, Math.round(g.board - minsNow()));
      fb.innerHTML = `${em} <b>${esc(line)}</b> 在「${esc(lv.stop ? lv.stop.name : f.from)}」<b class="${m <= 3 ? "hot" : "led"}">${m <= 0 ? "進站中" : `還有 ${m} 分`}</b><span class="tagl">即時</span>`;
    } else {
      const nx = (lv.times || []).filter(t => hmMin(t) >= minsNow() - 1).slice(0, 2);
      fb.innerHTML = `${em} ${esc(line)}・${esc(offWord(lv.t || "") || "沒有即時")}${nx.length ? `，時刻表${lv.approx ? "約" : ""} ${nx.map(esc).join("、")} 到「${esc(lv.stop ? lv.stop.name : f.from)}」` : `，規劃 ${esc(fhm)} 到「${esc(f.from)}」`}`;
    }
    card.querySelector("[data-arr]").innerHTML = `${minHm(Math.round(g.leave) % 1440)} 出門 → 預計 <b>${minHm(Math.round(g.arr) % 1440)}</b> 到`;
  });
}
async function loadLives(force) {
  const R = TRIP.res;
  for (const p of R?.plans || []) {
    if (TRIP.res !== R) return;   // 換了地點或起點
    if (!p.first || p.first.kind !== "bus") continue;
    const old = GO.live[p.key];
    if (!force && old && old.at && Date.now() - old.at < 50000) continue;
    if (!old) { GO.live[p.key] = {loading: true}; paintGo(); }
    try { GO.live[p.key] = Object.assign(await firstLive({...p.first, hm: hm(p.first.start)}), {at: Date.now(), nowAt: minsNow()}); }
    catch (e) {
      GO.live[p.key] = old && !old.loading && !old.err ? old : {err: e, at: Date.now()};   // 之前查到過就先用之前的（倒數照算）
      paintGo();
      if (busySecs(e)) return;   // 撞到上限：下一輪（每分鐘）再查
      continue;
    }
    paintGo();
  }
}
// 每 15 秒更新倒數、每分鐘更新即時到站（只在結果頁開著、畫面看得到時）
setInterval(() => {
  if (!$("#trip-res") || !TRIP.res?.plans?.length || document.visibilityState !== "visible") return;
  paintGo();
  if (++GO.ticks % 4 === 0) loadLives();
}, 15000);

// ── 搭到最近的車站再叫車（電腦版 api_trip_combo）：目的地最近的台鐵站；車站離目的地 40 公里內、不在起點旁邊或反方向才建議 ──
const TRAPOS_KEY = "busphone.trapos";   // 台鐵車站位置一天查一次（不是個人資料）
async function traPos() {
  try { const v = JSON.parse(localStorage.getItem(TRAPOS_KEY) || "null"); if (v && Date.now() - v.t < 86400e3 && v.v.length) return v.v; } catch (e) { /* 重抓 */ }
  const v = ((await tdx("v3/Rail/TRA/Station?$select=StationID,StationName,StationPosition&$format=JSON")).Stations || [])
    .filter(s => s.StationPosition?.PositionLat).map(s => [s.StationName?.Zh_tw || "", s.StationPosition.PositionLat, s.StationPosition.PositionLon]);
  localStorage.setItem(TRAPOS_KEY, JSON.stringify({t: Date.now(), v}));
  return v;
}
async function tripCombo(o, d) {
  const sts = await traPos();
  if (!sts.length) return {ok: false, why: "沒有車站資料"};
  const [name, la, lo] = sts.reduce((a, s) => meters(d.lat, d.lon, s[1], s[2]) < meters(d.lat, d.lon, a[1], a[2]) ? s : a);
  const st = {name, lat: la, lon: lo};
  if (meters(d.lat, d.lon, la, lo) > 40000) return {ok: false, why: "目的地附近 40 公里內沒有火車站"};
  if (meters(o.lat, o.lon, la, lo) < 1500 || meters(o.lat, o.lon, la, lo) > meters(o.lat, o.lon, d.lat, d.lon) * 1.3)
    return {ok: false, why: "最近的車站離你很近或在反方向，直接叫車比較划算"};
  const ps = await plans(o, st);
  if (!ps.length) return {ok: false, why: `到${name}站也找不到大眾運輸`};
  return {ok: true, station: name.endsWith("站") ? name : name + "車站", plan: ps.find(p => p.tags.includes("最快到")) || ps[0],
    taxi: taxi(st, d), maps: gmaps(st, d, "driving")};
}
function comboHtml() {
  if (GO.comboErr) return `<div class="card alt">${errBox("combo", GO.comboErr, loadCombo)}</div>`;
  const c = GO.combo;
  if (!c) return `<div class="card alt"><div class="ah"><span class="ai">🚆</span><div><b>搭到最近的車站再叫車</b><span><span class="spin"></span>查詢中…</span></div></div></div>`;
  if (!c.ok) return `<div class="cap" style="text-align:left">搭到車站再叫車：${esc(c.why || "不建議")}</div>`;
  const p = c.plan, t = c.taxi;
  return `<div class="card alt"><div class="ah"><span class="ai">🚆</span><div><b>搭到${esc(c.station)}再叫車</b><span>${esc(hm(p.start))} 出發・${esc(hm(p.end))} 到車站・再坐計程車約 ${t.min} 分（${t.lo}～${t.hi} 元，估算）</span></div></div>` +
    `<div style="font-weight:700">${esc(p.summary)} ➜ 🚕</div>` +
    `<details><summary>每一段怎麼走</summary>${p.legs.map(legHtml).join("")}</details>` +
    `<div class="acts"><a class="btn ghost sm press" href="tel:55688">📞 到站叫車 55688</a><a class="btn ghost sm press" href="${esc(c.maps)}" target="_blank" rel="noopener">車站到目的地導航 ↗</a></div></div>`;
}
async function loadCombo() {
  const R = TRIP.res; if (!R) return;
  GO.comboErr = null; GO.combo = null; paintCombo();
  try { const c = await tripCombo(R.o, R.d); if (TRIP.res === R) GO.combo = c; }
  catch (e) { if (TRIP.res === R) GO.comboErr = e; }
  if (TRIP.res === R) paintCombo();
}
function paintCombo() { const el = document.querySelector("#trip-res [data-combo]"); if (el) el.innerHTML = comboHtml(); }

// ── 目的地附近停車場（電腦版 api_trip_park＋生活助手 _parking_tdx）：全台都用 TDX 路外停車場，1.5 公里內最近 6 個 ──
const PARK_NOCAR = new Set([2, 3, 4, 5, 6]);   // 機車、重機、腳踏車、大客車、大貨車：不算汽車格
async function parkNear(lat, lon) {
  const city = await busCityAt(lat, lon);
  if (!city) return {rows: [], why: "查不出目的地在哪個縣市"};
  const base = `v1/Parking/OffStreet/`, ll = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const parks = ((await tdx(`${base}CarPark/City/${city}?$spatialFilter=nearby(${ll}, 1500)&$select=CarParkID,CarParkName,CarParkPosition,Description&$format=JSON`)).CarParks || [])
    .map(x => ({id: x.CarParkID, name: x.CarParkName?.Zh_tw || "", desc: String(x.Description || ""),
      dist: meters(lat, lon, x.CarParkPosition?.PositionLat ?? lat, x.CarParkPosition?.PositionLon ?? lon)}))
    .sort((a, b) => a.dist - b.dist).slice(0, 15);
  if (!parks.length) return {rows: [], why: "目的地 1.5 公里內沒有查到停車場資料"};
  const flt = parks.map(p => `CarParkID eq '${p.id}'`).join(" or "), av = {};
  for (const x of (await tdx(`${base}ParkingAvailability/City/${city}?$filter=${flt}&$format=JSON`)).ParkingAvailabilities || []) {
    if (x.ServiceStatus != null && x.ServiceStatus !== 1) continue;
    const car = (x.Availabilities || []).filter(s => !PARK_NOCAR.has(s.SpaceType));
    if (x.Availabilities?.length) av[x.CarParkID] = car.length ? [car.reduce((a, s) => a + Math.max(0, +s.AvailableSpaces || 0), 0), car.reduce((a, s) => a + (+s.NumberOfSpaces || 0), 0)] : [null, 0];
    else if (x.AvailableSpaces != null && +x.AvailableSpaces >= 0) av[x.CarParkID] = [+x.AvailableSpaces, +x.TotalSpaces || 0];
  }
  const need = parks.filter(p => !av[p.id]?.[1]), sp = {};
  if (need.length) {   // 沒有即時的：總格數另外查
    for (const x of (await tdx(`${base}ParkingSpace/City/${city}?$filter=${need.map(p => `CarParkID eq '${p.id}'`).join(" or ")}&$format=JSON`)).ParkingSpaces || [])
      sp[x.CarParkID] = (x.Spaces || []).filter(s => !PARK_NOCAR.has(s.SpaceType)).reduce((a, s) => a + (+s.NumberOfSpaces || 0), 0);
  }
  const descTotal = s => { const m = s.match(/(機車|小型車|汽車)\D{0,4}(\d+)\s*格/); return m && m[1] !== "機車" ? +m[2] : 0; };
  const rows = [];
  for (const p of parks) {
    const a = av[p.id], left = a ? a[0] : null, total = (a && a[1]) || sp[p.id] || descTotal(p.desc);
    if (total <= 0 && left == null) continue;   // 只有機車格
    rows.push({name: p.name, dist: p.dist, avail: left, total: Math.max(total, left || 0)});
  }
  return {rows: rows.slice(0, 6), src: "交通部 TDX", why: rows.length ? "" : "目的地 1.5 公里內沒有查到汽車停車場資料"};
}
async function loadPark() {
  const R = TRIP.res; if (!R) return;
  GO.park = {loading: true}; paintPark();
  let v;
  try { v = await parkNear(R.d.lat, R.d.lon); } catch (e) { v = {err: e}; }
  if (TRIP.res === R) { GO.park = v; paintPark(); }
}
function parkHtml() {
  const pk = GO.park;
  if (!pk) return `<button class="textbtn press" data-act="tpark">看目的地附近停車場剩幾格</button>`;
  if (pk.loading) return `<div class="cap" style="text-align:left"><span class="spin"></span>查停車場…</div>`;
  if (pk.err) return errBox("park", pk.err, loadPark);
  return pk.rows.length ? `<div class="small muted">目的地附近停車場（${esc(pk.src)}）</div>` + pk.rows.map(r => `<div class="mini"><span class="l"><span>${esc(r.name)}・${r.dist} 公尺</span></span>` +
      `<span class="r ${r.avail == null ? "off" : r.avail <= 5 ? "soon" : ""}">${r.avail == null ? `沒有即時・共 ${r.total} 格` : `剩 ${r.avail}／${r.total} 格`}</span></div>`).join("") :
    `<div class="small muted">${esc(pk.why || "附近沒有查到停車場資料")}</div>`;
}
function paintPark() { const el = document.querySelector("#trip-res [data-park]"); if (el) el.innerHTML = parkHtml(); }

// ── 規劃（1.5 照電腦版 openTrip：結果是推進頁 #trip-res，上面可以換起點）──
async function tripGo(dest) {
  TRIP.dest = dest; TRIP.cands = null; TRIP.res = null; TRIP.err = ""; TRIP.busy = "規劃中…";
  if (!$("#trip-res")) UI.push(`<header class="top"><button class="back">${icon("back")}返回</button><h1 class="center">${esc(String(dest.name).slice(0, 12))}</h1>` +
    `<button class="textbtn press" data-act="tsave" id="tp-star" aria-label="存成常去地點" style="width:60px">☆</button></header>` +
    `<div class="scroll"><div id="trip-res"></div></div>`, {onPop: () => { TRIP.dest = null; TRIP.res = null; TRIP.busy = false; renderTrip(); }});
  renderTrip();
  try {
    const o = await tripOrigin(), d = dest, straight = meters(o.lat, o.lon, d.lat, d.lon);
    const res = {o, d, straight, walk: {min: Math.max(1, Math.round(straight * 1.25 / WALK_M_MIN)), m: Math.round(straight * 1.25)}, plans: [], perr: "",
      time: new Date().toTimeString().slice(0, 5)};
    if (straight >= 60) {
      res.taxi = taxi(o, d);
      if (straight > NO_TRANSIT && !window.BusBridge?.ver) { res.plans = null; res.perr = "要先更新公車 App 到 1.3 版（我的助手「📱 主畫面小工具」下載）"; }
      else if (straight > NO_TRANSIT) { try { res.plans = await plans(o, d); } catch (e) { res.plans = null; res.perr = e.message; } }
      else res.skipped = true;
    } else res.same = true;
    if (TRIP.dest !== dest) return;   // 等的時候按了返回或換了地點
    TRIP.res = res;
  } catch (e) { if (TRIP.dest === dest) TRIP.err = e.message; }
  TRIP.busy = false;
  Object.assign(GO, {live: {}, combo: null, comboErr: null, park: null});
  renderTrip();
  const R = TRIP.res;
  if (R?.plans?.length) loadLives(true);
  else if (R && Array.isArray(R.plans) && !R.skipped && R.straight > 3000) loadCombo();
}
// 換起點：在結果頁就重新規劃
function tripFrom(k) {
  const q = $("#tp-q"); if (q) TRIP.q = q.value;
  TRIP.from = k;
  if (TRIP.dest && $("#trip-res")) return tripGo(TRIP.dest);
  renderTrip();
}

async function tripSearch() {
  const q = ($("#tp-q")?.value || "").trim();
  TRIP.q = q;
  if (!q) { TRIP.cands = null; TRIP.err = ""; return renderTrip(); }
  $("#tp-q")?.blur();
  TRIP.busy = "搜尋中…"; TRIP.err = ""; TRIP.cands = null; renderTrip();
  let ll = null;
  try { const o = await tripOrigin(); ll = [o.lat, o.lon]; TRIP.oname = o.name; } catch (e) { TRIP.oname = ""; /* 沒定位就找全台 */ }
  TRIP.cands = await findPlaces(q, ll);
  if (!TRIP.cands.length) TRIP.err = `找不到「${q}」，換個說法試試（加上縣市或路名，例如「台南 家樂福」），或直接打「緯度,經度」。`;
  TRIP.busy = false; renderTrip();
}

function savePlace() {
  const d = TRIP.dest; if (!d) return;
  const P = DB.data.places = Array.isArray(DB.data.places) ? DB.data.places : [];
  const i = P.findIndex(p => p.name === d.name && meters(+p.lat, +p.lon, d.lat, d.lon) < 80);
  if (i >= 0) P.splice(i, 1); else P.push({name: d.name, addr: d.addr || "", lat: d.lat, lon: d.lon, q: TRIP.q || d.name});
  save(); renderTrip();
  toast(i >= 0 ? `拿掉常去：${d.name}` : `存成常去：${d.name}`);
}

// 每一段（電腦版 legHtml：左邊時間、右邊怎麼搭）
function legHtml(l) {
  const tm = l.start && l.end ? `${hm(l.start)}–${hm(l.end)}` : "";
  if (l.kind === "walk" || l.kind === "wait") {
    if (!l.min && !tm) return "";
    return `<div class="leg mute"><div class="lt">${tm}</div><div class="lb">${l.emoji} ${l.label} ${l.min || 1} 分${l.kind === "walk" && l.m ? `（約 ${l.m} 公尺）` : ""}${l.kind === "walk" && l.to ? ` → ${esc(l.to)}` : ""}</div></div>`;
  }
  return `<div class="leg"><div class="lt">${tm || (l.min ? `約 ${l.min} 分` : "")}</div><div class="lb"><b>${l.emoji} ${esc(l.line && !l.line.includes(l.label) ? l.label + " " + l.line : l.line || l.label)}</b>` +
    `<span>${esc(l.from)} → ${esc(l.to)}${l.head && l.head !== l.line ? `・往 ${esc(l.head)}` : ""}${l.label === "客運" && l.agency ? `・${esc(l.agency)}` : ""}</span></div></div>`;
}
const kmTxt = m => m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 公尺`;

function tripFromHtml() {
  const D = DB.data, k = TRIP.from;
  const froms = [["here", "📍 目前位置"], ["home", "🏠 家"], ["work", "🏢 公司"]].filter(([v]) => v === "here" || D[v]?.lat);
  return `<div class="fromrow"><span class="lab">從</span><div class="chips scrollx">` +
    froms.map(([v, t]) => `<button class="chip press" aria-pressed="${k === v}" data-act="tfrom" data-k="${v}">${t}</button>`).join("") + `</div></div>`;
}

// 想去哪（電腦版 openWhere）：搜尋框、問 AI、起點、回家／去公司、常去地點或候選地點
function renderWhere(box) {
  const D = DB.data, P = Array.isArray(D.places) ? D.places : [];
  let h = `<form class="field where-in" id="tp-f">${icon("search")}<input type="search" id="tp-q" enterkeyhint="search" placeholder="地名、店名或地址，例如：家樂福" aria-label="想去哪" autocomplete="off" value="${esc(TRIP.q)}">` +
    `<button class="textbtn" type="submit">搜尋</button></form>` +
    `<button class="textbtn askline press" data-act="aiopen">💬 也可以打一句話問 AI，例如「回程最晚幾點？」</button>` + tripFromHtml();
  if (TRIP.busy && !TRIP.dest) h += `<div class="cap"><span class="spin"></span>${TRIP.busy}</div>`;
  else if (TRIP.err && !TRIP.dest) h += `<div class="note">${esc(TRIP.err)}</div>`;
  else if (TRIP.cands?.length) {
    h += `<div class="label"><span>${TRIP.cands.length} 個地點${TRIP.oname ? `・離${esc(TRIP.oname)}近的在前面` : ""}</span></div><div class="cardlist">` +
      TRIP.cands.map((p, i) => `<button class="rowlink place press" data-act="tpick" data-i="${i}"><span class="w"><b>${esc(p.name)}</b><span>${esc(p.addr || "")}</span></span>` +
        `<span class="d">${p.dist != null ? kmTxt(p.dist) : ""}</span></button>`).join("") +
      `</div><div class="cap">地點資料：OpenStreetMap。找不到的店家可以改打地址。</div>`;
  } else {
    const quick = [["home", "🏠 回家"], ["work", "🏢 去公司"]].filter(([k]) => D[k]?.lat && TRIP.from !== k);
    if (quick.length) h += `<div class="tiles two" style="margin-top:12px">${quick.map(([k, t]) => `<button class="tile press" data-act="tquick" data-k="${k}">${t}</button>`).join("")}</div>`;
    h += P.length ? `<div class="label"><span>常去地點</span></div><div class="cardlist">` +
      P.map((p, i) => `<button class="rowlink press" data-act="tplace" data-i="${i}"><span class="w"><b>${esc(p.name)}</b><span>${esc(p.addr || p.q || "")}</span></span><span class="chev">${icon("chev")}</span></button>`).join("") + `</div>` +
      `<div class="cap" style="text-align:left">在結果頁右上按 ☆ 存成常去地點，再按一次拿掉。只存在這支手機。</div>` :
      `<div class="cap" style="margin-top:18px">打地名、店名或地址就能規劃怎麼去。<br>結果頁右上按 ☆ 可以存成常去地點，下次點一下就好。</div>`;
  }
  box.innerHTML = h;
  $("#tp-f").onsubmit = e => { e.preventDefault(); tripSearch(); };
  $("#tp-q").oninput = e => { if (!e.target.value.trim() && TRIP.cands) { TRIP.cands = null; TRIP.err = ""; TRIP.q = ""; renderWhere(box); $("#tp-q").focus(); } };
}

// 方案卡片（電腦版 tripCard：倒數「再 N 分鐘出門」、第一班車、預計抵達、每一段；1.8 起有倒數，出門前提醒不做）
function tripCard(p, i) {
  return `<div class="card trip" data-k="${i}"><div class="tags">${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>` +
    `<div class="go" data-go></div><div class="fb" data-fb></div>` +
    `<div class="tm" data-arr>${hm(p.start)} → ${hm(p.end)} 到</div>` +
    `<div class="s">${fmtMin(p.min)}・轉乘 ${p.transfers} 次・走路 ${p.walk} 分</div>` +
    `<div style="font-weight:700">${esc(p.summary)}</div>` +
    `<details><summary>每一段怎麼走</summary>${p.legs.map(legHtml).join("")}</details></div>`;
}
function walkCard(R, main) {
  return `<div class="card alt${main ? " main" : ""}"><div class="ah"><span class="ai">🚶</span><div><b>${main ? "走路就到" : "走路"}</b><span>約 ${R.walk.min} 分鐘・${kmTxt(R.walk.m)}${main ? "（很近，不用等車）" : ""}</span></div></div>` +
    `<a class="btn ${main ? "" : "ghost "}sm press" href="${gmaps(R.o, R.d, "walking")}" target="_blank" rel="noopener">${icon("nav")}Google 地圖步行導航</a></div>`;
}
function taxiCard(R, main) {
  const t = R.taxi;
  return `<div class="card alt${main ? " main" : ""}"><div class="ah"><span class="ai">🚕</span><div><b>計程車 約 ${t.lo}～${t.hi} 元</b><span>估算・約 ${t.min} 分鐘・${t.km} 公里${t.night ? "・夜間" : ""}</span></div></div>` +
    `<div class="small muted">${esc(t.rule)}${t.guess ? "（這個縣市沒逐一核對）" : ""}。實際以跳表為準，塞車會更貴。</div>` +
    `<div class="acts"><a class="btn ${main ? "" : "ghost "}sm press" href="tel:55688">📞 台灣大車隊 55688</a>` +
    `<a class="btn ghost sm press" href="https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${R.o.lat}&pickup[longitude]=${R.o.lon}&dropoff[latitude]=${R.d.lat}&dropoff[longitude]=${R.d.lon}" target="_blank" rel="noopener">Uber App</a></div></div>`;
}
function driveCard(R) {
  return `<div class="card alt"><div class="ah"><span class="ai">🚗</span><div><b>開車</b><span>${R.taxi ? `約 ${R.taxi.min} 分鐘・${R.taxi.km} 公里（估算）` : "Google 地圖導航"}</span></div></div>` +
    `<div data-park>${parkHtml()}</div><div class="acts"><a class="btn ghost sm press" href="${gmaps(R.o, R.d, "driving")}" target="_blank" rel="noopener">${icon("nav")}Google 地圖開車導航</a></div></div>`;
}

// 行程結果（電腦版 openTrip 的 draw）
function renderTripRes(box) {
  const R = TRIP.res, d = TRIP.dest, P = Array.isArray(DB.data.places) ? DB.data.places : [];
  const star = $("#tp-star");
  if (star) star.textContent = d && P.some(p => p.name === d.name && meters(+p.lat, +p.lon, d.lat, d.lon) < 80) ? "⭐" : "☆";
  let h = tripFromHtml();
  if (R) h += `<div class="tripto">從 <b>${esc(R.o.name)}</b> 到 <b>${esc(R.d.name)}</b>${R.d.addr ? `<br>${esc(R.d.addr)}` : ""}</div>`;
  else if (d) h += `<div class="tripto">到 <b>${esc(d.name)}</b>${d.addr ? `<br>${esc(d.addr)}` : ""}</div>`;
  if (TRIP.busy) { box.innerHTML = h + `<div class="skel"></div><div class="skel"></div>`; return; }
  if (TRIP.err) { box.innerHTML = h + `<div class="note bad">${esc(TRIP.err)}</div><div class="cap" style="text-align:left">點上面的「家」「公司」改用別的起點。</div>`; return; }
  if (!R) { box.innerHTML = h; return; }
  if (R.same) { box.innerHTML = h + `<div class="note">你已經在「${esc(R.d.name)}」附近了（不到 60 公尺）。</div>`; return; }
  const near = R.skipped || R.straight <= WALK_NEAR, noBus = Array.isArray(R.plans) && !R.plans.length && !R.skipped;
  if (near) h += walkCard(R, true);
  if (R.plans === null) h += errBox("trip", {message: R.perr || "路線規劃查不到"}, () => tripGo(TRIP.dest));
  else if (R.plans.length) h += `<div class="label"><span>搭車（${R.plans.length} 種走法）</span><span>${R.time} 規劃</span></div><div class="list">${R.plans.map(tripCard).join("")}</div>`;
  else if (!R.skipped) {
    const hr = new Date().getHours(), late = hr >= 21 || hr < 6;
    h += `<div class="note">這個時間找不到大眾運輸的走法${late ? "（晚上可能已經收班，明天早上再查會有）" : "（目的地附近可能沒有公車、火車站）"}，下面有計程車和其他走法。</div>`;
  }
  if (noBus && R.taxi && R.straight <= 80000) h += taxiCard(R, true);
  if (noBus && R.straight > 3000) h += `<div data-combo>${comboHtml()}</div>`;
  const alt = [];
  if (!near && R.walk.min <= 40) alt.push(walkCard(R, false));
  if (!noBus && R.taxi && R.straight > WALK_NEAR && R.straight <= 80000) alt.push(taxiCard(R, false));
  alt.push(driveCard(R));
  h += `<div class="label"><span>其他走法</span></div><div class="list">${alt.join("")}</div>`;
  h += `<div class="cap"><a href="${gmaps(R.o, R.d, "transit")}" target="_blank" rel="noopener">在 Google 地圖看大眾運輸 ↗</a><br>資料來源：交通部 TDX、OpenStreetMap</div>`;
  box.innerHTML = h;
  paintGo();
}

function renderTrip() {
  const w = $("#trip-box"); if (w) renderWhere(w);
  const r = $("#trip-res"); if (r) renderTripRes(r);
}
