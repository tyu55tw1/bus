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
    return {kind, emoji, label, agency: s.agency?.name || "", line: still ? "" : String(t.shortName || t.name || (kind === "thsr" ? "高鐵" : "")),
      head: still ? "" : t.headsign || "", start: s.departure?.time, end: s.arrival?.time,
      min: Math.round((s.travelSummary?.duration || 0) / 60), m: Math.round(s.travelSummary?.length || 0),
      from: s.departure?.place?.name || "", to: s.arrival?.place?.name || ""};
  });
  const ride = legs.filter(l => l.kind !== "walk" && l.kind !== "wait");
  return {start: r.start_time, end: r.end_time, min: Math.round((r.travel_time || 0) / 60), legs,
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
  return out.map(x => ({...x.r, tags: x.tags}));
}
const p2 = n => String(n).padStart(2, "0");
const isoMin = t => `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}T${p2(t.getHours())}:${p2(t.getMinutes())}`;
async function plans(o, d, when) {   // when：幾點出發（Date，不給＝現在＋1 分；問 AI 會給）
  const t = when || new Date(Date.now() + 60e3), dep = isoMin(t) + ":00";
  const q = `origin=${o.lat.toFixed(6)},${o.lon.toFixed(6)}&destination=${d.lat.toFixed(6)},${d.lon.toFixed(6)}&gc=0.5&top=5&transit=3,4,5,6` +
    `&transfer_time=5,40&first_mile_mode=0&first_mile_time=15&last_mile_mode=0&last_mile_time=15&depart=${dep}`;
  let j;
  try { j = await tdx("maas/routing?" + q); } catch (e) {
    if (/HTTP (Error )?40[04]/.test(e.message)) return [];   // 40001：這兩個地點之間查不到大眾運輸
    throw e;
  }
  if (j.result !== "success") return [];
  const rs = ((j.data || {}).routes || []).map(parseRoute).filter(r => r.start && r.end);
  // TDX 偶爾混進已經開走的車（電腦版 11/20 碰過）：濾掉出發比查詢時間早的；全部都是才照原樣給
  const now = isoMin(new Date(t.getTime() - 60e3));
  const ok = rs.filter(r => r.start.slice(0, 16) >= now);
  return pickPlans(ok.length ? ok : rs);
}

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
  TRIP.busy = false; renderTrip();
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

// 方案卡片（電腦版 tripCard；手機版沒有即時倒數，用規劃的時刻）
function tripCard(p) {
  return `<div class="card trip"><div class="tags">${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>` +
    `<div class="tm">${hm(p.start)} → ${hm(p.end)} 到</div>` +
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
    `<div class="acts"><a class="btn ghost sm press" href="${gmaps(R.o, R.d, "driving")}" target="_blank" rel="noopener">${icon("nav")}Google 地圖開車導航</a></div></div>`;
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
  const alt = [];
  if (!near && R.walk.min <= 40) alt.push(walkCard(R, false));
  if (!noBus && R.taxi && R.straight > WALK_NEAR && R.straight <= 80000) alt.push(taxiCard(R, false));
  alt.push(driveCard(R));
  h += `<div class="label"><span>其他走法</span></div><div class="list">${alt.join("")}</div>`;
  h += `<div class="cap"><a href="${gmaps(R.o, R.d, "transit")}" target="_blank" rel="noopener">在 Google 地圖看大眾運輸 ↗</a><br>資料來源：交通部 TDX、OpenStreetMap</div>`;
  box.innerHTML = h;
}

function renderTrip() {
  const w = $("#trip-box"); if (w) renderWhere(w);
  const r = $("#trip-res"); if (r) renderTripRes(r);
}
