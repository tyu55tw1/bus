// 公車手機版・火車（第 3 步，2026-11-28）：台鐵／高鐵起訖站車次、一班車停哪、捷運即時到站
// 照電腦版 busapi.api_rail／api_train／api_metro、_fav_rail、_fav_metro。用 app.js 的 tdx()、DB、save()、esc()、hmMin…
"use strict";
const METRO = {"高雄捷運": "KRTC", "台北捷運": "TRTC", "桃園機場捷運": "TYMC", "高雄輕軌": "KLRT"};
const LINE_COLORS = {"KRTC|O": "#F39800", "KRTC|R": "#E2211C", "KLRT|C": "#7CBD52", "TRTC|BL": "#0070BD", "TRTC|R": "#E3002C",
  "TRTC|G": "#008659", "TRTC|O": "#F8B61C", "TRTC|BR": "#C48C31", "TRTC|Y": "#FFDB00", "TYMC|A": "#8246AF"};
const SKEY = "busphone.stations";   // 車站清單（台鐵、高鐵、各家捷運）一天查一次，存手機（不是個人資料）
const RAIL = {mode: "", day: 0, after: "", sts: null, list: null, busy: false, err: "", train: null, metro: null};
const TT = {};      // 起訖站時刻表「種類|起|迄|日期」→ {t, rows}（30 分鐘）
const BOARD = {};   // 台鐵車站誤點看板、捷運即時看板 → {t, v}（30 秒）
const zhs = s => String(s || "").replace(/台/g, "臺").trim();
const dayIso = n => { const d = new Date(Date.now() + n * 86400e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const hmNow = () => new Date().toTimeString().slice(0, 5);
const minsTo = hm => { const m = hmMin(hm) - hmMin(hmNow()); return m < -360 ? m + 1440 : m; };
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? " " + m % 60 + " 分" : ""}` : `${m} 分`;
const delayText = d => d == null ? "" : d ? `晚 ${d} 分` : "準點";

async function stations(kind) {   // tra／thsr → [[代碼, 站名]]；捷運（op）→ [[代碼們（逗號）, 站名, 線]]，轉乘站合成一個
  let all = {};
  try { all = JSON.parse(localStorage.getItem(SKEY) || "{}"); } catch (e) { /* 重查 */ }
  if (all[kind] && Date.now() - all[kind].t < 86400e3) return all[kind].v;
  let v;
  if (kind === "tra") v = ((await tdx("v3/Rail/TRA/Station?$select=StationID,StationName&$format=JSON")).Stations || []).map(s => [s.StationID, s.StationName?.Zh_tw || ""]);
  else if (kind === "thsr") v = (await tdx("v2/Rail/THSR/Station?$select=StationID,StationName&$format=JSON")).map(s => [s.StationID, s.StationName?.Zh_tw || ""]);
  else {
    const by = {};
    for (const s of await tdx(`v2/Rail/Metro/Station/${kind}?$select=StationID,StationName&$format=JSON`)) {
      const n = s.StationName?.Zh_tw || "";
      (by[n] = by[n] || []).push(s.StationID);
    }
    v = Object.entries(by).map(([n, ids]) => [ids.join(","), n, (ids[0].match(/^[A-Za-z]+/) || [""])[0]]).sort((a, b) => a[0].localeCompare(b[0]));
  }
  all[kind] = {t: Date.now(), v};
  localStorage.setItem(SKEY, JSON.stringify(all));
  return v;
}
const stId = (list, name) => (list.find(s => zhs(s[1]) === zhs(name)) || [])[0];

// 起訖站某天所有車次（電腦版 tra_timetable／thsr_timetable）
async function railTimes(kind, o, d, day) {
  const k = [kind, o, d, day].join("|");
  if (TT[k] && Date.now() - TT[k].t < 1800e3) return TT[k].rows;
  const ride = (a, b) => { const m = hmMin(b) - hmMin(a); return m < 0 ? m + 1440 : m; };
  const rows = [];
  if (kind === "tra") {
    for (const x of (await tdx(`v3/Rail/TRA/DailyTrainTimetable/OD/${o}/to/${d}/${day}?$format=JSON`)).TrainTimetables || []) {
      const info = x.TrainInfo || {}, st = x.StopTimes || [];
      if (st.length < 2) continue;
      const a = st[0], b = st[st.length - 1], dep = a.DepartureTime, arr = b.ArrivalTime;
      if (!dep || !arr) continue;
      const note = [];
      if (info.SuspendedFlag || a.SuspendedFlag || b.SuspendedFlag) note.push("⛔ 停駛");
      if (info.ExtraTrainFlag) note.push("加班車");
      const svc = [["BikeFlag", "🚲"], ["WheelChairFlag", "♿"], ["BreastFeedFlag", "🍼"], ["DiningFlag", "🍱"]].filter(([f]) => info[f]).map(([, i]) => i).join("");
      rows.push({no: info.TrainNo || "", type: (info.TrainTypeName?.Zh_tw || "").split("(")[0], dep, arr, ride: ride(dep, arr),
        to: info.EndingStationName?.Zh_tw || "", svc, note: note.join("、")});
    }
  } else {
    for (const x of await tdx(`v2/Rail/THSR/DailyTimetable/OD/${o}/to/${d}/${day}?$format=JSON`)) {
      const info = x.DailyTrainInfo || {}, dep = x.OriginStopTime?.DepartureTime, arr = x.DestinationStopTime?.ArrivalTime;
      if (dep && arr) rows.push({no: info.TrainNo || "", type: "高鐵", dep, arr, ride: ride(dep, arr), to: info.EndingStationName?.Zh_tw || "", svc: "", note: ""});
    }
  }
  rows.sort((a, b) => a.dep.localeCompare(b.dep));
  TT[k] = {t: Date.now(), rows};
  return rows;
}

async function board(k, path, pick) {   // 30 秒內重複用同一份（省 TDX 額度）
  if (BOARD[k] && Date.now() - BOARD[k].t < 30e3) return BOARD[k].v;
  const v = pick(await tdx(path));
  BOARD[k] = {t: Date.now(), v};
  return v;
}
const traDelays = o => board("tra|" + o, `v3/Rail/TRA/StationLiveBoard/Station/${o}?$format=JSON`,
  j => Object.fromEntries((j.StationLiveBoards || []).map(x => [x.TrainNo, x.DelayTime ?? 0])));
const metroBoard = op => board("metro|" + op, `v2/Rail/Metro/LiveBoard/${op}?$format=JSON`, j => j);

// 捷運某站的即時到站（電腦版 metro_rows）
function metroRows(op, bd, ids) {
  return bd.filter(x => ids.includes(x.StationID)).map(x => {
    let dest = x.DestinationStationName?.Zh_tw || x.TripHeadSign?.Zh_tw || "";
    if (!/^(往|逆|順)/.test(dest)) dest = "往" + dest;
    const t = x.EstimateTime, ok = (x.ServiceStatus ?? 0) === 0 && t != null, line = x.LineID || x.LineNO || "";
    return {c: LINE_COLORS[op + "|" + line] || "#888", line, lname: x.LineName?.Zh_tw || "", dest, m: ok ? t : null, t: ok ? (t === 0 ? "進站中" : `${t} 分`) : "—"};
  }).sort((a, b) => a.line.localeCompare(b.line) || a.dest.localeCompare(b.dest));
}

function railSet() {   // 電腦版搬過來的 rail（tra／thsr 的 o、d 站名）、railMode、metroOp、metroSt
  const D = DB.data;
  D.rail = D.rail && typeof D.rail === "object" ? D.rail : {};
  D.rail.tra = D.rail.tra || {o: "", d: ""};
  D.rail.thsr = D.rail.thsr || {o: "", d: ""};
  D.metroSt = D.metroSt && typeof D.metroSt === "object" ? D.metroSt : {};
  if (!METRO_OPS.includes(D.metroOp)) D.metroOp = "KRTC";
  return D;
}
const METRO_OPS = Object.values(METRO);

async function railMode(mode) {
  const D = railSet();
  RAIL.mode = mode; RAIL.list = null; RAIL.err = ""; RAIL.train = null; RAIL.metro = null; RAIL.sts = null;
  D.railMode = mode; save();
  RAIL.busy = true; renderRail();
  try { RAIL.sts = await stations(mode === "metro" ? D.metroOp : mode); } catch (e) { RAIL.err = e.message; }
  RAIL.busy = false; renderRail();
  if (mode === "metro" && D.metroSt[D.metroOp]) metroLook();
}

async function railFind() {
  const D = railSet(), kind = RAIL.mode, r = D.rail[kind];
  r.o = $("#rl-o").value.trim(); r.d = $("#rl-d").value.trim();
  RAIL.after = $("#rl-after").value || "";
  save();
  const o = stId(RAIL.sts || [], r.o), d = stId(RAIL.sts || [], r.d);
  if (!o || !d) { RAIL.err = `找不到車站「${!o ? r.o : r.d}」，從清單挑`; return renderRail(); }
  if (o === d) { RAIL.err = "起站和迄站一樣"; return renderRail(); }
  RAIL.busy = true; RAIL.err = ""; RAIL.train = null; renderRail();
  try {
    const day = dayIso(RAIL.day), today = !RAIL.day;
    const after = RAIL.after || (today ? hmNow() : "00:00");
    const rows = (await railTimes(kind, o, d, day)).filter(x => x.dep >= after);
    let dl = {};
    if (kind === "tra" && today && rows.length && minsTo(rows[0].dep) <= 60) { try { dl = await traDelays(o); } catch (e) { /* 誤點查不到就不顯示 */ } }
    RAIL.list = {kind, o, d, on: r.o, dn: r.d, day, today, rows: rows.map(x => ({...x, delay: dl[x.no]}))};
  } catch (e) { RAIL.err = e.message; }
  RAIL.busy = false; renderRail();
}

// 一班車停哪些站、現在到哪（台鐵今天用即時位置；高鐵照時刻推算）——電腦版 api_train
async function railTrain(no) {
  const L = RAIL.list;
  if (RAIL.train?.no === no) { RAIL.train = null; return renderRail(); }   // 再按一次收起來
  const T = RAIL.train = {no, busy: true, stops: [], cur: null, note: ""};
  renderRail();
  try {
    if (L.kind === "tra") {
      if (!L.today) T.note = "台鐵的車次停靠站只能查今天的。";
      else {
        const t = ((await tdx(`v3/Rail/TRA/DailyTrainTimetable/Today/TrainNo/${no}?$format=JSON`)).TrainTimetables || [])[0] || {};
        T.stops = (t.StopTimes || []).map(s => ({id: s.StationID, name: s.StationName?.Zh_tw || "", arr: (s.ArrivalTime || "").slice(0, 5), dep: (s.DepartureTime || "").slice(0, 5)}));
        const lv = ((await tdx(`v3/Rail/TRA/TrainLiveBoard?$filter=TrainNo eq '${no}'&$format=JSON`)).TrainLiveBoards || [])[0];
        const first = T.stops[0]?.dep || T.stops[0]?.arr;
        if (first && minsTo(first) > 30) T.note = `還沒發車（${first} 從${T.stops[0].name}出發）`;   // 半夜 TDX 還留著前一天的位置
        else if (lv) {
          T.cur = T.stops.findIndex(s => s.id === lv.StationID);
          if (T.cur < 0) T.cur = null;
          const at = T.cur != null ? T.stops[T.cur].name : lv.StationName?.Zh_tw || lv.StationID;
          T.note = `現在：${at} ${["進站中", "在站上", "已離站"][lv.TrainStationStatus] || ""}・${delayText(lv.DelayTime ?? 0)}`;
        } else T.note = "目前沒有這班車的即時位置（可能還沒發車或已經到站）";
      }
    } else {
      const x = (await tdx(`v2/Rail/THSR/DailyTimetable/TrainDate/${L.day}?$filter=DailyTrainInfo/TrainNo eq '${no}'&$format=JSON`))[0] || {};
      T.stops = (x.StopTimes || []).map(s => ({id: s.StationID, name: s.StationName?.Zh_tw || "", arr: (s.ArrivalTime || "").slice(0, 5), dep: (s.DepartureTime || "").slice(0, 5)}));
      if (L.today && T.stops.length) {
        const hm = hmNow(), passed = T.stops.map((s, i) => (s.dep || s.arr) && (s.dep || s.arr) <= hm ? i : -1).filter(i => i >= 0);
        const last = passed[passed.length - 1];
        if (last == null) T.note = `還沒發車（${T.stops[0].dep || T.stops[0].arr} 從${T.stops[0].name}出發）`;
        else if (last < T.stops.length - 1) { T.cur = last; T.note = `照時刻推算：已過 ${T.stops[last].name}，下一站 ${T.stops[last + 1].name}`; }
        else T.note = "這班車已經到終點了";
      }
    }
  } catch (e) { T.note = "查不到：" + e.message; }
  T.busy = false;
  if (RAIL.train === T) renderRail();
}

async function metroLook() {
  const D = railSet(), op = D.metroOp, sel = $("#mt-st");
  if (sel && sel.value) { D.metroSt[op] = sel.value; save(); }
  const ids = D.metroSt[op];
  if (!ids) return;
  const old = RAIL.metro?.ids?.join(",") === ids ? RAIL.metro.rows : null;
  const M = RAIL.metro = {op, ids: ids.split(","), busy: true, rows: old, err: ""};
  renderRail();
  try { M.rows = metroRows(op, await metroBoard(op), M.ids); M.t = new Date(); } catch (e) { M.err = e.message; }
  M.busy = false;
  if (RAIL.metro === M) renderRail();
}

const railFav = (kind, o, d) => DB.data.favs.findIndex(f => f.t === "rail" && (f.kind || "tra") === kind && f.o === o && f.d === d);
const metroFav = (op, ids) => DB.data.favs.findIndex(f => f.t === "metro" && f.op === op && (f.ids || []).join(",") === ids);
function toggleRailFav() {
  const L = RAIL.list, i = railFav(L.kind, L.o, L.d);
  if (i >= 0) DB.data.favs.splice(i, 1);
  else DB.data.favs.push({t: "rail", kind: L.kind, o: L.o, d: L.d, on: L.on, dn: L.dn, name: `${L.on}→${L.dn}`,
    label: `${L.kind === "tra" ? "🚆" : "🚄"} ${L.on} → ${L.dn}`});
  save(); renderRail(); renderFav(); if (i < 0) refreshLive();
  toast(i >= 0 ? "從常用拿掉了" : `加到常用：${L.on} → ${L.dn}`);
}
function toggleMetroFav() {
  const M = RAIL.metro, ids = M.ids.join(","), i = metroFav(M.op, ids);
  const name = (RAIL.sts || []).find(s => s[0] === ids)?.[1] || "";
  const opn = Object.keys(METRO).find(k => METRO[k] === M.op) || M.op;
  if (i >= 0) DB.data.favs.splice(i, 1);
  else DB.data.favs.push({t: "metro", kind: "metro", op: M.op, ids: M.ids, name, label: `🚇 ${opn} ${name}`});
  save(); renderRail(); renderFav(); if (i < 0) refreshLive();
  toast(i >= 0 ? "從常用拿掉了" : `加到常用：${opn} ${name}`);
}

function renderRail() {
  const D = railSet();
  const modes = [["tra", "🚆 台鐵"], ["thsr", "🚄 高鐵"], ["metro", "🚇 捷運"]];
  let h = `<div class="card"><div class="chips">` + modes.map(([m, n]) => `<button class="small ${m === RAIL.mode ? "on" : ""}" data-act="rmode" data-m="${m}">${n}</button>`).join("") + `</div>`;
  if (RAIL.mode === "tra" || RAIL.mode === "thsr") {
    const r = D.rail[RAIL.mode];
    h += `<datalist id="rl-sts">${(RAIL.sts || []).map(s => `<option value="${esc(s[1])}">`).join("")}</datalist>` +
      `<div class="trow"><input type="text" id="rl-o" list="rl-sts" placeholder="起站" value="${esc(r.o)}" autocomplete="off">` +
      `<button class="small" data-act="rswap" title="對調">⇄</button>` +
      `<input type="text" id="rl-d" list="rl-sts" placeholder="迄站" value="${esc(r.d)}" autocomplete="off"></div>` +
      `<div class="trow"><span class="chips">` + ["今天", "明天", "後天"].map((n, i) => `<button class="small ${i === RAIL.day ? "on" : ""}" data-act="rday" data-d="${i}">${n}</button>`).join("") +
      `</span><label class="sub">幾點以後 <input type="time" id="rl-after" value="${esc(RAIL.after)}"></label></div>` +
      `<button class="primary" data-act="rfind" ${RAIL.busy || !RAIL.sts ? "disabled" : ""}>${RAIL.busy ? "查詢中…" : "🔍 查車次"}</button>`;
  } else if (RAIL.mode === "metro") {
    h += `<div class="trow"><select id="mt-op">` + Object.entries(METRO).map(([n, c]) => `<option value="${c}" ${c === D.metroOp ? "selected" : ""}>${n}</option>`).join("") + `</select>` +
      `<select id="mt-st"><option value="">選車站</option>` + (RAIL.sts || []).map(s => `<option value="${esc(s[0])}" ${s[0] === D.metroSt[D.metroOp] ? "selected" : ""}>${esc(s[1])}</option>`).join("") + `</select></div>`;
    if (RAIL.busy) h += `<p class="muted">查車站中…</p>`;
  }
  if (RAIL.err) h += `<p class="muted">查不到：${esc(RAIL.err)}</p>`;
  h += `</div>`;
  const L = RAIL.list;
  if (L && L.kind === RAIL.mode) {
    h += `<div class="card"><h3>${esc(L.on)} → ${esc(L.dn)} <span class="sub">${L.day.slice(5).replace("-", "/")}・${L.rows.length} 班</span>` +
      `<button class="star dot" data-act="rfav" title="加到常用">${railFav(L.kind, L.o, L.d) >= 0 ? "⭐" : "☆"}</button></h3>`;
    if (!L.rows.length) h += `<p class="muted">這個時間以後沒有車了。</p>`;
    h += L.rows.slice(0, 40).map(x => {
      const m = L.today ? minsTo(x.dep) : null, sel = RAIL.train?.no === x.no;
      return `<button class="row full train${sel ? " hl" : ""}" data-act="rtrain" data-no="${esc(x.no)}">` +
        `<span class="eta ${m != null && m <= 10 ? "soon" : ""}">${esc(x.dep)}<br><span class="sub">${m == null ? "" : m <= 0 ? "快開了" : fmtMin(m) + "後"}</span></span>` +
        `<span><b>${esc(x.type)} ${esc(x.no)}</b> 往${esc(x.to)}${x.delay != null ? ` <span class="${x.delay ? "late" : "ok"}">${delayText(x.delay)}</span>` : ""}` +
        `<br><span class="sub">${esc(x.dep)}→${esc(x.arr)}・${fmtMin(x.ride)} ${esc(x.svc)} ${esc(x.note)}</span></span></button>` +
        (sel ? trainBox() : "");
    }).join("") + (L.rows.length > 40 ? `<p class="muted small-t">只列前 40 班，要看更晚的改「幾點以後」。</p>` : "") +
      `<p class="muted small-t">點車次看停靠站和現在到哪。</p></div>`;
  }
  const M = RAIL.metro;
  if (RAIL.mode === "metro" && M) {
    const name = (RAIL.sts || []).find(s => s[0] === M.ids.join(","))?.[1] || "";
    h += `<div class="card"><h3>🚇 ${esc(name)}<button class="star dot" data-act="mfav" title="加到常用">${metroFav(M.op, M.ids.join(",")) >= 0 ? "⭐" : "☆"}</button></h3>`;
    if (M.err) h += `<p class="muted">查不到：${esc(M.err)}</p>`;
    if (M.rows && !M.rows.length) h += `<p class="muted">目前沒有即時資料（可能還沒營運或末班已過）</p>`;
    h += (M.rows || []).map(metroRow).join("");
    h += `<p class="muted small-t">${M.busy ? "查詢中…" : M.t ? M.t.toLocaleTimeString("zh-TW", {hour12: false}) + " 更新・每 30 秒自動更新" : ""}</p></div>`;
  }
  const keep = document.activeElement?.id;
  $("#pane-rail").innerHTML = h;
  if (keep && /^rl-/.test(keep)) $("#" + keep)?.focus();
}
const metroRow = x => `<div class="row"><span class="eta ${x.m === 0 ? "now" : x.m != null && x.m <= 3 ? "soon" : x.m == null ? "off" : ""}">${esc(x.t)}</span>` +
  `<span><span class="ln" style="background:${x.c}"></span>${esc(x.dest)} <span class="sub">${esc(x.lname)}</span></span></div>`;

function trainBox() {
  const T = RAIL.train;
  if (T.busy) return `<div class="tbox"><p class="muted">查停靠站中…</p></div>`;
  return `<div class="tbox">` + (T.note ? `<p class="muted">${esc(T.note)}</p>` : "") +
    T.stops.map((s, i) => `<div class="tst${i === T.cur ? " hl" : ""}${T.cur != null && i < T.cur ? " past" : ""}">` +
      `<span>${esc(s.arr || s.dep)}</span><span>${i === T.cur ? "🚆 " : ""}${esc(s.name)}</span></div>`).join("") + `</div>`;
}

// 常用裡的火車、捷運（電腦版 _fav_rail：今天接下來 3 班，快開的台鐵加誤點；_fav_metro：即時看板前 6 筆）
const FAVX = new Map();   // 常用那一筆（物件）→ 顯示用資料
async function refreshRailFavs() {
  const day = dayIso(0), hm = hmNow();
  for (const f of DB.data.favs) {
    try {
      if (f.t === "rail" && f.o && f.d) {
        const kind = f.kind || "tra";
        const rows = (await railTimes(kind, f.o, f.d, day)).filter(x => x.dep >= hm).slice(0, 3);
        let dl = {};
        if (kind === "tra" && rows.length && minsTo(rows[0].dep) <= 60) { try { dl = await traDelays(f.o); } catch (e) { /* 不顯示誤點 */ } }
        FAVX.set(f, {trains: rows.map(x => ({...x, delay: dl[x.no]}))});
      } else if (f.t === "metro" && f.op && f.ids) {
        FAVX.set(f, {rows: metroRows(f.op, await metroBoard(f.op), f.ids).slice(0, 6)});
      }
    } catch (e) { FAVX.set(f, {...FAVX.get(f), err: e.message}); }
  }
}

function railFavRow(f) {
  const x = FAVX.get(f), i = DB.data.favs.indexOf(f);
  let body = "";
  if (!x) body = `<span class="sub">${window.BusBridge && DB.settings.tdxId ? "…" : ""}</span>`;
  else if (x.trains) body = x.trains.length ? x.trains.map(t => {
    const m = minsTo(t.dep);
    return `<div class="sub">${m <= 0 ? "快開了" : fmtMin(m) + "後"}・<b>${esc(t.dep)}</b>→${esc(t.arr)} ${esc(t.type)} ${esc(t.no)}` +
      (t.delay != null ? ` <span class="${t.delay ? "late" : "ok"}">${delayText(t.delay)}</span>` : "") + `</div>`;
  }).join("") : `<div class="sub">今天沒有車了</div>`;
  else if (x.rows) body = x.rows.length ? x.rows.map(metroRow).join("") : `<div class="sub">目前沒有即時資料</div>`;
  if (x?.err && !x.trains && !x.rows) body = `<div class="sub">查不到：${esc(x.err)}</div>`;
  return `<button class="row full rfav" data-act="frail" data-i="${i}"><span><b>${esc(f.label || f.name)}</b>${body}</span></button>`;
}

// 常用點火車、捷運 → 火車分頁直接查
async function openRailFav(f) {
  const D = railSet();
  if (f.t === "metro") {
    D.metroOp = f.op; D.metroSt[f.op] = f.ids.join(","); save();
    return railMode("metro");
  }
  const kind = f.kind || "tra";
  D.rail[kind] = {o: f.on || "", d: f.dn || ""};
  RAIL.day = 0; RAIL.after = "";
  await railMode(kind);
  if (RAIL.sts) railFind();
}
