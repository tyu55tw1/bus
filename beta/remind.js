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

function renderRemind() {
  const box = $("#remind-box");
  if (!box) return;
  if (!window.BusBridge) { box.innerHTML = ""; return; }
  if (!canRemind()) {
    box.innerHTML = `<div class="card"><h3>🔔 公車快到提醒</h3><p class="muted">要先更新公車 App 到 1.4 版（我的助手「📱 主畫面小工具」下載）才能用。</p></div>`;
    return;
  }
  const list = rmList(), favs = rmBusFavs();
  let h = `<div class="card"><h3>🔔 公車快到提醒</h3>`;
  if (!list.length && !RM.open) h += `<p class="muted">公車剩幾分鐘到你的站時跳通知，App 關著也會提醒。</p>`;
  h += list.map(r => `<div class="row"><span><b>${esc(r.route)}</b> ${esc(r.name)}<br><span class="sub">${esc(rmDesc(r))}</span></span>` +
    `<button class="star dot" data-act="rmdel" data-id="${esc(r.id)}" title="刪掉">🗑️</button></div>`).join("");
  if (RM.open) {
    h += `<div class="rmform"><label class="fl">哪一班<select id="rm-fav">` +
      favs.map((f, i) => `<option value="${i}" ${i === RM.fav ? "selected" : ""}>${esc(f.route)} ${esc(f.name)}${f.to ? "（往 " + esc(f.to) + "）" : ""}</option>`).join("") +
      `</select></label>` +
      `<div class="chips"><span class="sub">剩</span>` + RM_MINS.map(m => `<button class="small ${m === RM.min ? "on" : ""}" data-act="rmmin" data-m="${m}">${m} 分</button>`).join("") + `<span class="sub">通知</span></div>` +
      `<div class="chips">` + [["once", `這一次（${RM_HOURS} 小時內）`], ["daily", "每天固定時段"]].map(([k, n]) => `<button class="small ${k === RM.kind ? "on" : ""}" data-act="rmkind" data-k="${k}">${n}</button>`).join("") + `</div>`;
    if (RM.kind === "daily") h += `<div class="chips">` + [1, 2, 3, 4, 5, 6, 0].map(d => `<button class="small ${RM.days.includes(d) ? "on" : ""}" data-act="rmday" data-d="${d}">${WEEK_ZH[d]}</button>`).join("") + `</div>` +
      `<div class="trow"><input type="time" id="rm-start" value="${RM.start}"><span class="sub">到</span><input type="time" id="rm-end" value="${RM.end}"></div>`;
    h += `<div class="btns"><button class="primary" data-act="rmadd">開始提醒</button><button data-act="rmcancel">取消</button></div></div>`;
  } else if (favs.length) h += `<div class="btns"><button data-act="rmopen">＋ 加提醒</button></div>`;
  else h += `<p class="muted">先在「📍 附近」或「🔍 路線」把站牌加到常用，才能設提醒。</p>`;
  const warn = [];
  if (!BusBridge.notifyOk()) warn.push("通知被關掉了：到手機設定 → 應用程式 → 公車 → 通知 打開");
  if (!BusBridge.batteryOk()) warn.push(`電池不是「不受限制」：螢幕關著、App 沒開時可能不會提醒 <button class="small" data-act="rmbat">去設定</button>`);
  if (warn.length && (list.length || RM.open)) h += `<div class="warn">${warn.join("<br>")}</div>`;
  h += `</div>`;
  box.innerHTML = h;
}

// 時間欄位改了先記起來（重畫不會被蓋回去）
document.addEventListener("change", ev => {
  if (ev.target.id === "rm-fav") RM.fav = +ev.target.value;
  if (ev.target.id === "rm-start") RM.start = ev.target.value;
  if (ev.target.id === "rm-end") RM.end = ev.target.value;
});
