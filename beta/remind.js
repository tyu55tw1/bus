// 公車手機版・🔔 公車快到提醒（第 5 步，2026-11-28；照電腦版 remind.py 的「這一次」「每天固定時段」）
// 提醒清單存在 App（外殼 1.4 的 RemindService 在背景每分鐘查 TDX、剩 N 分跳通知），網頁用 BusBridge.getReminders／setReminders 整份讀寫。
// 「這一次」3 小時內有效、推完自動刪；「每天」選星期幾和時段，一天推一次。出門提醒（想去哪的走法）之後再接。
"use strict";
const RM = {open: false, kind: "once", fav: 0, min: 5, days: [1, 2, 3, 4, 5], start: "07:00", end: "08:30"};
const RM_MINS = [3, 5, 8, 10], RM_HOURS = 3;
const canRemind = () => !!(window.BusBridge && typeof BusBridge.getReminders === "function");

function rmList() {
  try { return JSON.parse(BusBridge.getReminders() || "[]"); } catch (e) { return []; }
}
function rmSave(list) {
  BusBridge.setReminders(JSON.stringify(list), DB.settings.tdxId || "", DB.settings.tdxSecret || "");
}
const rmBusFavs = () => DB.data.favs.filter(f => f.t === "bus" && f.city && f.stop);

function rmAdd() {
  const f = rmBusFavs()[RM.fav];
  if (!f) return toast("先在常用加公車站牌");
  if (!DB.settings.tdxId) return toast("先到 ⚙️ 設定輸入 TDX 金鑰");
  const r = {id: "r" + Date.now().toString(36), kind: RM.kind, city: f.city, stop: f.stop, route: f.route, sub: f.sub || "", dir: f.dir ?? 0,
    name: f.name || "", min: RM.min};
  if (RM.kind === "once") r.until = Date.now() + RM_HOURS * 3600e3;
  else {
    if (!RM.days.length) return toast("至少勾一天");
    if (RM.start >= RM.end) return toast("時段的開始要比結束早");
    Object.assign(r, {days: RM.days.slice().sort(), start: RM.start, end: RM.end});
  }
  const list = rmList();
  list.push(r);
  rmSave(list);
  RM.open = false;
  toast(RM.kind === "once" ? `好了：${RM_HOURS} 小時內 ${f.route} 剩 ${RM.min} 分會通知` : `好了：每天 ${RM.start}～${RM.end} 盯 ${f.route}`);
  setTimeout(renderRemind, 300);
}

function rmDel(id) {
  rmSave(rmList().filter(r => r.id !== id));
  setTimeout(renderRemind, 300);
}

function rmDesc(r) {
  if (r.kind === "once") {
    const left = Math.round((r.until - Date.now()) / 60e3);
    return `這一次・剩 ${r.min} 分通知・${left > 0 ? `還盯 ${fmtMin(left)}` : "已結束"}`;
  }
  const d = r.days.length === 7 ? "每天" : r.days.join(",") === "1,2,3,4,5" ? "平日" : "星期" + r.days.map(i => WEEK_ZH[i]).join("");
  return `${d} ${r.start}～${r.end}・剩 ${r.min} 分通知` + (r.done === dayIso(0) ? "・今天通知過了" : "");
}

// 1.4：畫面照電腦版 remBox／openReminders（方塊選擇、清單一列一個）；app.js 的 openRemind 推進頁
function renderRemind() {
  const box = $("#remind-box");
  if (!box) return;
  if (!canRemind()) {
    box.innerHTML = `<div class="empty"><div class="big">🔔</div><b>公車快到提醒</b><p>${window.BusBridge ? "要先更新公車 App 到 1.4 版以上（我的助手「📱 主畫面小工具」下載）才能用。" : "要在公車 App 裡才能設提醒。"}</p></div>`;
    return;
  }
  const list = rmList(), favs = rmBusFavs();
  let h = "";
  if (list.length) h += `<div class="label"><span>我的提醒</span></div><div class="cardlist">` + list.map(r =>
    `<div class="setrow remrow"><span class="row" style="min-width:0">${badge(r.route, "sm")}<span class="w"><b>${esc(r.name)}</b><span>${esc(rmDesc(r))}</span></span></span>` +
    `<button class="iconbtn press" data-act="rmdel" data-id="${esc(r.id)}" aria-label="刪掉">${icon("trash")}</button></div>`).join("") + `</div>`;
  else if (!RM.open) h += `<div class="empty"><div class="big">🔔</div><b>公車快到提醒</b><p>公車剩幾分鐘到你的站時跳通知，App 關著也會提醒。</p></div>`;
  if (RM.open) {
    const tile = (on, act, data, t) => `<button class="tile press" aria-pressed="${on}" data-act="${act}" ${data}>${t}</button>`;
    h += `<div class="card" style="margin-top:12px"><div class="remlab" style="margin-top:0">哪一班</div><div class="cardlist" style="padding:0">` +
      favs.map((f, i) => `<button class="rowlink press${i === RM.fav ? " on" : ""}" data-act="rmfav" data-i="${i}"><span class="row" style="min-width:0">${badge(f.route, "sm")}<span class="w"><b>${esc(f.alias || f.name)}</b><span>${f.to ? "往 " + esc(f.to) : ""}</span></span></span>` +
        `${i === RM.fav ? icon("star", "sel") : ""}</button>`).join("") + `</div>` +
      `<div class="remlab">剩幾分鐘通知</div><div class="tiles" style="grid-template-columns:repeat(4,1fr)">` + RM_MINS.map(m => tile(m === RM.min, "rmmin", `data-m="${m}"`, `${m} 分`)).join("") + `</div>` +
      `<div class="remlab">什麼時候</div><div class="tiles two">` + [["once", `這一次（${RM_HOURS} 小時內）`], ["daily", "每天固定時段"]].map(([k, n]) => tile(k === RM.kind, "rmkind", `data-k="${k}"`, n)).join("") + `</div>`;
    if (RM.kind === "daily") h += `<div class="remlab">星期幾</div><div class="tiles" style="grid-template-columns:repeat(7,1fr)">` +
      [1, 2, 3, 4, 5, 6, 0].map(d => tile(RM.days.includes(d), "rmday", `data-d="${d}"`, WEEK_ZH[d])).join("") + `</div>` +
      `<div class="remlab">時段</div><div class="chips"><label class="chip pick">${esc(RM.start)} 開始<input type="time" id="rm-start" value="${RM.start}" aria-label="開始"></label>` +
      `<label class="chip pick">${esc(RM.end)} 結束<input type="time" id="rm-end" value="${RM.end}" aria-label="結束"></label></div>`;
    h += `<div class="btns" style="margin-top:14px"><button class="btn press" data-act="rmadd" style="flex:1">${icon("bell")}開始提醒</button><button class="btn ghost press" data-act="rmcancel">取消</button></div></div>`;
  } else if (favs.length) h += `<button class="btn block press" data-act="rmopen" style="margin-top:12px">${icon("plus")}加提醒</button>`;
  else h += `<div class="note">先在「附近」或「查路線」把站牌加到常用，才能設提醒。</div>`;
  const warn = [];
  if (!BusBridge.notifyOk()) warn.push("通知被關掉了：到手機設定 → 應用程式 → 公車 → 通知 打開");
  if (!BusBridge.batteryOk()) warn.push(`電池不是「不受限制」：螢幕關著、App 沒開時可能不會提醒 <button class="textbtn" data-act="rmbat">去設定</button>`);
  if (warn.length && (list.length || RM.open)) h += `<div class="note">${warn.join("<br>")}</div>`;
  box.innerHTML = h;
}

// 時間欄位改了先記起來，重畫方塊上的字
document.addEventListener("change", ev => {
  if (ev.target.id === "rm-start") { RM.start = ev.target.value; renderRemind(); }
  if (ev.target.id === "rm-end") { RM.end = ev.target.value; renderRemind(); }
});
