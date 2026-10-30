// DeepSeek chat client (copy of the K2 client). Chats live on the laptop, so the phone and laptop share history live.
// Same shape as the baseline: esc() before md(), render functions, api(), stream(), poll().
// Added: lock and setup gate, offline page, keep/rename/delete, temporary chats, edit and resend, settings.
"use strict";
const THINK_END = "</ifm|think>";
const OFFLINE_MSG = "Can’t reach your laptop. Is it awake, with Tailscale on?";
const OFFLINE_SHORT = "Can’t reach your laptop.";
const NO_ANSWER ="No answer. The model ran out of room while thinking.";
const SP_MAX = 2000, MIN_PASS = 8, HOUR = 3600 * 1000;

const svg = (body, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  send: svg('<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>', 2.2),
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="24" height="24" rx="4"/></svg>',
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9"/>'),
  retry: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>'),
  edit: svg('<path d="M15.6 4.6a2 2 0 0 1 2.8 2.8L8 17.8 4 19l1.2-4Z"/><path d="M13.5 6.7l2.8 2.8"/>'),
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  chevDown: svg('<path d="m6 9 6 6 6-6"/>', 2.4),
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>',
  pin: svg('<path d="M9 3.5h6l-1 5.5 3.5 3.5v1.5h-11v-1.5L10 9Z"/><path d="M12 14v6.5"/>', 2.2),
  pinOff: svg('<path d="M9 3.5h6l-1 5.5 3.5 3.5v1.5h-11v-1.5L10 9Z"/><path d="M12 14v6.5M3.5 3.5l17 17"/>'),
  rename: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="M13 20h7"/>'),
  trash: svg('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>'),
  temp: svg('<circle cx="12" cy="12" r="8" stroke-dasharray="3 2.6"/>', 2.2),
  mark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M8 2.2v11.6M2.97 5.1l10.06 5.8M2.97 10.9l10.06-5.8"/></svg>',
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.7 3.4M6.4 7.6C3.9 9.3 2.5 12 2.5 12S6 18 12 18a9 9 0 0 0 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 2.4),
  dots: '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>',
};

const SUGGESTIONS = [
  "Explain how WireGuard works, simply",
  "Give me 5 weekend project ideas for an ML student",
  "Write a short, blunt cold email template",
  "Quiz me on probability with 3 questions",
];

const $ = s => document.querySelector(s);
const thread = $("#thread"), input = $("#input"), sendBtn = $("#send"), form = $("#form"), gate = $("#gate"), app = $("#app");
const wideMQ = matchMedia("(min-width: 1160px)");
const sidebarMQ = matchMedia("(min-width: 980px)");
const dialogMQ = matchMedia("(min-width: 720px)");
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
const fine = matchMedia("(pointer: fine)");
const touch = matchMedia("(hover: none)").matches;

let chats = [];          // chat summaries for the drawer
let chat = null;         // the open chat: {id, title, messages, stream, keep, temp}
let local = null;        // the reply this device is streaming: {chat, raw, start, thinkMs, row, frame, ctrl, ...}
let ver = { v: -1, lv: -1 }; // server change counters. lv: list, settings, lock. v: also every token.
let pollTimer = null;
let settings = { retention_hours: 24, auto_lock_min: 30, system_prompt: "", choices: [1, 24, 168, 720, 0], auto_lock_choices: [5, 15, 30, 60, 0] };
const openThinks = new Map(); // thinking panels the user toggled, kept across re-renders
const thinkTimes = new Map(); // "chatId:index" -> ms thought, for replies stopped before thinking ended (no thinkMs saved)
let edit = null;         // {index, saved}: the user message being edited, and the composer text it replaced
let shownActions = null; // earlier user message whose actions were revealed by a tap
let tempMode = false;    // the next new chat is temporary
let notice = null;       // {chatId, text, kind, text2}: an error box at the end of the thread
let screen = "boot";     // boot | app | gate | offline
let gateMode = null;     // lock | setup
let offline = false;
let warmed = false;
let lastActive = Date.now();

let currentId = null;
try { currentId = localStorage.getItem("k2-current"); } catch {}
const saveCurrent = () => { try { currentId ? localStorage.setItem("k2-current", currentId) : localStorage.removeItem("k2-current"); } catch {} };

// ---------- markdown (all text is HTML-escaped first, so model output can’t inject markup) ----------
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const RE = {
  fence: /^\s*```/,
  heading: /^(#{1,6})\s+(.*)$/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s*&gt;\s?/,
  item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};

function inline(s) {
  const codes = [], links = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => {
    links.push(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    return "\u0001" + (links.length - 1) + "\u0001";
  });
  s = s.replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/__(?=\S)([^_]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_(?=\S)([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([^~]+?)~~/g, "<del>$1</del>");
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[i]);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[i] + "</code>");
}

const isTable = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]);
function isBlockStart(lines, i) {
  const l = lines[i];
  return RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.item.test(l) || isTable(lines, i);
}

// Takes already-escaped lines.
function blocks(lines) {
  const out = [];
  let i = 0, m;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (RE.fence.test(line)) {
      // The language tag comes from escaped text and must match a short safe pattern, else it reads "code".
      const raw = (line.replace(RE.fence, "").trim().split(/\s+/)[0] || "").toLowerCase();
      const lang = /^[a-z0-9+#.-]{1,20}$/.test(raw) ? raw : "code";
      const buf = [];
      i++;
      while (i < lines.length && !RE.fence.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<div class="code"><div class="code-head"><span class="code-lang mono">' + lang + '</span><span class="code-btns"></span></div><pre><code>' + buf.join("\n") + "</code></pre></div>");
    } else if ((m = line.match(RE.heading))) {
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
    } else if (RE.hr.test(line)) {
      out.push("<hr>");
      i++;
    } else if (isTable(lines, i)) {
      const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<div class="tbl-w"><div class="tbl"><table><thead><tr>' + head.map(c => `<th><span class="cl">${c}</span></th>`).join("") + "</tr></thead><tbody>" +
        rows.map(r => "<tr>" + r.map(c => `<td><span class="cl">${c}</span></td>`).join("") + "</tr>").join("") + "</tbody></table></div></div>");
    } else if (RE.quote.test(line)) {
      const buf = [];
      while (i < lines.length && RE.quote.test(lines[i])) buf.push(lines[i++].replace(RE.quote, ""));
      out.push("<blockquote>" + blocks(buf) + "</blockquote>");
    } else if ((m = line.match(RE.item))) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const mm = l.match(RE.item);
        const indent = l.length - l.trimStart().length;
        if (mm && indent <= base + 1) {
          items.push({ text: inline(mm[3]), sub: [] });
          i++;
        } else if (l.trim() && indent > base && items.length) {
          items[items.length - 1].sub.push(l.slice(Math.min(indent, base + 2)));
          i++;
        } else if (!l.trim() && i + 1 < lines.length && (RE.item.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
          i++;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      const start = ordered && parseInt(m[2], 10) !== 1 ? ` start="${parseInt(m[2], 10)}"` : "";
      out.push(`<${tag}${start}>` + items.map(it => "<li>" + it.text + (it.sub.length ? blocks(it.sub) : "") + "</li>").join("") + `</${tag}>`);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines, i))) buf.push(inline(lines[i++].trim()));
      out.push("<p>" + buf.join("<br>") + "</p>");
    }
  }
  return out.join("");
}
const md = src => blocks(esc(src).split("\n"));

// ---------- helpers ----------
function split(raw) {
  const i = raw.indexOf(THINK_END);
  return i === -1 ? { thinking: raw.trim(), answer: "", done: false }
                  : { thinking: raw.slice(0, i).trim(), answer: raw.slice(i + THINK_END.length).trim(), done: true };
}
const titleFrom = text => { const t = text.replace(/\s+/g, " ").trim(); return t.length > 42 ? t.slice(0, 42) + "…" : t || "New chat"; };
const secs = ms => Math.max(1, Math.round(ms / 1000));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function txt(tag, cls, text) {
  const e = el(tag, cls);
  e.textContent = text;
  return e;
}
function button(cls, html, label, onClick) {
  const b = el("button", cls, html);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
const iconBtn = (icon, label, onClick, extra = "") => button("icon-btn sm " + extra, ICON[icon], label, onClick);

// Resolves true when the text reached the clipboard.
function copyText(text) {
  // navigator.clipboard needs a secure context; over plain http on the tailnet fall back to execCommand.
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => false);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return Promise.resolve(ok);
}
const copyToast = text => copyText(text).then(ok => toast(ok ? "Copied" : "Copy failed"));

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}
function announce(msg) {
  const l = $("#live");
  l.textContent = "";
  setTimeout(() => { l.textContent = msg; }, 30);
}

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function untilText(ts) {
  const m = (ts - Date.now()) / 60000;
  if (m < 1) return "<1m";
  if (m < 60) return Math.floor(m) + "m";
  if (m < 48 * 60) return Math.floor(m / 60) + "h";
  return Math.floor(m / 1440) + "d";
}
// One threshold, one colour, everywhere: under 2h left is attention.
const isSoon = ts => ts != null && ts - Date.now() < 2 * HOUR;

const RET_NAMES = { 1: "1 hour", 24: "24 hours", 168: "7 days", 720: "30 days", 0: "Never" };
const RET_SHORT = { 1: "1h", 24: "24h", 168: "7d", 720: "30d", 0: "Never" };
const LOCK_NAMES = { 5: "5 minutes", 15: "15 minutes", 30: "30 minutes", 60: "1 hour", 0: "Never" };
const LOCK_SHORT = { 5: "5m", 15: "15m", 30: "30m", 60: "1h", 0: "Never" };
const retShort = h => RET_SHORT[h] || h + "h";

const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
const toBottom = smooth => thread.scrollTo({ top: thread.scrollHeight, behavior: smooth && !reduced() ? "smooth" : "auto" });

function summaryFor(c) { return c && c.id ? chats.find(x => x.id === c.id) : null; }

// Expiry for a chat or a summary. Temp chats ignore `expires`.
function expiryOf(c) {
  if (!c || c.temp || c.keep) return null;
  const s = summaryFor(c);
  if (s && "expires" in s) return s.expires;
  if (c.expires !== undefined) return c.expires;
  return settings.retention_hours && c.updated ? c.updated + settings.retention_hours * HOUR : null;
}

// Header, actions sheet: `kept`, `deletes in 21h`, `temporary`. Returns a node or null.
function sublineNode(c, cls) {
  const s = summaryFor(c) || c;
  const n = el("span", cls);
  if (s.temp) { n.classList.add("accent"); n.innerHTML = ICON.temp; n.append("temporary"); return n; }
  if (s.keep) { n.innerHTML = ICON.pin; n.append("kept"); return n; }
  const exp = expiryOf(s);
  if (exp == null) return null;
  if (isSoon(exp)) { n.classList.add("accent"); n.appendChild(el("span", "dot")); }
  n.append(exp <= Date.now() ? "deleting" : "deletes in " + untilText(exp));
  return n;
}

// Adds code-block buttons and table edge fades to rendered markdown.
function finalize(box) {
  box.querySelectorAll(".code").forEach(block => {
    const btns = block.querySelector(".code-btns");
    const wrap = button("code-btn", null, null, () => { const on = block.classList.toggle("wrap"); wrap.textContent = on ? "Unwrap" : "Wrap"; });
    wrap.textContent = "Wrap";
    const copy = button("code-btn", null, null, async () => {
      if (await copyText(block.querySelector("code").textContent)) {
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1400);
      } else toast("Copy failed");
    });
    copy.textContent = "Copy";
    btns.append(wrap, copy);
  });
  requestAnimationFrame(() => box.querySelectorAll(".tbl").forEach(t => {
    const upd = () => t.parentNode.classList.toggle("over", t.scrollWidth - t.clientWidth - t.scrollLeft > 2);
    upd();
    t.addEventListener("scroll", upd, { passive: true });
  }));
  return box;
}

// ---------- server ----------
const JSON_H = { "Content-Type": "application/json" };
const isLockedRes = (status, data) => status === 423 || (status === 401 && data && data.error === "unlock");

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    const err = new Error(OFFLINE_MSG);
    err.offline = true;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch {}
  // 423: K2 is locked. 401 {"error":"unlock"}: this device has no session yet. Both show the lock screen.
  if (isLockedRes(res.status, data)) {
    enterLocked(!!(data && data.setup_needed));
    const err = new Error("locked");
    err.locked = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || (res.status === 404 ? "not found" : "Server returned " + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const post = (path, body = {}) => api(path, { method: "POST", headers: JSON_H, body: JSON.stringify(body) });

// For the gate: returns {ok, status, data} and never triggers enterLocked.
async function rawPost(path, body) {
  const res = await fetch(path, { method: "POST", headers: JSON_H, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

const friendly = err => err.offline || /load failed|failed to fetch|networkerror/i.test(err.message) ? OFFLINE_MSG : err.message;
// Toast for a failed action. Offline: the banner carries the long explanation, so the toast stays short.
function errToast(err) {
  if (err.locked) return;
  if (err.offline) { setOffline(true); toast(OFFLINE_SHORT); }
  else toast(friendly(err));
}

function setOffline(off) {
  if (off === offline) return;
  offline = off;
  $("#banner").hidden = !off;
  announce(off ? "Can’t reach your laptop. Retrying." : "Connected.");
  updateSend();
}

function warm() {
  // Loads the model before the first message.
  if (warmed || screen !== "app" || document.hidden) return;
  warmed = true;
  fetch("/api/warm", { method: "POST", headers: JSON_H, body: "{}" }).catch(() => { warmed = false; });
}

// ---------- rendering: thread ----------
function thinkNode(key, text, label) {
  const d = el("details", "think");
  d.open = openThinks.has(key) ? openThinks.get(key) : wideMQ.matches;
  const sum = el("summary", null, `<span class="mark">${ICON.mark}</span><span class="mono">${label}</span>${ICON.chev}`);
  const body = txt("div", "think-body", text);
  d.append(sum, body);
  // Wide margin notes clamp at 12 lines.
  if (text.split("\n").length > 12 || text.length > 520) {
    body.classList.add("clamp");
    const more = button("text-btn show-all", null, null, () => { body.classList.remove("clamp"); more.hidden = true; });
    more.textContent = "Show all";
    d.appendChild(more);
  }
  d.addEventListener("toggle", () => openThinks.set(key, d.open));
  return d;
}

// Phase-locks a repainted animation to the clock so it never restarts per token.
const phase = (node, period) => { if (node) node.style.animationDelay = -(performance.now() % period) + "ms"; };

// Fills `row` with an in-progress reply. `start` is a performance.now() timestamp.
function paintLive(row, key, raw, thinkMs, start, cold) {
  const { thinking, answer, done } = split(raw);
  row.textContent = "";
  const col = el("div", "t-col");
  const main = el("div", "a-main");
  if (!done) {
    const live = el("div", "think-live", `<span class="mark">${ICON.mark}</span><span class="mono shimmer">Thinking</span><span class="mono t-timer"></span>`);
    const timer = live.querySelector(".t-timer");
    timer.dataset.start = start;
    timer.textContent = ((performance.now() - start) / 1000).toFixed(1) + "s";
    phase(live.querySelector(".shimmer"), 2000);
    phase(live.querySelector(".mark svg"), 4000);
    col.appendChild(live);
    if (thinking) col.appendChild(txt("div", "think-tail", thinking.slice(-600)));
    if (cold && !raw) col.appendChild(txt("p", "cold", "Loading the model. The first reply after a restart is slow."));
  } else {
    col.appendChild(thinkNode(key, thinking, `Thought for ${secs(thinkMs || 0)}s`));
    if (answer) main.appendChild(el("div", "prose", md(answer)));
    else main.appendChild(el("span", "wait-dot"));
  }
  row.append(col, main);
}

function assistantNode(m, key, isLast) {
  const row = el("div", "msg a");
  const raw = m.raw || "";
  // Old saved replies without the end marker never finished thinking: show them as no answer.
  // A reply stopped during thinking also has no marker, but the user stopped it: Stop wins.
  const legacy = !!raw && !raw.includes(THINK_END) && !m.stopped;
  const { thinking } = split(raw);
  const content = legacy ? "" : m.content || "";
  const noAnswer = !content && !m.stopped;
  const col = el("div", "t-col");
  const tms = legacy ? 0 : m.thinkMs || thinkTimes.get(key) || 0;
  if (thinking) col.appendChild(thinkNode(key, thinking, tms ? `Thought for ${secs(tms)}s` : "Thought"));
  const main = el("div", "a-main");
  if (content) main.appendChild(finalize(el("div", "prose", md(content))));
  if (noAnswer) {
    main.appendChild(txt("p", "no-answer", NO_ANSWER));
    if (isLast) {
      const b = button("btn sm", ICON.retry + "Retry", null, retry);
      main.appendChild(b);
    }
  }
  if (m.stopped) main.appendChild(el("div", "status-line mono", '<span class="sq"></span>stopped'));
  if (m.truncated) main.appendChild(el("div", "status-line mono", '<span class="sq"></span>Cut off'));
  const acts = el("div", "a-acts");
  if (content) acts.appendChild(iconBtn("copy", "Copy", () => copyToast(content)));
  if (isLast && !noAnswer) acts.appendChild(iconBtn("retry", "Regenerate", retry));
  if (acts.childNodes.length) main.appendChild(acts);
  row.append(col, main);
  return row;
}

function userNode(m, i, lastUser) {
  const row = el("div", "msg u" + (i === lastUser || shownActions === i ? " acts-on" : "") + (edit && i > edit.index ? " dim" : ""));
  row.dataset.i = i;
  const b = txt("div", "bubble", m.content);
  b.addEventListener("click", () => {
    if (i === lastUser || String(window.getSelection())) return;
    shownActions = shownActions === i ? null : i;
    thread.querySelectorAll(".msg.u").forEach(r => r.classList.toggle("acts-on", +r.dataset.i === lastUser || +r.dataset.i === shownActions));
  });
  const a = el("div", "u-acts");
  a.appendChild(iconBtn("copy", "Copy", () => copyToast(m.content)));
  if (chat.id && !isStreaming()) a.appendChild(iconBtn("edit", "Edit", () => startEdit(i), "act-edit"));
  row.append(b, a);
  return row;
}

function noticeNode() {
  const box = el("div", "notice");
  box.setAttribute("role", "alert");
  box.appendChild(txt("span", null, notice.text));
  if (notice.kind) {
    const b = button("btn sm", null, null, retryNotice);
    b.textContent = "Retry";
    box.appendChild(b);
  }
  return box;
}

function retryNotice() {
  const n = notice;
  if (!n || isStreaming()) return;
  notice = null;
  if (n.kind === "regen") return retry();
  const text = input.value.trim() || n.text2 || "";
  if (!text) return renderThread();
  if (n.kind === "edit" && edit) return submitEdit(text);
  input.value = "";
  autosize();
  send(text);
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

function renderEmpty() {
  const wrap = el("div", "empty");
  const art = el("div", "empty-art");
  art.setAttribute("role", "img");
  art.setAttribute("aria-label", "Laptop and phone, linked");
  wrap.appendChild(art);
  wrap.appendChild(txt("div", "date mono", new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })));
  wrap.appendChild(txt("h1", null, greeting()));
  wrap.appendChild(txt("p", "lede", "Runs on your laptop. The model is DeepSeek via OpenRouter. " + (settings.retention_hours
    ? `Chats delete ${RET_NAMES[settings.retention_hours] || settings.retention_hours + " hours"} after the last message.`
    : "Chats stay until you delete them.")));
  if (notice && notice.chatId === null) wrap.appendChild(noticeNode());
  wrap.appendChild(txt("div", "label", "Start with"));
  const list = el("div", "starts");
  SUGGESTIONS.forEach((s, n) => {
    const c = button("start", null, null, () => { input.value = s; autosize(); updateSend(); input.focus(); });
    c.append(txt("span", "num mono", String(n + 1).padStart(2, "0")), txt("span", "txt", s));
    c.insertAdjacentHTML("beforeend", ICON.arrow);
    list.appendChild(c);
  });
  wrap.appendChild(list);
  thread.appendChild(wrap);
}

function renderHeader() {
  const title = $("#title"), sub = $("#subtitle"), btn = $("#title-btn");
  title.textContent = "";
  sub.textContent = "";
  sub.className = "mono";
  const isTemp = chat ? !!chat.temp : tempMode;
  document.body.classList.toggle("temp", isTemp && screen === "app");
  if (!chat || screen !== "app") {
    title.innerHTML = '<span class="wordmark">K<i>2</i></span>';
    if (tempMode && screen === "app") { sub.className = "mono accent"; sub.innerHTML = ICON.temp; sub.append("temporary"); }
  } else {
    title.appendChild(txt("span", null, chat.title));
    if (chat.id) title.insertAdjacentHTML("beforeend", ICON.chevDown);
    const s = sublineNode(chat, "");
    if (s) { sub.className = "mono " + s.className; sub.append(...s.childNodes); }
  }
  btn.disabled = !(chat && chat.id) || screen !== "app";
  // The name says which chat is open. The bare wordmark is decoration.
  if (chat && chat.id && screen === "app") btn.setAttribute("aria-label", `${chat.title}, chat options`);
  else btn.removeAttribute("aria-label");
  if (chat && chat.id && screen === "app") btn.setAttribute("aria-haspopup", "dialog");
  else btn.removeAttribute("aria-haspopup");
  const deco = (!chat || screen !== "app") && !(tempMode && screen === "app");
  if (deco) btn.setAttribute("aria-hidden", "true");
  else btn.removeAttribute("aria-hidden");
  $("#new").disabled = !chat && !tempMode;
}

function renderFooter() {
  const empty = !chat || (!chat.messages.length && !chat.stream && !(local && local.chat === chat));
  $("#temp-row").hidden = !(empty && !chat);
  $("#temp-switch").checked = tempMode;
  const strip = $("#edit-strip");
  strip.hidden = !edit;
  if (edit && chat) {
    const k = chat.messages.length - 1 - edit.index;
    $("#edit-text").textContent = k === 1 ? "Editing. The reply below is replaced."
      : k > 1 ? `Editing. The ${k} messages below are replaced.` : "Editing. Sends again.";
  }
  updateSend();
}

function renderThread() {
  if (screen === "offline") return;
  const top = thread.scrollTop;
  thread.textContent = "";
  renderHeader();
  renderFooter();
  const here = local && local.chat === chat;
  const isEmpty = !chat || (!chat.messages.length && !here && !chat.stream);
  document.body.classList.toggle("empty-state", screen !== "app" || isEmpty); // centered layouts drop the margin-note offset
  if (screen !== "app") return;
  if (isEmpty) {
    renderEmpty();
    onScroll();
    return;
  }
  const inner = el("div", "inner");
  let lastUser = -1;
  chat.messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  chat.messages.forEach((m, i) => {
    if (m.role === "user") inner.appendChild(userNode(m, i, lastUser));
    else {
      const row = assistantNode(m, `${chat.id}:${i}`, i === chat.messages.length - 1 && !chat.stream && !here);
      if (edit && i > edit.index) row.classList.add("dim");
      inner.appendChild(row);
    }
  });
  if (here) {
    inner.appendChild(local.row); // keep painting the same live element
  } else if (chat.stream) {
    // A reply streaming from another device, or from before this page loaded.
    const row = el("div", "msg a");
    paintLive(row, `${chat.id}:live`, chat.stream.raw, chat.stream.think_ms, performance.now() - (chat.stream.elapsed_ms || 0), false);
    inner.appendChild(row);
  }
  if (notice && notice.chatId === chat.id) inner.appendChild(noticeNode());
  thread.appendChild(inner);
  thread.scrollTop = top;
  onScroll();
}

// ---------- rendering: drawer ----------
let openRow = null;
let drawerDirty = false; // a rebuild was skipped while a row was open or being dragged
let rovingId = null;     // the row that holds the list's single tab stop
const SWIPE_W = 216;
const swipeW = row => row.querySelector(".crow-acts").offsetWidth || SWIPE_W;
function closeRow(r) {
  if (!r) return;
  r.classList.remove("open");
  const m = r.querySelector(".crow-main");
  m.style.transform = m.style.width = "";
  if (openRow === r) openRow = null;
  if (drawerDirty && !openRow) setTimeout(() => { if (!openRow && !$("#chats .crow.dragging")) renderDrawer(); }, 220);
}

function rowMeta(c) {
  const meta = el("span", "crow-meta mono");
  if (c.streaming) {
    meta.appendChild(el("span", "accent", '<span class="dot live"></span>replying'));
    return meta;
  }
  meta.append(relTime(c.updated));
  if (c.temp) { meta.append(" · "); meta.appendChild(txt("span", "accent", "temporary")); return meta; }
  const exp = expiryOf(c);
  if (exp == null) return meta;
  meta.append(" · ");
  const e = el("span", isSoon(exp) ? "accent" : "");
  if (isSoon(exp)) e.appendChild(el("span", "dot"));
  e.append(exp <= Date.now() ? "deleting" : "deletes in " + untilText(exp));
  meta.appendChild(e);
  return meta;
}

function chatRow(c) {
  const row = el("div", "crow" + (c.id === currentId ? " active" : ""));
  row.dataset.id = c.id;
  const acts = el("div", "crow-acts");
  const act = (label, icon, cls, fn) => {
    const b = button(cls, ICON[icon], null, () => { closeRow(row); fn(); });
    b.append(label);
    b.tabIndex = -1; // the same actions are in the ⋯ menu
    return b;
  };
  if (!c.temp) {
    acts.append(act(c.keep ? "Unkeep" : "Keep", c.keep ? "pinOff" : "pin", "", () => toggleKeep(c)),
      act("Rename", "rename", "", () => openActions(c, null, "rename")),
      act("Delete", "trash", "del", () => openActions(c, null, "delete")));
  }
  const main = el("div", "crow-main");
  const open = button("crow-open");
  open.append(txt("span", "crow-title", c.title), rowMeta(c));
  open.tabIndex = -1; // renderDrawer gives one row the list's tab stop
  open.setAttribute("aria-keyshortcuts", "Shift+F10");
  if (c.id === currentId) open.setAttribute("aria-current", "page");
  const more = iconBtn("more", `Options for ${c.title}`, e => { e.stopPropagation(); openActions(c, more); }, "more");
  more.tabIndex = -1; // reachable by Shift+F10 or the menu key on the row
  main.append(open, more);
  row.append(acts, main);
  bindRow(row, main, open, c);
  return row;
}

// After a long-press opens the sheet, the finger lifts over the new scrim. Eat that one click so it does not close the sheet.
function swallowClick() {
  const eat = e => { e.preventDefault(); e.stopPropagation(); };
  addEventListener("click", eat, { capture: true, once: true });
  // The click follows the lift, however long the hold. Stop eating shortly after the lift.
  const off = () => setTimeout(() => removeEventListener("click", eat, { capture: true }), 400);
  addEventListener("pointerup", off, { capture: true, once: true });
  addEventListener("pointercancel", off, { capture: true, once: true });
}

// Swipe left reveals Keep, Rename, Delete. Long-press or right-click opens Chat actions.
function bindRow(row, main, open, c) {
  let sx = 0, sy = 0, base = 0, dx = 0, tracking = false, drag = false, moved = false, suppress = false, lp = null;
  main.addEventListener("pointerdown", e => {
    if (e.button || e.target.closest(".more")) return;
    tracking = true; drag = false; moved = false; dx = 0; sx = e.clientX; sy = e.clientY;
    base = row.classList.contains("open") ? -swipeW(row) : 0;
    if (openRow && openRow !== row) { closeRow(openRow); suppress = true; }
    clearTimeout(lp);
    if (e.pointerType !== "mouse") lp = setTimeout(() => { if (tracking && !moved) { tracking = false; suppress = true; swallowClick(); openActions(c, null); } }, 500);
  });
  main.addEventListener("pointermove", e => {
    if (!tracking || e.pointerType === "mouse" || c.temp) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!drag) {
      if (Math.abs(mx) > 6 || Math.abs(my) > 6) { moved = true; clearTimeout(lp); }
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.2) {
        drag = true;
        try { main.setPointerCapture(e.pointerId); } catch {}
        row.classList.add("dragging");
      } else if (Math.abs(my) > 10) { tracking = false; return; }
    }
    if (drag) {
      const W = swipeW(row);
      dx = base + mx;
      if (dx > 0) dx *= 0.25;
      if (dx < -W) dx = -W + (dx + W) * 0.3; // resist past the actions: a full swipe never deletes
      // Left: the row narrows so the title stays in view. Right: a small rubber-band slide.
      main.style.transform = dx > 0 ? `translateX(${dx}px)` : "";
      main.style.width = dx < 0 ? `calc(100% - ${-dx}px)` : "";
    }
  });
  const end = () => {
    clearTimeout(lp);
    if (!tracking) return;
    tracking = false;
    if (!drag) return;
    row.classList.remove("dragging");
    suppress = true;
    main.style.transform = main.style.width = "";
    if (dx < -swipeW(row) * 0.35) { row.classList.add("open"); openRow = row; } else closeRow(row);
  };
  main.addEventListener("pointerup", end);
  main.addEventListener("pointercancel", end);
  main.addEventListener("contextmenu", e => { e.preventDefault(); clearTimeout(lp); tracking = false; suppress = false; openActions(c, fine.matches ? main : null); });
  open.addEventListener("click", () => {
    if (suppress) { suppress = false; return; }
    if (row.classList.contains("open")) { closeRow(row); return; }
    closeDrawer();
    if (c.id !== currentId || !chat) openChat(c.id);
  });
}

function renderSummary() {
  $("#sum-ret").textContent = settings.retention_hours ? retShort(settings.retention_hours) : "never";
  $("#sum-lock").textContent = settings.auto_lock_min ? LOCK_SHORT[settings.auto_lock_min] || settings.auto_lock_min + "m" : "never";
}

// Rebuilds the list. Keeps keyboard focus on the same row, and waits while a row is swiped open or dragged.
function renderDrawer() {
  const list = $("#chats");
  renderSummary();
  if (screen === "app" && (openRow || list.querySelector(".crow.dragging"))) { drawerDirty = true; return; }
  drawerDirty = false;
  const ae = document.activeElement;
  const fRow = ae && list.contains(ae) ? ae.closest(".crow") : null;
  const focus = fRow ? { id: fRow.dataset.id, more: ae.classList.contains("more") } : null;
  list.textContent = "";
  openRow = null;
  if (screen !== "app") return;
  // Only the current temporary chat is ever listed.
  const visible = chats.filter(c => !c.temp || c.id === currentId);
  if (!visible.length) { list.appendChild(txt("div", "no-chats", "No chats yet.")); return; }
  const section = (label, items) => {
    if (!items.length) return;
    list.appendChild(txt("div", "label sec", label));
    items.forEach(c => list.appendChild(chatRow(c)));
  };
  section("Kept", visible.filter(c => c.keep && !c.temp));
  section(settings.retention_hours ? "Auto-delete " + retShort(settings.retention_hours) : "Recent", visible.filter(c => !c.keep && !c.temp));
  section("Temporary", visible.filter(c => c.temp));
  // One tab stop for the whole list: the last focused row, else the open chat, else the first row.
  const rows = [...list.querySelectorAll(".crow")];
  const byId = id => rows.find(r => r.dataset.id === id);
  const stop = byId(focus && focus.id) || byId(rovingId) || byId(currentId) || rows[0];
  if (stop) stop.querySelector(".crow-open").tabIndex = 0;
  if (focus) {
    const r = byId(focus.id);
    const t = r && r.querySelector(focus.more ? ".more" : ".crow-open");
    if (t) t.focus({ preventScroll: true });
  }
}

// The 30 s tick: refresh "3h ago · deletes in 15h" in place, without rebuilding rows.
function refreshMeta() {
  $("#chats").querySelectorAll(".crow").forEach(r => {
    const c = chats.find(x => x.id === r.dataset.id);
    const m = r.querySelector(".crow-meta");
    if (c && m) m.replaceWith(rowMeta(c));
  });
}

// Up and Down move between rows, Home and End jump. Shift+F10 or the menu key opens Chat actions.
$("#chats").addEventListener("keydown", e => {
  const cur = e.target.closest && e.target.closest(".crow-open");
  if (!cur) return;
  const opens = [...$("#chats").querySelectorAll(".crow-open")];
  const i = opens.indexOf(cur);
  let n = -1;
  if (e.key === "ArrowDown") n = Math.min(opens.length - 1, i + 1);
  else if (e.key === "ArrowUp") n = Math.max(0, i - 1);
  else if (e.key === "Home") n = 0;
  else if (e.key === "End") n = opens.length - 1;
  else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
    e.preventDefault();
    const c = chats.find(x => x.id === cur.closest(".crow").dataset.id);
    if (c) openActions(c, cur.closest(".crow-main"));
    return;
  }
  if (n < 0) return;
  e.preventDefault();
  opens.forEach(o => { o.tabIndex = -1; });
  opens[n].tabIndex = 0;
  opens[n].focus();
});
$("#chats").addEventListener("focusin", e => {
  const r = e.target.closest && e.target.closest(".crow");
  if (r) rovingId = r.dataset.id;
});

// ---------- sheets: settings and chat actions ----------
let sheetEl = null, sheetReturn = null, sheetReturnRow = null, sheetShownAt = 0;
function showSheet(sh, trigger) {
  if (sheetEl && sheetEl !== sh) hideSheet();
  sheetReturn = document.activeElement;
  // A drawer row may be rebuilt while the sheet is up. Remember it by id to find it again.
  const fr = sheetReturn && sheetReturn.closest ? sheetReturn.closest("#chats .crow") : null;
  sheetReturnRow = fr ? { id: fr.dataset.id, more: sheetReturn.classList.contains("more") } : null;
  sheetShownAt = performance.now();
  const pop = sh.id === "actions" && !!trigger && dialogMQ.matches;
  sh.classList.toggle("pop", pop);
  document.body.classList.toggle("pop-open", pop);
  if (pop) {
    // Desktop popover anchored to its trigger. Under the header title it centers on the title.
    const r = trigger.getBoundingClientRect(), h = sh.offsetHeight;
    const left = trigger.id === "title-btn" ? r.left + r.width / 2 - 180 : r.left;
    const x = Math.max(8, Math.min(left, innerWidth - 368));
    const y = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    sh.style.setProperty("--px", x + "px");
    sh.style.setProperty("--py", y + "px");
  }
  sheetEl = sh;
  document.body.classList.add("sheet-open");
  sh.classList.add("open");
  requestAnimationFrame(() => {
    const f = sh.querySelector("input:not([type=checkbox]), .act-item, button");
    if (f && (fine.matches || f.tagName === "INPUT")) f.focus({ preventScroll: true });
  });
}
function hideSheet() {
  if (!sheetEl) return;
  const sh = sheetEl;
  sheetEl = null;
  if (sh.id === "settings") flushSp();
  if (sh.id === "settings" && pendingRet) { pendingRet = null; }
  sh.classList.remove("open", "dragging");
  sh.style.transform = "";
  document.body.classList.remove("sheet-open", "pop-open");
  let back = sheetReturn;
  if (back && !back.isConnected && sheetReturnRow) {
    const r = [...document.querySelectorAll("#chats .crow")].find(x => x.dataset.id === sheetReturnRow.id);
    back = r && r.querySelector(sheetReturnRow.more ? ".more" : ".crow-open");
  }
  sheetReturn = sheetReturnRow = null;
  if (back && back.focus && fine.matches && back.isConnected) back.focus({ preventScroll: true });
}
// A click that lands within 400ms of opening came from the gesture that opened the sheet.
$("#sheet-scrim").addEventListener("click", () => { if (performance.now() - sheetShownAt > 400) hideSheet(); });

// Drag the grabber or the head down past 30% of the sheet, or flick faster than 0.5px/ms, to dismiss.
function bindSheetDrag(sh) {
  let sy = 0, dy = 0, lastY = 0, lastT = 0, v = 0, active = false;
  sh.addEventListener("pointerdown", e => {
    if (dialogMQ.matches || !e.target.closest(".sheet-drag") || e.target.closest("button")) return;
    active = true; sy = lastY = e.clientY; lastT = e.timeStamp; dy = 0; v = 0;
    sh.classList.add("dragging");
    try { sh.setPointerCapture(e.pointerId); } catch {}
  });
  sh.addEventListener("pointermove", e => {
    if (!active) return;
    dy = Math.max(0, e.clientY - sy);
    const dt = e.timeStamp - lastT;
    if (dt > 0) v = (e.clientY - lastY) / dt;
    lastY = e.clientY; lastT = e.timeStamp;
    sh.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!active) return;
    active = false;
    sh.classList.remove("dragging");
    if (dy > sh.offsetHeight * 0.3 || v > 0.5) hideSheet();
    else sh.style.transform = "";
  };
  sh.addEventListener("pointerup", end);
  sh.addEventListener("pointercancel", end);
}
bindSheetDrag($("#settings"));
bindSheetDrag($("#actions"));

// Chat actions: menu, rename and delete steps swap inside one sheet.
function openActions(c, trigger, step = "menu") {
  const s = summaryFor(c) || c;
  if (!s || !s.id) return;
  const sh = $("#actions");
  buildActions(sh, s, step);
  if (sheetEl === sh) {
    const f = sh.querySelector("input, .act-item, button");
    if (f) f.focus({ preventScroll: true });
  } else showSheet(sh, trigger);
}

function buildActions(sh, s, step) {
  sh.textContent = "";
  const drag = el("div", "sheet-drag");
  drag.appendChild(el("div", "grab"));
  const head = el("div", "act-head");
  head.appendChild(txt("div", "act-title", s.title));
  const sub = sublineNode(s, "act-sub mono");
  if (sub) head.appendChild(sub);
  drag.appendChild(head);
  sh.appendChild(drag);
  const body = el("div", "sheet-body");
  sh.appendChild(body);
  const item = (icon, label, sm, fn, danger) => {
    const b = button("act-item" + (danger ? " danger" : ""), ICON[icon], null, fn);
    const t = el("span");
    t.append(label);
    if (sm) t.appendChild(txt("small", null, sm));
    b.appendChild(t);
    return b;
  };
  const cancel = cls => { const b = button("btn " + cls, null, null, hideSheet); b.textContent = "Cancel"; return b; };
  if (step === "menu") {
    const list = el("div", "act-list");
    if (s.temp) list.appendChild(item("trash", "Discard", null, () => discard(s), true));
    else {
      list.append(
        s.keep ? item("pinOff", "Stop keeping", settings.retention_hours ? `It deletes ${retShort(settings.retention_hours)} after the last message.` : "It stays until you delete it.", () => { hideSheet(); toggleKeep(s); })
               : item("pin", "Keep this chat", "It will never auto-delete.", () => { hideSheet(); toggleKeep(s); }),
        item("rename", "Rename", null, () => buildActions(sh, s, "rename")),
        item("trash", "Delete", null, () => buildActions(sh, s, "delete"), true));
    }
    body.append(list, cancel("act-cancel phone-only"));
  } else if (step === "rename") {
    const f = el("form");
    const inp = el("input", "act-field");
    inp.value = s.title;
    inp.maxLength = 80;
    inp.setAttribute("aria-label", "Chat title");
    inp.setAttribute("enterkeyhint", "done");
    const row = el("div", "act-btns");
    const save = el("button", "btn primary");
    save.type = "submit";
    save.textContent = "Save";
    row.append(cancel(""), save);
    f.append(inp, row);
    f.addEventListener("submit", e => { e.preventDefault(); rename(s, inp.value); });
    body.appendChild(f);
    requestAnimationFrame(() => { inp.focus(); inp.select(); });
  } else {
    body.appendChild(txt("p", "act-q", "Delete this chat? This can’t be undone."));
    const row = el("div", "act-btns");
    const del = button("btn danger", null, null, () => remove(s));
    del.textContent = "Delete";
    row.append(cancel(""), del);
    body.appendChild(row);
  }
}

async function toggleKeep(c) {
  const s = summaryFor(c) || c;
  try {
    await post(`/api/chats/${s.id}/keep`, { keep: !s.keep });
    if (chat && chat.id === s.id) chat.keep = !s.keep;
    toast(s.keep ? "No longer kept" : "Kept");
    await refreshList();
  } catch (e) { errToast(e); }
}

async function rename(s, value) {
  const t = value.trim();
  hideSheet();
  if (!t || t === s.title) return; // empty input keeps the old title
  try {
    const r = await post(`/api/chats/${s.id}/rename`, { title: t.slice(0, 80) });
    if (chat && chat.id === s.id) chat.title = r.title || t;
    toast("Renamed");
    await refreshList();
  } catch (e) { errToast(e); }
}

async function remove(s) {
  hideSheet();
  try {
    await api(`/api/chats/${s.id}`, { method: "DELETE", headers: JSON_H });
    if (s.id === currentId) { currentId = null; saveCurrent(); chat = null; edit = null; notice = null; renderThread(); }
    toast("Deleted");
    await refreshList();
  } catch (e) { errToast(e); }
}

async function discard(s) {
  hideSheet();
  if (chat && chat.id === s.id) { await leaveTemp(); currentId = null; saveCurrent(); chat = null; renderThread(); }
  else { try { await api(`/api/chats/${s.id}`, { method: "DELETE", headers: JSON_H }); } catch {} }
  toast("Discarded");
  refreshList().catch(() => {});
}

// Settings sheet
let pendingRet = null; // {h, n}: a shorter window that would delete n chats, not saved yet

function seg(box, choices, names, current, onPick) {
  if (box.dataset.built !== choices.join()) {
    box.textContent = "";
    box.appendChild(el("span", "thumb"));
    choices.forEach(v => {
      const b = button(null, null, null, () => onPick(v));
      b.textContent = names[v] ?? String(v);
      b.setAttribute("role", "radio");
      b.dataset.v = v;
      b.addEventListener("keydown", e => {
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = choices[(choices.indexOf(v) + d + choices.length) % choices.length];
        onPick(n);
        const nb = box.querySelector(`[data-v="${n}"]`);
        if (nb) nb.focus();
      });
      box.appendChild(b);
    });
    box.dataset.built = choices.join();
  }
  box.dataset.i = Math.max(0, choices.indexOf(current));
  box.querySelectorAll("button").forEach(b => {
    const on = +b.dataset.v === current;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  });
}

function renderSettings() {
  const ret = pendingRet ? pendingRet.h : settings.retention_hours;
  seg($("#ret-seg"), settings.choices, RET_SHORT, ret, pickRetention);
  seg($("#lock-seg"), settings.auto_lock_choices, LOCK_SHORT, settings.auto_lock_min, pickAutoLock);
  $("#ret-val").textContent = ret ? retShort(ret) : "never";
  $("#ret-line").textContent = ret ? `Chats are deleted ${RET_NAMES[ret] || ret + " hours"} after their last message. Kept chats stay.` : "Chats stay until you delete them.";
  $("#ret-line").hidden = !!pendingRet;
  $("#ret-confirm").hidden = !pendingRet;
  if (pendingRet) {
    $("#ret-confirm-text").textContent = `This deletes ${plural(pendingRet.n, "chat", "chats")} now.`;
    $("#ret-go").textContent = `Delete ${plural(pendingRet.n, "chat", "chats")}`;
  }
  const lk = settings.auto_lock_min;
  $("#lock-val").textContent = lk ? LOCK_SHORT[lk] || lk + "m" : "never";
  $("#lock-line").textContent = lk ? `Locks after ${LOCK_NAMES[lk] || lk + " minutes"} without use. Your passphrase opens it.` : "Stays open until you lock it.";
  const sp = $("#sp");
  if (document.activeElement !== sp && !spTimer && spState !== "saving") sp.value = settings.system_prompt || "";
  fitSp();
  spFoot();
}

function pickRetention(h) {
  if (h === settings.retention_hours) { pendingRet = null; renderSettings(); return; }
  // Same count rule as the server: older than the window, not kept, not streaming.
  const cutoff = Date.now() - h * HOUR;
  const n = h ? chats.filter(c => !c.keep && !c.temp && !c.streaming && c.updated < cutoff).length : 0;
  if (n) { pendingRet = { h, n }; renderSettings(); return; }
  pendingRet = null;
  saveRetention(h);
}
async function saveRetention(h) {
  const prev = settings.retention_hours;
  settings.retention_hours = h; // optimistic, so the thumb does not jump back
  pendingRet = null;
  renderSettings();
  try {
    const res = await post("/api/settings", { retention_hours: h });
    if (res && res.deleted) toast(`Deleted ${plural(res.deleted, "chat", "chats")}`);
    await refreshSettings();
    await refreshList();
    if (currentId) await refreshChat();
    else renderThread();
  } catch (e) {
    settings.retention_hours = prev;
    renderSettings();
    errToast(e);
  }
}
$("#ret-cancel").addEventListener("click", () => { pendingRet = null; renderSettings(); });
$("#ret-go").addEventListener("click", () => { if (pendingRet) saveRetention(pendingRet.h); });

async function pickAutoLock(min) {
  if (min === settings.auto_lock_min) return;
  const prev = settings.auto_lock_min;
  settings.auto_lock_min = min;
  renderSettings();
  try {
    await post("/api/settings", { auto_lock_min: min });
    await refreshSettings();
  } catch (e) {
    settings.auto_lock_min = prev;
    renderSettings();
    errToast(e);
  }
}

// System prompt: autosave 700ms after the last keystroke and on blur. Over 2000 characters it stops saving.
let spTimer = null, spState = "saved";
const sp = $("#sp");
function fitSp() {
  sp.style.height = "auto";
  sp.style.height = sp.scrollHeight + 2 + "px";
}
function spFoot() {
  const n = sp.value.length;
  $("#sp-state").textContent = n > SP_MAX ? "not saved" : spState;
  const c = $("#sp-count");
  c.textContent = `${n}/${SP_MAX}`;
  c.classList.toggle("over", n > SP_MAX);
}
async function saveSp() {
  clearTimeout(spTimer);
  spTimer = null;
  const v = sp.value;
  if (v.length > SP_MAX) { spState = "not saved"; spFoot(); return; }
  if (v === (settings.system_prompt || "")) { spState = "saved"; spFoot(); return; }
  spState = "saving";
  spFoot();
  try {
    await post("/api/settings", { system_prompt: v });
    settings.system_prompt = v;
    spState = sp.value === v ? "saved" : "saving";
  } catch {
    spState = "not saved";
  }
  spFoot();
}
const flushSp = () => { if (spTimer) saveSp(); };
sp.addEventListener("input", () => {
  fitSp();
  clearTimeout(spTimer);
  spTimer = null;
  if (sp.value.length > SP_MAX) { spState = "not saved"; spFoot(); return; }
  spState = "saving";
  spFoot();
  spTimer = setTimeout(saveSp, 700);
});
sp.addEventListener("blur", () => { if (spTimer || spState === "not saved") saveSp(); });

function openSettings() {
  closeDrawer();
  pendingRet = null;
  renderSettings();
  showSheet($("#settings"));
}
$("#open-settings").addEventListener("click", openSettings);
$("#settings-done").addEventListener("click", hideSheet);

// ---------- data ----------
let listLoaded = false;
async function refreshList() {
  chats = await api("/api/chats");
  listLoaded = true;
  renderDrawer();
  renderHeader();
}

async function refreshSettings() {
  settings = { ...settings, ...(await api("/api/settings")) };
  renderDrawer();
  renderSettings();
}

// `open` marks a user opening the chat: it counts as activity for the server's auto-lock. Polling never sends it.
async function refreshChat(open = false) {
  if (!currentId) { chat = null; renderThread(); return; }
  const stick = nearBottom();
  const gone = listLoaded && !chats.some(c => c.id === currentId) && !(local && local.chat.id === currentId);
  try {
    if (gone) { const e = new Error("not found"); e.status = 404; throw e; }
    chat = await api(`/api/chats/${currentId}`, open ? { headers: { "X-K2-Action": "open" } } : undefined);
  } catch (e) {
    if (e.status !== 404) throw e;
    currentId = null; saveCurrent(); chat = null;
  }
  if (edit && (!chat || !chat.messages[edit.index] || chat.messages[edit.index].role !== "user")) edit = null;
  renderThread();
  if (stick) toBottom();
}

// Switches only after the chat loads. If the laptop can't be reached, the old chat stays, header and drawer alike.
async function openChat(id) {
  const prev = { id: currentId, chat, edit, notice, shownActions, tempMode };
  edit = null; notice = null; shownActions = null; tempMode = false;
  currentId = id;
  saveCurrent();
  renderDrawer();
  try {
    await refreshChat(true);
  } catch (e) {
    if (e.locked) return;
    ({ id: currentId, chat, edit, notice, shownActions, tempMode } = prev);
    saveCurrent();
    renderDrawer();
    renderThread();
    if (e.offline) setOffline(true); // the banner says it; no toast on top
    else toast(friendly(e));
    return;
  }
  if (prev.edit) { input.value = prev.edit.saved; autosize(); }
  if (prev.chat && prev.chat.id !== id) leaveTemp(prev.chat);
  toBottom();
}

const localHere = () => !!(local && local.chat === chat);

// Polls cheap change counters. lv changes with the list, settings or lock state; v also on every streamed token.
async function poll() {
  clearTimeout(pollTimer);
  if (screen !== "app") return;
  try {
    const r = await api("/api/version");
    if (r.locked) { enterLocked(false); return; }
    setOffline(false);
    const lv = r.lv ?? r.v;
    if (lv !== ver.lv) {
      ver = { v: r.v, lv };
      await refreshSettings();
      await refreshList();
      if (!localHere()) await refreshChat();
    } else if (r.v !== ver.v) {
      ver.v = r.v;
      const s = summaryFor(chat);
      if (!localHere() && chat && (chat.stream || (s && s.streaming))) await refreshChat();
    }
  } catch (e) {
    if (e.locked) return;
    if (e.offline) setOffline(true);
  }
  if (screen !== "app") return;
  const watching = chat && chat.stream && !localHere();
  pollTimer = setTimeout(poll, document.hidden ? 8000 : offline ? 4000 : watching ? 500 : 2000);
}

// ---------- chat ----------
const isStreaming = () => !!(chat && (localHere() || chat.stream));
function updateSend() {
  const on = isStreaming();
  const disc = sendBtn.firstElementChild;
  const want = on ? "stop" : "send";
  if (disc.dataset.icon !== want) { disc.innerHTML = ICON[want]; disc.dataset.icon = want; }
  sendBtn.classList.toggle("stop", on);
  sendBtn.setAttribute("aria-label", on ? "Stop" : edit ? "Send edit" : "Send");
  sendBtn.disabled = on ? false : (!input.value.trim() || offline || screen !== "app");
}

// Puts text that never reached the server back in the composer.
function putBack(text) {
  const cur = input.value.trim();
  input.value = !cur || cur === text ? text : text + "\n" + input.value;
  autosize();
}

// Streams a reply. ctx: {kind: send|edit|regen, text, prev (messages before the optimistic change), index, saved}.
async function stream(url, body, target, ctx) {
  notice = null;
  const row = el("div", "msg a");
  const live = { chat: target, raw: "", start: performance.now(), thinkMs: null, row, frame: 0, ctrl: new AbortController(), accepted: false, cold: false, aborted: false };
  local = live;
  paintLive(row, "live", "", null, live.start, false);
  renderThread();
  toBottom();

  const paint = () => {
    live.frame = 0;
    const stick = nearBottom();
    paintLive(row, `${target.id}:live`, live.raw, live.thinkMs, live.start, live.cold);
    if (stick && row.isConnected) toBottom();
  };
  // Cold start: the model may still be loading. Say so instead of a silent row.
  const coldTimer = setTimeout(() => { if (!live.raw) { live.cold = true; paint(); } }, 2500);

  let error = null, failed = null, done = false;
  try {
    const res = await fetch(url, { method: "POST", headers: JSON_H, body: JSON.stringify(body), signal: live.ctrl.signal });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch {}
      if (isLockedRes(res.status, data)) {
        clearTimeout(coldTimer);
        if (local === live) local = null;
        target.messages = ctx.prev;
        if (ctx.text) putBack(ctx.text);
        enterLocked(!!(data && data.setup_needed));
        return;
      }
      const e = new Error((data && data.error) || "Server returned " + res.status);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    live.accepted = true; // 200: the server has the message
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.chat) {
          target.id = msg.chat.id;
          target.title = msg.chat.title;
          target.temp = !!msg.chat.temp;
          if (chat === target) { currentId = target.id; saveCurrent(); }
          refreshList().catch(() => {});
        } else if (msg.done) {
          done = true;
          error = msg.error || null;
        } else if (msg.t) {
          live.raw += msg.t;
          if (live.thinkMs === null && live.raw.includes(THINK_END)) live.thinkMs = performance.now() - live.start;
          if (!live.frame) live.frame = requestAnimationFrame(paint);
        }
      }
    }
  } catch (e) {
    if (live.aborted || e.name === "AbortError") {
      clearTimeout(coldTimer);
      if (local === live) local = null;
      return;
    }
    if (live.accepted) error = friendly(e);
    else failed = e;
  }
  clearTimeout(coldTimer);
  if (live.frame) cancelAnimationFrame(live.frame);
  if (local === live) local = null;
  if (screen !== "app") return;

  if (failed) { rollback(target, ctx, failed); return; }
  if (!done && !error) error = OFFLINE_MSG; // the connection dropped mid-reply
  const thought = live.thinkMs ?? performance.now() - live.start; // stopped while thinking: time spent so far
  try { await refreshList(); if (chat && chat.id === target.id) await refreshChat(); } catch {}
  if (chat && chat.id === target.id) {
    const i = chat.messages.length - 1, m = chat.messages[i], k = `${chat.id}:${i}`;
    if (m && m.role === "assistant" && !m.thinkMs && !thinkTimes.has(k)) { thinkTimes.set(k, thought); renderThread(); }
  }
  if (error && chat && chat.id === target.id) {
    notice = { chatId: chat.id, text: error, kind: "regen" };
    renderThread();
    toBottom(true);
  }
  announce("Reply finished.");
  updateSend();
}

// The server never accepted the message: undo the optimistic change and give the text back.
function rollback(target, ctx, err) {
  target.messages = ctx.prev;
  if (!target.id && chat === target) chat = null;
  const msg = err.status ? err.message : friendly(err);
  if (ctx.kind === "edit") {
    if (err.status === 409 && !(err.data && err.data.error)) {
      // Stale edit: the chat changed on another device. Keep the typed text as a plain draft.
      edit = null;
      putBack(ctx.text);
      toast("Chat changed on another device. Try again.");
      refreshChat().catch(() => {});
      return;
    }
    edit = { index: ctx.index, saved: ctx.saved };
    input.value = ctx.text;
    autosize();
  } else if (ctx.text) putBack(ctx.text);
  notice = { chatId: target.id || null, text: msg, kind: err.status === 413 ? null : ctx.kind, text2: ctx.text };
  renderThread();
  toBottom();
  announce(msg);
}

function send(text) {
  if (!chat) chat = { id: null, title: titleFrom(text), messages: [], stream: null, keep: false, temp: tempMode };
  const prev = chat.messages.slice();
  chat.messages = prev.concat({ role: "user", content: text });
  shownActions = null;
  const body = { text };
  if (!chat.id && chat.temp) body.temp = true;
  stream(`/api/chats/${chat.id || "new"}/messages`, body, chat, { kind: "send", text, prev });
}

function retry() {
  if (!chat || !chat.id || isStreaming()) return;
  const prev = chat.messages.slice();
  if (chat.messages.at(-1)?.role === "assistant") chat.messages = chat.messages.slice(0, -1);
  if (chat.messages.at(-1)?.role !== "user") { chat.messages = prev; return; }
  stream(`/api/chats/${chat.id}/retry`, {}, chat, { kind: "regen", prev });
}

// Edit loads the message into the composer. Later messages dim until it is sent or cancelled.
function startEdit(i) {
  if (isStreaming() || !chat || !chat.id || !chat.messages[i] || chat.messages[i].role !== "user") return;
  const saved = edit ? edit.saved : input.value;
  edit = { index: i, saved };
  shownActions = null;
  input.value = chat.messages[i].content;
  autosize();
  renderThread();
  const row = thread.querySelector(`.msg.u[data-i="${i}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function cancelEdit() {
  if (!edit) return;
  input.value = edit.saved;
  edit = null;
  autosize();
  renderThread();
}
function submitEdit(text) {
  if (!edit || !text || !chat || !chat.id || isStreaming()) return;
  const { index, saved } = edit;
  const n = chat.messages.length;
  const prev = chat.messages.slice();
  chat.messages = prev.slice(0, index).concat({ role: "user", content: text });
  edit = null;
  input.value = saved;
  autosize();
  stream(`/api/chats/${chat.id}/edit`, { index, n, text }, chat, { kind: "edit", text, prev, index, saved });
}
$("#edit-cancel").addEventListener("click", cancelEdit);

async function stop() {
  if (!chat || !chat.id) return;
  try { await fetch(`/api/chats/${chat.id}/stop`, { method: "POST", headers: JSON_H, body: "{}" }); } catch {}
}

// Leaving a temporary chat deletes it, so "Deleted when you leave" is true.
function leaveTemp(c = chat) {
  if (!c || !c.temp || !c.id) return Promise.resolve();
  const id = c.id;
  chats = chats.filter(x => x.id !== id);
  if (local && local.chat === c) { local.aborted = true; local.ctrl.abort(); local = null; }
  const opts = { method: "POST", headers: JSON_H, body: "{}", keepalive: true };
  return fetch(`/api/chats/${id}/stop`, opts).catch(() => {})
    .then(() => fetch(`/api/chats/${id}`, { method: "DELETE", headers: JSON_H, keepalive: true }))
    .catch(() => {});
}

function newChat(temp = false) {
  if (edit) cancelEdit();
  leaveTemp();
  currentId = null;
  saveCurrent();
  chat = null;
  notice = null;
  tempMode = temp;
  closeDrawer();
  renderThread();
  renderDrawer();
  if (fine.matches) input.focus();
}

// ---------- gate: lock and setup ----------
let lockTimer = null, waitTimer = null, gateBusy = false;

function syncChrome() {
  const c = !gate.hidden && !gate.classList.contains("out") ? "#141312" : darkMQ.matches ? "#1a1918" : "#f5f0e6";
  $('meta[name="theme-color"]').setAttribute("content", c);
}
darkMQ.addEventListener("change", syncChrome);

function wipe() {
  // Locked means nothing readable stays on screen or in memory here.
  chats = []; listLoaded = false; chat = null; local = null; ver = { v: -1, lv: -1 };
  edit = null; notice = null; shownActions = null; tempMode = false; warmed = false; pendingRet = null;
  openThinks.clear();
  thinkTimes.clear();
  thread.textContent = "";
  $("#chats").textContent = "";
  $("#actions").textContent = "";
  clearTimeout(toastTimer);
  $("#toast").textContent = "";
  $("#toast").classList.remove("show");
  $("#live").textContent = "";
  $("#edit-text").textContent = "";
  $("#ret-confirm-text").textContent = "";
  $("#ret-go").textContent = "";
  sp.value = "";
  input.value = "";
  offline = false; // silently: no "Connected." announcement behind the gate
  $("#banner").hidden = true;
  autosize();
}

function renderGate(mode) {
  gateMode = mode;
  $("#g-lock").hidden = mode !== "lock";
  $("#g-setup").hidden = mode !== "setup";
  gate.setAttribute("aria-label", mode === "setup" ? "Set up DeepSeek Chat" : "DeepSeek Chat is locked");
  if (mode === "lock") { if (!waitTimer) lockState("idle"); }
  else { $("#setup-pass").value = $("#setup-pass2").value = ""; $("#setup-ack").checked = false; checkSetup(); }
  if (fine.matches) setTimeout(() => { const f = $(mode === "lock" ? "#lock-pass" : "#setup-pass"); if (!f.disabled) f.focus(); }, 30);
}

function enterLocked(setupNeeded) {
  const mode = setupNeeded ? "setup" : "lock";
  if (screen === "gate") { if (gateMode !== mode) renderGate(mode); return; }
  if (local) { local.aborted = true; local.ctrl.abort(); local = null; }
  clearTimeout(pollTimer);
  clearInterval(offTimer);
  hideSheet();
  closeDrawer();
  wipe();
  screen = "gate";
  document.body.classList.remove("offline-full", "temp");
  renderHeader();
  gate.classList.remove("opening", "out", "in");
  void gate.offsetWidth;
  gate.classList.add("in"); // fades in over 120ms: locking must feel instant
  gate.hidden = false;
  app.inert = true;
  syncChrome();
  renderGate(mode);
  lockPoll();
}

// While locked, notice if another device unlocked K2.
function lockPoll() {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(async () => {
    if (screen !== "gate") return;
    try {
      // A lock made while offline reaches the server first. Until then, "unlocked" there means nothing here.
      if (lockPending) { await sendLock(); if (lockPending) { lockPoll(); return; } }
      const st = await api("/api/state");
      if (screen !== "gate") return;
      if (!st.locked) {
        // The real server can be unlocked while this device has no session yet: check before opening.
        const r = await fetch("/api/settings");
        if (r.ok && screen === "gate") { openApp(true); return; }
      } else if (!!st.setup_needed !== (gateMode === "setup")) renderGate(st.setup_needed ? "setup" : "lock");
    } catch {}
    lockPoll();
  }, 5000);
}

// Lock here first, then tell the server. An unreachable laptop must never keep this screen open.
// The flag survives a reload, so reopening the page while the laptop is still away stays locked.
let lockPending = false; // the server has not confirmed the lock yet
try { lockPending = localStorage.getItem("k2-lock-pending") === "1"; } catch {}
function setLockPending(on) {
  lockPending = on;
  try { on ? localStorage.setItem("k2-lock-pending", "1") : localStorage.removeItem("k2-lock-pending"); } catch {}
}
function sendLock() {
  return fetch("/api/lock", { method: "POST", headers: JSON_H, body: "{}", keepalive: true })
    .then(r => { if (r.ok || r.status === 423) setLockPending(false); }, () => {});
}
async function lockNow() {
  if (screen !== "app") return;
  await Promise.race([leaveTemp(), new Promise(r => setTimeout(r, 800))]);
  if (screen !== "app") return;
  setLockPending(true);
  enterLocked(false);
  sendLock();
}
$("#lock-pill").addEventListener("click", lockNow);
$("#settings-lock").addEventListener("click", lockNow);

// Lock screen states: idle, checking, wrong, wait (rate limit), opening.
const lockPass = $("#lock-pass"), lockCap = $("#lock-cap"), lockGo = $("#lock-go"), lockStatus = $("#lock-status");
function lockState(s, n) {
  lockPass.readOnly = s === "checking" || s === "opening";
  lockPass.disabled = s === "wait";
  lockGo.disabled = s === "wait";
  lockCap.classList.toggle("bad", s === "wrong" || s === "wait");
  lockStatus.className = "g-status" + (s === "wrong" || s === "wait" || s === "error" ? " bad" : "");
  lockGo.innerHTML = s === "checking" || s === "opening" ? ICON.dots : s === "wait" ? `<span class="mono">${n}</span>` : ICON.send;
  lockGo.setAttribute("aria-label", s === "wait" ? `Wait ${n} seconds` : "Unlock");
  if (s === "idle") lockStatus.textContent = "Enter your passphrase.";
  else if (s === "checking") lockStatus.textContent = "Checking.";
  else if (s === "opening") lockStatus.textContent = "Opening.";
  else if (s === "wrong") lockStatus.textContent = "Wrong passphrase. Try again.";
  else if (s === "wait") { lockStatus.textContent = "Too many tries. Try again in "; lockStatus.appendChild(txt("span", "mono", n + "s")); }
}

$("#lock-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (gateBusy || waitTimer) return;
  if (!lockPass.value) { lockPass.focus(); return; }
  gateBusy = true;
  lockState("checking");
  let r;
  try { r = await rawPost("/api/unlock", { passphrase: lockPass.value }); }
  catch {
    gateBusy = false;
    lockState("error");
    lockStatus.textContent = OFFLINE_MSG;
    announce(OFFLINE_MSG);
    return;
  }
  gateBusy = false;
  if (r.ok) {
    lockState("opening");
    lockPass.value = "";
    openApp(true);
    return;
  }
  const wait = Math.ceil(Number(r.data && r.data.retry_after) || 0);
  if (r.status === 429 || (r.status === 401 && wait > 0)) rateLimit(wait > 0 ? wait : 5);
  else if (r.status === 401) {
    lockState("wrong");
    announce("Wrong passphrase.");
    shake(lockCap);
    lockPass.select(); // retype at once
  } else {
    lockState("error");
    lockStatus.textContent = (r.data && r.data.error) || "Server returned " + r.status;
  }
});
lockPass.addEventListener("input", () => { if (!waitTimer && lockCap.classList.contains("bad")) lockState("idle"); });

function rateLimit(n) {
  clearInterval(waitTimer);
  announce(`Too many tries. Try again in ${n} seconds.`);
  const tick = () => {
    if (n <= 0) {
      clearInterval(waitTimer);
      waitTimer = null;
      lockState("idle");
      if (fine.matches) lockPass.focus();
      return;
    }
    lockState("wait", n);
    n--;
  };
  waitTimer = setInterval(tick, 1000);
  tick();
}

function shake(node) {
  if (reduced()) return;
  node.classList.remove("shake");
  void node.offsetWidth;
  node.classList.add("shake");
}

// Setup screen
function checkSetup(serverError) {
  const a = $("#setup-pass").value, b = $("#setup-pass2").value, fb = $("#setup-fb");
  let ok = false, bad = false, msg;
  if (serverError) { msg = serverError; bad = true; }
  else if (!a) msg = "Use 8 or more characters.";
  else if (a.length < MIN_PASS) msg = MIN_PASS - a.length === 1 ? "1 more character." : `${MIN_PASS - a.length} more characters.`;
  else if (b.length >= a.length && a !== b) { msg = "The two don’t match yet."; bad = true; }
  else if (a === b) { msg = "They match."; ok = true; }
  else msg = "Now type it again.";
  fb.className = "s-feedback" + (bad ? " bad" : "");
  fb.innerHTML = ok ? ICON.check : "";
  fb.append(msg);
  $("#setup-cap2").classList.toggle("bad", bad && !serverError);
  $("#setup-go").disabled = !(ok && $("#setup-ack").checked) || gateBusy;
  return ok && $("#setup-ack").checked;
}
["#setup-pass", "#setup-pass2"].forEach(s => $(s).addEventListener("input", () => checkSetup()));
$("#setup-ack").addEventListener("change", () => checkSetup());
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (gateBusy || !checkSetup()) return;
  gateBusy = true;
  $("#setup-go").disabled = true;
  let r;
  try { r = await rawPost("/api/setup", { passphrase: $("#setup-pass").value }); }
  catch { gateBusy = false; checkSetup(OFFLINE_MSG); return; }
  gateBusy = false;
  if (r.ok || r.status === 409) {
    $("#setup-pass").value = $("#setup-pass2").value = "";
    if (r.ok) { openApp(true); return; }
    renderGate("lock"); // already set up elsewhere
    return;
  }
  checkSetup((r.data && r.data.error) || "Server returned " + r.status);
});
document.querySelectorAll("#gate input").forEach(i => i.addEventListener("focus", () => {
  if (document.body.classList.contains("kb") && gateMode === "setup") setTimeout(() => i.scrollIntoView({ block: "center" }), 250);
}));

document.querySelectorAll(".eye").forEach(b => {
  const target = document.getElementById(b.dataset.for);
  b.innerHTML = ICON.eye;
  b.addEventListener("click", () => {
    const show = target.type === "password";
    target.type = show ? "text" : "password";
    b.innerHTML = show ? ICON.eyeOff : ICON.eye;
    b.setAttribute("aria-label", show ? "Hide passphrase" : "Show passphrase");
  });
});

// Unlock: load settings, list and the open chat behind the gate, then lift the shackle and fade.
async function openApp(fromGate) {
  if (lockPending && !fromGate) { enterLocked(false); return; } // locked here while the laptop was away
  if (fromGate) setLockPending(false);
  clearTimeout(lockTimer);
  clearInterval(offTimer);
  screen = "app";
  document.body.classList.remove("offline-full");
  ver = { v: -1, lv: -1 };
  try {
    await refreshSettings();
    await refreshList();
    await refreshChat(true);
  } catch (e) {
    if (e.locked) return;
    if (e.offline && !fromGate) { renderOffline(); return; }
  }
  if (screen !== "app") return;
  renderDrawer();
  renderThread();
  toBottom();
  if (!gate.hidden) await reveal();
  lastActive = Date.now();
  poll();
  warm();
  if (fine.matches && !chat) input.focus();
}

function reveal() {
  return new Promise(res => {
    app.inert = false;
    const rm = reduced();
    gate.classList.remove("in");
    if (!rm) gate.classList.add("opening"); // shackle lifts 12px in 160ms, then holds 100ms
    setTimeout(() => { gate.classList.add("out"); syncChrome(); }, rm ? 0 : 260);
    setTimeout(() => { gate.hidden = true; gate.classList.remove("opening", "out"); lockState("idle"); res(); }, rm ? 130 : 480);
  });
}

// ---------- offline (cold launch, no successful call yet) ----------
let offTimer = null;
function renderOffline() {
  screen = "offline";
  document.body.classList.add("offline-full", "empty-state");
  document.body.classList.remove("temp");
  thread.textContent = "";
  renderHeader();
  const w = el("div", "offline");
  const art = el("div", "off-art");
  art.setAttribute("role", "img");
  art.setAttribute("aria-label", "Laptop with an unplugged cable");
  w.appendChild(art);
  w.appendChild(txt("h1", null, "Can’t reach your laptop."));
  w.appendChild(txt("p", "lede", "DeepSeek Chat runs on your laptop. It has to be awake and on your tailnet."));
  const ol = el("ol", "checks");
  ["Wake the laptop or open the lid.", "Turn on Tailscale on this phone.", "Check that DeepSeek Chat is running on the laptop."].forEach((t, i) => {
    const li = el("li");
    li.append(txt("span", "mono", String(i + 1)), txt("span", null, t));
    ol.appendChild(li);
  });
  w.appendChild(ol);
  const row = el("div", "off-row");
  const b = button("btn primary", null, null, offCheck);
  b.textContent = "Try again";
  row.append(b, txt("span", "mono off-status", ""));
  w.appendChild(row);
  thread.appendChild(w);
  offCountdown();
}
function offCountdown() {
  let n = 5;
  const st = thread.querySelector(".off-status");
  clearInterval(offTimer);
  const tick = () => {
    if (n <= 0) { offCheck(); return; }
    if (st) st.textContent = `retrying in ${n}s`;
    n--;
  };
  tick();
  offTimer = setInterval(tick, 1000);
}
async function offCheck() {
  clearInterval(offTimer);
  const st = thread.querySelector(".off-status");
  if (st) st.textContent = "checking";
  let s;
  try { s = await api("/api/state"); }
  catch (e) {
    if (e.locked) return;
    if (screen === "offline") setTimeout(offCountdown, 400);
    return;
  }
  document.body.classList.remove("offline-full");
  if (s.locked) enterLocked(!!s.setup_needed);
  else openApp(false);
}

async function boot() {
  let st;
  try { st = await api("/api/state"); }
  catch (e) {
    if (e.locked) return;
    if (e.offline) { renderOffline(); return; }
    st = { locked: false };
  }
  if (st.locked) enterLocked(!!st.setup_needed);
  else openApp(false);
}

// ---------- UI wiring ----------
function autosize() {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
  updateSend();
}

form.addEventListener("submit", e => {
  e.preventDefault();
  // While a reply streams, only the Stop button itself stops it. Enter in the composer never does.
  if (isStreaming()) { if (e.submitter === sendBtn) stop(); return; }
  const text = input.value.trim();
  if (!text || offline || screen !== "app") return;
  if (edit) { submitEdit(text); return; }
  input.value = "";
  autosize();
  send(text);
});
input.addEventListener("input", autosize);
input.addEventListener("keydown", e => {
  // Enter sends. Shift+Enter is a newline.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (isStreaming()) return; // keep the draft, keep the reply
    form.requestSubmit();
  } else if (e.key === "ArrowUp" && !input.value && !edit && fine.matches && chat) {
    // Up arrow in an empty composer edits the last message.
    let last = -1;
    chat.messages.forEach((m, i) => { if (m.role === "user") last = i; });
    if (last >= 0) { e.preventDefault(); startEdit(last); }
  }
});

function onScroll() {
  $("#down").classList.toggle("show", !nearBottom() && screen === "app");
  $("#header").classList.toggle("scrolled", thread.scrollTop > 4);
}
thread.addEventListener("scroll", onScroll, { passive: true });
$("#down").addEventListener("click", () => toBottom(true));

$("#temp-switch").addEventListener("change", e => {
  if (chat) return;
  tempMode = e.target.checked;
  renderThread();
});

const drawerOpen = () => document.body.classList.contains("drawer-open");
function syncSidebar() {
  const overlay = !sidebarMQ.matches;
  $("#sidebar").inert = overlay && !drawerOpen();
  $("#pane").inert = overlay && drawerOpen(); // the overlay drawer is modal: Tab stays in it
}
let drawerOpener = null; // focus to restore when the overlay drawer closes
function openDrawer(e) {
  if (sidebarMQ.matches || screen !== "app" || drawerOpen()) return;
  renderDrawer();
  drawerOpener = document.activeElement;
  document.body.classList.add("drawer-open");
  syncSidebar();
  // Keyboard or mouse: move focus into the drawer. A tap or swipe leaves it alone.
  if (fine.matches || (e && e.detail === 0)) {
    const t = $("#chats .crow-open[tabindex='0']") || $("#sb-new");
    t.focus({ preventScroll: true });
  }
}
function closeDrawer() {
  const was = drawerOpen();
  document.body.classList.remove("drawer-open");
  if (openRow) closeRow(openRow);
  syncSidebar();
  if (!was || sidebarMQ.matches) return;
  const back = drawerOpener;
  drawerOpener = null;
  const lost = !document.activeElement || document.activeElement === document.body || $("#sidebar").contains(document.activeElement);
  if (back && back.isConnected && lost && !back.closest("[inert]")) back.focus({ preventScroll: true });
}
sidebarMQ.addEventListener("change", syncSidebar);
syncSidebar();
$("#menu").addEventListener("click", openDrawer);
$("#scrim").addEventListener("click", closeDrawer);
$("#new").addEventListener("click", () => newChat(false));
$("#sb-new").addEventListener("click", () => newChat(false));
$("#sb-temp").addEventListener("click", () => newChat(true));
$("#title-btn").addEventListener("click", () => { if (chat && chat.id) openActions(chat, $("#title-btn")); });

// Tap elsewhere hides revealed user-message actions and closes an open swipe row.
document.addEventListener("pointerdown", e => {
  if (openRow && !openRow.contains(e.target)) closeRow(openRow);
  if (shownActions !== null && !e.target.closest(".msg.u")) {
    shownActions = null;
    const us = [...thread.querySelectorAll(".msg.u")];
    us.forEach((r, k) => r.classList.toggle("acts-on", k === us.length - 1));
  }
}, true);

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (sheetEl) hideSheet();
    else if (drawerOpen()) closeDrawer();
    else if (edit) cancelEdit();
    return;
  }
  // Focus stays inside an open sheet.
  if (e.key === "Tab" && sheetEl) {
    const f = [...sheetEl.querySelectorAll("button, input, textarea, [tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.offsetParent);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!sheetEl.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// Swipe from the left edge to open the drawer, swipe left to close it.
let touchX = null, touchY = null;
document.addEventListener("touchstart", e => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
document.addEventListener("touchend", e => {
  if (touchX === null || screen !== "app" || sheetEl) { touchX = null; return; }
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 40) {
    if (!drawerOpen() && dx > 0 && touchX < 30) openDrawer();
    if (drawerOpen() && dx < 0 && !e.target.closest(".crow")) closeDrawer();
  }
  touchX = null;
}, { passive: true });

// iOS ignores interactive-widget, so size the app to the visual viewport when the keyboard opens.
const vv = window.visualViewport;
if (vv && /iP(hone|ad|od)/.test(navigator.userAgent)) {
  // --kb is the keyboard height. Sheets and the toast sit on top of it, so pinning the page at 0 hides nothing.
  const fit = () => {
    const kb = Math.max(0, window.innerHeight - vv.height);
    document.documentElement.style.setProperty("--app-h", vv.height + "px");
    document.documentElement.style.setProperty("--kb", kb + "px");
    document.body.classList.toggle("kb", kb > 120);
    window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}
// The toast sits 12px above the composer.
new ResizeObserver(() => document.documentElement.style.setProperty("--foot-h", $("#footer").offsetHeight + "px")).observe($("#footer"));

// Auto-lock: the client also tracks activity. A live reply pauses the timer.
["pointerdown", "keydown", "scroll"].forEach(t => addEventListener(t, () => { lastActive = Date.now(); }, { capture: true, passive: true }));
function idleCheck() {
  if (screen !== "app") return;
  if (local || chats.some(c => c.streaming)) { lastActive = Date.now(); return; }
  const m = settings.auto_lock_min;
  if (m && Date.now() - lastActive >= m * 60000) lockNow();
}
setInterval(idleCheck, 10000);

// Privacy veil for the app switcher.
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("veiled", document.hidden);
  if (document.hidden) return;
  idleCheck();
  if (screen === "app") { poll(); warm(); }
  else if (screen === "offline") offCheck();
});
addEventListener("pagehide", () => { document.body.classList.add("veiled"); leaveTemp(); });
addEventListener("pageshow", () => document.body.classList.remove("veiled"));

// Running "Thinking" timers, in tenths.
setInterval(() => {
  document.querySelectorAll(".t-timer[data-start]").forEach(t => { t.textContent = ((performance.now() - +t.dataset.start) / 1000).toFixed(1) + "s"; });
}, 100);
// Refresh "deletes in" hints.
setInterval(() => { if (screen === "app") { refreshMeta(); renderHeader(); } }, 30000);
wideMQ.addEventListener("change", () => { if (screen === "app") renderThread(); });

autosize();
boot();
