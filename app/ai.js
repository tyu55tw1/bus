// 公車手機版・💬 問 AI（第 4 步，2026-11-28）：用聊天的方式問交通
// 照電腦版 chat.py：用使用者自己的 Gemini 免費金鑰（設定頁輸入、只存這支手機；網頁直接呼叫 Google，有 CORS）。
// AI 只能透過工具拿資料（trip.js 的找地點、路線規劃、計程車估算），回答裡的時間、分鐘、元這些數字逐一比對工具結果，
// 對不上就叫 AI 重答一次，再對不上就改成「查不到確定的資料」（不讓 AI 自己編）。對話只在記憶體，關掉 App 就清掉。
// 手機版先做 find_place、plan_trip、taxi_estimate、remember；公車到站、天氣、最晚一班、出門提醒之後再加。
"use strict";
const AI_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"];   // 前面的忙線或下架就換下一個
const AI_API = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const AI_KEY = "busphone.ai";      // 今天問了幾句（免費額度別被用光）
const AI_PER_DAY = 100, AI_ROUNDS = 6, AI_TDX = 3;
const AI = {open: false, busy: false, msgs: [], hist: [], reg: {}};
const WEEK_ZH = "日一二三四五六";
const AI_FALLBACK = "這個我查不到確定的資料（不想亂講時間或票價 🙏）。可以換個說法再問一次，或用上面的「想去哪？」直接查。";

const WHERE = {type: "string", description: "地點：HERE=使用者的出發點、HOME=家、WORK=公司、find_place 回傳的 id（P 開頭），或直接寫地名"};
const AI_TOOLS = [
  {name: "find_place", description: "找地點（店名、地名、地址、車站）。回傳候選（離起點近的在前）和 best；ambiguous=true 表示有好幾個差不多的，要請使用者選，不要自己挑。",
    parameters: {type: "object", properties: {q: {type: "string", description: "要找的地點，例如「家樂福」「台北車站」「成大醫院」"}, near: WHERE}, required: ["q"]}},
  {name: "plan_trip", description: "規劃大眾運輸怎麼去（公車、火車、捷運），回傳 2～3 種走法：幾點出門 leave_at、幾點到 arrive、轉乘幾次、走路幾分；沒有大眾運輸時有計程車估價 taxi。",
    parameters: {type: "object", properties: {to: WHERE, from: WHERE,
      prefer: {type: "string", enum: ["fastest", "fewest_transfers", "least_walk"], description: "最快到／最少轉乘（不想轉車）／最少走路"},
      depart: {type: "string", description: "幾點出發 HH:MM（不給＝現在）"}}, required: ["to"]}},
  {name: "taxi_estimate", description: "計程車估價（費用範圍、約幾分鐘、幾公里；都是估算）。",
    parameters: {type: "object", properties: {to: WHERE, from: WHERE}, required: ["to"]}},
  {name: "remember", description: "記住使用者的家、公司或偏好（存在他的手機）。kind=home/work 要給 place；kind=pref 給 text（例如「不喜歡轉車」）；kind=forget_pref 刪掉一個偏好。",
    parameters: {type: "object", properties: {kind: {type: "string", enum: ["home", "work", "pref", "forget_pref"]}, place: WHERE, text: {type: "string"}}, required: ["kind"]}},
];

class AskUser extends Error { constructor(out) { super("ask"); this.out = out; } }

function pid(p) {   // 同一個地點同一個 id（名字＋座標）
  let h = 5381;
  for (const c of `${p.name}|${(+p.lat).toFixed(5)}|${(+p.lon).toFixed(5)}`) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return "P" + h.toString(16).padStart(8, "0").slice(-5);
}
const plOut = p => ({id: p.id || pid(p), name: p.name, addr: p.addr || "", ll: [+(+p.lat).toFixed(5), +(+p.lon).toFixed(5)]});
const hmOf = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

// ── 工具 ──
async function aiFind(q, near, ctx) {
  const rows = await findPlaces(q, near ? [near.lat, near.lon] : null);
  let k = nq(q);
  for (const w of ["最近的", "最近", "附近的", "附近"]) k = k.replace(w, "");
  let hit = rows.filter(p => k && (nq(p.name).includes(k) || (nq(p.name).length >= 2 && k.includes(nq(p.name)))));
  const exact = hit.filter(p => nq(p.name) === k);
  if (exact.length) hit = exact;
  let cand = (hit.length ? hit : rows).slice(0, 6);
  const ds = cand.map(p => p.dist).filter(d => d != null);
  if (ds.length) { const far = Math.min(...ds) * 2 + 3000; cand = cand.filter(p => p.dist == null || p.dist <= far); }
  cand.forEach(p => { p.id = pid(p); AI.reg[p.id] = p; });
  const out = {query: q, near: near ? near.name : "", places: cand.map(p => ({...plOut(p), dist_m: p.dist})), best: null, ambiguous: false};
  if (!cand.length) { out.note = "找不到這個地點，請使用者換個說法（加縣市或路名）或打地址"; return out; }
  const a = cand[0];
  const others = cand.slice(1).filter(p => meters(a.lat, a.lon, p.lat, p.lon) > (nq(p.name) === nq(a.name) ? 1500 : 400));
  if (others.length && (!hit.length || a.dist == null || others[0].dist == null)) out.ambiguous = true;
  else if (others.length) out.ambiguous = others[0].dist - a.dist < Math.max(300, a.dist * .25);
  if (!out.ambiguous) out.best = a.id; else out.note = "有好幾個差不多的，請使用者點畫面上的按鈕選一個";
  return out;
}

async function aiWhere(ref, ctx, def = "HERE") {
  ref = String(ref || def).trim();
  const up = ref.toUpperCase();
  if (["HERE", "ORIGIN", "目前位置", "這裡", "我這裡"].includes(up)) {
    if (!ctx.origin) throw new Error("還不知道使用者在哪裡（定位沒開），請他打出發地點，或設定家");
    return ctx.origin;
  }
  const D = DB.data;
  if (up === "HOME" || ["家", "我家", "回家"].includes(ref)) {
    if (!D.home?.lat) throw new Error("使用者還沒設定家，請他說家在哪裡（可以用 remember 記住）");
    return {name: "家", lat: +D.home.lat, lon: +D.home.lon};
  }
  if (up === "WORK" || ["公司", "上班的地方"].includes(ref)) {
    if (!D.work?.lat) throw new Error("使用者還沒設定公司，請他說公司在哪裡（可以用 remember 記住）");
    return {name: "公司", lat: +D.work.lat, lon: +D.work.lon};
  }
  if (/^P[0-9a-f]{5}$/.test(ref)) {
    if (AI.reg[ref]) return AI.reg[ref];
    throw new Error("這個地點 id 已經失效，請用 find_place 重新找");
  }
  const out = await aiFind(ref, ctx.origin || (D.home?.lat ? {name: "家", lat: +D.home.lat, lon: +D.home.lon} : null), ctx);
  if (out.best) return AI.reg[out.best];
  ctx.turn.push(["find_place", out]);
  throw new AskUser(out);
}

function taxiShort(o, d) {
  const t = taxi(o, d);
  return {lo: t.lo, hi: t.hi, min: t.min, km: t.km, night: t.night, note: "估算"};
}

async function tPlan(args, ctx) {
  const o = await aiWhere(args.from, ctx), d = await aiWhere(args.to, ctx);
  const now = new Date(), straight = meters(o.lat, o.lon, d.lat, d.lon);
  const out = {from: o.name, to: {...plOut(d), name: d.name}, now: hmOf(now), straight_m: straight,
    walk: {min: Math.max(1, Math.round(straight * 1.25 / WALK_M_MIN)), near: straight <= WALK_NEAR}, plans: [], _o: o, _d: d};
  if (straight < 60) { out.note = "已經在目的地附近（不到 60 公尺）"; return out; }
  out.taxi = taxiShort(o, d);
  if (straight <= NO_TRANSIT) { out.note = "很近，建議走路"; return out; }
  let when = new Date(now.getTime() + 60e3);
  const m = String(args.depart || "").match(/^(\d{1,2}):(\d{2})$/);
  if (m && +m[1] < 24 && +m[2] < 60) {
    const t = new Date(now); t.setHours(+m[1], +m[2], 0, 0);
    when = t > when ? t : new Date(t.getTime() + 86400e3);
    out.depart = `${when.getMonth() + 1}/${when.getDate()} ${hmOf(when)}`;
  }
  if (ctx.tdx >= AI_TDX) throw new Error("這一句已經查很多次即時資料了（TDX 免費金鑰每分鐘次數有限），先用前面查到的結果回答");
  ctx.tdx++;
  let ps;
  try { ps = await plans(o, d, when); } catch (e) {
    if (/頻繁|429/.test(e.message)) { out.busy = true; out.plans = null; out.note = "即時資料來源忙線，請使用者 10 秒後再問一次"; return out; }
    throw e;
  }
  const want = {fastest: "最快到", fewest_transfers: "最少轉乘", least_walk: "最少走路"}[args.prefer] ||
    (/轉車|轉乘/.test((DB.data.aiPrefs || []).join("")) ? "最少轉乘" : /走路/.test((DB.data.aiPrefs || []).join("")) ? "最少走路" : "最快到");
  ps.sort((a, b) => !a.tags.includes(want) - !b.tags.includes(want));
  out.prefer = want;
  out.plans = ps.map((p, i) => {
    const k = p.legs.findIndex(l => l.kind !== "walk" && l.kind !== "wait"), f = p.legs[k];
    const before = p.legs.slice(0, Math.max(k, 0)).filter(l => l.kind === "walk").reduce((a, l) => a + l.min, 0);
    const leave = f ? new Date(new Date(f.start).getTime() - before * 60e3) : new Date(p.start);
    const r = {no: i + 1, tags: p.tags, leave_at: hmOf(leave), leave_in_min: Math.floor((leave - now) / 60e3), arrive: hm(p.end),
      ride: fmtMin(p.min), transfers: p.transfers, walk_min: p.walk, summary: p.summary};
    if (f) r.first = {type: f.label, line: f.line, board_stop: f.from, board_at: hm(f.start), walk_to_stop_min: before};
    return r;
  });
  if (out.plans.length && out.plans.every(p => p.leave_in_min < -1)) out.note = "查到的班次都剛開走了，請使用者點「看路線」重查";
  if (want === "最少轉乘" && out.plans[0]?.transfers > 0) out.note = `沒有不用轉車的走法，最少要轉 ${out.plans[0].transfers} 次`;
  if (!ps.length) {
    const late = now.getHours() >= 21 || now.getHours() < 6;
    out.note = (late ? "這個時間查不到大眾運輸走法（晚上可能已經收班；明天早上再查會有）" : "查不到到這裡的大眾運輸走法（目的地附近可能沒有公車或火車站）") + "，可以坐計程車（taxi 是估價）";
  }
  return out;
}

async function tRemember(args, ctx) {
  const D = DB.data;
  if (args.kind === "home" || args.kind === "work") {
    const p = await aiWhere(args.place, ctx);
    D[args.kind] = {name: p.name, lat: p.lat, lon: p.lon, q: p.addr || p.name};
    save(); renderTrip();
    return {ok: true, saved: args.kind, name: p.name};
  }
  D.aiPrefs = Array.isArray(D.aiPrefs) ? D.aiPrefs : [];
  const t = String(args.text || "").trim().slice(0, 40);
  if (!t) return {ok: false, note: "沒有內容"};
  if (args.kind === "pref") { if (!D.aiPrefs.includes(t)) D.aiPrefs.push(t); D.aiPrefs = D.aiPrefs.slice(-10); }
  else D.aiPrefs = D.aiPrefs.filter(x => !x.includes(t) && !t.includes(x));
  save();
  return {ok: true, prefs: D.aiPrefs};
}

async function runTool(name, args, ctx) {
  try {
    let r;
    if (name === "find_place") r = await aiFind(String(args.q || ""), args.near ? await aiWhere(args.near, ctx) : ctx.origin, ctx);
    else if (name === "plan_trip") r = await tPlan(args, ctx);
    else if (name === "taxi_estimate") { const o = await aiWhere(args.from, ctx), d = await aiWhere(args.to, ctx); r = {from: o.name, to: d.name, taxi: taxiShort(o, d), _o: o, _d: d}; }
    else if (name === "remember") r = await tRemember(args, ctx);
    else r = {error: "沒有這個工具"};
    ctx.turn.push([name, r]);
    return r;
  } catch (e) {
    if (e instanceof AskUser) return e.out;
    return {error: e.message};
  }
}
// 給 AI 看的工具結果：拿掉 _ 開頭（程式自己要用的座標）
const forAi = r => JSON.parse(JSON.stringify(r, (k, v) => k.startsWith("_") ? undefined : v));

// ── 數字檢查（電腦版 check_numbers）──
const RX_TIME = /(?<!\d)(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)/g;
const RX_TIME_ZH = /(上午|早上|中午|下午|晚上|半夜|凌晨)?\s*(\d{1,2})\s*點\s*(?:(\d{1,2})\s*分|半)?/g;
const RX_NUM = /\d+(?:\.\d+)?/g;
const normNum = s => String(+s);
function checkNumbers(reply, texts) {
  const times = new Set(), nums = new Set(), bad = [];
  for (const t of texts) {
    for (const m of t.matchAll(RX_TIME)) times.add(`${p2(+m[1])}:${m[2]}`);
    for (const m of t.matchAll(RX_NUM)) nums.add(normNum(m[0]));
  }
  for (const m of reply.matchAll(RX_TIME)) if (!times.has(`${p2(+m[1])}:${m[2]}`)) bad.push(m[0]);
  let rest = reply.replace(RX_TIME, " ");
  for (const m of rest.matchAll(RX_TIME_ZH)) {
    const h = +m[2], mi = m[3] ? +m[3] : m[0].includes("半") ? 30 : 0;
    const c = [`${p2(h)}:${p2(mi)}`, `${p2((h + 12) % 24)}:${p2(mi)}`];
    if (m[3] || m[0].includes("半")) { if (!c.some(x => times.has(x))) bad.push(m[0].trim()); }
    else if (![...times].some(t => t.startsWith(p2(h) + ":") || t.startsWith(p2((h + 12) % 24) + ":")) && !nums.has(String(h))) bad.push(m[0].trim());
  }
  rest = rest.replace(RX_TIME_ZH, " ");
  for (const m of rest.matchAll(RX_NUM)) {
    const n = normNum(m[0]);
    if (n.replace(".", "").length > 1 && !nums.has(n)) bad.push(m[0]);
  }
  return bad;
}

function aiSystem(ctx) {
  const n = new Date(), D = DB.data, prefs = D.aiPrefs || [];
  return [
    "你是「公車 App」裡的交通小幫手，幫使用者查怎麼去、幾點出門、計程車大概多少。用繁體中文（台灣用語）回答，口氣親切、簡短：最多 4～5 行，不要 Markdown 標題、不要表格、不要用 ** 粗體。",
    `現在時間：${dayIso(0)}（星期${WEEK_ZH[n.getDay()]}）${hmOf(n)}。`,
    `出發點 HERE：${ctx.origin ? ctx.origin.name : "還不知道（定位沒開）"}。家 HOME：${D.home?.lat ? "已設定" : "還沒設定"}。公司 WORK：${D.work?.lat ? "已設定" : "還沒設定"}。`,
    `使用者的偏好：${prefs.length ? prefs.join("、") : "沒有"}。`,
    "規則（一定要遵守）：",
    "1. 時間、幾分鐘、班次、票價、車資、路線號碼：只能用這次對話裡工具回傳的資料，原樣照抄。不可以自己估、自己加減、自己編。工具沒給就說「查不到」。",
    "2. 問到交通、路線就一定先呼叫工具，不要憑記憶回答。",
    "3. 地點：用 find_place 找（或直接把地名放進 plan_trip 的 to）。回傳 ambiguous=true 時不要自己挑，簡短請使用者點畫面上的按鈕選。「最近的 X」有 best 就直接用 best。",
    "4. 接著問的時候沿用前面的地點 id：「不想轉車呢？」→ plan_trip 同樣的 to、prefer=fewest_transfers；「少走路」→ prefer=least_walk。",
    "5. 規劃結果先講第一個走法（plans[0]，已經照偏好排好）：搭什麼、幾點出門（leave_at，或「再 leave_in_min 分鐘出門」）、幾點到（arrive）；其他走法一句帶過。leave_in_min 小於 0 就說這班趕不上、請他看下一班。",
    "6. plans 是空的、或很遠沒有大眾運輸：說計程車估價（taxi 的 lo～hi 元、約 min 分鐘），講明是估算。busy=true 是資料來源忙線，請他 10 秒後再問一次。",
    "7. 不要講座標、id、英文欄位名。畫面會自動附上「看路線」「Google 地圖」等按鈕，可以說「點下面的按鈕」。",
    "8. 跟交通、出門無關的問題：禮貌一句帶過（不要回答內容），再問他想去哪裡。公車幾分到、天氣這些手機版還不能問，請他用常用、附近、路線分頁看。",
    "9. 使用者說「記住我家在…」「我不喜歡轉車」這類話就用 remember。",
  ].join("\n");
}

async function gemini(contents, system) {
  const key = DB.settings.gemKey;
  if (!key) throw new Error("先到 ⚙️ 設定輸入 Gemini 金鑰，才能問 AI。");
  const body = JSON.stringify({systemInstruction: {parts: [{text: system}]}, contents, tools: [{functionDeclarations: AI_TOOLS}],
    generationConfig: {temperature: 0.2, maxOutputTokens: 700}});
  let last = "", wait = 0;
  for (const m of AI_MODELS) {
    try {
      const r = await fetch(AI_API(m), {method: "POST", headers: {"x-goog-api-key": key, "Content-Type": "application/json"}, body});
      if (!r.ok) {
        last = "HTTP " + r.status;
        // 1.4：429 要等幾秒（Retry-After 標頭，或回應裡的 RetryInfo.retryDelay「37s」），沒有就 60 秒 → 畫面倒數
        if (r.status === 429) {
          let s = +r.headers.get("Retry-After") || 0;
          if (!s) try { s = Math.ceil(parseFloat(JSON.stringify(await r.json()).match(/"retryDelay":"([\d.]+)s"/)?.[1]) || 0); } catch (e) { /* 沒寫 */ }
          wait = Math.max(wait, s || 60);
        }
        if ([404, 429, 500, 503].includes(r.status)) continue;
        if (r.status === 400 || r.status === 403) throw new Error("Gemini 金鑰不對或沒開權限（到 ⚙️ 設定重新輸入）");
        break;
      }
      const c = (((await r.json()).candidates || [])[0] || {}).content || {};
      if (c.parts?.length) { c.role = "model"; return c; }
      last = "回了空白";
    } catch (e) {
      if (/金鑰/.test(e.message)) throw e;
      last = e.message;
    }
  }
  throw new Error(wait ? `AI 免費額度暫時用完了（${wait} 秒）`
    : /429/.test(last) ? "AI 免費額度暫時用完了（Google 那邊限流），等一下再問；路線一樣可以在「想去哪？」查。"
    : "AI 現在連不上，等一下再問；路線一樣可以在「想去哪？」查。");
}

function aiTake() {   // 一天最多問幾句（用使用者自己的免費額度）
  let u = {};
  try { u = JSON.parse(localStorage.getItem(AI_KEY) || "{}"); } catch (e) { /* 重算 */ }
  if (u.day !== dayIso(0)) u = {day: dayIso(0), n: 0};
  if (u.n >= AI_PER_DAY) return false;
  u.n++; localStorage.setItem(AI_KEY, JSON.stringify(u));
  return true;
}

async function aiAsk(text, show) {
  text = String(text || "").trim().slice(0, 300);
  if (!text || AI.busy) return;
  AI.retry = null; delete WAITS.ai;   // 新問題：取消上一題的倒數
  AI.msgs.push({who: "me", text: show || text});
  if (!aiTake()) { AI.msgs.push({who: "ai", text: `今天已經問了 ${AI_PER_DAY} 句，明天再問；路線一樣可以在「想去哪？」查。`}); return renderAi(); }
  AI.busy = true; renderAi();
  const ctx = {origin: null, turn: [], tdx: 0};
  try { const o = await tripOrigin(); ctx.origin = {name: o.name, lat: o.lat, lon: o.lon}; } catch (e) { /* 沒定位：AI 會請他說出發點 */ }
  const user = {role: "user", parts: [{text}]};
  let work = [...AI.hist, user];
  const keep = [user], system = aiSystem(ctx);
  let reply = "", retried = false;
  try {
    for (let i = 0; i < AI_ROUNDS; i++) {
      const c = await gemini(work, system);
      const calls = c.parts.filter(p => p.functionCall).map(p => p.functionCall);
      if (calls.length) {
        const resp = {role: "user", parts: []};
        for (const fc of calls.slice(0, 5)) {
          const r = await runTool(fc.name, fc.args || {}, ctx);
          resp.parts.push({functionResponse: {name: fc.name, response: {result: forAi(r)}, ...(fc.id ? {id: fc.id} : {})}});
        }
        work.push(c, resp); keep.push(c, resp);
        continue;
      }
      reply = c.parts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
      const src = [system, ...work.flatMap(x => x.parts.map(p => p.text && x.role === "user" ? p.text : p.functionResponse ? JSON.stringify(p.functionResponse.response) : "")).filter(Boolean)];
      const bad = reply ? checkNumbers(reply, src) : ["（空白）"];
      if (!bad.length) { keep.push({role: "model", parts: [{text: reply}]}); break; }
      if (retried) { reply = AI_FALLBACK; break; }
      retried = true;
      work = [...work, c, {role: "user", parts: [{text: `（系統檢查，不是使用者說的話）你的回答裡有工具結果沒有的數字：${bad.slice(0, 6).join("、")}。請先呼叫工具查，或只用工具結果裡的數字重新回答；查不到就說查不到。`}]}];
      reply = "";
    }
    reply = reply || AI_FALLBACK;
  } catch (e) {
    reply = e.message.replace(/（\d+ 秒）/, "");
    if (busySecs(e)) { AI.retry = {text, show, err: e}; reply += "，倒數完會自動再問一次；路線一樣可以在「想去哪？」查。"; }
  }
  if (keep[keep.length - 1].role !== "model") keep.push({role: "model", parts: [{text: reply}]});
  AI.hist = [...AI.hist, ...keep].slice(-40);
  while (AI.hist.length && !(AI.hist[0].role === "user" && AI.hist[0].parts.some(p => p.text))) AI.hist.shift();   // 開頭要是使用者說的話
  AI.msgs.push({who: "ai", text: reply, btns: aiButtons(ctx)});
  AI.busy = false; renderAi();
}

// 這一句查到的東西 → 回答下面的按鈕（選地點、看路線、Google 地圖、叫車）
function aiButtons(ctx) {
  const out = [];
  const ask = [...ctx.turn].reverse().find(([n, r]) => n === "find_place" && r.ambiguous)?.[1];
  const plan = [...ctx.turn].reverse().find(([n, r]) => (n === "plan_trip" || n === "taxi_estimate") && r._d)?.[1];
  if (ask && !plan) {
    for (const p of ask.places.slice(0, 5))
      out.push({t: p.name + (p.dist_m != null ? `・${p.dist_m >= 1000 ? (p.dist_m / 1000).toFixed(1) + " 公里" : p.dist_m + " 公尺"}` : "") +
          (p.addr ? `（${p.addr.replace(/^(臺|台)?..[市縣]/, "").slice(0, 10)}）` : ""),
        say: `去${p.name}（${p.addr}）[${p.id}]`, show: `去${p.name}` + (p.addr ? `（${p.addr.slice(0, 14)}）` : "")});
    return out;
  }
  if (plan) {
    out.push({t: "🗺️ 看路線", go: {name: plan._d.name, lat: plan._d.lat, lon: plan._d.lon}});
    out.push({t: "🌐 Google 地圖", href: gmaps(plan._o, plan._d, "transit")});
    if (plan.taxi && (!plan.plans?.length || plan.straight_m > 3000)) out.push({t: "🚕 叫車 55688", href: "tel:55688"});
  }
  return out;
}

// 1.4：畫面照電腦版 openChat（對話泡泡＋底部輸入列，app.js 的 openAi 推進頁）
const AI_SUGG = ["明天早上 8 點要到成大醫院，幾點出門？", "去最近的家樂福", "回家怎麼搭最快？", "記住我不喜歡轉車"];
function renderAi() {
  const box = $("#ai-box");
  if (!box) return;
  let h = "";
  if (!DB.settings.gemKey) h += `<div class="aihint">先按常用頁右上齒輪輸入 Gemini 金鑰（免費，aistudio.google.com 申請），才能問 AI。</div>`;
  if (!AI.msgs.length) h += `<div class="aihint">用說的查怎麼去：AI 會幫你查路線、公車幾分到、計程車大概多少錢。查到的數字都是 TDX 真的資料。</div>` +
    `<div class="chips sugg">` + AI_SUGG.map(t => `<button class="chip press" data-act="aisugg" data-t="${esc(t)}">${esc(t)}</button>`).join("") + `</div>`;
  AI.msgs.forEach((m, i) => {
    h += `<div class="msg ${m.who}"><div class="bub">${esc(m.text).replace(/\n/g, "<br>")}</div>`;
    if (m.btns?.length && i === AI.msgs.length - 1) h += `<div class="aibtns">` + m.btns.map((b, j) => b.href
      ? `<a class="btn sm ghost" href="${esc(b.href)}" target="_blank" rel="noopener">${esc(b.t)}</a>`
      : `<button class="btn sm ghost press" data-act="aibtn" data-j="${j}">${esc(b.t)}</button>`).join("") + `</div>`;
    h += `</div>`;
  });
  if (AI.busy) h += `<div class="msg ai"><div class="bub wait"><span class="spin"></span>查詢中…</div></div>`;
  else if (AI.retry) h += errBox("ai", AI.retry.err, () => { const r = AI.retry; AI.retry = null; if (r && AI.open) aiAsk(r.text, r.show); });   // 撞到上限倒數（app.js）
  if (AI.msgs.length && !AI.busy) h += `<div class="cap"><button class="textbtn" data-act="aiclear">清除對話</button></div>`;
  box.innerHTML = h;
  box.scrollTop = box.scrollHeight;
  const q = $("#ai-q"), s = $("[data-act=aisend]");
  if (q) q.disabled = AI.busy;
  if (s) s.disabled = AI.busy;
}

function aiBtn(j) {
  const b = AI.msgs[AI.msgs.length - 1]?.btns?.[j];
  if (!b) return;
  if (b.say) return aiAsk(b.say, b.show);
  if (b.go) { showPlan(); tripGo(b.go); }   // 1.4：想去哪在查路線分頁的「路線規劃」
}

// 設定頁的 Gemini 金鑰（app.js 的 renderSet 會插這張卡）
function aiSetCard() {
  let u = {};
  try { u = JSON.parse(localStorage.getItem(AI_KEY) || "{}"); } catch (e) { /* 沒有 */ }
  return `<div class="card"><h3>🤖 Gemini 金鑰（問 AI 用）</h3><p class="muted">只存在這支手機，不會上傳。到 aistudio.google.com「Get API key」免費申請。` +
    `今天問了 ${u.day === dayIso(0) ? u.n : 0} 句（一天最多 ${AI_PER_DAY} 句）。</p>` +
    `<label>API 金鑰<input type="password" id="gem-key" autocomplete="off" value="${esc(DB.settings.gemKey)}"></label>` +
    `<div class="btns"><button class="primary" data-act="savegem">存起來</button><button data-act="testgem">測試金鑰</button></div>` +
    `<p class="muted" id="gem-test">測試金鑰不會用掉每天的問 AI 次數。</p></div>`;
}
/** 1.3（2026-11-28 使用者：「公車沒測試金鑰」）：只列模型清單，不叫 Gemini 回答，不吃免費次數（跟行事曆手機版一樣） */
async function testGemKey() {
  const key = $("#gem-key").value.trim(), out = $("#gem-test");
  if (!key) { out.textContent = "先把金鑰貼進上面的格子。"; return; }
  out.textContent = "測試中…";
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {headers: {"x-goog-api-key": key}});
    out.textContent = r.ok ? "✅ 金鑰可以用！記得按「存起來」。"
      : r.status === 400 ? "❌ 金鑰不對：重新複製一次，前後不要多空白。"
      : r.status === 403 ? "❌ 這把金鑰沒有開 Gemini 權限，或已經被停用：到 aistudio.google.com/apikey 換一把。"
      : r.status === 429 ? "⏳ 金鑰是對的，但現在查太頻繁，等一下再試。"
      : `❓ Gemini 回了 ${r.status}，等一下再試。`;
  } catch (err) {
    out.textContent = "📶 連不到 Gemini：看看有沒有網路。";
  }
}
