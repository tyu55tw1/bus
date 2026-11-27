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
  save();   // 1.4：起訖站在選站抽屜選（電腦版 pickStation），不再讀輸入框
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
  const x = L.rows.find(r => r.no === no) || {no};
  const T = RAIL.train = {no, busy: true, stops: [], cur: null, note: "", x, on: [L.o, L.d]};
  // 1.4：電腦版 openTrain 的推進頁
  T.s = UI.push(`<header class="top"><button class="back">${icon("back")}火車</button><h1 class="center">${esc(x.type || (L.kind === "thsr" ? "高鐵" : ""))} ${esc(no)} 次</h1><span style="width:60px"></span></header>
    <div class="scroll"><div class="small muted" style="margin:0 2px 10px">${esc(dayLabel(L.day))}${x.dep ? `・${x.dep} 開 → ${x.arr} 到・往 ${esc(x.to || "")}${x.svc ? "・" + esc(x.svc) : ""}` : ""}</div><div data-body><div class="skel"></div></div></div>`,
    {onPop: () => { if (RAIL.train === T) RAIL.train = null; }});
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
  if (RAIL.train === T) drawTrain();
}

async function metroLook() {
  const D = railSet(), op = D.metroOp;
  const ids = mtIds(op);
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

// ── 畫面（1.4 起照電腦版 renderRail／renderTrain／railResHtml／openTrain／renderMetro） ──
const dayLabel = iso => { const d = new Date(iso + "T00:00"); return `${d.getMonth() + 1}/${d.getDate()}（${"日一二三四五六"[d.getDay()]}）`; };
const TRAIN_COLORS = [["普悠瑪", "#FDE2E2", "#B91C1C"], ["太魯閣", "#FDE2E2", "#B91C1C"], ["自強", "#FFE4CC", "#B45309"], ["莒光", "#FFF4BF", "#8A5A00"],
  ["區間快", "#D7F0FF", "#0369A1"], ["區間", "#E3E8FF", "#3730A3"], ["復興", "#E8F5E9", "#2E7D32"], ["普快", "#EEEEEE", "#424242"]];
const trainCss = n => { const c = TRAIN_COLORS.find(x => String(n || "").startsWith(x[0])); return c ? `background:${c[1]};color:${c[2]}` : ""; };
// 捷運車站：手機版存代碼字串，電腦版搬過來的是 {ids, name}
const mtIds = op => { const v = railSet().metroSt[op]; return v && typeof v === "object" ? v.ids : v || ""; };

function renderRail() {
  const box = $("#pane-rail");
  if (!box) return;
  const D = railSet(), mode = RAIL.mode || "tra";
  let h = `<div class="seg" style="margin-bottom:12px">` + [["tra", "台鐵"], ["thsr", "高鐵"], ["metro", "捷運"]].map(([k, t]) =>
    `<button aria-pressed="${mode === k}" data-act="rmode" data-m="${k}">${t}</button>`).join("") + `</div>`;
  if (mode === "metro") h += metroHtml(D);
  else {
    const r = D.rail[mode];
    h += `<div class="pickrow"><button class="pickbtn press" data-act="rpick" data-p="o"><span>起站</span><b>${esc(r.o || "選起站")}</b></button>
        <button class="swapbtn press" data-act="rswap" aria-label="起訖站對調">${icon("swap")}</button>
        <button class="pickbtn press" data-act="rpick" data-p="d"><span>迄站</span><b>${esc(r.d || "選迄站")}</b></button></div>
      <div class="label"><span>日期</span></div>
      <div class="chips scrollx">${[0, 1, 2].map(n => `<button class="chip press" aria-pressed="${RAIL.day === n}" data-act="rday" data-d="${n}">${["今天", "明天", "後天"][n]}</button>`).join("")}</div>
      <div class="label"><span>幾點以後</span></div>
      <div class="chips"><button class="chip press" aria-pressed="${!RAIL.after}" data-act="rnow">${RAIL.day === 0 ? "現在" : "整天"}</button>
        <label class="chip pick" aria-pressed="${!!RAIL.after}">${RAIL.after ? `${esc(RAIL.after)} 以後` : "指定時間"}<input type="time" id="rl-after" value="${esc(RAIL.after)}" aria-label="幾點以後"></label></div>
      <button class="btn block press" data-act="rfind" style="margin-top:16px"${RAIL.busy ? " disabled" : ""}>${RAIL.busy ? '<span class="spin"></span>查詢中…' : "查詢時刻表"}</button>`;
    if (RAIL.err) h += `<div style="margin-top:12px">${errBox("rail", RAIL.err, () => RAIL.sts ? railFind() : railMode(mode))}</div>`;
    h += railResHtml(mode);
  }
  box.innerHTML = h;
}

function railResHtml(kind) {
  const L = RAIL.list;
  if (!L || L.kind !== kind) return RAIL.err ? "" : `<div class="cap" style="margin-top:14px">選好起訖站按「查詢時刻表」。點某一班可以看停靠站和現在到哪。</div>`;
  const on = railFav(L.kind, L.o, L.d) >= 0;
  const head = `<div class="label"><span>${esc(L.on)} → ${esc(L.dn)}・${esc(dayLabel(L.day))}${RAIL.after ? `・${esc(RAIL.after)} 以後` : ""}</span>
    <button data-act="rfav">${on ? "★ 已在常用" : "☆ 加到常用"}</button></div>`;
  if (!L.rows.length) return head + `<div class="note">這個時間以後沒有車了（台鐵兩站之間沒有直達車時，可以用「查路線」裡的路線規劃）。</div>`;
  return head + `<div class="cardlist">` + L.rows.slice(0, 40).map(t => {
    const m = L.today ? minsTo(t.dep) : null;
    return `<button class="trow press" data-act="rtrain" data-no="${esc(t.no)}">
      <span><span class="tm">${esc(t.dep)}<small>→</small>${esc(t.arr)}</span><div class="s"><span class="ttag" style="${trainCss(t.type)}">${esc(t.type || (kind === "thsr" ? "高鐵" : ""))}</span>${esc(t.no)} 次・${fmtMin(t.ride)}${t.note ? "・" + esc(t.note) : ""}${delayHtml(t.delay)}</div></span>
      <span class="r">${m != null ? (m <= 0 ? `<b class="soon">快開了</b>` : m < 120 ? `<b class="${m <= 5 ? "soon" : ""}">${m}<small>分後開</small></b>` : `<span class="small muted">${Math.floor(m / 60)} 小時後</span>`) : ""}</span></button>`;
  }).join("") + `</div>` + (L.rows.length > 40 ? `<div class="cap">只列前 40 班，要看更晚的改「幾點以後」</div>` : "") +
    (kind === "tra" ? `<div class="cap">「準點／晚 N 分」是起站的即時看板，只有快到站的車才有</div>` : "");
}

// 車次頁內容（railTrain 查完呼叫）
function drawTrain() {
  const T = RAIL.train;
  if (!T || !T.s || !T.s.isConnected) return;
  const body = $("[data-body]", T.s);
  if (!T.stops.length) { body.innerHTML = `<div class="note">${esc(T.note || "查不到這班車的停靠站。")}</div>`; return; }
  body.innerHTML = (T.note ? `<div class="card" style="margin-bottom:10px"><b>${esc(T.note)}</b></div>` : "") +
    `<div class="card"><div class="line">` + T.stops.map((x, i) => `<div class="stop${T.on.includes(x.id) ? " mine" : ""}${T.cur != null && i < T.cur ? " past" : ""}">` +
      (i === T.cur ? `<span class="busm">車</span>` : "") + `<span class="nm">${esc(x.name)}${T.on.includes(x.id) ? `<small>${x.id === T.on[0] ? "上車" : "下車"}</small>` : ""}</span>` +
      `<span class="e">${x.arr && x.dep && x.arr !== x.dep ? `${esc(x.arr)} 到・${esc(x.dep)} 開` : esc(x.dep || x.arr)}</span></div>`).join("") + `</div></div>`;
}

function metroHtml(D) {
  const op = D.metroOp, ids = mtIds(op), M = RAIL.metro;
  const name = (RAIL.sts || []).find(s => s[0] === ids)?.[1] || (typeof D.metroSt[op] === "object" ? D.metroSt[op].name : "");
  let h = `<div class="chips scrollx" style="margin-bottom:12px">` + Object.entries(METRO).map(([n, c]) =>
    `<button class="chip press" aria-pressed="${c === op}" data-act="mtop" data-op="${c}">${esc(n)}</button>`).join("") + `</div>
    <button class="pickbtn press" data-act="rpick" data-p="m"><span>車站</span><b>${ids ? esc(name || "車站") : "點這裡選車站"}</b></button>`;
  if (RAIL.err) h += `<div style="margin-top:12px">${errBox("rail", RAIL.err, () => railMode("metro"))}</div>`;
  if (!ids) return h + `<div class="cap" style="margin-top:14px">選車站後顯示各方向下一班還有幾分到。</div>`;
  const on = metroFav(op, ids) >= 0;
  h += `<div class="label"><span>各方向下一班</span><button data-act="mfav">${on ? "★ 已在常用" : "☆ 加到常用"}</button></div>`;
  if (M?.err) h += errBox("metro", M.err, () => metroLook());
  if (!M || (!M.rows && M.busy)) h += `<div class="skel"></div>`;
  else if (M.rows && !M.rows.length) h += `<div class="note">目前沒有即時資料（可能還沒營運或末班已過）。</div>`;
  else if (M.rows) h += `<div class="cardlist">` + M.rows.map(r => `<div class="rrow" style="grid-template-columns:auto 1fr auto"><span class="badge sm" style="background:${esc(r.c)};min-width:14px;width:14px;padding:0"></span>
      <span class="w"><b>${esc(r.dest)}</b><span>${esc(r.lname)}</span></span>${r.m == null ? `<span class="eta off sm"><span class="n">—</span></span>` : r.m === 0 ? `<span class="eta now sm"><span class="n">進站中</span></span>` :
      `<span class="eta sm ${r.m <= 3 ? "soon" : ""}"><span class="n num">${r.m}<small>分</small></span></span>`}</div>`).join("") + `</div>`;
  h += `<div class="cap">${M?.t ? M.t.toLocaleTimeString("zh-TW", {hour12: false}) + " 更新・" : ""}開著這頁每 30 秒更新・台中捷運 TDX 目前沒有即時資料</div>`;
  return h;
}

// 選站抽屜（電腦版 pickStation）：搜尋、最近用過、全部；which：o 起站、d 迄站、m 捷運車站
async function railPick(which) {
  const D = railSet(), kind = which === "m" ? D.metroOp : RAIL.mode;
  const sh = UI.sheet(which === "o" ? "選起站" : which === "d" ? "選迄站" : "選車站",
    `<div class="field">${icon("search")}<input type="search" id="st-q" placeholder="打站名搜尋，例如：台南、左營" aria-label="搜尋車站" autocomplete="off"></div><div id="st-l" style="margin-top:6px"><div class="cap"><span class="spin"></span>載入車站…</div></div>`);
  let list;
  try { list = RAIL.sts && RAIL.mode === (which === "m" ? "metro" : kind) ? RAIL.sts : await stations(kind); }
  catch (e) { $("#st-l", sh).innerHTML = `<div class="note bad">${esc(String(e.message).replace(/（\d+ 秒）/, ""))}，等一下再試</div>`; return; }
  const cur = which === "m" ? mtIds(kind) : D.rail[kind][which];
  const norm = t => zhs(t).replace(/\s+/g, "").replace(/(.{2,})(車站|站)$/, "$1");
  const tile = s => `<button class="tile press" aria-pressed="${which === "m" ? s[0] === cur : s[1] === cur}" data-act="stpick" data-w="${which}" data-id="${esc(s[0])}" data-n="${esc(s[1])}">${esc(s[1])}</button>`;
  const LN = {KRTC: {R: "紅線", O: "橘線"}, KLRT: {C: "環狀輕軌"}, TYMC: {A: "機場線"}, TRTC: {BL: "板南線", R: "淡水信義線", G: "松山新店線", O: "中和新蘆線", BR: "文湖線", Y: "環狀線"}};
  function draw() {
    const inp = $("#st-q", sh), L = $("#st-l", sh);
    if (!inp || !L) return;
    const q = norm(inp.value);
    if (q) {
      const hit = list.filter(s => norm(s[1]).includes(q));
      L.innerHTML = hit.length ? `<div class="tiles" style="margin-top:8px">${hit.map(tile).join("")}</div>` : `<div class="cap">找不到「${esc(inp.value)}」</div>`;
      return;
    }
    const rec = ((D.st || {})[kind] || []).map(n => list.find(s => s[1] === n)).filter(Boolean);
    const groups = {};
    list.forEach(s => { const g = which === "m" ? (LN[kind] || {})[s[2]] || s[2] || "車站" : kind === "thsr" ? "高鐵站" : "全部車站"; (groups[g] = groups[g] || []).push(s); });
    L.innerHTML = (rec.length ? `<div class="grouph">最近用過</div><div class="tiles">${rec.map(tile).join("")}</div>` : "") +
      Object.keys(groups).map(g => `<div class="grouph">${esc(g)}</div><div class="tiles">${groups[g].map(tile).join("")}</div>`).join("");
  }
  $("#st-q", sh).oninput = draw;
  draw();
}
function railPicked(which, id, name) {
  const D = railSet();
  UI.closeSheet();
  if (which === "m") {
    D.metroSt[D.metroOp] = id; save();
    RAIL.metro = null; renderRail(); return metroLook();
  }
  const kind = RAIL.mode;
  D.st = D.st && typeof D.st === "object" ? D.st : {};
  D.st[kind] = [name, ...(D.st[kind] || []).filter(n => n !== name)].slice(0, 6);
  D.rail[kind][which] = name; save();
  renderRail();
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
