/* ==================================================================
   SportsDesk spotting board kit
   Shared engine for the NFL, MLB and soccer boards (nfl.html, mlb.html, soccer-board.html).
   The NBA board (board.html) is its own file and does not use this.

   A sport file calls SD.start({...}) with the pieces that differ by sport:
   rosters, season lines, tonight's line, the feed, the situation strip, team stats, on-air lines.
   ================================================================== */
(function(){
"use strict";
const SD = window.SD = {};
const P = SD.P = new URLSearchParams(location.search);
const $ = SD.$ = s => document.querySelector(s);
const esc = SD.esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
SD.num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
SD.hl = s => esc(s).replace(/([+−]?\d+(?:[.\-\/]\d+)?%?)/g, "<b>$1</b>");
SD.ord = n => n + (["th","st","nd","rd"][(n % 100 - 20) % 10] || ["th","st","nd","rd"][n % 100] || "th");
SD.last = name => String(name || "").trim().split(/\s+/).slice(-1)[0];

async function J(url){
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache:"no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
SD.J = J;
SD.pool = async function(items, n, fn){
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length:n }, async () => { while (i < items.length){ const k = i++; try{ out[k] = await fn(items[k]); }catch(e){ out[k] = null; } } }));
  return out;
};
function lum(hex){
  const n = parseInt(hex.replace("#",""),16);
  const c = [(n>>16)&255,(n>>8)&255,n&255].map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});
  return .2126*c[0]+.7152*c[1]+.0722*c[2];
}
SD.color = function(p, a){ const ok = h => h && /^[0-9a-f]{6}$/i.test(h); let c = ok(p) ? "#"+p : null; if (!c || lum(c) < .015) c = ok(a) ? "#"+a : "#1a5fa8"; return c; };
const ymd = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;

/* one-time async lookups (game logs, overviews) that re-render the panel when they land */
const cache = {};
SD.once = function(key, fn){
  if (key in cache) return cache[key];
  cache[key] = "pending";
  Promise.resolve().then(fn).then(v => { cache[key] = v == null ? null : v; }, () => { cache[key] = null; })
    .then(() => { if (SD.S.openId && SD.renderDetail) SD.renderDetail(); });
  return "pending";
};

SD.start = function(M){
  const cfg = SD.cfg = {
    team: (P.get("team") || M.defaultTeam).toUpperCase(),
    event: P.get("event") || "",
    league: P.get("league") || M.league,
    days: Math.min(30, +(P.get("days") || M.days || 10)),
    delay: Math.max(0, Math.min(120, +(P.get("delay") || 0))),
    poll: Math.max(5, +(P.get("poll") || (P.get("delay") ? 5 : 15))),
    view: (P.get("view") || "").toLowerCase()
  };
  M.setup && M.setup(cfg);
  SD.BASE = `https://site.api.espn.com/apis/site/v2/sports/${M.sport}/${cfg.league}`;
  SD.ATH = `https://site.web.api.espn.com/apis/common/v3/sports/${M.sport}/${cfg.league}/athletes`;
  const S = SD.S = { ev:null, teams:{}, players:{}, live:{}, state:"pre", snap:null, openId:null, seenFeed:new Set(), M };
  const store = SD.store = {
    get(k){ try{ return localStorage.getItem(`sd${M.key}:` + k) || ""; }catch(e){ return ""; } },
    set(k, v){ try{ localStorage.setItem(`sd${M.key}:` + k, v); }catch(e){} }
  };
  const FEEDONLY = cfg.view === "feed";
  if (FEEDONLY) document.body.classList.add("feedonly");
  document.title = `SportsDesk ${M.title}`;

  /* ---------- top bar ---------- */
  document.body.insertAdjacentHTML("afterbegin", `
  <div class="bar">
    <span class="brand">SportsDesk</span>
    <span class="t">${esc(M.title)}</span>
    <span class="mu" id="mu"></span>
    <span class="status" id="status"><i></i><span id="statusTxt">Loading</span></span>
    <label class="finder" title="Type a jersey number to find the player on both teams"># <input id="find" inputmode="numeric" maxlength="3" autocomplete="off"><span class="hits" id="hits"></span></label>
    <form id="f"><label for="team">Team</label><input id="team" maxlength="5" autocomplete="off"><label for="delay">Delay</label><input id="delay" type="number" min="0" max="120" step="1" inputmode="numeric" style="width:58px;text-transform:none" title="Seconds to hold live stats and alerts back so they match your video"><button>Apply</button></form>
    <button class="pbtn" id="pop" type="button" title="Open the score and alerts in a small window you can park next to OBS">Pop-out alerts</button>
    <button class="pbtn" id="print" type="button">Print</button>
  </div>
  <div class="msg" id="msg"></div>
  <div id="app"><p class="loading">Pulling rosters, season numbers and the matchup from ESPN…</p></div>`);
  $("#team").value = cfg.team;
  $("#delay").value = cfg.delay || "";
  $("#f").addEventListener("submit", e => {
    e.preventDefault();
    const t = $("#team").value.trim().toUpperCase(); if (!t) return;
    if (t !== cfg.team){ P.set("team", t); P.delete("event"); }
    const d = Math.max(0, Math.min(120, parseInt($("#delay").value, 10) || 0));
    if (d) P.set("delay", d); else P.delete("delay");
    location.search = P.toString();
  });
  $("#print").addEventListener("click", () => window.print());
  $("#pop").addEventListener("click", () => {
    const q = new URLSearchParams(P); q.set("view", "feed"); if (S.ev) q.set("event", S.ev);
    window.open(location.pathname + "?" + q.toString(), "sdalerts" + M.key, "popup=yes,width=440,height=780");
  });
  $("#find").addEventListener("input", findNumber);
  function setStatus(cls, txt){ $("#status").className = "status " + cls; $("#statusTxt").textContent = txt; }
  SD.setStatus = setStatus;

  /* ---------- find the game: today, or the next one within `days` ---------- */
  async function findEvent(){
    if (cfg.event) return cfg.event;
    const now = new Date();
    for (let i = 0; i <= cfg.days; i++){
      const d = new Date(now); d.setDate(now.getDate() + i);
      try{
        const sb = await J(`${SD.BASE}/scoreboard?dates=${ymd(d)}`);
        const ev = (sb.events || []).find(e => e.competitions[0].competitors.some(c => (c.team.abbreviation || "").toUpperCase() === cfg.team));
        if (ev) return ev.id;
      }catch(e){}
    }
    return null;
  }
  async function snapshot(){
    const sum = await J(`${SD.BASE}/summary?event=${S.ev}`);
    const extra = M.extra ? await M.extra(sum).catch(() => null) : null;
    return { sum, extra };
  }

  /* ---------- load ---------- */
  async function load(){
    setStatus("", "Finding the game");
    const id = await findEvent();
    if (!id){
      $("#app").innerHTML = "";
      $("#msg").textContent = `No ${cfg.team} game in the next ${cfg.days} days. Check the team code${M.codesHint ? " (" + M.codesHint + ")" : ""} or add &event= with an ESPN game ID.`;
      $("#msg").classList.add("on"); setStatus("", "No game found"); return;
    }
    S.ev = id;
    const snap = await snapshot();
    const comp = snap.sum.header.competitions[0];
    for (const c of comp.competitors){
      const t = c.team, side = c.homeAway;
      S.teams[side] = { id:String(t.id), abbr:t.abbreviation, name:t.displayName || t.name, short:t.shortDisplayName || t.name || t.abbreviation,
        color: SD.color(t.color, t.alternateColor), rec: (c.record && c.record[0] && (c.record[0].summary || c.record[0].displayValue)) || "", players:[] };
    }
    setStatus("", "Loading rosters");
    await Promise.all(["away","home"].map(async side => {
      const list = await M.loadPlayers(side, S.teams[side], snap.sum).catch(e => { console.error(e); return []; });
      S.teams[side].players = list;
      list.forEach(p => { p.side = side; S.players[p.id] = p; });
    }));
    for (const ti of snap.sum.injuries || []){
      for (const it of ti.injuries || []){
        const p = it.athlete && S.players[String(it.athlete.id)];
        if (p) p.inj = it.status || (it.type && it.type.description) || p.inj;
      }
    }
    renderShell(snap.sum, comp);
    renderTeams();
    if (cfg.delay > 0) snaps.push({ t:Date.now(), snap });
    apply(snap);
    tick();
    if (M.seasonOf){
      const all = Object.values(S.players).filter(p => p.season === undefined);
      SD.pool(all, 6, p => M.seasonOf(p)).then(vals => {
        all.forEach((p, i) => p.season = vals[i] || null);
        renderTeams(); if (S.openId) renderDetail();
      });
    }
  }

  /* ---------- shell ---------- */
  function renderShell(sum, comp){
    const A = S.teams.away, H = S.teams.home, when = new Date(comp.date);
    const gi = sum.gameInfo || {}, venue = gi.venue ? `${gi.venue.fullName || ""}${gi.venue.address && gi.venue.address.city ? ", " + gi.venue.address.city : ""}` : "";
    const odds = (sum.pickcenter && sum.pickcenter[0]) || (sum.odds && sum.odds[0]) || null;
    const line = odds ? [odds.details, odds.overUnder ? `O/U ${odds.overUnder}` : ""].filter(Boolean).join(", ") : "";
    const at = M.vs ? M.vs(comp) : "at";
    $("#mu").innerHTML = `<b style="--tc:${A.color}"><i></i>${esc(A.abbr)}</b> ${esc(at)} <b style="--tc:${H.color}"><i></i>${esc(H.abbr)}</b><span class="meta">${esc(when.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" }))} ${esc(when.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }))}${venue ? " · " + esc(venue) : ""}${line ? " · " + esc(line) : ""}</span>`;
    const ctx = (M.context ? M.context(sum) : []).filter(Boolean);
    $("#app").innerHTML = `
      <div class="layout">
        <div class="col away" id="colA"></div>
        <aside class="desk" id="desk">
          <div class="box alerts feedbox">
            <div class="sc" id="sc">
              <div class="t a" style="--tc:${A.color}"><i class="poss"></i><b>${esc(A.abbr)}</b><strong id="scA">0</strong></div>
              <div class="mid" id="scMid"><span>${esc(when.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }))}</span>${esc(when.toLocaleDateString([], { month:"short", day:"numeric" }))}</div>
              <div class="t h" style="--tc:${H.color}"><i class="poss"></i><b>${esc(H.abbr)}</b><strong id="scH">0</strong></div>
            </div>
            <div class="sit" id="sit" hidden></div>
            <div class="pulse" id="pulse" hidden></div>
            <ul class="feed" id="feed"><li class="empty">Scoring and big moments land here once it starts.</li></ul>
          </div>
          <section class="detail" id="detail" hidden aria-label="Player detail"></section>
          <div class="box teambox" id="teamBox" hidden></div>
          ${ctx.map(c => `<div class="box"><h3>${esc(c.title)}</h3><div class="list">${c.html}</div></div>`).join("")}
        </aside>
        <div class="col home" id="colH"></div>
      </div>`;
  }

  /* ---------- cards ---------- */
  const SERIOUS = M.serious || /out|question|doubt|suspend|injured reserve|^ir$/i;
  SD.SERIOUS = SERIOUS;
  function strip(t, sm){
    if (!t) return "";
    if (t.none) return `<div class="tn${sm ? " sm" : ""}"><span class="lab">${esc(t.label || "TONIGHT")}</span><span class="none">${esc(t.none)}</span></div>`;
    return `<div class="tn${sm ? " sm" : ""}"><span class="lab">${esc(t.label || "TONIGHT")}</span>` +
      t.items.map(([lab, v, cls]) => `<span class="st${cls ? " " + cls : ""}"><b>${esc(v == null || v === "" ? "–" : v)}</b><i>${esc(lab)}</i></span>`).join("") + `</div>`;
  }
  function card(p, mini){
    const t = S.teams[p.side], row = S.live[p.id];
    const note = store.get("p:" + p.id);
    const noteEl = note ? `<div class="pnote">${esc(note)}</div>` : "";
    const injCls = /out|injured reserve|^ir$/i.test(p.inj || "") ? "" : " q";
    const badges = `${SERIOUS.test(p.inj || "") ? `<span class="inj${injCls}">${esc(p.inj)}</span>` : ""}${(M.badges ? M.badges(p, row) : []).map(b => `<span class="${b.cls || "st5"}">${esc(b.text)}</span>`).join("")}`;
    const tonight = M.tonight ? M.tonight(p, row) : null;
    const out = /out|injured reserve/i.test(p.inj || "") ? " out" : "";
    if (mini){
      return `<div class="pc mini${out}${S.openId === p.id ? " sel" : ""}" data-pid="${esc(p.id)}" data-num="${esc(p.jersey)}" style="--tc:${t.color}">
        <div class="jn">${esc(p.jersey)}</div>
        <div>
          <div class="top"><span class="name">${esc(p.name)}</span><span class="pos">${esc(p.pos)}</span>${badges}<span class="sl">${M.seasonMini ? M.seasonMini(p) : ""}</span></div>
          ${strip(tonight, true)}
          ${noteEl}
        </div>
      </div>`;
    }
    const bio = M.bio ? M.bio(p) : "";
    return `<div class="pc${out}${S.openId === p.id ? " sel" : ""}" data-pid="${esc(p.id)}" data-num="${esc(p.jersey)}" style="--tc:${t.color}">
      <div class="jn">${esc(p.jersey)}</div>
      <div>
        <div class="top"><span class="name">${esc(p.name)}</span><span class="pos">${esc(p.pos)}</span>${badges}</div>
        ${bio ? `<div class="bio">${bio}</div>` : ""}
        ${strip(tonight)}
        <div class="ssn${row ? "" : " big"}">${M.seasonLine ? M.seasonLine(p) : ""}</div>
        ${noteEl}
      </div>
    </div>`;
  }
  function chip(p){
    const t = S.teams[p.side], row = S.live[p.id], tl = M.chipLine ? M.chipLine(p, row) : "";
    const out = /out|injured reserve/i.test(p.inj || "") ? " out" : "";
    return `<span class="chip${out}${S.openId === p.id ? " sel" : ""}" data-pid="${esc(p.id)}" data-num="${esc(p.jersey)}" style="--tc:${t.color}" title="${esc(p.name + (p.inj ? " · " + p.inj : ""))}"><b>${esc(p.jersey)}</b>${esc(p.short || p.name)}<i>${esc(p.pos)}</i>${tl ? `<span class="tl">${esc(tl)}</span>` : ""}</span>`;
  }
  function renderTeams(){
    [["away", "#colA"], ["home", "#colH"]].forEach(([side, sel]) => {
      const el = $(sel); if (!el) return;
      const t = S.teams[side];
      const openFolds = new Set([...el.querySelectorAll("details.fold[open] .grp")].map(g => g.textContent.replace(/\s*\(\d+\)$/, "")));
      el.style.setProperty("--tc", t.color);
      el.innerHTML = `<h2>${esc(t.name)}<span>${esc(t.rec)}</span></h2>` +
        M.groups(side).map(g => {
          if (!g.list.length) return "";
          const body = g.chips ? `<div class="chips">${g.list.map(chip).join("")}</div>` : g.list.map(p => card(p, g.mini)).join("");
          if (g.fold) return `<details class="fold"><summary><span class="grp">${esc(g.label)}</span> <span class="who">${g.list.map(p => esc(p.short || p.name)).join(", ")}</span></summary>${body}</details>`;
          if (g.cls) return `<div class="grp ${g.cls}">${esc(g.label)}</div><div class="${g.cls}set">${body}</div>`;
          return `<div class="grp">${esc(g.label)}</div>${body}`;
        }).join("");
      el.querySelectorAll("details.fold").forEach(d => { if (openFolds.has(d.querySelector(".grp").textContent.replace(/\s*\(\d+\)$/, ""))) d.open = true; });
    });
    findNumber();
  }
  SD.renderTeams = renderTeams;

  /* ---------- jersey-number finder ---------- */
  function findNumber(){
    const v = ($("#find") && $("#find").value || "").trim();
    document.querySelectorAll(".flash").forEach(x => x.classList.remove("flash"));
    if (!v){ $("#hits").textContent = ""; return; }
    const hits = Object.values(S.players).filter(p => String(p.jersey) === v);
    $("#hits").textContent = hits.length ? hits.map(p => `${S.teams[p.side].abbr} ${p.name} (${p.pos})`).join(" · ") : "nobody";
    const els = [...document.querySelectorAll(`[data-num="${CSS.escape(v)}"]`)];
    els.forEach(x => x.classList.add("flash"));
    if (els[0] && document.activeElement === $("#find")) els[0].scrollIntoView({ block:"nearest" });
  }

  /* ---------- live ---------- */
  function apply(snap){
    S.snap = snap;
    const sum = snap.sum, comp = sum.header.competitions[0], st = comp.status || {}, ty = st.type || {};
    S.state = ty.state || "pre";
    if (S.state !== "pre"){
      for (const c of comp.competitors){ const el = $(c.homeAway === "home" ? "#scH" : "#scA"); if (el) el.textContent = c.score ?? "0"; }
      const mid = M.clock ? M.clock(snap) : { top:ty.shortDetail || "", bottom:"" };
      if ($("#scMid")) $("#scMid").innerHTML = `<span>${esc(mid.top)}</span>${esc(mid.bottom || "")}`;
    }
    try{ S.live = M.parseLive ? M.parseLive(snap) : {}; }catch(e){ console.error(e); }
    const poss = M.possession ? M.possession(snap) : null;
    document.querySelectorAll("#sc .t").forEach(x => x.classList.remove("has"));
    if (poss) { const el = document.querySelector(poss === "home" ? "#sc .t.h" : "#sc .t.a"); if (el) el.classList.add("has"); }
    const sit = M.situation && S.state === "in" ? M.situation(snap) : "";
    $("#sit").hidden = !sit; $("#sit").innerHTML = sit || "";
    const pulse = M.pulse && S.state !== "pre" ? M.pulse(snap) : "";
    $("#pulse").hidden = !pulse; $("#pulse").innerHTML = pulse || "";
    renderFeed(snap);
    renderTeamBox(snap);
    $("#desk").classList.toggle("pre", S.state === "pre");
    renderTeams();
    if (S.openId) renderDetail();
  }
  function renderFeed(snap){
    let items = [];
    try{ items = M.feed ? M.feed(snap) : []; }catch(e){ console.error(e); }
    const el = $("#feed"); if (!el) return;
    if (!items.length){ if (S.state !== "pre") el.innerHTML = `<li class="empty">Nothing big yet.</li>`; return; }
    const first = !S.seenFeed.size;
    const html = items.slice().reverse().slice(0, 80).map((a, i) => {
      const fresh = !first && !S.seenFeed.has(a.key) && i < 3;
      return `<li class="fi${a.big ? " big" : ""}${fresh ? " fresh" : ""}" style="--tc:${a.side ? S.teams[a.side].color : "var(--desk)"}"><span class="tm">${esc(a.stamp || "")}</span><div><span class="k">${esc(a.kicker || "")}</span><span class="h">${esc(a.head || "")}</span></div></li>`;
    }).join("");
    items.forEach(a => S.seenFeed.add(a.key));
    el.innerHTML = html;
  }
  function renderTeamBox(snap){
    const el = $("#teamBox"); if (!el) return;
    const rows = M.teamRows && S.state !== "pre" ? M.teamRows(snap) : null;
    if (!rows || !rows.length){ el.hidden = true; return; }
    el.hidden = false;
    const A = S.teams.away, H = S.teams.home;
    const cell = (v, me, them, dir) => `<td class="${dir && me != null && them != null && me * dir > them * dir ? "win" : ""}">${esc(v ?? "–")}</td>`;
    el.innerHTML = `<h3>Team stats</h3><table class="tb">
      <tr><th style="--tc:${A.color}"><i></i>${esc(A.abbr)}</th><th></th><th style="--tc:${H.color}"><i></i>${esc(H.abbr)}</th></tr>
      ${rows.map(([k, a, h, na, nh, dir]) => `<tr>${cell(a, na, nh, dir)}<td class="k">${esc(k)}</td>${cell(h, nh, na, dir)}</tr>`).join("")}
    </table>${M.teamFoot ? `<p class="tbf">${esc(M.teamFoot(snap) || "")}</p>` : ""}`;
  }

  let timer = null;
  const snaps = []; let shown = null;
  async function tick(){
    clearTimeout(timer);
    try{
      let snap = await snapshot();
      if (cfg.delay > 0){
        snaps.push({ t:Date.now(), snap });
        const cutoff = Date.now() - cfg.delay * 1000;
        while (snaps.length && snaps[0].t <= cutoff) shown = snaps.shift().snap;
        if (!shown){ setStatus("", `Syncing to your ${cfg.delay}s delay…`); timer = setTimeout(tick, cfg.poll * 1000); return; }
        snap = shown;
      }
      apply(snap);
      if (S.state === "in") setStatus("live", `Live${cfg.delay ? `, ${cfg.delay}s delay` : ""}, updated ` + new Date().toLocaleTimeString([], { hour:"numeric", minute:"2-digit", second:"2-digit" }));
      else if (S.state === "post"){ setStatus("", "Final"); return; }
      else setStatus("", "Pregame, checks for lineups every minute");
    }catch(e){ console.error(e); setStatus("", "Connection hiccup, retrying"); }
    timer = setTimeout(tick, (S.state === "pre" ? 60 : cfg.poll) * 1000);
  }

  /* ---------- player panel ---------- */
  function openPlayer(id){
    const p = S.players[id]; if (!p) return;
    S.openId = id;
    const t = S.teams[p.side], d = $("#detail");
    d.style.setProperty("--tc", t.color);
    d.innerHTML = `
      <div class="dh"><span class="jn">${esc(p.jersey)}</span><div><div class="nm">${esc(p.name)}</div><div class="dim">${esc(t.abbr)} · ${esc(p.pos)}${p.college ? " · " + esc(p.college) : ""}</div></div><button class="x" type="button">Close ✕</button></div>
      <textarea class="pn" rows="1" placeholder="Your notes on ${esc(p.short || p.name)}…">${esc(store.get("p:" + id))}</textarea>
      <div id="dBody"></div>`;
    d.hidden = false; $("#desk").classList.add("has-detail");
    d.querySelector(".x").addEventListener("click", closePlayer);
    const n = d.querySelector(".pn");
    const fit = () => { n.style.height = "auto"; n.style.height = n.scrollHeight + 2 + "px"; }; fit();
    n.addEventListener("input", () => { store.set("p:" + id, n.value); fit(); });
    n.addEventListener("change", renderTeams);
    document.querySelectorAll(".pc.sel,.chip.sel").forEach(c => c.classList.remove("sel"));
    document.querySelectorAll(`[data-pid="${CSS.escape(id)}"]`).forEach(c => c.classList.add("sel"));
    $("#desk").scrollTop = 0;
    renderDetail();
  }
  function closePlayer(){
    S.openId = null; const d = $("#detail"); if (!d) return;
    d.hidden = true; d.innerHTML = ""; $("#desk").classList.remove("has-detail");
    document.querySelectorAll(".pc.sel,.chip.sel").forEach(c => c.classList.remove("sel"));
  }
  function renderDetail(){
    const p = S.openId && S.players[S.openId], body = $("#dBody"); if (!p || !body) return;
    let r = { say:[], html:"" };
    try{ r = M.detail(p, S.live[p.id], S.snap) || r; }catch(e){ console.error(e); }
    body.innerHTML = `<h4>On-air lines</h4>
      ${r.say.length ? `<ul class="say">${r.say.map(x => `<li>${SD.hl(x)}</li>`).join("")}</ul>` : '<p class="dim">Nothing yet.</p>'}
      ${r.html || ""}
      <p class="dim foot">From ESPN${cfg.delay ? `, on your ${cfg.delay}s delay` : ""}. Updates live. Esc or click the player again to close.</p>`;
  }
  SD.renderDetail = renderDetail;
  SD.tile = (v, k, cls = "") => `<div class="tile${cls ? " " + cls : ""}"><b>${esc(v == null || v === "" ? "–" : v)}</b><i>${esc(k)}</i></div>`;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && S.openId) closePlayer(); });
  document.addEventListener("click", e => {
    const c = e.target.closest && e.target.closest(".pc,.chip");
    if (!c || !c.dataset.pid) return;
    if (c.dataset.pid === S.openId) closePlayer(); else openPlayer(c.dataset.pid);
  });

  load().catch(e => { console.error(e); $("#msg").textContent = "Couldn't load the board: " + e.message; $("#msg").classList.add("on"); setStatus("", "Error"); });
};

/* shared helper: a player's ESPN game log, newest first, as rows keyed by label */
SD.gamelog = async function(id, season){
  const d = await J(`${SD.ATH}/${id}/gamelog${season ? "?season=" + season : ""}`);
  const labels = (d.labels || []).map(x => String(x).toUpperCase());
  const reg = (d.seasonTypes || []).filter(t => /regular/i.test(t.displayName || ""));
  const types = reg.length ? reg : (d.seasonTypes || []).slice(0, 1);
  const seen = new Map();
  const walk = o => { if (!o || typeof o !== "object") return;
    if (o.eventId && Array.isArray(o.stats) && !seen.has(String(o.eventId)) && String(o.eventId) !== String(SD.S.ev)) seen.set(String(o.eventId), o.stats);
    for (const k in o) if (typeof o[k] === "object") walk(o[k]); };
  types.forEach(walk);
  if (!seen.size) return null;
  const games = [...seen].map(([eid, st]) => {
    const g = {}; labels.forEach((l, i) => { if (!(l in g)) g[l] = st[i]; else g[l + "_2"] = st[i]; });
    const m = (d.events || {})[eid] || {};
    g.date = m.gameDate; g.opp = `${m.atVs || ""} ${(m.opponent && m.opponent.abbreviation) || ""}`.trim(); g.res = m.gameResult || "";
    return g;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
  return { games, labels, label:(types[0] && types[0].displayName) || "" };
};
/* overview stat line: labels + the split whose name matches `want` (regex), else the first */
SD.overview = async function(id, want){
  const d = await J(`${SD.ATH}/${id}/overview`);
  const s = d.statistics; if (!s || !s.labels || !s.splits) return null;
  const split = (want && s.splits.find(x => want.test(x.displayName || ""))) || s.splits[0];
  if (!split) return null;
  const v = { _label: split.displayName, _splits: s.splits.map(x => x.displayName) };
  s.labels.forEach((l, i) => { const k = String(l).toUpperCase(); if (k in v) v[k + "_2"] = split.stats[i]; else v[k] = split.stats[i]; });
  // every split, for "all competitions" lines
  v._all = s.splits.map(x => { const o = { _label:x.displayName }; s.labels.forEach((l, i) => { const k = String(l).toUpperCase(); if (k in o) o[k + "_2"] = x.stats[i]; else o[k] = x.stats[i]; }); return o; });
  return v;
};
SD.lastSeason = (() => { const n = new Date(); return n.getMonth() >= 8 ? n.getFullYear() : n.getFullYear() - 1; })();
})();
