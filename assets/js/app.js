
/* keep a stray rejected promise (e.g. a dropped fetch) from leaving the app in a
   silently-broken state; log it for debugging but don't spam the console */
addEventListener('unhandledrejection',e=>{ console.warn('Unhandled promise rejection:',e&&e.reason); e.preventDefault(); });

/* ---------- custom cursor removed for the flat-black STREDIO design ---------- */

/* ---------- particles removed for the flat-black STREDIO design ----------
   __bg is kept as a no-op so the video player's pause/resume calls stay safe. */
window.__bg={start(){},stop(){}};

/* ---------- catalog data (live TMDB via /api, with mock fallback) ---------- */
const GENRES=["Action","Drama","Sci-Fi","Horror","Comedy","Thriller","Documentary","Animation","Romance","Crime"];
const HUES=[240,248,256,264,272,280];
const SAMPLE=[
  ["Echoes of Obsidian",2021,8.4,"Sci-Fi"],["The Quiet Hour",2019,7.8,"Drama"],["Nightfall Protocol",2023,8.1,"Thriller"],
  ["Paper Lanterns",2018,7.2,"Romance"],["Vector",2022,8.6,"Action"],["Glass Cathedral",2020,7.9,"Drama"],
  ["Hollow Tide",2024,8.2,"Horror"],["Static Bloom",2017,7.5,"Sci-Fi"],["Midnight Cartographer",2021,8.0,"Crime"],
  ["The Long Exposure",2016,7.7,"Drama"],["Cobalt Dreams",2023,8.3,"Animation"],["Ashfall",2019,7.4,"Thriller"],
  ["Lumen",2022,8.5,"Sci-Fi"],["Saltwater Saints",2018,7.1,"Drama"],["The Understudy",2020,7.6,"Comedy"],
  ["Northbound",2024,8.7,"Action"],["Cinder & Smoke",2015,7.3,"Crime"],["Parallax",2021,8.1,"Sci-Fi"],
];
/* offline/demo fallback catalog — no stock images: these render as the branded
   gradient "art" card (title over a violet gradient), never a random photo */
const MOCK=SAMPLE.map((m,i)=>({id:'mock-'+i,title:m[0],year:m[1],rating:m[2],genre:m[3]}));
let CATALOG=MOCK.slice();

const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* rating badge colour by score: red <5 · yellow 5–6.9 · green 7–8.4 · blue 8.5+
   (0 / unrated → a muted "NR" chip so a missing TMDB score never reads as red 0) */
function rateClass(r){ r=+r||0; if(r<=0) return 'r-nr'; if(r<5) return 'r-red'; if(r<7) return 'r-yellow'; if(r<8.5) return 'r-green'; return 'r-blue'; }
function rateText(r){ r=+r||0; return r>0?(r.toFixed(1)):'NR'; }

function posterHTML(it,seed,opts){
  const h=HUES[seed%HUES.length];
  const bg=`linear-gradient(155deg,hsl(${h} 30% 12%),hsl(${h} 22% 6%))`;
  const img=it.poster||'';
  // `cov` + onload→`rdy` fades the cover in only once it has actually decoded, so a card
  // never flashes a half-painted / placeholder-then-image jump on a fast reload.
  const imgTag=img?`<img class="cov" src="${esc(img)}" loading="lazy" alt="${esc(it.title)} poster" onload="this.classList.add('rdy')" onerror="this.remove()"/>`:'';
  // add-on catalog items (sports/channels/etc.) carry data-addon so a click opens the
  // direct-to-sources sheet instead of the TMDB detail modal (which their ids don't resolve to).
  const addonAttrs=it._addon?` data-addon="1" data-addon-name="${esc(it._addonName||'')}"`:'';
  // Continue Watching posters carry a corner ✕ that drops the title from watch history
  // (handled in the global click listener, which stops the card from opening the modal).
  const removeBtn=(opts&&opts.removable)?`<button type="button" class="cw-remove" data-remove-id="${esc(it.id)}" aria-label="${esc(t('continue.remove'))}" title="${esc(t('continue.remove'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`:'';
  // Continue Watching cards carry a resume timecode (0–1) → a thin crimson bar at the
  // bottom edge. Only drawn when there's meaningful progress to show.
  const pct=(opts&&+opts.progress>0)?Math.max(0,Math.min(1,+opts.progress)):0;
  const progBar=pct>0.01?`<div class="cw-progress" aria-hidden="true"><i style="width:${(pct*100).toFixed(1)}%"></i></div>`:'';
  return `<div class="poster" tabindex="0" role="button" aria-label="${esc(it.title)} (${esc(it.year)}) — ${esc(t('poster.view_details'))}" data-id="${esc(it.id)}" data-type="${esc(it.type||'movie')}" data-t="${esc(it.title)}" data-y="${esc(it.year)}" data-r="${esc(it.rating)}" data-g="${esc(it.genre)}" data-p="${esc(img)}" data-s="${seed}"${addonAttrs}>
    ${removeBtn}
    <div class="art" style="background:${bg}">
      <div class="t">${esc(it.title)}</div>
      ${imgTag}
    </div>
    ${(it.type==='tv'||it.type==='series')?`<div class="tvtag mono" aria-label="Series">TV</div>`:''}
    <div class="rate mono ${rateClass(it.rating)}">${esc(rateText(it.rating))}</div>
    ${progBar}
    <div class="ov">
      <div class="ov-title">${esc(it.title)}</div>
      <div class="ov-meta"><span>${esc(it.year)}</span>${it.rating?`<span class="ov-star">★ ${esc(it.rating)}</span>`:''}</div>
      <span class="pill">${esc(I18N.genre(it.genre))}</span>
      <span class="stream">${esc(t('poster.stream'))}</span>
    </div></div>`;
}
/* wrap a poster cover in a thumbnail-row card that carries a small white title
   label beneath the artwork (used by the horizontal home/continue/offline rails;
   the drill-down grid keeps its own .gcard caption instead). */
function pcard(it,seed,opts){
  return `<div class="pcard">${posterHTML(it,seed,opts)}</div>`;
}

/* ---------- home: seven categorised rows + featured hero ---------- */
const LOGO_BASE='https://image.tmdb.org/t/p/w300';
/* studio cards → server-side STUDIO_COMPANIES key. Logos are TMDB company logos
   rendered full-colour on a light plate (see .studio-card CSS — flattening them to
   white silhouettes turned emblem marks into blobs). Order matches the layout. */
/* `scale` optically equalises each logo (calibrated against TMDB w300 aspect ratios:
   Marvel 4.48, DreamWorks 1.69, Pixar 4.76, Warner 1.09, DC 1.00, Sony 6.50, Universal
   1.89, Disney 2.97, Fox 1.25, Paramount 1.28). See .studio-card img CSS. */
const STUDIOS=[
  {key:'marvel',     name:'Marvel Studios',      logo:'/hUzeosd33nzE5MCNsZxCGEKTXaQ.png', scale:1.02},
  {key:'dreamworks', name:'DreamWorks',          logo:'/3BPX5VGBov8SDqTV7wC1L1xShAS.png', scale:0.93},
  {key:'pixar',      name:'Pixar',               logo:'/1TjvGVDMYsj6JBxOAkUHpPEwLf7.png', scale:1.02},
  {key:'warner',     name:'Warner Bros.',        logo:'/zhD3hhtKB5qyv7ZeL4uLpNxgMVU.png', scale:1.10},
  {key:'dc',         name:'DC',                  logo:'/4Y00XuSMuP1gimd0jP6JT57QbCI.png', scale:1.10},
  {key:'sony',       name:'Sony Pictures',       logo:'/xAb1o9HrSvKBo9mnXC8fJKDNu00.png', scale:1.02},
  {key:'universal',  name:'Universal',           logo:'/8lvHyhjr8oUKOOy2dKXoALWKdp0.png', scale:0.88},
  {key:'disney',     name:'Disney',              logo:'/wdrCwmRnLFJhEoH8GSfymY85KHT.png', scale:0.97},
  {key:'fox',        name:'20th Century FOX',    logo:'/qZCc1lty5FzX30aOCVRBLzaVmcp.png', scale:1.08},
  {key:'paramount',  name:'Paramount Pictures',  logo:'/jay6WcMgagAklUt7i9Euwj1pzTF.png', scale:1.07},
];
/* the seven rows, in order; the studio row is injected after Top Rated Anime */
const HOME_ROWS=[
  {cat:'trending_movie', key:'sec.trending_movies'},
  {cat:'trending_tv',    key:'sec.trending_shows'},
  {cat:'top_movie',      key:'sec.top_movies'},
  {cat:'top_tv',         key:'sec.top_shows'},
  {cat:'trending_anime', key:'sec.trending_anime'},
  {cat:'top_anime',      key:'sec.top_anime'},
  // streaming-service rows — each merges the service's movies + shows (server-side)
  {cat:'prov_netflix',     key:'sec.netflix'},
  {cat:'prov_disney',      key:'sec.disney'},
  {cat:'prov_prime',       key:'sec.prime'},
  {cat:'prov_apple',       key:'sec.apple'},
  {cat:'prov_max',         key:'sec.max'},
  {cat:'prov_paramount',   key:'sec.paramount'},
  {cat:'prov_crunchyroll', key:'sec.crunchyroll'},
  {studio:true,          key:'sec.studios'},   // studio logo row, after the streaming-service rows
];

/* ---- "Catalog Rows" add-on: the six Trending / Top-Rated rows on the home screen ----
   Unlike Upcoming/Studios (one row each), this add-on governs the whole block of
   built-in category rows and is *configurable*: its Configure modal lets you check
   which of the six rows appear. The add-on's own install state gates the whole block
   (remove → none of the six show); the per-row checkbox choice persists separately.
   Declared here (above renderHome/bootHome) because a no-intro boot calls renderHome()
   synchronously during this script's first pass — these consts must already be
   initialised by then, or renderHome's filter hits a temporal-dead-zone ReferenceError
   and the whole home paints empty. (catalogInstalled/RowEnabled are read at call time.) */
const CATALOG_ROW_CATS=['trending_movie','trending_tv','top_movie','top_tv','trending_anime','top_anime'];
const CATALOG_ROWS_KEY='stredio.catalogRows';
/* which rows are enabled — defaults to all six on; an unknown/old entry stays on so an
   upgrade never silently hides a row. */
const CATALOG_ROWS_ON=(function(){
  const on={}; CATALOG_ROW_CATS.forEach(c=>on[c]=true);
  try{ const raw=localStorage.getItem(CATALOG_ROWS_KEY);
    if(raw){ const s=JSON.parse(raw); CATALOG_ROW_CATS.forEach(c=>{ if(typeof s[c]==='boolean') on[c]=s[c]; }); } }
  catch(e){}
  return on;
})();
function saveCatalogRows(){ try{ localStorage.setItem(CATALOG_ROWS_KEY,JSON.stringify(CATALOG_ROWS_ON)); }catch(e){} }
/* Is the "Catalog Rows" add-on installed? Defaults to true if ADDONS isn't ready yet
   (installed-by-default), so an early renderHome() during boot still builds the rows. */
function catalogInstalled(){
  try{ const a=(typeof ADDONS!=='undefined')&&ADDONS.find(x=>x.id==='catalog'); return a?!!a.installed:true; }
  catch(e){ return true; }
}
function catalogRowEnabled(cat){ return CATALOG_ROWS_ON[cat]!==false; }
/* Repaint the home rows after the add-on is toggled or its row selection changes —
   only when the home is already built (a no-op elsewhere; renderHome rebuilds #strips
   from scratch, honouring the new filter). */
function renderCatalogSection(){
  const host=document.getElementById('strips');
  if(host&&host.children.length){ try{ renderHome(); }catch(e){} }
}

/* ---- "Streaming Services" add-on: the seven provider rows on the home screen ----
   Mirrors the Catalog-Rows add-on exactly, but for the streaming-service rows
   (Netflix, Disney+, Prime Video, Apple TV+, Max, Paramount+, Crunchyroll). Declared
   here (above renderHome/bootHome) for the same temporal-dead-zone reason as the
   catalog block — a no-intro boot reads these during renderHome's first pass. */
const PROVIDER_ROW_CATS=['prov_netflix','prov_disney','prov_prime','prov_apple','prov_max','prov_paramount','prov_crunchyroll'];
const PROVIDER_ROWS_KEY='stredio.providerRows';
const PROVIDER_ROWS_ON=(function(){
  const on={}; PROVIDER_ROW_CATS.forEach(c=>on[c]=true);
  try{ const raw=localStorage.getItem(PROVIDER_ROWS_KEY);
    if(raw){ const s=JSON.parse(raw); PROVIDER_ROW_CATS.forEach(c=>{ if(typeof s[c]==='boolean') on[c]=s[c]; }); } }
  catch(e){}
  return on;
})();
function saveProviderRows(){ try{ localStorage.setItem(PROVIDER_ROWS_KEY,JSON.stringify(PROVIDER_ROWS_ON)); }catch(e){} }
function providersInstalled(){
  try{ const a=(typeof ADDONS!=='undefined')&&ADDONS.find(x=>x.id==='providers'); return a?!!a.installed:true; }
  catch(e){ return true; }
}
function providerRowEnabled(cat){ return PROVIDER_ROWS_ON[cat]!==false; }
function renderProviderSection(){
  const host=document.getElementById('strips');
  if(host&&host.children.length){ try{ renderHome(); }catch(e){} }
}

/* clickable category header → opens the drill-down grid. The studio header is
   static (its individual logo cards are the links). */
function stripHeadHTML(row){
  const label=esc(t(row.key));
  if(row.studio) return `<div class="strip-head"><span class="strip-title static mono">${label}</span></div>`;
  return `<div class="strip-head"><button class="strip-title mono" type="button" data-cat="${esc(row.cat)}" data-key="${esc(row.key)}" aria-label="${label} — ${esc(t('cat.see_all'))}">${label} <span class="arr" aria-hidden="true"></span></button></div>`;
}
function studioRowHTML(){
  return STUDIOS.map(s=>
    `<div class="studio-card" tabindex="0" role="button" data-studio="${esc(s.key)}" data-name="${esc(s.name)}" aria-label="${esc(s.name)} — ${esc(t('cat.browse_titles'))}">
      <img src="${LOGO_BASE}${esc(s.logo)}" loading="lazy" alt="${esc(s.name)} logo" style="--logo-scale:${s.scale||1}" onerror="this.style.display='none';this.nextElementSibling.style.cssText='opacity:1;position:static;background:none'"/>
      <span class="studio-name">${esc(s.name)}</span>
    </div>`).join('');
}

/* ---------- upcoming marquee (movies + series) ----------
   A compact (188×112) landscape cover. Carries the same data-* payload
   as a poster so the upcoming-row handler opens its details on click, and reveals a
   year · ★rating · genre meta row on hover/focus — the "card information" affordance. */
function upcomingCardHTML(m,i){
  const img=m.backdrop||m.poster||'';
  const art=img
    ? `<img src="${esc(img)}" loading="lazy" alt="" onerror="this.remove()"/>`
    : `<div class="uc-fallback">${esc(m.title)}</div>`;
  // Upcoming cards always use the wide-tracked text title (no TMDB logo art).
  const titleMark=`<span class="uc-title">${esc(m.title)}</span>`;
  const genre=m.genre?`<span class="uc-genre">${esc(I18N.genre(m.genre))}</span>`:'';
  const info=`<div class="uc-info"><span>${esc(m.year)}</span>${genre}</div>`;
  // Interactive card — same dataset a poster carries, read by the #upcomingRow handler.
  return `<div class="upcoming-card" tabindex="0" role="button"
      aria-label="${esc(m.title)} (${esc(m.year)}) — ${esc(t('poster.view_details'))}"
      data-id="${esc(m.id)}" data-type="${esc(m.type||'movie')}" data-t="${esc(m.title)}"
      data-y="${esc(m.year)}" data-r="${esc(m.rating)}" data-g="${esc(m.genre)}"
      data-p="${esc(m.poster||m.backdrop||'')}" data-s="${i||0}">
    ${art}
    <div class="uc-grad"></div>
    <div class="uc-meta">${titleMark}${info}</div>
  </div>`;
}
/* Normalise a title-logo to a uniform OPTICAL footprint. TMDB logos have wildly
   different aspect ratios (a 7:1 wordmark vs a 1:1 emblem), so a fixed height makes
   the wide ones dominate. Instead we size each so its geometric mean √(w·h) equals
   UM_LOGO — equal visual "mass" — then clamp to a box so nothing overflows the card.
   (Same idea as the studio cards' per-logo --logo-scale, computed live here.) */
const UM_LOGO=27, UM_LOGO_MAXW=134, UM_LOGO_MAXH=27;
function umFitLogo(img){
  const nw=img.naturalWidth, nh=img.naturalHeight;
  if(!nw||!nh) return;
  const a=nw/nh, rt=Math.sqrt(a);
  let w=UM_LOGO*rt, h=UM_LOGO/rt;                 // √(w·h)=UM_LOGO for every logo
  const k=Math.min(1, UM_LOGO_MAXW/w, UM_LOGO_MAXH/h);   // shrink-to-fit, keep aspect
  img.style.width=(w*k)+'px'; img.style.height=(h*k)+'px';
}
/* two top-of-page auto-scrolling strips — Movies (scrolls right→left) above Series
   (scrolls left→right via .um-rev). Each header opens its own drill-down. */
function upcomingStripHTML(){
  return `<div class="strip reveal in" data-row="upcoming-movie">${stripHeadHTML({cat:'upcoming_movie',key:'sec.upcoming_movies'})}<div class="um-rail"><div class="um-track" id="umTrack"></div></div></div>`
       + `<div class="strip reveal in" data-row="upcoming-series"><div class="um-rail"><div class="um-track um-rev" id="umTrack2"></div></div></div>`;
}
/* fill a marquee track with the card list duplicated once (for a seamless wrap) and
   drive it with a Web Animations API loop whose duration is derived from one copy's
   width, so the scroll speed stays ~medium (UM_SPEED px/sec) regardless of title
   count. WAAPI (rather than a CSS animation) keeps the scroll position across the
   home view being hidden then re-shown — see the .um-track CSS note. */
const UM_SPEED=130;   // px/sec — fast auto-scroll
const UM_REDUCE=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)');
function fillUpcoming(track,list){
  const strip=track&&track.closest('.strip');
  if(!track) return;
  if(!list.length){ if(strip) strip.remove(); return; }   // nothing upcoming → drop the row
  // One marquee "copy" must be at least a viewport wide, or the seamless loop
  // leaves a visible gap. Repeat a short list until it spans the screen, then the
  // ×2 below makes the wrap seamless.
  const unit=188+14, need=Math.ceil((window.innerWidth||1280)/unit)+1;
  let copy=list.slice(); while(copy.length<need) copy=copy.concat(list);
  const cards=copy.map((m,i)=>upcomingCardHTML(m,i)).join('');
  track.innerHTML=cards+cards;                              // two copies → seamless wrap
  if(track._umAnim){ try{track._umAnim.cancel();}catch(e){} track._umAnim=null; }  // re-fill (boot runs twice): drop the old loop
  // Build the loop on the next frame so the track width is measured. But it can only
  // be measured while the track is actually visible — if the marquee is (re)filled
  // while the home view is hidden (e.g. toggling the Upcoming add-on from the #addons
  // page), scrollWidth is 0 and the period maths collapses, so we defer and let
  // showHome() build it when Home is shown. See startUpcomingAnim().
  requestAnimationFrame(()=>startUpcomingAnim(track));
}
/* Build (once) the seamless-scroll WAAPI loop for a marquee track. Idempotent and
   guarded on visibility, so it's safe to call from fillUpcoming() AND from showHome()
   (which retries any track that couldn't be measured while the home view was hidden). */
function startUpcomingAnim(track){
  if(!track||track._umAnim) return;            // missing or already looping
  if(UM_REDUCE&&UM_REDUCE.matches) return;     // reduced-motion → no auto-scroll at all
  if(track.offsetParent===null) return;        // hidden (display:none ancestor) → can't measure; showHome() will retry
  // The loop period is one copy's content width + one gap (the distance from a
  // card to its duplicate). copyW = (scrollWidth - one seam gap)/2; period adds
  // the gap back. Translate by exactly -period so the wrap is invisible (the
  // .um-rev row plays the same keyframes in reverse, so the maths is identical).
  const GAP=14, copyW=(track.scrollWidth-GAP)/2, period=copyW+GAP;
  if(copyW<=0) return;                          // un-measured/empty track → nothing to scroll
  const rev=track.classList.contains('um-rev');
  track._umAnim=track.animate(
    [{transform:'translateX(0)'},{transform:'translateX(-'+period+'px)'}],
    {duration:(period/UM_SPEED)*1000, iterations:Infinity, easing:'linear', direction:rev?'reverse':'normal'}
  );
  // Pause while the rail is hovered or holds keyboard focus so a card can be read /
  // clicked without sliding away (was a CSS :hover/:focus-within rule; WAAPI needs
  // it wired in JS). Each rail is wired once.
  const rail=track.closest('.um-rail');
  if(rail&&!rail._umHoverWired){
    rail._umHoverWired=true;
    const pause=()=>{ if(track._umAnim) track._umAnim.pause(); };
    const play =()=>{ if(track._umAnim&&!rail.matches(':hover, :focus-within')) track._umAnim.play(); };
    rail.addEventListener('mouseenter',pause); rail.addEventListener('mouseleave',play);
    rail.addEventListener('focusin',pause);    rail.addEventListener('focusout',play);
  }
}
/* fetch one upcoming category into its track; a row that returns nothing drops out */
async function loadUpcomingTrack(trackId,cat){
  const track=document.getElementById(trackId);
  try{
    const r=await fetch(`/api/browse?cat=${cat}&page=1&lang=${I18N.lang()}`);
    if(!r.ok) throw new Error(cat+' '+r.status);
    const data=await r.json();
    // keep only titles with art so the landscape covers always render
    const list=(data.results||[]).filter(m=>m.backdrop||m.poster);
    fillUpcoming(track,list);
  }catch(e){ const s=track&&track.closest('.strip'); if(s) s.remove(); }
}
function loadUpcomingRow(){
  loadUpcomingTrack('umTrack','upcoming_movie');     // row 1: movies (right→left)
  loadUpcomingTrack('umTrack2','upcoming_series');   // row 2: series (left→right)
}
/* Paint (or clear) the home Upcoming marquee, gated on the "Upcoming Radar"
   add-on. Called by renderHome() and again whenever the add-on is toggled in the
   catalog, so install/remove takes effect live without a reload. */
function renderUpcomingSection(){
  const up=document.getElementById('upcomingRow'); if(!up) return;
  if(upcomingInstalled()){ up.innerHTML=upcomingStripHTML(); loadUpcomingRow(); }
  else { up.innerHTML=''; }
}
/* Insert (or remove) the home STUDIOS logo row live, gated on the "Studios" add-on.
   Unlike the upcoming marquee (its own container), the studio row is interleaved in
   #strips after the streaming-service rows — so on a live toggle we splice it in just
   after the last provider row (before any installed add-on catalog rows), or append if
   those dropped out, and remove it when the add-on is turned off. renderHome() already
   filters it at build time, so this only matters for a toggle while the home is painted. */
function renderStudioSection(){
  const host=document.getElementById('strips');
  if(!host||!host.children.length) return;        // home not built yet → renderHome handles it
  const existing=host.querySelector('.strip[data-row="studio"]');
  if(studiosInstalled()){
    if(existing) return;                          // already shown
    const el=document.createElement('div');
    el.className='strip reveal in';
    el.setAttribute('data-row','studio');
    el.innerHTML=stripHeadHTML({studio:true,key:'sec.studios'})+railHTML(studioRowHTML());
    const provs=[...host.querySelectorAll('.strip')].filter(s=>/^prov_/.test(s.dataset.row||''));
    const lastProv=provs[provs.length-1];
    host.insertBefore(el,lastProv?lastProv.nextSibling:null);   // after last provider row (null → append)
    initStripRails();
  }else if(existing){ existing.remove(); }
}
/* tile a short list until it spans the viewport so a row never stops short on a
   wide display (mirrors the old addon-strip padding logic) */
function tileToWidth(list){
  if(!list.length) return list;
  const need=Math.ceil((window.innerWidth||1280)/(160+14))+1;
  const out=[]; while(out.length<Math.max(need,list.length)) out.push(...list);
  return out;
}
function fillRail(strip,list){
  if(!strip) return;
  if(!list.length){ strip.remove(); return; }     // a category that returned nothing drops out
  const row=strip.querySelector('.strip-row'); if(!row) return;
  row.innerHTML=tileToWidth(list).map((m,i)=>pcard(m,i)).join('');
  const rail=strip.querySelector('.strip-rail'); if(rail) syncRail(rail);
}
async function loadHomeRow(row,strip){
  try{
    const r=await fetch(`/api/browse?cat=${encodeURIComponent(row.cat)}&page=1&lang=${I18N.lang()}`);
    if(!r.ok) throw new Error('row '+r.status);
    const data=await r.json();
    const list=(data.results||[]).filter(m=>m.poster);
    fillRail(strip,list);
    return list;
  }catch(e){ if(strip) strip.remove(); return []; }   // drop a failed row, don't strand a skeleton
}
/* Append a horizontal row for every catalog declared by an installed add-on
   (sports, live channels, niche catalogs…) below the built-in TMDB rows. The
   server enumerates them (/api/addon-catalogs) and serves each catalog's
   contents normalised to the poster-card shape (/api/addon-catalog). Cards are
   tagged _addon so a click opens the direct-to-sources sheet, not the TMDB modal. */
async function appendAddonRows(){
  const host=document.getElementById('strips'); if(!host) return;
  host.querySelectorAll('[data-row^="addon:"]').forEach(el=>el.remove());   // clear any prior pass (e.g. language switch)
  // Enumerate catalogs from the user's installed collection — no server round-trip.
  let cats=[];
  for(const a of (window.INSTALLED_ADDONS||[])){
    if(!addonHasResource(a,'catalog'))continue;
    for(const c of ((a.manifest&&a.manifest.catalogs)||[]))
      cats.push({addonId:a.id,addonName:a.manifest.name,type:c.type,id:c.id,name:c.name,url:a.url});
  }
  // Skip the built-in/default add-ons: Cinemeta's catalogs already power the seven
  // home rows; an installed stream add-on is a stream source, not a home catalog.
  // Only genuinely user-installed third-party catalogs (e.g. Nebula Sports) get rows.
  cats=cats.filter(c=>!CURATED_BACKEND_IDS.includes(c.addonId));
  if(!cats.length) return;
  const n=skRowCount();
  for(const c of cats){
    const label=c.name||c.addonName||'Add-on';
    const strip=document.createElement('div');
    strip.className='strip reveal in';
    strip.dataset.row='addon:'+c.addonId+':'+c.type+':'+c.id;
    strip.innerHTML=`<div class="strip-head"><span class="strip-title static mono">${esc(label)}</span></div>`
      +railHTML(Array.from({length:n},skPoster).join(''));
    host.appendChild(strip);
    loadAddonRow(c,strip);
  }
  initStripRails();
}
async function loadAddonRow(c,strip){
  try{
    // Browser → the add-on's catalog endpoint directly.
    const data=await fetchAddonJSON(addonBaseUrl(c.url),`catalog/${c.type}/${encodeURIComponent(c.id)}.json`);
    // keep only poster-bearing items (a rail needs art), and tag them as add-on cards
    const list=(data.metas||[]).map(mapStremioMetaC).filter(m=>m.poster)
      .map(m=>({...m,type:c.type,_addon:true,_addonName:c.addonName||''}));
    fillRail(strip,list);                     // drops the strip if nothing renders
    const rail=strip.querySelector('.strip-rail'); if(rail)wireRail(rail);
  }catch(e){ strip.remove(); }
}
/* build the seven rows (studio row populated immediately, the six TMDB rows as
   skeletons), fetch the categories in parallel, and seed the hero from the first
   row that has backdrop art. */
function renderHome(){
  const host=document.getElementById('strips'); if(!host) return;
  const n=skRowCount();
  // Upcoming-movies marquee lives in its own container above; Continue Watching slots
  // between it and the categorised rows. #strips holds only the HOME_ROWS rails.
  // The marquee is gated on the "Upcoming Radar" add-on (renderUpcomingSection).
  renderUpcomingSection();
  // The STUDIOS logo row is gated on the "Studios" add-on, like the upcoming marquee.
  // The six Trending / Top-Rated rows are gated on the "Catalog Rows" add-on AND its
  // per-row selection; provider rows are always built.
  const rows=HOME_ROWS.filter(row=>{
    if(row.studio) return studiosInstalled();
    if(CATALOG_ROW_CATS.includes(row.cat)) return catalogInstalled()&&catalogRowEnabled(row.cat);
    if(PROVIDER_ROW_CATS.includes(row.cat)) return providersInstalled()&&providerRowEnabled(row.cat);
    return true;
  });
  host.innerHTML=rows.map(row=>{
    const body=row.studio?railHTML(studioRowHTML()):railHTML(Array.from({length:n},skPoster).join(''));
    return `<div class="strip reveal in" data-row="${row.studio?'studio':esc(row.cat)}">${stripHeadHTML(row)}${body}</div>`;
  }).join('');
  initStripRails();
  renderContinueWatching();   // signed-in resume rail, directly below the upcoming marquee
  appendAddonRows();   // installed add-on catalog rows (sports/channels/etc.), below the built-in rows — non-blocking
  const strips=[...host.querySelectorAll('.strip')];   // #strips holds the rendered `rows`, aligned 1:1
  let heroDone=false;
  // The hero is driven by /api/hero — admin-curated (manual movies/series) or, by
  // default, this week's trending movies. It's the authoritative source and wins
  // over any row-seeded hero, so a manual pick is always honoured. If it fails or
  // returns nothing (offline/demo), we fall back to seeding from the first
  // backdrop-bearing row so the banner is never empty.
  let heroFromApi=false;
  // one-shot "a hero banner has been painted" signal, so the intro reveal can wait for it
  let heroResolve; const heroReady=new Promise(r=>{ heroResolve=r; });
  // /api/hero is authoritative and normally fast. Let it settle (paint or bow out)
  // BEFORE any row backdrop may stand in — otherwise a quick row paints a cover that
  // the API instantly swaps out, which is the "different covers flash" seen on a fast
  // F5 reload. A grace window keeps a genuinely stalled API from holding the hero hostage.
  const apiSettled=loadHeroFeature().then(shown=>{ if(shown){ heroFromApi=true; heroDone=true; heroResolve(); } });
  const seedGate=Promise.race([apiSettled, new Promise(r=>setTimeout(r,2000))]);
  // seed the hero from the first backdrop-bearing row to resolve (trending movies
  // usually wins) so one slow row — e.g. a long Georgian translation batch — never
  // holds the hero hostage, once the API has had its say.
  const jobs=rows.map((row,i)=>{
    if(row.studio) return Promise.resolve(null);
    const p=loadHomeRow(row,strips[i]);
    p.then(list=>{
      if(!list||!list.some(m=>m.backdrop)) return;
      seedGate.then(()=>{
        if(heroDone) return;   // API already painted the authoritative hero → no stand-in swap
        heroDone=true; renderHero(list); markRevealsInView(); heroResolve();
      });
    });
    return p;
  });
  const rowsReady=Promise.all(jobs).then(async lists=>{
    if(!lists.some(l=>l&&l.length)){ if(!heroFromApi&&rows.length) renderOfflineHome(); heroResolve(); return; }   // no TMDB / offline → demo catalog (but not when the user removed every content row)
    await seedGate;
    if(!heroDone){ const f=lists.find(l=>l&&l.length); if(f){ renderHero(f); markRevealsInView(); } heroResolve(); }
  });
  // resolve once the row fetches have settled AND a hero banner has been painted
  return Promise.all([rowsReady, heroReady]);
}
/* Pull the curated/auto hero from the server and paint it. Returns true when a
   hero was shown. The selection is shared across both languages (the server only
   localises per request), so KA and EN see the same titles. */
async function loadHeroFeature(){
  try{
    const r=await fetch(`/api/hero?lang=${I18N.lang()}`);
    if(!r.ok) return false;
    const d=await r.json();
    const list=(d&&d.results||[]).filter(m=>m&&(m.backdrop||m.poster));
    if(!list.length) return false;
    renderHero(list,{ordered:true}); markRevealsInView();
    return true;
  }catch(e){ return false; }
}
/* wrap a row of poster cards in a full-bleed rail with left/right scroll arrows
   and a custom scroll line (thumb feathers in/out at both ends) */
function railHTML(cards){
  return `<div class="strip-rail"><button class="strip-arrow l" data-dir="-1" aria-label="${esc(t('ui.scroll_left'))}">‹</button><div class="strip-row">${cards}</div><button class="strip-arrow r" data-dir="1" aria-label="${esc(t('ui.scroll_right'))}">›</button><div class="strip-scroll" aria-hidden="true"><div class="strip-scroll-thumb"></div></div></div>`;
}
/* show/hide the arrows at the row's start/end so you can't scroll past the ends,
   and size/position the custom scroll-line thumb to mirror the scroll state */
function syncRail(rail){
  const row=rail.querySelector('.strip-row'),
        l=rail.querySelector('.strip-arrow.l'), r=rail.querySelector('.strip-arrow.r');
  if(!row||!l||!r) return;
  const span=row.scrollWidth-row.clientWidth;   // total scrollable distance
  const max=span-1;
  l.disabled = row.scrollLeft<=0;
  r.disabled = row.scrollLeft>=max;
  const track=rail.querySelector('.strip-scroll'),
        thumb=rail.querySelector('.strip-scroll-thumb');
  if(track&&thumb){
    if(span<=0){ track.hidden=true; return; }   // nothing to scroll → no line
    track.hidden=false;
    const ratio=row.clientWidth/row.scrollWidth;          // visible fraction = thumb width
    const pos=row.scrollLeft/span;                         // 0..1 along the track
    thumb.style.width=(ratio*100)+'%';
    thumb.style.left=(pos*(100-ratio*100))+'%';
  }
}
/* wire scroll arrows + custom scroll-line on a single rail (idempotent) */
function wireRail(rail){
  if(rail.__wired) return; rail.__wired=true;
  const row=rail.querySelector('.strip-row');
  row.addEventListener('scroll',()=>syncRail(rail),{passive:true});
  rail.querySelectorAll('.strip-arrow').forEach(btn=>btn.addEventListener('click',()=>{
    const amt=Math.max(row.clientWidth*0.8,174);   // ~poster(160)+gap(14) minimum
    row.scrollBy({left:(+btn.dataset.dir)*amt,behavior:'smooth'});
  }));
  syncRail(rail);
}
/* wire any not-yet-initialised home rails (called after each render) — covers both the
   categorised rows in #strips and the Continue Watching rail above them */
function initStripRails(){ document.querySelectorAll('#strips .strip-rail, #continueRow .strip-rail').forEach(wireRail); }
addEventListener('resize',()=>document.querySelectorAll('#strips .strip-rail, #continueRow .strip-rail').forEach(syncRail));

/* ---------- Continue Watching rail (signed-in only) ----------
   Drawn from the per-account watch-history store; the most recent titles, capped for a
   single rail. Hidden entirely when signed out or empty, so a fresh/guest home looks
   exactly as before. Posters reuse posterHTML, so a click reopens the detail/streams
   modal to resume.

   The store holds a snapshot (title + cover) captured in whatever language was active
   when the title was watched. Like every other home row, the rail must localise to the
   CURRENT language — so on render we re-fetch each title's localized cover + name from
   /api/meta (cached per id+lang) and swap it in. The stored snapshot paints instantly
   first (no layout shift / blank rail), exactly as the catalog rows skeleton-then-fill. */
const CONTINUE_CAP=20;
const cwLocCache={};   // `${id}|${lang}` -> {title, poster} localized metadata, per session
function cwMetaUrl(m,lang){
  const isTv=(m.type==='tv'||m.type==='series');
  return `/api/meta/${encodeURIComponent(m.id)}?${isTv?'type=tv&':''}lang=${lang}`;
}
async function localizeContinue(list,lang){
  await Promise.all(list.map(async m=>{
    if(!m.id||String(m.id).startsWith('mock-')) return;   // no live metadata for demo entries
    const key=m.id+'|'+lang; if(cwLocCache[key]) return;
    try{
      const r=await fetch(cwMetaUrl(m,lang)); if(!r.ok) return;
      const meta=await r.json();
      cwLocCache[key]={ title:meta.title||m.title, poster:meta.poster||m.poster };
    }catch(e){}
  }));
}
function renderContinueWatching(){
  const host=document.getElementById('continueRow'); if(!host) return;
  const list=(window.AUTH&&AUTH.user)?watchHistory().slice(0,CONTINUE_CAP):[];
  if(!list.length){ host.hidden=true; host.innerHTML=''; return; }
  const lang=I18N.lang();
  const paint=()=>{
    const cards=list.map((m,i)=>{
      const loc=cwLocCache[m.id+'|'+lang];   // localized cover+name when we have it; else the snapshot
      const r=entryResume(m);                // saved timecode → resume bar (null when none)
      return pcard({ id:m.id, title:(loc&&loc.title)||m.title, year:m.year, type:m.type,
        genre:m.genre, rating:m.rating, poster:(loc&&loc.poster)||m.poster },i,
        {removable:true, progress:r?r.pct:0});
    }).join('');
    host.innerHTML=`<div class="strip reveal in" data-row="continue">`+
      `<div class="strip-head"><span class="strip-title static mono">${esc(t('sec.continue'))}</span></div>`+
      railHTML(cards)+`</div>`;
    host.hidden=false;
    const rail=host.querySelector('.strip-rail'); if(rail) wireRail(rail);
  };
  paint();                                   // instant: cached-localized or the stored snapshot
  localizeContinue(list,lang).then(()=>{     // swap in localized covers for the current language
    if(!(window.AUTH&&AUTH.user)) return;    // signed out while fetching
    if(I18N.lang()!==lang) return;           // language switched again → its own render handles it
    paint();
  });
}

/* ---------- featured hero banner ---------- */
const heroEl=()=>document.getElementById('hero');
/* a small persisted "My List" the hero's + button toggles */
const MYLIST_KEY='sf:mylist';
function myList(){ try{ return JSON.parse(localStorage.getItem(MYLIST_KEY)||'[]'); }catch(e){ return []; } }
function inMyList(id){ return myList().some(x=>x.id===id); }
function toggleMyList(item){
  const list=myList(); const i=list.findIndex(x=>x.id===item.id); let added;
  if(i>=0){ list.splice(i,1); added=false; }
  else { list.push({id:item.id,title:item.title,year:item.year,type:item.type||'movie',
    genre:item.genre,rating:item.rating,poster:item.poster||''}); added=true; }
  try{ localStorage.setItem(MYLIST_KEY,JSON.stringify(list)); }catch(e){}
  return added;
}

/* ---------- watch history (per-account, on-device) ----------
   Backs the Continue Watching rail. Recorded the moment playback starts (a real stream
   OR the demo clip). The store is namespaced by the signed-in email so two accounts
   sharing one browser don't see each other's list, and is only written while signed in.
   Most-recent-first, de-duped by title id, capped at HISTORY_CAP. */
const HISTORY_CAP=60;
function historyKey(){ const u=(window.AUTH&&AUTH.user&&AUTH.user.email)||'guest'; return 'sf:history:'+u; }
function watchHistory(){ try{ return JSON.parse(localStorage.getItem(historyKey())||'[]'); }catch(e){ return []; } }
function saveHistory(list){ try{ localStorage.setItem(historyKey(),JSON.stringify(list)); }catch(e){} }
/* drop one title from the Continue Watching rail (the corner ✕ on each card) */
function removeFromHistory(id){
  if(!id) return;
  // tombstone the removal so it syncs as a delete (not resurrected from another device)
  const tomb=removedAll(); tomb[String(id)]=Date.now(); removedSave(tomb);
  saveHistory(watchHistory().filter(x=>String(x.id)!==String(id)));
  renderContinueWatching();
  syncPush();
}
function recordWatch(){
  if(!(window.AUTH&&AUTH.user)) return;                 // history is a signed-in feature
  const m=window.currentTitleMeta; if(!m||!m.id) return;
  const list=watchHistory().filter(x=>x.id!==m.id);     // an existing entry floats back to the top
  const isSeries=window.currentMediaType==='series'&&window.seriesCtx&&seriesCtx.active&&seriesCtx.season!=null&&seriesCtx.ep!=null;
  // `key` is the resume media-key (movie id, or id:S#E# for the exact episode) so the rail
  // bar + the player's auto-resume read the same position; season/episode let RESUME jump
  // straight back into the right episode of a series.
  list.unshift({ id:m.id, title:m.title||'', poster:m.poster||'', year:m.year||'', type:m.type||'movie',
                 genre:m.genre||'', rating:m.rating||'', ep:window.currentEpLabel||'',
                 key:curMediaKey(), at:Date.now(),       // `at` drives cross-device merge ordering
                 season:isSeries?seriesCtx.season:null, episode:isSeries?seriesCtx.ep:null });
  saveHistory(list.slice(0,HISTORY_CAP));
  // re-watching a previously removed title clears its tombstone so it returns to the rail
  const tomb=removedAll(); if(tomb[String(m.id)]){ delete tomb[String(m.id)]; removedSave(tomb); }
  syncPush();
}

/* ---------- resume progress (timecode) — per-account, on-device ----------
   A sibling store to watch history: a map of mediaKey → {pos, dur, at}. mediaKey is the
   title id for a movie, or `${id}:S${season}E${ep}` for one series episode — so a show
   resumes the exact episode you stopped on. Drives BOTH the Continue Watching progress
   bars AND the player's auto-resume seek. Namespaced by the signed-in email, like history. */
const PROGRESS_MIN=8;        // ignore the first few seconds (accidental opens / quick peeks)
const PROGRESS_DONE=0.94;    // ≥94% watched (or within the last ~12s) counts as finished
function progressStoreKey(){ const u=(window.AUTH&&AUTH.user&&AUTH.user.email)||'guest'; return 'sf:progress:'+u; }
function progressAll(){ try{ return JSON.parse(localStorage.getItem(progressStoreKey())||'{}'); }catch(e){ return {}; } }
function progressSaveAll(map){ try{ localStorage.setItem(progressStoreKey(),JSON.stringify(map)); }catch(e){} }
function getProgress(key){ if(!key) return null; const p=progressAll()[key]; return (p&&p.pos>0)?p:null; }
function putProgress(key,pos,dur){
  if(!key||!(pos>0)) return;
  const map=progressAll(); map[key]={pos:Math.round(pos),dur:Math.round(dur||0),at:Date.now()};
  // bound the store: keep the 240 most-recently-updated keys so it can't grow without limit
  const keys=Object.keys(map);
  if(keys.length>240){ keys.sort((a,b)=>(map[b].at||0)-(map[a].at||0)).slice(240).forEach(k=>delete map[k]); }
  progressSaveAll(map);
  syncPush();   // throttled (~25s) → cross-device resume without hammering the server
}
function delProgress(key){ if(!key) return; const map=progressAll(); if(map[key]!=null){ delete map[key]; progressSaveAll(map); } }
/* media key for whatever is playing right now (movie id, or id:S#E# for a series episode) */
function curMediaKey(){
  const m=window.currentTitleMeta; if(!m||!m.id) return '';
  if(window.currentMediaType==='series'&&window.seriesCtx&&seriesCtx.active&&seriesCtx.season!=null&&seriesCtx.ep!=null)
    return m.id+':S'+seriesCtx.season+'E'+seriesCtx.ep;
  return String(m.id);
}
/* resume info for a Continue Watching entry → {pos,dur,pct,key} or null when there's
   nothing meaningful to resume (no duration, barely started, or already finished). */
function entryResume(e){
  if(!e) return null;
  const key=e.key||String(e.id||'');
  const p=getProgress(key); if(!p||!(p.dur>0)) return null;
  const pct=p.pos/p.dur;
  if(pct<0.01||pct>PROGRESS_DONE) return null;
  return { pos:p.pos, dur:p.dur, pct:pct, key:key };
}
/* clock formatter for the modal RESUME label (the player has its own private fmt()) */
function fmtClock(t){ if(!isFinite(t)||t<0)t=0; t=Math.floor(t);
  const h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=t%60;
  return (h?h+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0'); }

/* ---------- cross-device sync: watch history + resume progress ----------
   localStorage stays the instant, offline-safe source of truth; the server doc
   (/api/library-state) is the shared copy. PULL on sign-in + when the tab regains
   focus (merge by recency); PUSH throttled to ~once/25s of activity, so a 2-hour
   watch is a handful of writes (gentle on Neon's free tier). Signed-in only —
   guests never sync. A per-account tombstone map (`sf:removed:<email>`) stops a
   title removed on one device from resurrecting off another device's older copy. */
const WATCH_PUSH_MS=25000;        // coalesce server writes to ~once / 25s of activity
const WATCH_PULL_MIN=15000;       // don't re-pull more often than this on focus
let _wPushT=null,_wPushPending=false,_wLastPull=0,_wPulling=false;
function _wAuthed(){ return !!(window.AUTH&&AUTH.user); }
function removedKey(){ const u=(window.AUTH&&AUTH.user&&AUTH.user.email)||'guest'; return 'sf:removed:'+u; }
function removedAll(){ try{ return JSON.parse(localStorage.getItem(removedKey())||'{}'); }catch(e){ return {}; } }
function removedSave(m){ try{ localStorage.setItem(removedKey(),JSON.stringify(m)); }catch(e){} }
function _mergeHist(a,b,tomb){
  const m=new Map();
  for(const e of [].concat(a||[],b||[])){ if(!e||e.id==null) continue;
    const id=String(e.id),p=m.get(id); if(!p||(+e.at||0)>(+p.at||0)) m.set(id,e); }
  return [...m.values()].filter(e=>{ const t=tomb[String(e.id)]; return !(t&&t>=(+e.at||0)); })
    .sort((x,y)=>(+y.at||0)-(+x.at||0)).slice(0,HISTORY_CAP);
}
function _mergeProg(a,b){
  const out={},A=a||{},B=b||{};
  for(const k of new Set([...Object.keys(A),...Object.keys(B)])){
    const x=A[k],y=B[k]; out[k]=(!x||(y&&(+y.at||0)>=(+x.at||0)))?(y||x):x; }
  const keys=Object.keys(out).sort((p,q)=>(+out[q].at||0)-(+out[p].at||0)).slice(0,240);
  const capped={}; for(const k of keys) capped[k]=out[k]; return capped;
}
function _mergeTomb(a,b){
  const out={},now=Date.now(),TTL=30*24*3600*1000;
  for(const src of [a||{},b||{}]) for(const id of Object.keys(src)){ const at=+src[id]||0; if(at>(out[id]||0)) out[id]=at; }
  for(const id of Object.keys(out)) if(now-out[id]>TTL) delete out[id];
  return out;
}
async function syncPull(){
  if(!_wAuthed()||_wPulling) return; _wPulling=true;
  try{
    const r=await fetch('/api/library-state'); if(!r.ok) return;
    const remote=await r.json();
    const tomb=_mergeTomb(removedAll(),remote.removed||{}); removedSave(tomb);
    saveHistory(_mergeHist(watchHistory(),remote.history||[],tomb));
    progressSaveAll(_mergeProg(progressAll(),remote.progress||{}));
    _wLastPull=Date.now();
    try{ renderContinueWatching(); }catch(e){}
  }catch(e){}
  finally{ _wPulling=false; }
}
function _wPushNow(keepalive){
  if(_wPushT){ clearTimeout(_wPushT); _wPushT=null; }
  _wPushPending=false; if(!_wAuthed()) return;
  const body=JSON.stringify({ history:watchHistory(), progress:progressAll(), removed:removedAll() });
  try{ fetch('/api/library-state',{method:'PUT',headers:{'Content-Type':'application/json'},body,keepalive:!!keepalive}).catch(()=>{}); }catch(e){}
}
function syncPush(){ if(!_wAuthed()) return; _wPushPending=true; if(!_wPushT) _wPushT=setTimeout(()=>_wPushNow(false),WATCH_PUSH_MS); }
function syncFlush(keepalive){ if(_wPushPending) _wPushNow(keepalive); }
function _wStop(){ if(_wPushT){ clearTimeout(_wPushT); _wPushT=null; } _wPushPending=false; }
addEventListener('visibilitychange',()=>{ if(!document.hidden&&_wAuthed()&&Date.now()-_wLastPull>WATCH_PULL_MIN) syncPull(); });
addEventListener('focus',()=>{ if(_wAuthed()&&Date.now()-_wLastPull>WATCH_PULL_MIN) syncPull(); });
addEventListener('pagehide',()=>{ try{ syncFlush(true); }catch(e){} });

/* ============================================================
   USER SETTINGS — / interface preferences.
   Stored locally per browser, applied live to the player and UI.
   Read at point-of-use by the player (autoplay, subtitles, external
   player); subtitle styling + the blur-unwatched class apply on change.
   ============================================================ */
const SETTINGS_KEY='stredio.settings.v1';
const SETTINGS_DEFAULTS={
  autoplayNext:true,      // roll into the next episode when credits end
  nextPopupSecs:35,       // how early the "Next episode" button surfaces
  subLang:'off',          // auto-enable a subtitle track in this language ('off' = none)
  subSize:100,            // ::cue font-size (%)
  subColor:'#ffffff',
  subBg:'transparent',
  subOutline:'#000000',
  subOutlineW:2,          // subtitle outline thickness in px (0 = none); drives the ::cue text-shadow
  blurUnwatched:false,    // blur stills of episodes you haven't started
  externalPlayer:'disabled', // disabled | vlc | infuse | outplayer | nplayer
  enhance:false,          // picture-enhance: CSS contrast/saturation bump + film-grain overlay
  enhanceLevel:50,        // enhance intensity 0–100 (drives filter strength + grain opacity)
  clarity:false,          // clarity: real SVG unsharp-mask sharpening on the video
  clarityLevel:40         // clarity intensity 0–100 (drives the sharpen kernel amount)
};
const SETTINGS=(function(){
  try{ return Object.assign({},SETTINGS_DEFAULTS,JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')); }
  catch(e){ return Object.assign({},SETTINGS_DEFAULTS); }
})();
function saveSettings(){ try{ localStorage.setItem(SETTINGS_KEY,JSON.stringify(SETTINGS)); }catch(e){} }
function setSetting(k,v){ SETTINGS[k]=v; saveSettings(); applySetting(k); }
/* side-effects that must reflect immediately (others are read at use-time) */
function applySetting(k){
  if(k==null||k==='subColor'||k==='subBg'||k==='subOutline'||k==='subOutlineW'||k==='subSize'){ applySubtitleStyle(); updateSubtitlePreview(); }
  if(k==null||k==='nextPopupSecs') updatePopupRing();
  if(k==null||k==='blurUnwatched') document.body.classList.toggle('blur-unwatched',!!SETTINGS.blurUnwatched);
  if(k==null||k==='enhance'||k==='enhanceLevel'||k==='clarity'||k==='clarityLevel'){ try{ VP.applyEnhance(); }catch(e){} }
}
function applyAllSettings(){ applySetting(null); }
/* the subtitle "outline" — a multi-direction text-shadow (a real outline isn't a ::cue
   prop), scaled by the chosen width. Shared so the player and the live preview match. */
function subtitleOutlineShadow(){
  const o=SETTINGS.subOutline;
  const w=Math.max(0,Math.min(6,+SETTINGS.subOutlineW));
  if(!o||o==='transparent'||!(w>0)) return '0 1px 3px rgba(0,0,0,.9)';
  return `-${w}px -${w}px 0 ${o},${w}px -${w}px 0 ${o},-${w}px ${w}px 0 ${o},${w}px ${w}px 0 ${o},`
    +`0 0 ${w*2}px ${o},0 2px 6px rgba(0,0,0,.85)`;
}
/* build/refresh the ::cue stylesheet from the current subtitle prefs */
function applySubtitleStyle(){
  let st=document.getElementById('subCueStyle');
  if(!st){ st=document.createElement('style'); st.id='subCueStyle'; document.head.appendChild(st); }
  const c=SETTINGS.subColor||'#ffffff';
  const bg=(SETTINGS.subBg&&SETTINGS.subBg!=='transparent')?SETTINGS.subBg:'transparent';
  const size=Math.max(50,Math.min(300,+SETTINGS.subSize||100));
  st.textContent=`#playerVideo::cue{color:${c} !important;background:${bg} !important;`
    +`font-size:${size}% !important;text-shadow:${subtitleOutlineShadow()} !important;}`;
}
/* mirror the subtitle prefs into the Settings-page live preview + bg swatch */
function updateSubtitlePreview(){
  const el=document.getElementById('subPreview');
  if(el){
    const size=Math.max(50,Math.min(300,+SETTINGS.subSize||100));
    const px=Math.max(12,Math.min(30,Math.round(15*size/100)));
    const bg=(SETTINGS.subBg&&SETTINGS.subBg!=='transparent')?SETTINGS.subBg:'transparent';
    el.style.color=SETTINGS.subColor||'#ffffff';
    el.style.fontSize=px+'px';
    el.style.textShadow=subtitleOutlineShadow();
    el.style.background=bg;
    el.style.padding=(bg==='transparent')?'2px 0':'2px 8px';
  }
  const sw=document.getElementById('subBgSwatch');
  if(sw){ const bg=SETTINGS.subBg||'transparent'; sw.style.background=(bg==='transparent')?'':bg; }
}
/* fill the auto-play clock ring proportionally to the chosen popup duration (of 60s) */
function updatePopupRing(){
  const r=document.getElementById('popupRing'); if(!r)return;
  const s=Math.max(0,Math.min(60,+SETTINGS.nextPopupSecs||0));
  r.style.setProperty('--p',String(Math.round(s/60*100)));
}
/* derive a friendly display name from an email's local part when the account has no
   stored name — "lawiletis.hakebi.69" → "Lawiletis Hakebi" — for the PROFILE card */
function prettyNameFromEmail(email){
  const local=String(email||'').split('@')[0]||'';
  const name=local.split(/[._\-+]|\d+/).filter(Boolean)
    .map(p=>p.charAt(0).toUpperCase()+p.slice(1)).join(' ').trim();
  return name||local||'Account';
}

/* per-episode "watched" set (backs the blur-unwatched feature). An episode is
   marked the moment it starts playing; keyed by imdb:season:episode. */
const WATCHED_EPS_KEY='stredio.watchedEps.v1';
function watchedEps(){ try{ return JSON.parse(localStorage.getItem(WATCHED_EPS_KEY)||'{}'); }catch(e){ return {}; } }
function epWatchKey(imdb,s,e){ return String(imdb)+':'+s+':'+e; }
function isEpWatched(imdb,s,e){ return imdb?!!watchedEps()[epWatchKey(imdb,s,e)]:false; }
function markEpWatched(imdb,s,e){
  if(!imdb||s==null||e==null)return;
  const w=watchedEps(); w[epWatchKey(imdb,s,e)]=1;
  try{ localStorage.setItem(WATCHED_EPS_KEY,JSON.stringify(w)); }catch(_){}
}

/* bind the Settings-page controls to the store: paint current values, persist on change */
function initSettingsControls(){
  const bind=(id,key,num)=>{
    const el=document.getElementById(id); if(!el)return;
    if(el.type==='checkbox'){
      el.checked=!!SETTINGS[key];
      el.addEventListener('change',()=>setSetting(key,el.checked));
    }else{
      el.value=String(SETTINGS[key]);
      el.addEventListener('input',()=>setSetting(key,num?+el.value:el.value));
      el.addEventListener('change',()=>setSetting(key,num?+el.value:el.value));
    }
  };
  bind('setBlurUnwatched','blurUnwatched');
  bind('setAutoplayNext','autoplayNext');
  bind('setNextPopup','nextPopupSecs',true);
  bind('setSubLang','subLang');
  bind('setSubSize','subSize',true);
  bind('setSubColor','subColor');
  bind('setSubBg','subBg');
  bind('setSubOutline','subOutline');
  bind('setSubOutlineW','subOutlineW',true);
  bind('setExternalPlayer','externalPlayer');
}

/* the hero is an auto-rotating carousel; the active dot's CSS fill animation IS
   the clock — advancing on its animationend keeps the progress bar and the slide
   change perfectly in sync, and hover-pause is just `animation-play-state` */
const HERO={ slides:[], i:0, delay:4000, pos:0, w:0, looped:false, rm:false };
/* Max slides in the featured-hero carousel — matches the server's /api/hero cap and
   the admin picker (HERO_MAX), so every hand-picked / trending title actually shows. */
const HERO_MAX=8;
/* always use the title's own TMDB art: landscape backdrop first, then the poster.
   If the API gave us neither (offline/demo), return '' and fall back to a branded
   gradient — never a random stock photo. */
const heroBg=it=>it.backdrop||it.poster||'';
/* branded gradient keyed off the title's hue — the placeholder shown before (or
   instead of) a slide's real backdrop image */
function heroBgFallback(it){
  const h=HUES[Math.abs(String(it.title||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0))%HUES.length];
  // MUST be the `background-image` longhand, not the `background` shorthand: this string
  // is used as a slide's inline style, and the shorthand would reset background-size/
  // background-position inline (to auto / 0% 0%), clobbering the .hero-bg stylesheet's
  // `cover` + `center 20%`. ensureSlideBg() later only swaps background-image, so those
  // clobbered values would survive and the real backdrop would render at natural size,
  // top-left anchored — cut off and unresponsive on resize (only slide 0, which sets the
  // image longhand directly, escaped this). Longhand here keeps cover/position intact.
  return `background-image:linear-gradient(135deg,hsl(${h} 34% 16%),hsl(${h} 26% 7%))`;
}
/* CSS background value for a hero slide: the real image, or the gradient when no
   art exists. Used for the eagerly-loaded active slide. */
function heroBgStyle(it){
  const img=heroBg(it);
  return img?`background-image:url('${esc(img)}')`:heroBgFallback(it);
}
/* Pull a slide's deferred backdrop in: download via Image() first, then paint it
   as the background once decoded so a hidden slide never crossfades in half-loaded.
   The active slide sets its background inline (heroSlideHTML); every OTHER slide
   carries its URL in data-bg until it's about to be shown — this keeps first paint
   to a SINGLE hero image instead of all six (often ~3MB each) downloading at once. */
function ensureSlideBg(sl){
  const bgEl=sl&&sl.querySelector('.hero-bg'); if(!bgEl||!bgEl.dataset.bg) return;
  const url=bgEl.dataset.bg; delete bgEl.dataset.bg;
  const pre=new Image();
  const paint=()=>{ bgEl.style.backgroundImage=`url('${url}')`; };
  pre.src=url;
  // decode() resolves only once the image is fully downloaded AND decoded, so the
  // background is swapped in one clean frame — never a half-decoded / streaky pass
  // (the artifact seen when a language switch loads a fresh, uncached backdrop).
  if(pre.decode){ pre.decode().then(paint).catch(paint); }
  else { pre.onload=paint; pre.onerror=paint; }
}
/* up to `n` feature-worthy titles: only feature titles that have a real TMDB
   backdrop so the hero is never a random non-movie image; highest-rated first,
   de-duped by title. If none have a backdrop (offline/mock) fall back to any. */
function pickFeatured(list,n=6){
  if(!list||!list.length) return [];
  const rich=list.filter(m=>m.backdrop);
  const pool=(rich.length?rich:list).slice().sort((a,b)=>(b.rating||0)-(a.rating||0));
  const seen=new Set(),out=[];
  for(const m of pool){ if(seen.has(m.title))continue; seen.add(m.title); out.push(m); if(out.length>=n)break; }
  return out;
}
/* like pickFeatured but preserves the given order (used for the admin-curated /
   trending hero feed): just drop blanks + title duplicates and cap to `n`. */
function dedupeFeatured(list,n=8){
  const seen=new Set(),out=[];
  for(const m of (list||[])){ if(!m||seen.has(m.title))continue; seen.add(m.title); out.push(m); if(out.length>=n)break; }
  return out;
}
// A track slide is now image-ONLY — the foreground copy/buttons live in a single pinned
// overlay (heroInnerHTML) that stays put while the backdrops scroll behind it. opts:
// {defer, active, clone}; `dataI` is the LOGICAL index (a clone mirrors its real twin's).
function heroSlideHTML(it,dataI,opts){
  opts=opts||{};
  const defer=!!opts.defer, active=!!opts.active, clone=!!opts.clone;
  // Only the live first slide paints its art inline for the fastest first paint; every other
  // slide (and all clones) defers its often-multi-MB backdrop via data-bg, which ensureSlideBg()
  // decodes-then-paints just before the slide scrolls in — so first paint stays a single image
  // and a swapped-in (uncached) backdrop never flashes a half-decoded frame.
  const bg=heroBg(it);
  const eager=(active&&!defer);
  const bgAttr=(bg&&!eager)?` data-bg="${esc(bg)}"`:'';
  const bgStyle=(bg&&eager)?`background-image:url('${esc(bg)}')`:heroBgFallback(it);
  // slides carry no text now → always decorative / hidden from assistive tech
  return `<div class="hero-slide${active?' active':''}${clone?' hero-clone':''}" data-i="${dataI}" aria-hidden="true">
      <div class="hero-media"><div class="hero-bg"${bgAttr} style="${bgStyle}"></div></div>
    </div>`;
}
// the pinned foreground copy for one title — title/plot/meta + PLAY / MY LIST. Lives once in
// #hero (heroFillContent swaps it in on each slide change); replacing the nodes re-runs the
// rise-in animation so the content cross-fades in place rather than scrolling with the image.
function heroInnerHTML(it){
  const plot=it.overview||t('hero.plot_fallback');
  // plain inline "rating  year" — no badge boxes, no genre chip (per the crimson brand)
  const meta=`<span>${esc(it.year)}</span><span>${it.rating?('★ '+esc(it.rating)):''}</span><span>${esc(I18N.genre(it.genre))||''}</span>`;
  const added=inMyList(it.id);
  // Prefer the TMDB title-logo (PNG wordmark); fall back to the gradient text title.
  // onerror restores the text title if the logo image ever fails to load.
  const titleInner=it.titleLogo
    ? `<img class="hero-logo" src="${esc(it.titleLogo)}" alt="${esc(it.title)}" onerror="this.parentNode.classList.remove('has-logo');this.parentNode.textContent=this.alt"/>`
    : esc(it.title);
  return `<h2 class="hero-title${it.titleLogo?' has-logo':''}">${titleInner}</h2>
        <p class="hero-plot">${esc(plot)}</p>
        <div class="hero-meta">${meta}</div>
        <div class="hero-actions">
          <button class="hero-btn hero-play" type="button"><span class="ic" aria-hidden="true">▶</span> ${esc(t('hero.play'))}</button>
          <button class="hero-btn hero-add${added?' on':''}" type="button"
            aria-label="${esc(added?t('mylist.remove'):t('mylist.add'))}" aria-pressed="${added}"><span class="ic" aria-hidden="true">${added?'✓':'+'}</span> <span class="hero-add-t">${esc(t('nav.my_list'))}</span></button>
        </div>`;
}
// swap the pinned overlay to a title's copy and (re)bind PLAY / MY LIST to it
function heroFillContent(it){
  const el=heroEl(); if(!el||!it) return;
  const box=el.querySelector('.hero-inner'); if(!box) return;
  box.innerHTML=heroInnerHTML(it);
  box.querySelector('.hero-play').onclick=()=>openInfoModal({
    id:it.id, type:it.type||'movie', t:it.title, y:it.year, r:it.rating, g:it.genre, p:it.poster||'', s:0
  });
  const add=box.querySelector('.hero-add');
  add.onclick=()=>{
    const on=toggleMyList(it);
    add.classList.toggle('on',on);
    const ic=add.querySelector('.ic'); if(ic) ic.textContent=on?'✓':'+';
    add.setAttribute('aria-pressed',on); add.setAttribute('aria-label',on?t('mylist.remove'):t('mylist.add'));
    toast(on?t('toast.added',{t:it.title}):t('toast.removed',{t:it.title}), on?'var(--accent)':'var(--danger)');
  };
}
function renderHero(list,opts){
  const el=heroEl(); if(!el) return;
  // a hero is already painted → this is a data/language swap, not first paint. Defer
  // slide 0's backdrop through the decode-then-paint path so a swapped-in (uncached)
  // image never flashes a half-decoded frame.
  const reRender=!!el.querySelector('.hero-slide');
  // `ordered` (the /api/hero path) keeps the server's order — the admin's curated
  // sequence, or trending order — instead of re-sorting by rating; it still de-dupes
  // by title and caps the carousel. Row-seeded heroes use pickFeatured (rating-ranked).
  const slides=(opts&&opts.ordered)?dedupeFeatured(list,HERO_MAX):pickFeatured(list,HERO_MAX);
  if(!slides.length){ el.hidden=true; el.innerHTML=''; return; }
  el.hidden=false;
  const N=slides.length, looped=N>1;
  HERO.slides=slides; HERO.i=0; HERO.looped=looped;
  HERO.pos=looped?1:0;   // cell 0 is the clone of the last slide; the real first slide is cell 1
  HERO.rm=matchMedia('(prefers-reduced-motion:reduce)').matches;
  el.style.setProperty('--hero-delay',(HERO.delay/1000)+'s');
  const dots=looped
    ? `<div class="hero-dots" role="tablist" aria-label="${esc(t('ui.featured_titles'))}">`+
        slides.map((s,i)=>`<button class="hero-dot${i===0?' active':''}" type="button" role="tab" data-i="${i}" aria-selected="${i===0}" aria-label="${esc(t('ui.show')+' '+s.title)}"></button>`).join('')+
      `</div>` : '';
  // assemble the flex track: [clone(last)] real0..realN-1 [clone(first)]. The two edge
  // clones make the loop seamless — autoplay/drag glides onto a clone, then JS teleports
  // (no transition) to its identical real twin. Clones defer their art + are non-interactive.
  const cells=[];
  if(looped) cells.push(heroSlideHTML(slides[N-1],N-1,{defer:true,clone:true}));
  slides.forEach((s,i)=>cells.push(heroSlideHTML(s,i,{active:i===0,defer:reRender||i!==0})));
  if(looped) cells.push(heroSlideHTML(slides[0],0,{defer:true,clone:true}));
  // start the row pre-shifted to the real first slide so first paint shows it, not the clone.
  // The .hero-inner overlay is a SIBLING of the track (not inside a slide) so it stays pinned
  // while the backdrops scroll behind it; heroFillContent swaps its copy on each slide change.
  el.innerHTML=`<div class="hero-track" style="transform:translateX(${looped?'-100%':'0'})">`+cells.join('')+`</div>`+
    `<div class="hero-inner">${heroInnerHTML(slides[0])}</div>`+dots;
  el.querySelectorAll('.hero-dot').forEach(d=>d.addEventListener('click',()=>heroGo(+d.dataset.i)));
  // set the live slide + dots + pinned copy, warm neighbour backdrops (clone-aware), then
  // measure the viewport and pin the track in px.
  heroSetActive(0);
  requestAnimationFrame(heroLayout);
  // wire the carousel clock + hover/focus pause exactly once per element
  if(!el.__heroWired){
    el.__heroWired=true;
    el.addEventListener('animationend',e=>{ if(e.animationName==='heroDotFill') heroGo(HERO.i+1); });
    const pause=p=>el.classList.toggle('paused',p);
    el.addEventListener('mouseenter',()=>pause(true));
    el.addEventListener('mouseleave',()=>pause(false));
    el.addEventListener('focusin',()=>pause(true));
    el.addEventListener('focusout',()=>pause(false));

    // re-pin the track in px when the viewport resizes (slide width changes)
    addEventListener('resize',heroLayout,{passive:true});

    // ---- drag / swipe the whole track (finger + mouse cursor) ----
    // One Pointer Events path covers touch, mouse and pen. touch-action:pan-y (CSS) lets a
    // vertical drag scroll the page natively while we own the horizontal axis. The track
    // follows the finger 1:1 (rubber-banded past ~0.9 of a slide so a single gesture can't
    // out-run the lone edge clone), then a velocity-aware snap commits to a neighbour or
    // eases back. A committed/over-threshold drag swallows the trailing click so PLAY / +
    // never fire mid-swipe. Disabled while there's only one slide.
    const DRAG_MIN=8, GO_DIST=0.18, GO_VEL=0.5;   // commit past 18% of a slide, or a flick
    let dx0=0,dy0=0,drag=false,axis=null,ddx=0,pType='',lastX=0,lastT=0,vx=0;
    el.addEventListener('pointerdown',e=>{
      if(HERO.slides.length<2) return;
      if(e.pointerType==='mouse'&&e.button!==0) return;
      dx0=e.clientX; dy0=e.clientY; drag=true; axis=null; ddx=0; vx=0;
      lastX=e.clientX; lastT=e.timeStamp||0; pType=e.pointerType;
    });
    el.addEventListener('pointermove',e=>{
      if(!drag) return;
      const dx=e.clientX-dx0, dy=e.clientY-dy0;
      if(axis===null){
        if(Math.abs(dx)<DRAG_MIN&&Math.abs(dy)<DRAG_MIN) return;
        axis=Math.abs(dx)>Math.abs(dy)?'x':'y';
        if(axis==='x'){ el.classList.add('dragging','paused'); try{el.setPointerCapture(e.pointerId);}catch(_){} }
      }
      if(axis!=='x') return;                 // vertical → hand it back to the page scroll
      e.preventDefault();
      ddx=dx;
      const t=e.timeStamp||0;                // running velocity (px/ms) for flick detection
      if(t>lastT){ vx=(e.clientX-lastX)/(t-lastT); lastX=e.clientX; lastT=t; }
      heroPlace(HERO.pos,false,heroRubber(dx));
    },{passive:false});
    const endDrag=()=>{
      if(!drag) return; drag=false;
      const wasX=axis==='x';
      el.classList.remove('dragging');
      if(wasX){
        const W=HERO.w||el.clientWidth||1;
        const far=Math.abs(ddx)>W*GO_DIST, flick=Math.abs(vx)>GO_VEL;
        if((far||flick)&&Math.sign(ddx||-vx)!==0){
          const dir=(ddx<0||(ddx===0&&vx<0))?1:-1;   // dragged left → next
          heroGo(HERO.i+dir);
        }else{
          heroPlace(HERO.pos,true);                  // snap back to the current slide
        }
      }
      if(wasX&&Math.abs(ddx)>DRAG_MIN){       // kill the click a drag would otherwise emit
        const supp=ev=>{ ev.stopPropagation(); ev.preventDefault(); };
        el.addEventListener('click',supp,{capture:true,once:true});
        setTimeout(()=>el.removeEventListener('click',supp,true),350);
      }
      axis=null; ddx=0; vx=0;
      el.classList.toggle('paused', pType==='mouse'&&(el.matches(':hover')||el.contains(document.activeElement)));
    };
    el.addEventListener('pointerup',endDrag);
    el.addEventListener('pointercancel',endDrag);
  }
  el.classList.remove('paused');
}
/* ---- hero track engine ----
   The track is a flex row translated in px. `pos` is the current CELL (clone(last)=0,
   real slides=1..N, clone(first)=N+1); the live LOGICAL index is HERO.i. Parallax pans
   each slide's .hero-media a fraction of the track distance for depth. */
const HERO_PARALLAX=0.07;   // bg trails the scroll by ~7% of a slide width → depth
function heroTrack(){ const el=heroEl(); return el&&el.querySelector('.hero-track'); }
// measure the viewport and re-pin the track (no animation) — first paint + resize
function heroLayout(){
  const el=heroEl(), tr=heroTrack(); if(!el||!tr) return;
  HERO.w=el.clientWidth||tr.clientWidth||1;
  heroPlace(HERO.pos,false);
}
// translate the track to `pos` (+ optional live drag offset); when animate, the .animating
// CSS glide carries both the track and each media layer to their targets in lockstep.
function heroPlace(pos,animate,dragPx){
  const el=heroEl(), tr=heroTrack(); if(!tr) return;
  HERO.pos=pos;
  const W=HERO.w||(el&&el.clientWidth)||1;
  const base=-pos*W+(dragPx||0);
  tr.classList.toggle('animating',!!animate);
  tr.style.transform='translate3d('+base.toFixed(2)+'px,0,0)';
  heroParallax(base);
}
// per-cell parallax: media translate = -k·rel·W, so the backdrop moves at (1-k)× the
// foreground — same direction, slower — for both the incoming and outgoing slide.
function heroParallax(basePx){
  const tr=heroTrack(); if(!tr) return;
  const W=HERO.w||1, maxRel=1;
  tr.querySelectorAll(':scope > .hero-slide').forEach((sl,c)=>{
    const media=sl.querySelector('.hero-media'); if(!media) return;
    if(HERO.rm){ media.style.transform=''; return; }
    let rel=(c*W+basePx)/W;                          // 0 when this cell is centred in view
    rel=Math.max(-maxRel,Math.min(maxRel,rel));
    media.style.transform='translate3d('+(-HERO_PARALLAX*rel*W).toFixed(2)+'px,0,0)';
  });
}
// soft-cap the live drag: ~1:1 with the finger for normal swipes, but asymptotes to ±W so a
// single gesture can never out-run the lone edge clone (which would expose a black gap), and
// naturally limits a swipe to one slide — the snap commits the rest.
function heroRubber(px){
  const W=HERO.w||1;
  return W*Math.tanh(px/W);
}
// set the live LOGICAL slide: active class (for Ken Burns) + dots + warm this/prev/next
// backdrops, and swap the pinned copy to this title (which re-runs its rise-in animation)
function heroSetActive(L){
  const el=heroEl(), tr=heroTrack(); if(!tr) return;
  const cells=tr.querySelectorAll(':scope > .hero-slide');
  const ac=L+(HERO.looped?1:0);
  ensureSlideBg(cells[ac]); ensureSlideBg(cells[ac+1]); ensureSlideBg(cells[ac-1]);
  cells.forEach((sl,c)=>sl.classList.toggle('active',c===ac));
  el.querySelectorAll('.hero-dot').forEach((d,i)=>{ d.classList.toggle('active',i===L); d.setAttribute('aria-selected',i===L); });
  heroFillContent(HERO.slides[L]);
}
// animate the track to a target cell; if it's an edge clone, teleport to the real twin on landing
function heroAnimateTo(cell,wrapTo){
  const tr=heroTrack(); if(!tr) return;
  heroPlace(cell,true);
  if(wrapTo==null) return;
  const land=()=>{ tr.removeEventListener('transitionend',onEnd); heroPlace(wrapTo+1,false); };
  const onEnd=e=>{ if(e.target===tr&&e.propertyName==='transform') land(); };
  tr.addEventListener('transitionend',onEnd);
  setTimeout(()=>{ if(HERO.pos===cell){ tr.removeEventListener('transitionend',onEnd); land(); } },820);
}
// go to logical slide `rawL`; rawL may be -1 or N to glide through an edge clone and wrap
function heroGo(rawL){
  const s=HERO.slides, N=s.length; if(N<2) return;
  const el=heroEl(); if(!el) return;
  const realL=((rawL%N)+N)%N;
  const wrap=(rawL<0||rawL>N-1);
  heroSetActive(realL);                 // content/dots/clock update immediately (restarts the fill)
  HERO.i=realL;
  heroAnimateTo(rawL+1, wrap?realL:null);
}

/* ---------- skeleton placeholders ----------
   Shimmer the real layout while live data loads, so there's no stale imagery and
   no layout shift when titles swap in. renderHome() paints the row skeletons
   itself; these helpers feed it and the drill-down grid. */
function skPoster(){ return '<div class="pcard" aria-hidden="true"><div class="poster sk"></div></div>'; }
/* enough cards to fill one full-bleed row at the current width */
function skRowCount(){ return Math.min(14,Math.max(6,Math.ceil((window.innerWidth||1200)/174)+1)); }
function skGcard(){
  return '<div class="gcard"><div class="poster sk" aria-hidden="true"></div>'+
    '<div class="cap"><div class="sk-line" style="height:13px;width:78%;margin-top:9px"></div>'+
    '<div class="sk-line" style="height:11px;width:38%;margin-top:8px;opacity:.75"></div></div></div>';
}
/* roughly three rows of placeholder cards for the drill-down grid */
function skGridCount(){ const w=window.innerWidth||1200; return Math.max(2,Math.floor((w-40)/170))*3; }

/* offline / no-TMDB fallback → the bundled demo catalog as a single row */
function renderOfflineHome(){
  const host=document.getElementById('strips'); if(!host) return;
  const cards=tileToWidth(CATALOG).map((m,i)=>pcard(m,i)).join('');
  host.innerHTML=`<div class="strip reveal in"><div class="strip-head"><span class="strip-title static mono">${esc(t('grid.all_titles'))}</span></div>${railHTML(cards)}</div>`;
  initStripRails(); renderHero(CATALOG); markRevealsInView();
}

/* footer reflects the real catalog source AND the real playback capability */
let __catalogSource='mock';
function renderFooter(){
  const el=document.querySelector('aside .foot'); if(!el)return;
  const playback=window.STREAM_READY?t('footer.stream_ready'):t('footer.demo_mode');
  const cat=__catalogSource==='TMDB'?t('footer.catalog_live'):t('footer.catalog_mock');
  el.innerHTML=`${esc(t('footer.preview'))}<br>${esc(t('footer.catalog_label'))}${esc(cat)}<br><span style="color:var(--accent)">${esc(t('footer.playback_label'))}${esc(playback)}</span>`;
}
function setSourceLabel(src){ __catalogSource=src; renderFooter(); }
window.renderFooter=renderFooter;

/* reveal any .reveal elements already within the viewport (the IntersectionObserver
   alone can leave above-the-fold/short-catalog items stuck invisible) */
function markRevealsInView(){
  document.querySelectorAll('.reveal:not(.in)').forEach(el=>{
    const r=el.getBoundingClientRect();
    if(r.top<innerHeight&&r.bottom>0) el.classList.add('in');
  });
}

/* ---------- view switch: home (the seven rows) vs. drill-down grid ---------- */
let gridReturnFocus=null;   // element to restore keyboard focus to when leaving a drill-down
/* returning home resets the controls so they match what's shown: clear the search
   box, deselect the filter pill + sliders, and forget the drill-down state (so the
   language toggle doesn't re-fetch a hidden grid). */
function resetBrowseControls(){
  const si=document.querySelector('.search input'); if(si) si.value='';
  document.querySelectorAll('#genrePills .pill-btn.on').forEach(x=>x.classList.remove('on'));
  document.querySelectorAll('#typePills .pill-btn').forEach(x=>x.classList.toggle('on',x.dataset.type==='all'));
  activeType='all';
  const yr=document.getElementById('yr'), rt=document.getElementById('rt');
  if(yr) yr.value=yr.min; if(rt) rt.value=0;
  try{ updateYrLabel(); updateRtLabel(); }catch(e){}
  GRID.kind=null; GRID.params=null;
}
function showHome(){ const h=document.getElementById('home'),c=document.getElementById('catview'); if(h)h.hidden=false; if(c)c.hidden=true; resetBrowseControls(); try{ renderContinueWatching(); }catch(e){}
  // Now that Home is visible again, start any Upcoming marquee that couldn't be measured
  // while it was hidden (e.g. the row was filled/toggled from the #addons page). Already-
  // running tracks are skipped (startUpcomingAnim is idempotent), so this never restarts a
  // scroll that survived the view switch.
  try{ document.querySelectorAll('#upcomingRow .um-track').forEach(startUpcomingAnim); }catch(e){}
}
function showCatview(){ const h=document.getElementById('home'),c=document.getElementById('catview'); if(h)h.hidden=true; if(c)c.hidden=false; }

/* ---------- drill-down grid: category / studio / search / filter ----------
   One controller backs every full-grid view. GRID.kind selects the data source;
   a request token guards against an out-of-order response from a superseded view. */
const GRID={ kind:null, params:null, page:1, totalPages:1, list:[], token:0 };
/* active media-type filter ('all' | 'movie' | 'tv') — set by the TYPE pills, read
   by both search and the discover grid so "Series" scopes every catalog query. */
let activeType='all';
const catGridEl=()=>document.getElementById('catGrid');
const catPagerEl=()=>document.getElementById('catPager');
function catGridMessage(html){ const el=catGridEl(); if(el) el.innerHTML=`<div class="grid-msg" style="color:var(--text-muted);font-size:17px;padding:24px 4px;grid-column:1/-1">${html}</div>`; }
function renderCatSkeleton(){ const el=catGridEl(); if(el) el.innerHTML=Array.from({length:skGridCount()},skGcard).join(''); }
function renderCatGrid(list){
  const el=catGridEl(); if(!el) return;
  el.innerHTML=list.map((m,i)=>
    `<div class="gcard">${posterHTML(m,i)}<div class="cap"><div class="t">${esc(m.title)}</div><div class="y mono">${esc(m.year)}</div></div></div>`
  ).join('');
}
function setCatPager(state){
  const el=catPagerEl(); if(!el) return;
  if(state==='hidden'){ el.innerHTML=''; return; }
  const info=`<span class="page-info">${esc(t('cat.page',{x:GRID.page,y:GRID.totalPages}))}</span>`;
  if(state==='loading'){ el.innerHTML=`<button class="loadmore" disabled><span class="sf-loader sm" aria-hidden="true" style="margin-right:9px"></span>${esc(t('grid.loading'))}</button>`; return; }
  if(state==='more'){
    el.innerHTML=`<button class="loadmore" id="catMore">${esc(t('grid.load_more'))}</button>${info}`;
    const b=el.querySelector('#catMore'); if(b) b.addEventListener('click',catLoadMore);
    return;
  }
  el.innerHTML=info;   // last page → just the page indicator
}
function gridUrl(page){
  const lang=I18N.lang(), p=GRID.params||{};
  if(GRID.kind==='category') return `/api/browse?cat=${encodeURIComponent(p.cat)}&page=${page}&lang=${lang}&full=1`;
  if(GRID.kind==='studio')   return `/api/browse?cat=studio&studio=${encodeURIComponent(p.studio)}&page=${page}&lang=${lang}&full=1`;
  if(GRID.kind==='search'){ const ty=p.type&&p.type!=='all'?`&type=${p.type}`:''; return `/api/search?q=${encodeURIComponent(p.query)}&page=${page}&lang=${lang}${ty}`; }
  const sp=new URLSearchParams(p.filters||{}); sp.set('page',page); sp.set('lang',lang);
  return '/api/catalog?'+sp.toString();
}
async function loadGridPage(reset){
  const token=++GRID.token;
  // Delay the skeleton: a fast response (very often "no results") arrives before the
  // timer fires, so we never flash a full grid of placeholder cards just to wipe them.
  // Only genuinely slow requests get the skeleton. Prior content stays put meanwhile.
  let skTimer=null;
  if(reset){ GRID.page=1; GRID.list=[]; skTimer=setTimeout(()=>{ if(token===GRID.token) renderCatSkeleton(); },200); }
  setCatPager('loading');
  try{
    const r=await fetch(gridUrl(GRID.page));
    if(!r.ok) throw new Error('grid '+r.status);
    const data=await r.json();
    clearTimeout(skTimer);
    if(token!==GRID.token) return;                 // a newer view superseded this request
    GRID.totalPages=Math.max(1,Math.min(500,data.totalPages||1));
    const results=data.results||[];
    GRID.list=reset?results.slice():GRID.list.concat(results);
    if(!GRID.list.length){ catGridMessage(GRID.kind==='search'?t('grid.no_results',{q:esc(GRID.params.query||'')}):esc(t('grid.no_titles'))); setCatPager('hidden'); return; }
    renderCatGrid(GRID.list); markRevealsInView();
    setCatPager(GRID.page<GRID.totalPages?'more':'end');
  }catch(e){
    clearTimeout(skTimer);
    if(token!==GRID.token) return;
    // backend unreachable (offline / file://) → filter the bundled demo catalog so
    // search & filter still work in demo mode, mirroring the home's offline fallback
    if(reset){
      const local=offlineFilter();
      if(local.length){ GRID.list=local; renderCatGrid(local); markRevealsInView(); setCatPager('hidden'); return; }
      if(!GRID.list.length) catGridMessage(GRID.kind==='search'?t('grid.no_results',{q:esc(GRID.params.query||'')}):esc(t('grid.no_titles')));
    }
    setCatPager('hidden');
  }
}
/* offline degradation for the drill-down: search/filter the bundled demo CATALOG */
function offlineFilter(){
  if(GRID.kind==='search'){ const q=(GRID.params.query||'').toLowerCase(); return CATALOG.filter(m=>(m.title||'').toLowerCase().includes(q)); }
  if(GRID.kind==='filter'){ const f=GRID.params.filters||{};
    if(f.type==='tv') return [];   // demo catalog is movies-only, no offline series
    return CATALOG.filter(m=>
    (!f.genre||m.genre===f.genre) && (!f.yearGte||(+m.year>=+f.yearGte)) && (!f.ratingGte||((+m.rating||0)>=+f.ratingGte))); }
  return [];   // category/studio have no offline equivalent
}
function catLoadMore(){ if(GRID.page>=GRID.totalPages) return; GRID.page++; loadGridPage(false); }

/* open a drill-down view (category header, studio card, search, or filters).
   opts.focusTitle moves keyboard focus to the heading on entry — used for header/
   studio activations, but NOT for live search/filter (which must keep focus in the
   control the user is operating). */
function openGrid(opts){
  const cv=document.getElementById('catview');
  // remember where we came from (only when entering from outside the drill-down)
  if(!cv||!cv.contains(document.activeElement)) gridReturnFocus=document.activeElement;
  GRID.kind=opts.kind; GRID.params=opts;
  const titleEl=document.getElementById('catTitle');
  if(titleEl) titleEl.textContent=opts.title||(opts.titleKey?t(opts.titleKey):'');
  showCatview();
  window.scrollTo(0,0);
  if(opts.focusTitle&&titleEl){ try{ titleEl.focus(); }catch(e){} }   // orient screen readers on the new view
  loadGridPage(true);
}
function openCategory(cat,titleKey){ openGrid({kind:'category',cat,titleKey,focusTitle:true}); }
function openStudio(key,name){ openGrid({kind:'studio',studio:key,title:name,focusTitle:true}); }
function openSearch(q){ openGrid({kind:'search',query:q,type:activeType,title:t('cat.results',{q})}); }
function openFilter(filters){ openGrid({kind:'filter',filters,title:t('cat.filtered')}); }

/* read the existing filter panel UI (genre pill + year/rating sliders) */
function activeFilters(){
  const g=document.querySelector('#genrePills .pill-btn.on');
  const yr=document.getElementById('yr'), rt=document.getElementById('rt');
  const f={};
  if(g) f.genre=g.dataset.genre||g.textContent.trim();
  if(yr&&+yr.value>+yr.min) f.yearGte=yr.value;
  if(rt&&+rt.value>0) f.ratingGte=rt.value;
  if(activeType==='tv'||activeType==='movie') f.type=activeType;   // Series → /discover/tv
  return f;
}

/* ---------- STREDIO top nav: Home / TV Shows / Movies / New & Popular / My List ----------
   Home → the categorised rows; TV Shows/Movies → a type-scoped discover grid;
   New & Popular → trending movies; My List → the saved-titles grid. All four grid
   views reuse the existing drill-down controller (openGrid / catview). */
function setTypeScope(ty){
  activeType=ty;
  const tp=document.getElementById('typePills');
  if(tp) tp.querySelectorAll('.pill-btn').forEach(x=>x.classList.toggle('on',x.dataset.type===ty));
}
function openMyList(){
  if(typeof showCatview==='function') showCatview();
  GRID.kind='mylist'; GRID.params={}; GRID.totalPages=1; GRID.page=1;
  const titleEl=document.getElementById('catTitle'); if(titleEl) titleEl.textContent=t('nav.my_list');
  const list=myList();
  if(!list.length){ catGridMessage(esc(t('mylist.empty'))); setCatPager('hidden'); window.scrollTo(0,0); return; }
  renderCatGrid(list.map(m=>({id:m.id,title:m.title,year:m.year||'',type:m.type||'movie',
    genre:m.genre||'',rating:m.rating||'',poster:m.poster||''})));
  setCatPager('hidden'); try{ markRevealsInView(); }catch(e){} window.scrollTo(0,0);
}
function setTopNavActive(nav){
  // keep the header strip AND the drawer category items (phones) in sync
  document.querySelectorAll('#topnav .topnav-link,aside .nav-cat').forEach(a=>a.classList.toggle('active',a.dataset.nav===nav));
}
function topNav(nav){
  if(window.__page!=='browse'&&typeof gotoPage==='function') gotoPage('browse');
  // gotoPage() swaps the visible .page but leaves the URL hash alone, so coming from
  // #addons/#settings the address bar stayed stuck on the old hash while showing the
  // catalog. All top-nav destinations live on the browse page → sync the hash to it
  // (replaceState, so we don't re-fire routeTo or push a redundant history entry).
  if(location.hash&&location.hash!=='#browse') history.replaceState(null,'','#browse');
  if(nav==='home'){ if(typeof showHome==='function'){ showHome(); window.scrollTo(0,0); } }
  else if(nav==='tv'){ setTypeScope('tv'); openGrid({kind:'filter',filters:{type:'tv'},title:t('nav.tv_shows'),focusTitle:true}); }
  else if(nav==='movies'){ setTypeScope('movie'); openGrid({kind:'filter',filters:{type:'movie'},title:t('nav.movies'),focusTitle:true}); }
  else if(nav==='new'){ openGrid({kind:'category',cat:'trending_movie',title:t('nav.new_popular'),focusTitle:true}); }
  else if(nav==='mylist'){ openMyList(); }
  setTopNavActive(nav);
}
(function wireTopNav(){
  const nav=document.getElementById('topnav'); if(!nav) return;
  nav.addEventListener('click',e=>{ const a=e.target.closest('.topnav-link'); if(!a) return; e.preventDefault(); topNav(a.dataset.nav); });
  nav.addEventListener('keydown',e=>{ if(e.key!=='Enter'&&e.key!==' ') return; const a=e.target.closest('.topnav-link'); if(!a) return; e.preventDefault(); topNav(a.dataset.nav); });
})();

/* ---------- drawer category links (phones): route through topNav() + close the drawer ---------- */
(function wireDrawerCats(){
  document.querySelectorAll('aside .nav-cat[data-nav]').forEach(a=>{
    const go=e=>{ e.preventDefault();
      if(typeof topNav==='function') topNav(a.dataset.nav);
      document.body.classList.add('nav-closed');                       // mirror the drawer's apply(false)
      const bd=document.getElementById('navBackdrop'); if(bd) bd.classList.remove('show'); };
    a.addEventListener('click',go);
    a.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' ') go(e); });
  });
})();

/* ---------- detail-modal synopsis "Read more" (phones only) ----------
   Clamps #mPlot to 5 lines on small screens and reveals the toggle only when the
   synopsis actually overflows. A MutationObserver re-checks on every rewrite of the
   text (loading → enriched → fallbacks) so a fast title-switch never leaves stale state. */
(function plotReadMore(){
  const plot=document.getElementById('mPlot'), btn=document.getElementById('mReadMore');
  if(!plot||!btn) return;
  const mq=matchMedia('(max-width:640px)');
  let expanded=false;
  function refresh(){
    if(!mq.matches){ plot.classList.remove('clamped'); btn.hidden=true; btn.classList.remove('is-less'); return; }
    if(expanded){
      plot.classList.remove('clamped');
      btn.hidden=false; btn.classList.add('is-less'); btn.textContent=t('modal.read_less');
      return;
    }
    plot.classList.add('clamped'); btn.classList.remove('is-less');
    const overflowing = plot.scrollHeight > plot.clientHeight + 2;
    if(overflowing){ btn.hidden=false; btn.textContent=t('modal.read_more'); }
    else { plot.classList.remove('clamped'); btn.hidden=true; }
  }
  btn.addEventListener('click',()=>{ expanded=!expanded; refresh(); });
  new MutationObserver(()=>{ expanded=false; refresh(); }).observe(plot,{childList:true,characterData:true,subtree:true});
  if(mq.addEventListener) mq.addEventListener('change',()=>{ expanded=false; refresh(); });
  refresh();
})();

/* ---------- header / studio / back wiring (delegated on the home rows) ---------- */
(function wireHome(){
  const strips=document.getElementById('strips');
  if(strips){
    strips.addEventListener('click',e=>{
      const head=e.target.closest('.strip-title:not(.static)');
      if(head&&head.dataset.cat){ openCategory(head.dataset.cat,head.dataset.key); return; }
      const studio=e.target.closest('.studio-card');
      if(studio){ openStudio(studio.dataset.studio,studio.dataset.name); }
    });
    strips.addEventListener('keydown',e=>{
      if(e.key!=='Enter'&&e.key!==' ') return;
      const studio=e.target.closest('.studio-card');
      if(studio){ e.preventDefault(); openStudio(studio.dataset.studio,studio.dataset.name); }
    });
  }
  // Upcoming rows live in #upcomingRow (sibling of #strips): a header opens that
  // category's drill-down; a card opens the same detail modal a poster does.
  const upRow=document.getElementById('upcomingRow');
  if(upRow){
    upRow.addEventListener('click',e=>{
      const head=e.target.closest('.strip-title:not(.static)');
      if(head&&head.dataset.cat){ openCategory(head.dataset.cat,head.dataset.key); return; }
      const uc=e.target.closest('.upcoming-card');
      if(uc&&uc.dataset.id) openInfoModal(uc.dataset);
    });
    upRow.addEventListener('keydown',e=>{   // role=button cards need explicit Enter/Space → open
      if(e.key!=='Enter'&&e.key!==' ') return;
      const uc=e.target.closest('.upcoming-card');
      if(uc&&uc.dataset.id){ e.preventDefault(); openInfoModal(uc.dataset); }
    });
  }
  const back=document.getElementById('catBack');
  if(back) back.addEventListener('click',()=>{
    const target=gridReturnFocus;
    showHome(); window.scrollTo(0,0);
    if(target&&target.focus){ try{ target.focus(); }catch(e){} }   // restore focus to the header/card that opened the view
    gridReturnFocus=null;
  });
})();

/* ---------- boot: paint the home rows, then label the footer source ----------
   renderHome() builds the seven skeleton rails and runs a syncRail() per rail, each of
   which reads scrollWidth/clientWidth — i.e. seven forced layouts. Run during the splash
   animation those would jank it (the cold-cache "skip"). So the intro splash calls bootHome()
   from BEHIND its black reveal curtain, where the heavy work is invisible. The once-guard
   keeps it to a single run. With no splash (reduced-motion / already removed) we build now. */
/* Wait until the home's above-the-fold visuals have actually painted — the active hero
   backdrop image plus the poster/logo images currently in the viewport — so the intro
   curtain lifts on a finished page, not one still streaming art. Off-screen rail posters
   are lazy and intentionally skipped (they only load on scroll). Capped so offline / slow
   art can never trap the user on the black curtain — it just reveals on the deadline. */
function waitHomeVisuals(maxMs){
  return new Promise(resolve=>{
    let done=false; const finish=()=>{ if(done) return; done=true; clearTimeout(cap); resolve(); };
    const cap=setTimeout(finish,maxMs);
    const proms=[];
    const hb=document.querySelector('#hero .hero-slide.active .hero-bg');   // active hero backdrop
    if(hb){
      const m=(getComputedStyle(hb).backgroundImage||'').match(/url\(["']?(.*?)["']?\)/);
      if(m&&m[1]&&m[1]!=='none') proms.push(new Promise(res=>{ const im=new Image(),go=()=>res();
        im.onload=go; im.onerror=go; im.src=m[1]; if(im.decode){ im.decode().then(go).catch(go); } setTimeout(go,maxMs); }));
    }
    const vw=innerWidth, vh=innerHeight;
    document.querySelectorAll('#strips img,#continueRow img,#upcomingRow img,#hero img').forEach(im=>{
      const r=im.getBoundingClientRect();
      if(r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw) return;     // off-screen → lazy, won't load yet
      if(im.complete&&im.naturalWidth>0) return;                     // already painted
      proms.push(new Promise(res=>{ const go=()=>res();
        im.addEventListener('load',go,{once:true}); im.addEventListener('error',go,{once:true}); setTimeout(go,maxMs); }));
    });
    if(!proms.length) return finish();
    Promise.all(proms).then(finish);
  });
}
function bootHome(){
  if(bootHome.done) return bootHome.ready; bootHome.done=true;
  let dataReady; try{ dataReady=renderHome(); }catch(e){ dataReady=null; }
  fetch('/api/config').then(r=>r.ok?r.json():{tmdb:false})
    .then(cfg=>setSourceLabel(cfg.tmdb?'TMDB':'mock'))
    .catch(()=>setSourceLabel('mock'));
  // "home ready" = row data + hero painted (dataReady), THEN the hero backdrop + on-screen
  // posters decoded (waitHomeVisuals) — the intro curtain waits on this before lifting.
  bootHome.ready=Promise.resolve(dataReady).then(()=>waitHomeVisuals(4000)).catch(()=>{});
  window.__homeReady=bootHome.ready;
  return bootHome.ready;
}
window.bootHome=bootHome;
if(!document.getElementById('intro')) bootHome();   // no splash → build immediately

/* ---- filter dropdown toggle ---- */
const fToggle=document.getElementById('filterToggle'),fPanel=document.getElementById('filterPanel');
function setFilterOpen(open){ fToggle.classList.toggle('on',open); fPanel.classList.toggle('open',open); fToggle.setAttribute('aria-expanded',String(open)); }
fToggle.addEventListener('click',e=>{e.stopPropagation();setFilterOpen(!fPanel.classList.contains('open'));});
document.addEventListener('click',e=>{if(!e.target.closest('.search'))setFilterOpen(false);});

/* ---- filter controls ---- */
document.getElementById('genrePills').innerHTML=GENRES.map(g=>`<button class="pill-btn" type="button" data-genre="${esc(g)}">${esc(I18N.genre(g))}</button>`).join('');
/* re-label genre pills in place on language change (keeps the active selection) */
function relabelGenrePills(){ document.querySelectorAll('#genrePills .pill-btn').forEach(b=>{ const g=b.dataset.genre; if(g) b.textContent=I18N.genre(g); }); }
document.getElementById('genrePills').addEventListener('click',e=>{
  const b=e.target.closest('.pill-btn'); if(!b)return;
  const wasOn=b.classList.contains('on');
  document.querySelectorAll('#genrePills .pill-btn').forEach(x=>x.classList.remove('on'));
  if(!wasOn) b.classList.add('on');
  applyFilters();
});
/* TYPE pills (All / Movies / Series) — exactly one is always active. Re-run the
   live search with the new scope if the box has a query, otherwise re-evaluate the
   discover filters so picking "Series" alone surfaces popular shows. */
const typePills=document.getElementById('typePills');
typePills.addEventListener('click',e=>{
  const b=e.target.closest('.pill-btn'); if(!b||b.classList.contains('on'))return;
  typePills.querySelectorAll('.pill-btn').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); activeType=b.dataset.type||'all';
  const q=document.querySelector('.search input').value.trim();
  if(q) openSearch(q); else applyFilters();
});
const yrEl=document.getElementById('yr'), rtEl=document.getElementById('rt');
function updateYrLabel(){ const v=+yrEl.value, on=v>+yrEl.min, lbl=on?t('filter.from_year',{y:v}):t('filter.any_year');
  document.getElementById('yrOut').textContent=lbl; yrEl.setAttribute('aria-valuetext',lbl); }
function updateRtLabel(){ const v=+rtEl.value, on=v>0, lbl=on?(v.toFixed(1)+'+'):t('filter.any_rating');
  document.getElementById('rtOut').textContent=lbl; rtEl.setAttribute('aria-valuetext',lbl); }
yrEl.addEventListener('input',updateYrLabel); yrEl.addEventListener('change',applyFilters);
rtEl.addEventListener('input',updateRtLabel); rtEl.addEventListener('change',applyFilters);

function applyFilters(){
  const si=document.querySelector('.search input'); if(si)si.value='';
  const f=activeFilters();
  if(f.genre||f.yearGte||f.ratingGte||f.type) openFilter(f);   // genre/year/rating/type → filtered grid
  else showHome();                                             // all cleared → back to the seven rows
}
document.querySelector('.clearall').addEventListener('click',e=>{
  e.preventDefault();
  document.querySelectorAll('#genrePills .pill-btn.on').forEach(x=>x.classList.remove('on'));
  typePills.querySelectorAll('.pill-btn').forEach(x=>x.classList.toggle('on',x.dataset.type==='all'));
  activeType='all';
  yrEl.value=yrEl.min; rtEl.value=0; updateYrLabel(); updateRtLabel();
  applyFilters(); setFilterOpen(false);
});
document.querySelector('.clearall').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); e.target.click(); } });

/* ---- search (debounced) + ENTER applies search/filters ---- */
const searchInput=document.querySelector('.search input');
/* Anti-autofill: the field ships `readonly` so Chrome won't dump a saved email
   into it on load (which would silently search for it and blank the catalog).
   Drop readonly the moment the user actually interacts, and wipe anything the
   browser still managed to autofill before the first real keystroke. */
let searchTouched=false;
function unlockSearch(){ searchInput.removeAttribute('readonly'); }
['focus','pointerdown'].forEach(ev=>searchInput.addEventListener(ev,unlockSearch));
searchInput.addEventListener('keydown',()=>{ searchTouched=true; },true);
function wipeAutofill(){ if(!searchTouched && searchInput.value){ searchInput.value=''; } }
wipeAutofill();
window.addEventListener('load',wipeAutofill);
setTimeout(wipeAutofill,400);   // Chrome autofills asynchronously after load
let searchTimer;
searchInput.addEventListener('input',e=>{
  const q=e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>{ if(q) openSearch(q); else showHome(); },350);
});
function runEnter(){
  clearTimeout(searchTimer);
  const q=searchInput.value.trim();
  if(q) openSearch(q); else applyFilters();
  setFilterOpen(false);
}
searchInput.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); runEnter(); } });

/* ---- search: the centred bay is always visible; the magnifier in the right-hand
   icon cluster focuses it (or runs the query when one is typed) ---- */
(function wireSearch(){
  const icon=document.getElementById('searchIcon');
  const hdr=document.getElementById('topbar');
  // toggle the class AND re-measure the header in the same frame: opening search on a
  // phone adds a full-width second row, so the header grows ~58px. syncTopbarHeight reads
  // the new height and updates the hero's --topbar-h synchronously, so the hero's pull-up
  // grows in lock-step — nothing shifts (a deferred ResizeObserver sync would flash a jump).
  const openBar=()=>{ if(hdr&&!hdr.classList.contains('search-open')){ hdr.classList.add('search-open'); syncTopbarHeight(); } };
  if(icon) icon.addEventListener('click',()=>{
    unlockSearch(); openBar();
    if(searchInput.value.trim()) runEnter(); else searchInput.focus({preventScroll:true});
  });
  searchInput.addEventListener('focus',()=>{ unlockSearch(); openBar(); });   // drop readonly + reveal on first interaction
  // Collapse the empty bay when focus leaves it — BUT the filter panel lives inside
  // .search, so clicking the filter toggle (or a pill/slider in the panel) blurs the
  // empty input. Without these guards that blur would strip `search-open` and clip the
  // panel away the instant it opened. Skip the collapse while the panel is open, or
  // when focus simply moved to another control inside the search/filter UI.
  searchInput.addEventListener('blur',e=>{
    if(fPanel.classList.contains('open')) return;
    if(e.relatedTarget&&e.relatedTarget.closest&&e.relatedTarget.closest('.search')) return;
    if(hdr&&!searchInput.value.trim()){ hdr.classList.remove('search-open'); syncTopbarHeight(); }
  });
  searchInput.addEventListener('keydown',e=>{ if(e.key==='Escape'){ searchInput.value=''; searchInput.blur(); } });
})();

/* ---- topbar frame: paint the search "bay" — a recessed cool-dark panel whose top
   corners flare outward in crimson S-curves to bridge into the logo + icon zones.
   The shape is derived from the live search-box geometry so it tracks layout/locale
   changes; redrawn via ResizeObserver. ---- */
function buildTopbarFrame(){
  const header=document.getElementById('topbar');
  const svg=document.getElementById('topbarFrame');
  if(!header||!svg) return;
  if(getComputedStyle(svg).display==='none'){ svg.innerHTML=''; return; }   // mobile: SVG hidden
  const search=header.querySelector('.search');
  if(!search) return;
  const hb=header.getBoundingClientRect();
  const W=Math.round(hb.width), H=Math.round(hb.height);
  if(W<80||H<20) return;
  const sb=search.getBoundingClientRect();
  const cw=48, topY=1, botY=H-4, rT=10;                    // flare width, insets, top corner radius
  let sx0=Math.max(cw+6, sb.left-hb.left);
  let sx1=Math.min(W-cw-6, sb.right-hb.left);
  if(sx1-sx0<60) return;
  const cy=topY+(botY-topY)*0.5;                           // mid control (vertical tangent at the narrow top)
  const r=n=>Math.round(n*10)/10;
  // each side is ONE curve: narrow rounded TOP → flaring OUT to a WIDE BOTTOM ear tip,
  // so the bar opens downward (the "bent" connectors point down, not up)
  const lflare=`M ${r(sx0)} ${r(topY+rT)} C ${r(sx0)} ${r(cy)} ${r(sx0-cw*0.45)} ${r(botY)} ${r(sx0-cw)} ${r(botY)}`;
  const rflare=`M ${r(sx1)} ${r(topY+rT)} C ${r(sx1)} ${r(cy)} ${r(sx1+cw*0.45)} ${r(botY)} ${r(sx1+cw)} ${r(botY)}`;
  // full silhouette (filled cool-dark): narrow rounded top → right side down-out → wide bottom → left side up-in
  const panel=`M ${r(sx0+rT)} ${r(topY)} L ${r(sx1-rT)} ${r(topY)} Q ${r(sx1)} ${r(topY)} ${r(sx1)} ${r(topY+rT)} `+
            `C ${r(sx1)} ${r(cy)} ${r(sx1+cw*0.45)} ${r(botY)} ${r(sx1+cw)} ${r(botY)} `+
            `L ${r(sx0-cw)} ${r(botY)} `+
            `C ${r(sx0-cw*0.45)} ${r(botY)} ${r(sx0)} ${r(cy)} ${r(sx0)} ${r(topY+rT)} `+
            `Q ${r(sx0)} ${r(topY)} ${r(sx0+rT)} ${r(topY)} Z`;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.setAttribute('width',W); svg.setAttribute('height',H);
  svg.setAttribute('preserveAspectRatio','none');
  svg.innerHTML=
    `<defs>`+
      `<linearGradient id="tbPanel" x1="0" y1="0" x2="0" y2="1">`+
        `<stop offset="0" stop-color="#170E0F"/><stop offset="1" stop-color="#0E0809"/>`+
      `</linearGradient>`+
      `<linearGradient id="tbFlare" gradientUnits="userSpaceOnUse" x1="0" y1="${r(topY)}" x2="0" y2="${r(botY)}">`+
        `<stop offset="0" stop-color="#C01F33" stop-opacity="0.9"/>`+
        `<stop offset="0.55" stop-color="#8B0F1D" stop-opacity="0.5"/>`+
        `<stop offset="1" stop-color="#7A1320" stop-opacity="0.25"/>`+
      `</linearGradient>`+
    `</defs>`+
    `<path d="${panel}" fill="url(#tbPanel)" stroke="rgba(122,19,32,0.28)" stroke-width="1"/>`+
    `<path class="tb-flare" d="${lflare}" fill="none" stroke="url(#tbFlare)" stroke-width="2" stroke-linecap="round"/>`+
    `<path class="tb-flare" d="${rflare}" fill="none" stroke="url(#tbFlare)" stroke-width="2" stroke-linecap="round"/>`;
}
/* keep the hero's pull-up exactly equal to the live header height. The hero slides up
   under the sticky header via a negative margin of (page-top + --topbar-h); if --topbar-h
   doesn't match the real header height the hero shifts (and the backdrop leaves a sliver
   at the top). The CSS guesses (56/109/114px) drift from reality once the header reflows
   to a second row when search opens, or with a different locale/font — so measure it and
   set --topbar-h from the actual height. Inline style outranks every media-query guess. */
function syncTopbarHeight(){
  const header=document.getElementById('topbar');
  if(!header) return;
  const h=Math.round(header.getBoundingClientRect().height);
  if(!h) return;
  document.querySelectorAll('.hero').forEach(el=>el.style.setProperty('--topbar-h',h+'px'));
}
(function topbarFrame(){
  const header=document.getElementById('topbar');
  const search=header&&header.querySelector('.search');
  if(!header||!search) return;
  const draw=()=>requestAnimationFrame(()=>{ syncTopbarHeight(); buildTopbarFrame(); });
  if('ResizeObserver' in window){ const ro=new ResizeObserver(draw); ro.observe(header); ro.observe(search); }
  window.addEventListener('resize',draw);
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(draw);
  draw(); requestAnimationFrame(draw);
})();

/* ---- navbar account + messages icons ---- */
(function navIcons(){
  const u=document.getElementById('userIcon'), c=document.getElementById('chatIcon');
  if(u) u.addEventListener('click',()=>{
    if(window.AUTH&&AUTH.user){ location.hash='#settings'; }
    else if(typeof window.openAuth==='function'){ window.openAuth(null); }
  });
  if(c) c.addEventListener('click',()=>{ if(typeof toast==='function') toast('No new notifications','var(--accent)'); });
})();

/* ---- typewriter placeholder: cycles popular titles, "typing" them into the box
   (à la 1shows.org). The search bay is collapsed behind the magnifier on every viewport
   and opening it focuses the input — so pausing on focus meant the animation was never
   seen. We pause ONLY once the field has real text, so the animation plays the moment the
   user opens (and focuses) the empty box. Honours prefers-reduced-motion (static i18n ph). ---- */
(function typewriterPlaceholder(){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  /* two phrases (localized via i18n), each with its own hold time, looped forever */
  const PHRASES=[
    { key:'search.type1', hold:5000 },
    { key:'search.type2', hold:10000 },
  ];
  let wi=0, ci=0, deleting=false, timer;
  /* leave the box alone only once the user has actually typed something — being focused
     (which happens automatically when the bay opens) must NOT stop the animation */
  const busy=()=> searchInput.value.length>0;
  const schedule=ms=>{ timer=setTimeout(tick,ms); };
  function tick(){
    if(busy()){ searchInput.setAttribute('placeholder',t('search.ph')); return schedule(900); }
    const text=t(PHRASES[wi].key);                     // re-read each tick → follows language toggle
    searchInput.setAttribute('placeholder', text.slice(0,ci));
    if(!deleting){
      if(ci<text.length){ ci++; return schedule(60+Math.random()*55); }
      deleting=true; return schedule(PHRASES[wi].hold); // hold the full phrase
    }
    if(ci>0){ ci--; return schedule(30); }
    deleting=false; wi=(wi+1)%PHRASES.length; return schedule(400); // next phrase
  }
  schedule(700);
  /* restart the typing from the top each time the empty bay opens (the search icon focuses
     it) so the user actually SEES it start typing, instead of catching it mid-hold */
  searchInput.addEventListener('focus',()=>{
    if(busy()) return;
    clearTimeout(timer); wi=0; ci=0; deleting=false;
    searchInput.setAttribute('placeholder','');     // blank instantly → no flash of the held phrase
    schedule(180);
  });
})();

/* document title reflects the current page, re-applied on language change */
function setDocTitle(){ const p=window.__page||'browse';
  const key={browse:'page.browse',addons:'page.addons',settings:'page.settings',legal:'page.legal',terms:'page.terms'}[p]||'page.browse';
  document.title='STREDIO — '+t(key); }
/* page nav (low-level: show a section; routing/guards live in the auth module) */
function gotoPage(p){
  document.querySelectorAll('.page').forEach(s=>s.classList.toggle('active',s.id===p));
  document.querySelectorAll('aside .nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page===p));
  window.__page=p;
  if(p==='browse'&&typeof showHome==='function') showHome();   // Browse always lands on the seven rows
  setDocTitle();
  window.scrollTo(0,0);
}
/* nav items are real <a href="#page"> (focusable, keyboard-operable); intercept the
   click so we route through the hash guard instead of the browser jumping to the id */
document.querySelectorAll('aside .nav-item[data-page]').forEach(el=>
  el.addEventListener('click',e=>{
    e.preventDefault();
    const p=el.dataset.page;
    /* gated page while signed out → open the sign-in card immediately, right here.
       Don't depend on the hash→hashchange→routeTo chain (its timing/firing varies
       across browsers); call openAuth directly so the click is always answered. */
    const signedIn=!!(window.AUTH&&window.AUTH.user);
    if(window.isGated&&window.isGated(p)&&!signedIn){
      if(typeof window.openAuth==='function') window.openAuth(p);
      else navigate(p);            // fallback: let the router open the dialog
      return;
    }
    navigate(p);
  }));

/* footer "Terms & Conditions" + "DMCA / Takedown" links → public legal pages; the
   "back" buttons return to the catalog. All are plain (ungated) routes, so a
   signed-out visitor reaches them too. */
(function(){
  const go=p=>e=>{ if(e&&e.type==='keydown'&&e.key!=='Enter'&&e.key!==' ')return; if(e)e.preventDefault(); navigate(p); };
  const wire=(id,page)=>{ const el=document.getElementById(id); if(el){ el.addEventListener('click',go(page)); el.addEventListener('keydown',go(page)); } };
  wire('footerLegal','legal');
  wire('footerTerms','terms');
  const lb=document.getElementById('legalBack'); if(lb) lb.addEventListener('click',go('browse'));
  const tb=document.getElementById('termsBack'); if(tb) tb.addEventListener('click',go('browse'));
})();

/* ---------- Terms & Conditions content (bilingual, rendered into #termsBody) ---------- *
 * Stredio is a media catalog & UI that does not host,
 * store, or distribute media; community add-ons are independent third-party software the
 * user installs at their own discretion. Static, trusted content — safe to inject as HTML. */
const TERMS_CONTACT_EN=`<p>For general questions about these Terms or the Platform: <a href="mailto:contact@stredio.com">contact@stredio.com</a></p>
  <p>For copyright / DMCA takedown notices (designated agent): <a href="mailto:legal@stredio.com">legal@stredio.com</a></p>`;
const TERMS_CONTACT_KA=`<p>ზოგადი შეკითხვებისთვის ამ პირობებზე ან პლატფორმაზე: <a href="mailto:contact@stredio.com">contact@stredio.com</a></p>
  <p>საავტორო უფლებების / DMCA შეტყობინებებისთვის (დანიშნული აგენტი): <a href="mailto:legal@stredio.com">legal@stredio.com</a></p>`;
const TERMS_DATA={
  en:[
    {h:`Introduction`, body:[
      `Welcome to Stredio. These Terms &amp; Conditions ("Terms") govern your access to and use of the Stredio website, applications, and related services (together, the "Platform"). By accessing or using the Platform, you agree to be bound by these Terms. If you do not agree, you must not access or use the Platform.`,
      `Stredio is a media catalog and user-interface platform. It provides tools to discover, organise, and play media that is made available by third-party services. Stredio does not host, store, upload, or distribute any media files. Please read these Terms carefully together with our DMCA / Takedown Policy, which is incorporated into these Terms by reference.`,
    ]},
    {h:`Definitions`, body:[
      {ul:[
        `<b>"Platform"</b> — the Stredio website, software, interfaces, and related services.`,
        `<b>"Add-on"</b> — a first-party or third-party software module that supplies catalogs, metadata, subtitles, ratings, or stream links to the Platform.`,
        `<b>"Official Add-on"</b> — an Add-on developed or curated by the Stredio team and shipped with the Platform.`,
        `<b>"Community Add-on"</b> — an Add-on created and maintained independently by third-party developers, which a user may choose to install.`,
        `<b>"Content"</b> — any catalog metadata, artwork, stream link, subtitle, or other material surfaced through the Platform or an Add-on.`,
        `<b>"Third-Party Service"</b> — any external website, server, or service that actually hosts or transmits Content.`,
        `<b>"User", "you"</b> — any person who accesses or uses the Platform.`,
      ]},
    ]},
    {h:`Use of the Platform`, body:[
      `The Platform operates solely as a media catalog and user interface. It indexes descriptive information (titles, artwork, ratings, and metadata) and provides a unified interface for discovering and playing media supplied by Third-Party Services and Add-ons.`,
      `Stredio does not store, host, upload, cache, or distribute any media content. All playable media is provided by, and hosted on, independent Third-Party Services that are outside our control.`,
      `You may use the Platform only for lawful, personal, non-commercial purposes, in compliance with these Terms and all applicable laws. Certain features may require you to create an account; you are responsible for safeguarding your credentials and for all activity under your account.`,
      `We may modify, suspend, or discontinue any part of the Platform at any time, with or without notice.`,
    ]},
    {h:`Eligibility`, body:[
      `You must be at least 18 years old, or the age of legal majority in your jurisdiction, to create an account or use the Platform. By using the Platform you represent and warrant that you meet this requirement and have the legal capacity to enter into these Terms. The Platform is not directed to children, and we do not knowingly collect personal data from anyone under the age of majority.`,
    ]},
    {h:`The Add-on Ecosystem`, body:[
      `The Platform provides an open framework that allows Users to install Add-ons. Add-ons extend the Platform with catalogs, metadata, subtitles, ratings, and stream sources.`,
      `<b>Community Add-ons are created, published, and maintained independently by third-party community developers. They are not developed, maintained, controlled, or endorsed by Stredio or its team.</b> Stredio provides the framework only; we do not select, review, monitor, or control what any Community Add-on accesses, indexes, links to, or makes available.`,
      `Installing a Community Add-on is done entirely at the User's own discretion and risk. Stredio has no control over, and accepts no responsibility for, the Content, availability, legality, accuracy, or behaviour of any Community Add-on or of the Third-Party Services it connects to.`,
      `By default, no Community streaming Add-on is installed, and the Platform functions purely as a media catalog and user interface. Stream sources become available only after a User chooses to install and configure a Community Add-on.`,
      `Copyright holders who wish to report allegedly infringing material accessed through a Community Add-on must contact the individual Add-on developer or the Third-Party Service that hosts the material, and not Stredio. See the "DMCA &amp; Copyright" section below.`,
    ]},
    {h:`User Obligations`, body:[
      `You are solely responsible for the Add-ons you choose to install and for any Content you access, stream, or download through them. You must comply with all copyright, intellectual-property, and other laws applicable in your jurisdiction.`,
      `You agree not to: (a) use the Platform for any unlawful purpose; (b) use the Platform or any Add-on to access, reproduce, or distribute material you are not legally entitled to access; (c) circumvent or disable any security or access-control feature; (d) interfere with or disrupt the Platform or its infrastructure; or (e) infringe the rights of any third party.`,
      `Installing and using Community Add-ons is done at your own risk. You accept full responsibility for ensuring that your use of any Add-on is lawful in your jurisdiction.`,
    ]},
    {h:`Intellectual Property`, body:[
      `The Platform — including its software, design, interface, trademarks, logos, and original content — is owned by Stredio or its licensors and is protected by applicable intellectual-property laws. Except as expressly permitted, you may not copy, modify, distribute, or create derivative works from the Platform.`,
      `Catalog metadata and artwork displayed on the Platform are descriptive information provided for identification and discovery purposes and remain the property of their respective owners. They are not the copyrighted media files themselves.`,
      `Add-ons and the Content they supply are the property of their respective developers and rights holders. Nothing in these Terms grants you any right in third-party intellectual property.`,
    ]},
    {h:`DMCA &amp; Copyright`, body:[
      `Stredio respects the intellectual-property rights of others and expects its Users to do the same. Because Stredio does not host, store, or transmit any media files, infringing media is not located on our servers.`,
      `If you believe that descriptive metadata or a link presented by an Official Stredio component infringes your copyright, you may send a takedown notice to our designated agent at <a href="mailto:legal@stredio.com">legal@stredio.com</a>. We will respond to valid notices and will promptly disable or remove the offending material that is within our control.`,
      `For Content accessed through a Community Add-on or a Third-Party Service, the material is hosted by, and under the control of, that Add-on developer or service — not Stredio. Takedown notices for such material must be directed to the relevant Add-on developer or the Third-Party Service that actually hosts the file. Removing a link or metadata entry from our index does not, and cannot, delete a file stored on a third-party server.`,
      `A valid takedown notice should include:`,
      {ol:[
        `Identification of the copyrighted work you claim has been infringed.`,
        `Identification of the specific material and its exact location on the Platform.`,
        `Your contact details (name, organisation, email, and physical address).`,
        `A statement that you have a good-faith belief the use is not authorised by the rights holder, its agent, or the law.`,
        `A statement, under penalty of perjury, that the information in your notice is accurate and that you are the rights holder or are authorised to act on its behalf.`,
        `Your physical or electronic signature.`,
      ]},
      `<b>Counter-notification.</b> If you believe that material we removed or disabled was removed as a result of mistake or misidentification, you may send a counter-notification to our designated agent at <a href="mailto:legal@stredio.com">legal@stredio.com</a>, including: (a) identification of the removed material and the location where it appeared before removal; (b) your name, address, telephone number, and email; (c) a statement, under penalty of perjury, that you have a good-faith belief the material was removed or disabled by mistake or misidentification; (d) your consent to the jurisdiction of the courts identified in the "Governing Law" section and to accept service of process from the party that filed the original notice; and (e) your physical or electronic signature.`,
      `<b>Repeat infringers.</b> In appropriate circumstances, and at our sole discretion, we will disable or terminate the accounts of Users who are determined to be repeat infringers.`,
    ]},
    {h:`Disclaimer of Warranties`, body:[
      `The Platform is provided "as is" and "as available", without warranties of any kind, whether express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, title, and non-infringement.`,
      `Stredio makes no warranty that the Platform will be uninterrupted, secure, or error-free, or that any Content available through Add-ons or Third-Party Services will be available, accurate, complete, lawful, or of any particular quality. Stredio does not endorse and is not responsible for any Content, Add-on, or Third-Party Service, and any reliance you place on such material is strictly at your own risk.`,
    ]},
    {h:`Limitation of Liability`, body:[
      `To the maximum extent permitted by applicable law, Stredio and its operators, affiliates, and contributors shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of data, profits, or goodwill, arising out of or in connection with your use of (or inability to use) the Platform, any Add-on, or any Third-Party Service.`,
      `Stredio is not responsible for the behaviour, Content, or legality of any third-party Add-on or Third-Party Service, nor for any action a User takes in reliance on them. Nothing in these Terms excludes or limits any liability that cannot be excluded or limited under applicable law.`,
    ]},
    {h:`Indemnification`, body:[
      `You agree to indemnify, defend, and hold harmless Stredio and its operators, affiliates, and contributors from and against any claims, demands, liabilities, damages, losses, costs, and expenses (including reasonable legal fees) arising out of or related to: (a) your use or misuse of the Platform; (b) any Add-on you install, configure, or use, or any Third-Party Service you reach through it; (c) Content you access, stream, download, or share; (d) your violation of these Terms or of any applicable law; or (e) your infringement of any intellectual-property or other right of any person or entity.`,
    ]},
    {h:`Governing Law`, body:[
      `These Terms are governed by and construed in accordance with the laws of Georgia, without regard to its conflict-of-laws provisions. You agree to submit to the exclusive jurisdiction of the competent courts of Georgia for the resolution of any dispute arising out of or relating to these Terms or the Platform.`,
    ]},
    {h:`Changes to Terms`, body:[
      `We may update these Terms from time to time. When we do, we will revise the "Last updated" date shown above, and material changes may be communicated through the Platform. Your continued use of the Platform after changes take effect constitutes acceptance of the revised Terms. If you do not agree to the changes, you must stop using the Platform.`,
    ]},
    {h:`General`, body:[
      `If any provision of these Terms is held invalid or unenforceable, that provision will be limited or severed to the minimum extent necessary and the remaining provisions will remain in full force and effect. Our failure to enforce any provision is not a waiver of it. You may not assign these Terms without our prior consent; we may assign them to a successor or affiliate. These Terms, together with the DMCA / Takedown Policy, are the entire agreement between you and Stredio regarding the Platform and supersede any prior understanding.`,
    ]},
    {h:`Contact Information`, body:[
      `Questions about these Terms, or notices required under them, may be sent to the addresses below:`,
      {box:TERMS_CONTACT_EN},
    ]},
  ],
  ka:[
    {h:`შესავალი`, body:[
      `მოგესალმებით Stredio-ში. ეს წესები და პირობები ("პირობები") არეგულირებს თქვენს წვდომას და გამოყენებას Stredio-ის ვებსაიტზე, აპლიკაციებსა და დაკავშირებულ სერვისებზე (ერთობლივად — "პლატფორმა"). პლატფორმაზე წვდომით ან მისი გამოყენებით თქვენ ეთანხმებით ამ პირობებს. თუ არ ეთანხმებით, არ უნდა ისარგებლოთ პლატფორმით.`,
      `Stredio არის მედია კატალოგისა და მომხმარებლის ინტერფეისის პლატფორმა. ის გთავაზობთ ხელსაწყოებს მესამე მხარის სერვისების მიერ ხელმისაწვდომი მედიის აღმოსაჩენად, დასალაგებლად და დასაკრავად. Stredio არ მასპინძლობს, არ ინახავს, არ ტვირთავს და არ ავრცელებს არცერთ მედია ფაილს. გთხოვთ, ყურადღებით წაიკითხოთ ეს პირობები ჩვენს DMCA / წაშლის პოლიტიკასთან ერთად, რომელიც ამ პირობების განუყოფელი ნაწილია.`,
    ]},
    {h:`განმარტებები`, body:[
      {ul:[
        `<b>"პლატფორმა"</b> — Stredio-ის ვებსაიტი, პროგრამული უზრუნველყოფა, ინტერფეისები და დაკავშირებული სერვისები.`,
        `<b>"დამატება" (Add-on)</b> — პირველი ან მესამე მხარის პროგრამული მოდული, რომელიც პლატფორმას აწვდის კატალოგებს, მეტამონაცემებს, სუბტიტრებს, შეფასებებს ან სტრიმების ბმულებს.`,
        `<b>"ოფიციალური დამატება"</b> — დამატება, რომელიც შემუშავებული ან შერჩეულია Stredio-ის გუნდის მიერ და მოყვება პლატფორმას.`,
        `<b>"საზოგადოების დამატება"</b> — დამატება, რომელიც დამოუკიდებლად არის შექმნილი და მხარდაჭერილი მესამე მხარის შემქმნელების მიერ და რომლის ინსტალაციაც მომხმარებელს შეუძლია საკუთარი შეხედულებისამებრ.`,
        `<b>"კონტენტი"</b> — ნებისმიერი კატალოგის მეტამონაცემი, საფარის გრაფიკა, სტრიმის ბმული, სუბტიტრი ან სხვა მასალა, რომელიც ჩანს პლატფორმაზე ან დამატების მეშვეობით.`,
        `<b>"მესამე მხარის სერვისი"</b> — ნებისმიერი გარე ვებსაიტი, სერვერი ან სერვისი, რომელიც რეალურად მასპინძლობს ან გადასცემს კონტენტს.`,
        `<b>"მომხმარებელი", "თქვენ"</b> — ნებისმიერი პირი, რომელიც წვდება ან იყენებს პლატფორმას.`,
      ]},
    ]},
    {h:`პლატფორმის გამოყენება`, body:[
      `პლატფორმა მუშაობს მხოლოდ როგორც მედია კატალოგი და მომხმარებლის ინტერფეისი. ის ახდენს აღწერითი ინფორმაციის ინდექსირებას (სათაურები, გრაფიკა, შეფასებები და მეტამონაცემები) და გთავაზობთ ერთიან ინტერფეისს მესამე მხარის სერვისებისა და დამატებების მიერ მოწოდებული მედიის აღმოსაჩენად და დასაკრავად.`,
      `Stredio არ ინახავს, არ მასპინძლობს, არ ტვირთავს, არ ქეშავს და არ ავრცელებს არცერთ მედია კონტენტს. ყველა დასაკრავი მედია მოწოდებულია და განთავსებულია დამოუკიდებელ მესამე მხარის სერვისებზე, რომლებიც ჩვენი კონტროლის მიღმაა.`,
      `პლატფორმის გამოყენება შეგიძლიათ მხოლოდ კანონიერი, პირადი, არაკომერციული მიზნებისთვის, ამ პირობებისა და ყველა მოქმედი კანონის დაცვით. ზოგიერთ ფუნქციას შესაძლოა ანგარიშის შექმნა დასჭირდეს; თქვენ პასუხისმგებელი ხართ თქვენი მონაცემების დაცვაზე და თქვენი ანგარიშით განხორციელებულ ყველა ქმედებაზე.`,
      `ჩვენ შეგვიძლია ნებისმიერ დროს შევცვალოთ, შევაჩეროთ ან შევწყვიტოთ პლატფორმის ნებისმიერი ნაწილი, წინასწარი შეტყობინებით ან მის გარეშე.`,
    ]},
    {h:`უფლებამოსილება (ასაკი)`, body:[
      `პლატფორმის გამოსაყენებლად ან ანგარიშის შესაქმნელად უნდა იყოთ სულ მცირე 18 წლის, ან თქვენი იურისდიქციის სრულწლოვანების ასაკის. პლატფორმის გამოყენებით თქვენ აცხადებთ და იძლევით გარანტიას, რომ აკმაყოფილებთ ამ მოთხოვნას და გაქვთ ამ პირობების დადების სამართლებრივი ქმედუნარიანობა. პლატფორმა არ არის გათვლილი ბავშვებზე და ჩვენ შეგნებულად არ ვაგროვებთ პერსონალურ მონაცემებს სრულწლოვანების ასაკს მიუღწეველ პირებზე.`,
    ]},
    {h:`დამატებების ეკოსისტემა`, body:[
      `პლატფორმა გთავაზობთ ღია ჩარჩოს, რომელიც მომხმარებლებს დამატებების ინსტალაციის საშუალებას აძლევს. დამატებები აფართოებს პლატფორმას კატალოგებით, მეტამონაცემებით, სუბტიტრებით, შეფასებებითა და სტრიმის წყაროებით.`,
      `<b>საზოგადოების დამატებები იქმნება, ქვეყნდება და მხარდაჭერილია დამოუკიდებლად მესამე მხარის შემქმნელების მიერ. ისინი არ არის შემუშავებული, მხარდაჭერილი, კონტროლირებადი ან მოწონებული Stredio-ის ან მისი გუნდის მიერ.</b> Stredio უზრუნველყოფს მხოლოდ ჩარჩოს; ჩვენ არ ვარჩევთ, არ ვამოწმებთ, არ ვაკონტროლებთ იმას, რასაც საზოგადოების დამატება წვდება, ინდექსირებს, აკავშირებს ან ხელმისაწვდომს ხდის.`,
      `საზოგადოების დამატების ინსტალაცია მთლიანად მომხმარებლის შეხედულებითა და რისკით ხდება. Stredio-ს არ აქვს კონტროლი და არ იღებს პასუხისმგებლობას ნებისმიერი საზოგადოების დამატების ან მისი დაკავშირებული მესამე მხარის სერვისების კონტენტზე, ხელმისაწვდომობაზე, კანონიერებაზე, სიზუსტესა თუ ქცევაზე.`,
      `ნაგულისხმევად, არცერთი საზოგადოების სტრიმინგ-დამატება არ არის დაინსტალირებული და პლატფორმა მუშაობს მხოლოდ როგორც მედია კატალოგი და მომხმარებლის ინტერფეისი. სტრიმის წყაროები ხელმისაწვდომი ხდება მხოლოდ მას შემდეგ, რაც მომხმარებელი თავად აირჩევს საზოგადოების დამატების ინსტალაციასა და კონფიგურაციას.`,
      `საავტორო უფლებების მფლობელებმა, რომელთაც სურთ საზოგადოების დამატების მეშვეობით ხელმისაწვდომი სავარაუდოდ დარღვევითი მასალის შესახებ შეტყობინება, უნდა დაუკავშირდნენ კონკრეტული დამატების შემქმნელს ან მესამე მხარის სერვისს, რომელიც მასპინძლობს მასალას — და არა Stredio-ს. იხილეთ ქვემოთ "DMCA და საავტორო უფლებები".`,
    ]},
    {h:`მომხმარებლის ვალდებულებები`, body:[
      `თქვენ ხართ ერთპიროვნულად პასუხისმგებელი იმ დამატებებზე, რომელთა ინსტალაციასაც ირჩევთ, და ნებისმიერ კონტენტზე, რომელსაც მათი მეშვეობით წვდებით, უყურებთ ან ჩამოტვირთავთ. თქვენ უნდა დაიცვათ საავტორო, ინტელექტუალური საკუთრებისა და სხვა კანონები, რომლებიც მოქმედებს თქვენს იურისდიქციაში.`,
      `თქვენ თანხმდებით, რომ არ: (ა) გამოიყენებთ პლატფორმას რაიმე უკანონო მიზნით; (ბ) გამოიყენებთ პლატფორმას ან დამატებას ისეთ მასალაზე წვდომისთვის, რეპროდუცირებისთვის ან გასავრცელებლად, რომელზეც კანონიერი უფლება არ გაქვთ; (გ) გვერდს აუვლით ან გათიშავთ უსაფრთხოების ან წვდომის კონტროლის ფუნქციებს; (დ) ხელს შეუშლით ან დაარღვევთ პლატფორმის ან მისი ინფრასტრუქტურის მუშაობას; ან (ე) დაარღვევთ მესამე მხარის უფლებებს.`,
      `საზოგადოების დამატებების ინსტალაცია და გამოყენება თქვენი საკუთარი რისკით ხდება. თქვენ იღებთ სრულ პასუხისმგებლობას იმის უზრუნველსაყოფად, რომ ნებისმიერი დამატების გამოყენება თქვენს იურისდიქციაში კანონიერია.`,
    ]},
    {h:`ინტელექტუალური საკუთრება`, body:[
      `პლატფორმა — მისი პროგრამული უზრუნველყოფის, დიზაინის, ინტერფეისის, სავაჭრო ნიშნების, ლოგოებისა და ორიგინალური კონტენტის ჩათვლით — ეკუთვნის Stredio-ს ან მის ლიცენზიარებს და დაცულია მოქმედი ინტელექტუალური საკუთრების კანონებით. გარდა იმ შემთხვევებისა, როცა ეს პირდაპირ ნებადართულია, თქვენ არ შეგიძლიათ პლატფორმის კოპირება, შეცვლა, გავრცელება ან მისგან წარმოებული ნამუშევრების შექმნა.`,
      `პლატფორმაზე ნაჩვენები კატალოგის მეტამონაცემები და გრაფიკა არის აღწერითი ინფორმაცია იდენტიფიკაციისა და აღმოჩენის მიზნებისთვის და რჩება მათი შესაბამისი მფლობელების საკუთრებად. ისინი არ წარმოადგენს თავად საავტორო უფლებებით დაცულ მედია ფაილებს.`,
      `დამატებები და მათ მიერ მოწოდებული კონტენტი მათი შესაბამისი შემქმნელებისა და უფლების მფლობელების საკუთრებაა. ამ პირობებში არაფერი განიჭებთ უფლებას მესამე მხარის ინტელექტუალურ საკუთრებაზე.`,
    ]},
    {h:`DMCA და საავტორო უფლებები`, body:[
      `Stredio პატივს სცემს სხვების ინტელექტუალური საკუთრების უფლებებს და იგივეს მოელის თავისი მომხმარებლებისგან. რადგან Stredio არ მასპინძლობს, არ ინახავს და არ გადასცემს არცერთ მედია ფაილს, დარღვევითი მედია ჩვენს სერვერებზე არ მდებარეობს.`,
      `თუ თვლით, რომ Stredio-ის ოფიციალური კომპონენტის მიერ წარმოდგენილი აღწერითი მეტამონაცემი ან ბმული არღვევს თქვენს საავტორო უფლებას, შეგიძლიათ გამოაგზავნოთ წაშლის შეტყობინება ჩვენს დანიშნულ აგენტთან: <a href="mailto:legal@stredio.com">legal@stredio.com</a>. ჩვენ ვუპასუხებთ ვალიდურ შეტყობინებებს და დაუყოვნებლივ გავთიშავთ ან წავშლით დარღვევით მასალას, რომელიც ჩვენი კონტროლის ფარგლებშია.`,
      `საზოგადოების დამატების ან მესამე მხარის სერვისის მეშვეობით ხელმისაწვდომი კონტენტი განთავსებულია და კონტროლდება ამ დამატების შემქმნელის ან სერვისის მიერ — და არა Stredio-ის. ასეთი მასალის წაშლის შეტყობინებები უნდა გაიგზავნოს შესაბამისი დამატების შემქმნელთან ან მესამე მხარის სერვისთან, რომელიც რეალურად მასპინძლობს ფაილს. ჩვენი ინდექსიდან ბმულის ან მეტამონაცემის წაშლა არ შლის და ვერ წაშლის მესამე მხარის სერვერზე განთავსებულ ფაილს.`,
      `ვალიდური წაშლის შეტყობინება უნდა შეიცავდეს:`,
      {ol:[
        `იმ საავტორო ნაწარმოების იდენტიფიკაცია, რომელიც, თქვენი აზრით, დაირღვა.`,
        `კონკრეტული მასალისა და მისი ზუსტი მდებარეობის იდენტიფიკაცია პლატფორმაზე.`,
        `თქვენი საკონტაქტო მონაცემები (სახელი, ორგანიზაცია, ელფოსტა და ფიზიკური მისამართი).`,
        `განცხადება, რომ კეთილსინდისიერად მიგაჩნიათ, რომ გამოყენება არ არის ნებადართული უფლების მფლობელის, მისი აგენტის ან კანონის მიერ.`,
        `განცხადება, ცრუ ჩვენების პასუხისმგებლობის ქვეშ, რომ შეტყობინებაში მოცემული ინფორმაცია ზუსტია და რომ თქვენ ხართ უფლების მფლობელი ან უფლებამოსილი მის სახელით მოქმედებაზე.`,
        `თქვენი ფიზიკური ან ელექტრონული ხელმოწერა.`,
      ]},
      `<b>საპასუხო შეტყობინება.</b> თუ თვლით, რომ ჩვენ მიერ წაშლილი ან გათიშული მასალა მოიხსნა შეცდომის ან არასწორი იდენტიფიკაციის გამო, შეგიძლიათ გამოაგზავნოთ საპასუხო შეტყობინება ჩვენს დანიშნულ აგენტთან მისამართზე <a href="mailto:legal@stredio.com">legal@stredio.com</a>, რომელიც მოიცავს: (ა) წაშლილი მასალის იდენტიფიკაციას და მის ადგილმდებარეობას წაშლამდე; (ბ) თქვენს სახელს, მისამართს, ტელეფონის ნომერსა და ელფოსტას; (გ) განცხადებას, ცრუ ჩვენების პასუხისმგებლობის ქვეშ, რომ კეთილსინდისიერად მიგაჩნიათ, რომ მასალა წაიშალა ან გაითიშა შეცდომით ან არასწორი იდენტიფიკაციით; (დ) თქვენს თანხმობას „მარეგულირებელი კანონმდებლობის“ სექციაში მითითებული სასამართლოების იურისდიქციაზე და თავდაპირველი შეტყობინების ავტორისგან საპროცესო დოკუმენტების მიღებაზე; და (ე) თქვენს ფიზიკურ ან ელექტრონულ ხელმოწერას.`,
      `<b>განმეორებითი დამრღვევები.</b> შესაბამის შემთხვევებში და ჩვენი შეხედულებისამებრ, ჩვენ გავთიშავთ ან დავხურავთ იმ მომხმარებლების ანგარიშებს, რომლებიც დადგინდება როგორც განმეორებითი დამრღვევები.`,
    ]},
    {h:`გარანტიების უარყოფა`, body:[
      `პლატფორმა მოწოდებულია "როგორც არის" და "როგორც ხელმისაწვდომია", ნებისმიერი სახის გარანტიის გარეშე, იქნება ეს პირდაპირი თუ ნაგულისხმევი, მათ შორის — ვაჭრობისთვის ვარგისიანობის, კონკრეტული მიზნისთვის შესაბამისობის, საკუთრებისა და უფლების დაურღვევლობის ნაგულისხმევი გარანტიების ჩათვლით.`,
      `Stredio არ იძლევა გარანტიას, რომ პლატფორმა იქნება უწყვეტი, უსაფრთხო ან შეცდომების გარეშე, ან რომ დამატებებისა და მესამე მხარის სერვისების მეშვეობით ხელმისაწვდომი კონტენტი იქნება ხელმისაწვდომი, ზუსტი, სრული, კანონიერი ან რაიმე კონკრეტული ხარისხის. Stredio არ მოიწონებს და არ არის პასუხისმგებელი არცერთ კონტენტზე, დამატებაზე ან მესამე მხარის სერვისზე, და ასეთ მასალაზე დაყრდნობა მთლიანად თქვენი რისკით ხდება.`,
    ]},
    {h:`პასუხისმგებლობის შეზღუდვა`, body:[
      `მოქმედი კანონით დაშვებული მაქსიმალური ფარგლებში, Stredio და მისი ოპერატორები, აფილირებული პირები და კონტრიბუტორები არ იქნებიან პასუხისმგებელი რაიმე არაპირდაპირ, შემთხვევით, სპეციალურ, თანმდევ ან სადამსჯელო ზიანზე, ან მონაცემების, მოგების თუ რეპუტაციის დაკარგვაზე, რომელიც წარმოიშობა პლატფორმის, ნებისმიერი დამატების ან მესამე მხარის სერვისის გამოყენებასთან (ან გამოყენების შეუძლებლობასთან) დაკავშირებით.`,
      `Stredio არ არის პასუხისმგებელი ნებისმიერი მესამე მხარის დამატების ან სერვისის ქცევაზე, კონტენტზე ან კანონიერებაზე, ისევე როგორც მომხმარებლის ნებისმიერ ქმედებაზე, რომელიც მათზე დაყრდნობით ხდება. ამ პირობებში არაფერი გამორიცხავს ან ზღუდავს იმ პასუხისმგებლობას, რომელიც მოქმედი კანონით ვერ გამოირიცხება ან შეიზღუდება.`,
    ]},
    {h:`ზიანის ანაზღაურება (ინდემნიფიკაცია)`, body:[
      `თქვენ თანხმდებით, რომ აანაზღაურებთ, დაიცავთ და გაათავისუფლებთ Stredio-ს და მის ოპერატორებს, აფილირებულ პირებსა და კონტრიბუტორებს ნებისმიერი პრეტენზიის, მოთხოვნის, ვალდებულების, ზიანის, დანაკარგის, ხარჯისა და დანახარჯისგან (გონივრული იურიდიული ხარჯების ჩათვლით), რომელიც წარმოიშობა ან დაკავშირებულია: (ა) თქვენ მიერ პლატფორმის გამოყენებასთან ან არასათანადო გამოყენებასთან; (ბ) ნებისმიერ დამატებასთან, რომელსაც აინსტალირებთ, აკონფიგურირებთ ან იყენებთ, ან მესამე მხარის სერვისთან, რომელსაც მისი მეშვეობით წვდებით; (გ) კონტენტთან, რომელსაც წვდებით, უყურებთ, ჩამოტვირთავთ ან აზიარებთ; (დ) ამ პირობების ან ნებისმიერი მოქმედი კანონის დარღვევასთან; ან (ე) ნებისმიერი პირის ან ორგანიზაციის ინტელექტუალური საკუთრების ან სხვა უფლების დარღვევასთან.`,
    ]},
    {h:`მარეგულირებელი კანონმდებლობა`, body:[
      `ეს პირობები რეგულირდება და განიმარტება საქართველოს კანონმდებლობის შესაბამისად, კანონთა კოლიზიის ნორმების გათვალისწინების გარეშე. თქვენ თანხმდებით, რომ ამ პირობებთან ან პლატფორმასთან დაკავშირებული ნებისმიერი დავის გადასაჭრელად დაემორჩილებით საქართველოს კომპეტენტური სასამართლოების ექსკლუზიურ იურისდიქციას.`,
    ]},
    {h:`პირობების ცვლილებები`, body:[
      `ჩვენ შესაძლოა დროდადრო განვაახლოთ ეს პირობები. ამ შემთხვევაში განვაახლებთ ზემოთ მითითებულ "ბოლო განახლების" თარიღს, ხოლო არსებითი ცვლილებები შესაძლოა გამოცხადდეს პლატფორმის მეშვეობით. ცვლილებების ძალაში შესვლის შემდეგ პლატფორმის გამოყენების გაგრძელება ნიშნავს განახლებული პირობების მიღებას. თუ არ ეთანხმებით ცვლილებებს, უნდა შეწყვიტოთ პლატფორმის გამოყენება.`,
    ]},
    {h:`ზოგადი დებულებები`, body:[
      `თუ ამ პირობების რომელიმე დებულება ბათილად ან აღუსრულებლად იქნა მიჩნეული, ეს დებულება შეიზღუდება ან გამოეყოფა მინიმალური აუცილებელი ფარგლებით, ხოლო დანარჩენი დებულებები სრულად შენარჩუნდება ძალაში. ჩვენ მიერ რომელიმე დებულების აღუსრულებლობა არ ნიშნავს მასზე უარის თქმას. თქვენ არ შეგიძლიათ ამ პირობების გადაცემა ჩვენი წინასწარი თანხმობის გარეშე; ჩვენ შეგვიძლია მათი გადაცემა უფლებამონაცვლეზე ან აფილირებულ პირზე. ეს პირობები, DMCA / წაშლის პოლიტიკასთან ერთად, წარმოადგენს სრულ შეთანხმებას თქვენსა და Stredio-ს შორის პლატფორმასთან დაკავშირებით და ანაცვლებს ნებისმიერ წინა შეთანხმებას.`,
    ]},
    {h:`საკონტაქტო ინფორმაცია`, body:[
      `კითხვები ამ პირობებზე, ან მათ ფარგლებში მოთხოვნილი შეტყობინებები, შეგიძლიათ გამოაგზავნოთ ქვემოთ მითითებულ მისამართებზე:`,
      {box:TERMS_CONTACT_KA},
    ]},
  ],
};
function renderTerms(){
  const L=(typeof I18N!=='undefined'&&I18N.lang&&I18N.lang()==='ka')?'ka':'en';
  const data=TERMS_DATA[L]||TERMS_DATA.en;
  const el=document.getElementById('termsBody'); if(!el)return;
  el.innerHTML=data.map(s=>{
    const inner=s.body.map(b=>{
      if(typeof b==='string')return `<p>${b}</p>`;
      if(b.ol)return `<ol>${b.ol.map(li=>`<li>${li}</li>`).join('')}</ol>`;
      if(b.ul)return `<ul>${b.ul.map(li=>`<li>${li}</li>`).join('')}</ul>`;
      if(b.box)return `<div class="legal-contact">${b.box}</div>`;
      return '';
    }).join('');
    return `<div class="legal-section"><h3>${s.h}</h3>${inner}</div>`;
  }).join('');
}
renderTerms();

/* ---------- collapsible sidebar ---------- */
(function(){
  const body=document.body,backdrop=document.getElementById('navBackdrop');
  const mq=matchMedia('(max-width:860px)');
  const isMobile=()=>mq.matches;
  const isOpen=()=>!body.classList.contains('nav-closed');
  function apply(open){
    body.classList.toggle('nav-closed',!open);
    backdrop.classList.toggle('show',open);   // sidebar is a drawer everywhere now → dim + click-to-close on desktop too
    if(!isMobile()){ try{localStorage.setItem('stredio.nav',open?'open':'closed');}catch(e){} }
  }
  function toggle(){ apply(!isOpen()); }
  document.getElementById('navToggle').addEventListener('click',toggle);
  document.getElementById('asideClose').addEventListener('click',()=>apply(false));
  backdrop.addEventListener('click',()=>apply(false));
  document.querySelectorAll('aside [data-page]').forEach(el=>el.addEventListener('click',()=>apply(false)));
  addEventListener('keydown',e=>{
    if(e.key==='\\' && !['INPUT','TEXTAREA'].includes((document.activeElement||{}).tagName)
       && !document.getElementById('playerOverlay').classList.contains('open')){ e.preventDefault(); toggle(); }
  });
  /* initial: closed by default everywhere; only open on desktop if explicitly remembered */
  let open=false;
  if(!isMobile()){ let saved=null; try{saved=localStorage.getItem('stredio.nav');}catch(e){} open=saved==='open'; }
  body.classList.toggle('nav-closed',!open);
  backdrop.classList.toggle('show',open);
  mq.addEventListener&&mq.addEventListener('change',()=>{
    if(isMobile()){ body.classList.add('nav-closed'); backdrop.classList.remove('show'); }
    else { let saved=null; try{saved=localStorage.getItem('stredio.nav');}catch(e){} const o=saved==='open';
      body.classList.toggle('nav-closed',!o); backdrop.classList.toggle('show',o); }
  });
})();

/* ---------- playback readiness ---------- */
/* window.STREAM_READY mirrors whether a third-party stream source is installed, so the
   footer status line and the play guard stay in sync. loadRemoteAddons() (in the addons
   section) recomputes it whenever the installed add-on set changes. */
window.STREAM_READY=false;

/* topbar scroll border */
addEventListener('scroll',()=>document.getElementById('topbar').classList.toggle('scrolled',scrollY>10));

/* reveals */
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)e.target.classList.add('in')}),{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));

/* modal */
let currentTitle='',currentYear='',modalToken=0,modalLastFocus=null;
const overlay=document.getElementById('overlay');
const modalAlive=t=>t===modalToken&&overlay.classList.contains('open'); // ignore stale async responses
document.addEventListener('click',e=>{
  const rm=e.target.closest('.cw-remove');                // Continue Watching corner ✕
  if(rm){ e.preventDefault(); e.stopPropagation(); removeFromHistory(rm.dataset.removeId); return; }
  const p=e.target.closest('.poster');
  if(!p||p.id==='mPoster'||p.closest('#overlay'))return;  // never re-trigger from the modal's own poster
  if(p.dataset.addon){ openAddonSources(p.dataset); return; }  // add-on catalog card → direct-to-sources
  openInfoModal(p.dataset);
});
/* open the detail/streams modal for a poster dataset {id,t,y,r,g,p,s}.
   Shared by poster clicks and the hero banner's Play button. */
function openInfoModal(ds){
  const t=++modalToken;
  modalLastFocus=document.activeElement;
  teardownTrailer();                                   // kill any prior trailer before the next title mounts
  const isTv=ds.type==='tv';
  const mTitleEl=document.getElementById('mTitle');
  mTitleEl.classList.remove('has-logo'); mTitleEl.textContent=ds.t;   // reset; enrichModalMeta may swap in a logo
  // #mMeta is the pure mono chip row (★ rating · year); genres render into #mGenres so
  // the enrichModalMeta innerHTML rewrite of #mMeta can't clobber them.
  document.getElementById('mMeta').innerHTML=`<span class="star">★</span> ${esc(ds.r)}<span>${esc(ds.y)}</span>`;
  document.getElementById('mGenres').innerHTML=ds.g?`<span class="chip">${esc(I18N.genre(ds.g))}</span>`:'';
  document.getElementById('mKicker').textContent=I18N.t(isTv?'modal.now_streaming':'modal.now_showing');
  // reset the redesigned sub-sections so a fast title-switch never flashes stale data
  const tg=document.getElementById('mTagline'); tg.hidden=true; tg.textContent='';
  const ca=document.getElementById('mCast'); ca.hidden=true; ca.classList.remove('expanded');
  document.getElementById('mPlot').textContent=I18N.t('modal.loading_synopsis');
  const mp=document.getElementById('mPoster');
  const h=HUES[(+ds.s||0)%HUES.length];
  mp.style.background=`linear-gradient(155deg,hsl(${h} 30% 12%),hsl(${h} 22% 6%))`;
  // instant placeholder = the grid poster, blurred into ambient backdrop art (never a stretched
  // poster). enrichModalMeta crossfades the real landscape backdrop in over this on load.
  mp.innerHTML=ds.p?`<div class="art" style="position:absolute;inset:0"><img class="m-ambient" src="${esc(ds.p)}" loading="lazy" alt="" onerror="this.remove()"/></div>`:'';
  currentTitle=ds.t;currentYear=ds.y;
  // snapshot the title for watch-history; recordWatch() reads this when playback starts
  window.currentTitleMeta={ id:ds.id||'', title:ds.t||'', year:ds.y||'', type:ds.type||'movie',
                            genre:ds.g||'', rating:ds.r||'', poster:ds.p||'' };
  const sc=document.getElementById('mScroll'); if(sc)sc.scrollTop=0;   // every open starts at the hero
  wireModalActions(ds);                                // watchlist + WATCH CTA, bound to THIS title
  overlay.classList.add('open'); overlay.setAttribute('aria-hidden','false');
  setTimeout(()=>{try{document.getElementById('closeModal').focus();}catch(e){}},40);

  const id=ds.id||'';
  window.currentImdb=null; window.currentStreams=[]; window.currentMediaType='movie'; window.currentEpLabel=''; window.currentLang='ka';
  resetEpChooser(); clearSeriesCtx();
  if(id&&id.startsWith('mock-')){
    /* mock entry — no live data available */
    document.getElementById('mPlot').textContent=I18N.t('modal.mock_synopsis');
    demoOrCatalogOnly('');
  }else if(ds.type==='tv'&&/^\d+$/.test(id)){
    /* TV / anime — real TMDB metadata (synopsis, cast, trailer). The season +
       episode chooser is wired to the addon engine: picking an episode queries
       installed series addons for that
       tt:season:episode. Until an episode is picked, no stream list is shown. */
    window.currentMediaType='series';
    setStreams(`<div class="demo-note">${esc(I18N.t('modal.pick_episode'))}</div>`);
    fetch('/api/meta/'+encodeURIComponent(id)+'?type=tv&lang='+I18N.lang()).then(r=>r.ok?r.json():null).then(meta=>{
      if(!modalAlive(t))return;
      if(meta){ enrichModalMeta(meta); setupSeriesChooser(id,meta,t); }
      else document.getElementById('mPlot').textContent=I18N.t('modal.synopsis_unavailable');
    }).catch(()=>{ if(modalAlive(t))document.getElementById('mPlot').textContent=I18N.t('modal.synopsis_unavailable'); });
  }else if(/^tt\d+$/.test(id)){
    /* addon-catalog item — the id IS the IMDb id, query streams directly */
    loadRealStreams(id);
    fetch('/api/meta/'+encodeURIComponent(id)+'?lang='+I18N.lang()).then(r=>r.ok?r.json():null).then(meta=>{
      if(!modalAlive(t))return;
      if(meta)enrichModalMeta(meta); else document.getElementById('mPlot').textContent=I18N.t('modal.synopsis_unavailable');
    }).catch(()=>{ if(modalAlive(t))document.getElementById('mPlot').textContent=I18N.t('modal.synopsis_unavailable'); });
  }else{
    /* TMDB numeric id — fetch meta to learn the IMDb id, then query streams */
    setStreams(`<div class="stream-source-label">${esc(I18N.t('modal.loading_metadata'))}</div>`);
    document.getElementById('mPlot').textContent=I18N.t('modal.loading_synopsis');
    fetch('/api/meta/'+encodeURIComponent(id)+'?lang='+I18N.lang()).then(r=>r.ok?r.json():null).then(meta=>{
      if(!modalAlive(t))return;
      if(!meta){ document.getElementById('mPlot').textContent=I18N.t('modal.synopsis_unavailable'); demoOrCatalogOnly(''); return; }
      enrichModalMeta(meta);
      if(meta.imdb)loadRealStreams(meta.imdb);
      else demoOrCatalogOnly(`<div class="demo-note">${esc(I18N.t('modal.no_imdb'))}</div>`);
    }).catch(()=>{
      if(!modalAlive(t))return;
      document.getElementById('mPlot').textContent=I18N.t('modal.synopsis_unavailable');
      demoOrCatalogOnly('');
    });
  }
}
function enrichModalMeta(meta){
  // Swap the text title for the TMDB title-logo when one exists. The alt text keeps
  // the title accessible (and is restored verbatim if the image fails to load).
  const mt=document.getElementById('mTitle');
  if(meta.titleLogo){
    const label=mt.textContent||meta.title||'';
    mt.classList.add('has-logo');
    mt.innerHTML=`<img class="title-logo" src="${esc(meta.titleLogo)}" alt="${esc(label)}" onerror="this.parentNode.classList.remove('has-logo');this.parentNode.textContent=this.alt"/>`;
  }
  // Swap the portrait poster for the landscape backdrop now that we have it — the 16:9
  // hero wants a landscape image. Ken-Burns runs on the container, so the swap is seamless;
  // with no backdrop we keep the poster/HUES gradient already painted by openInfoModal.
  if(meta.backdrop){
    // Crossfade the landscape backdrop in over the blurred ambient placeholder instead of a
    // hard innerHTML swap — that hard swap is what made the open look like "two screens".
    const mp=document.getElementById('mPoster');
    const wrap=document.createElement('div'); wrap.className='art'; wrap.style.cssText='position:absolute;inset:0';
    const img=document.createElement('img'); img.className='m-backdrop'; img.alt=''; img.decoding='async';
    img.onload=()=>img.classList.add('rdy');
    img.onerror=()=>wrap.remove();
    img.src=meta.backdrop;
    if(img.complete)img.classList.add('rdy');   // already cached → fade-in target is instant
    wrap.appendChild(img); mp.appendChild(wrap);
  }
  const isTv=window.currentMediaType==='series';
  // tagline eyebrow + synopsis
  const tg=document.getElementById('mTagline');
  if(meta.tagline){ tg.textContent=meta.tagline; tg.hidden=false; } else { tg.hidden=true; tg.textContent=''; }
  document.getElementById('mPlot').textContent=meta.plot||meta.tagline||I18N.t('modal.no_synopsis');
  // META CHIP ROW — the ONLY writer of #mMeta (★ rating · year · runtime · seasons·episodes)
  const parts=[];
  if(meta.rating)parts.push(`<span class="star">★</span> ${esc(meta.rating)}`);
  if(meta.year)parts.push(`<span>${esc(meta.year)}</span>`);
  if(meta.runtime)parts.push(`<span>${esc(meta.runtime)}</span>`);
  if(isTv&&meta.seasons){
    const epTotal=(meta.seasonList||[]).reduce((a,s)=>a+(s.episodes||0),0);
    const segs=[meta.seasons===1?I18N.t('modal.season_one'):I18N.t('modal.seasons_count',{n:meta.seasons})];
    if(epTotal)segs.push(I18N.t('modal.episodes_count',{n:epTotal}));
    parts.push(`<span><svg class="m-tv-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M7 3l5 3 5-3"/></svg>${esc(segs.join(' · '))}</span>`);
  }
  document.getElementById('mMeta').innerHTML=parts.join('');
  // GENRE CHIPS → separate sibling (never clobbered by the #mMeta rewrite)
  document.getElementById('mGenres').innerHTML=(meta.genre||[]).map(g=>`<span class="chip">${esc(I18N.genre(g))}</span>`).join('');
  // director/creator is shown once, in the Casts & Credits section (renderCast)
  renderCast(meta,isTv);
  mountTrailer(meta,modalToken);
}
function closeInfoModal(){ teardownTrailer(); overlay.classList.remove('open'); overlay.setAttribute('aria-hidden','true'); modalToken++;
  if(modalLastFocus&&modalLastFocus.focus){try{modalLastFocus.focus();}catch(e){}} }
document.getElementById('closeModal').addEventListener('click',closeInfoModal);
overlay.addEventListener('click',e=>{if(e.target===overlay)closeInfoModal()});
addEventListener('keydown',e=>{ if(e.key==='Escape'&&overlay.classList.contains('open')
  &&!document.getElementById('playerOverlay').classList.contains('open')) closeInfoModal(); });
/* focus trap — keep Tab cycling inside the open dialog (mirrors the auth modal).
   tabindex="-1" elements (hero bg, trailer iframe) are excluded by the selector. */
overlay.addEventListener('keydown',e=>{
  if(e.key!=='Tab'||!overlay.classList.contains('open'))return;
  const items=[...overlay.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,[tabindex]:not([tabindex="-1"])')].filter(el=>el.offsetParent!==null);
  if(!items.length)return;
  const first=items[0], last=items[items.length-1];
  if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
});

/* ---------- trailer hero (muted YouTube autoplay + mute toggle) ----------
   The backdrop (#mPoster, Ken-Burns) is painted first; a muted youtube-nocookie
   iframe cross-dissolves in on its load event once /api/meta resolves. It is torn
   down on close AND at the top of every open so two iframes never play at once. */
let modalTrailer=null, modalMuted=true, modalTrailerKey='', trailerLive=false;
// speaker icons for the trailer mute toggle (inherit the button's currentColor)
const SVG_SPK_OFF='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
const SVG_SPK_ON='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
// gesture HUD speaker/brightness icons (22px, inherit white .ic color)
const SVG_HUD_VOL0='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
const SVG_HUD_VOLLO='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
const SVG_HUD_VOLHI='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const SVG_HUD_BRIGHT='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
// how long the trailer plays HIDDEN (backdrop cover shown) before fading in — long enough
// to outlast YouTube's start-of-play centre play/pause flash, so the reveal is chrome-free.
const TRAILER_REVEAL_DELAY=4000;
function teardownTrailer(){
  const hero=document.getElementById('mHero'); if(hero)hero.classList.remove('has-trailer');
  if(modalTrailer){ try{modalTrailer.src='about:blank';}catch(e){} modalTrailer.remove(); modalTrailer=null; }
  const slot=document.getElementById('mTrailerSlot'); if(slot)slot.innerHTML='';
  modalTrailerKey=''; modalMuted=true; trailerLive=false;
  const mb=document.getElementById('mMuteBtn');
  if(mb){ mb.setAttribute('aria-pressed','true'); mb.setAttribute('aria-label',I18N.t('modal.unmute'));
    const ic=mb.querySelector('.m-mute-ic'); if(ic)ic.innerHTML=SVG_SPK_OFF; }
}
function ytPost(func,args){ try{ modalTrailer&&modalTrailer.contentWindow&&modalTrailer.contentWindow.postMessage(
  JSON.stringify({event:'command',func:func,args:args||[]}),'*'); }catch(e){} }
function ytSrc(key,muted){
  // No loop/playlist param on purpose: "playlist mode" is what adds YouTube's centre
  // ◁ ❚❚ ▷ (prev/pause/next) chrome. We loop in JS instead (replay on the ENDED state in
  // the message listener), so controls=0 + fs=0 + iv_load_policy=3 give a clean player.
  return 'https://www.youtube-nocookie.com/embed/'+encodeURIComponent(key)+
    '?autoplay=1&'+(muted?'mute=1':'mute=0')+'&controls=0&modestbranding=1&rel=0'+
    '&playsinline=1&disablekb=1&fs=0&iv_load_policy=3&enablejsapi=1';
}
function mountTrailer(meta,token){
  if(!modalAlive(token))return;
  let key=meta.trailerKey||'';
  if(!key&&meta.trailer){ const m=/[?&]v=([\w-]{6,})/.exec(meta.trailer); if(m)key=m[1]; }
  if(!key)return;                                   // no trailer → keep the Ken-Burns backdrop only
  modalTrailerKey=key; modalMuted=true; trailerLive=false;
  const slot=document.getElementById('mTrailerSlot');
  if(!slot)return;
  const ifr=document.createElement('iframe');
  ifr.title=I18N.t('modal.trailer_title',{title:currentTitle||meta.title||''});
  ifr.setAttribute('allow','autoplay; encrypted-media; picture-in-picture');
  ifr.setAttribute('referrerpolicy','strict-origin-when-cross-origin');
  ifr.setAttribute('tabindex','-1'); ifr.setAttribute('aria-hidden','true');
  // Prompt the embed to start emitting IFrame-API messages. revealTrailer (the 'message'
  // listener below) runs only when the player actually answers — so a frame blocked by
  // CSP / an ad-blocker / network never reveals, and the backdrop "cover" stays as the
  // graceful fallback (no broken-embed glyph, no orphan mute button).
  ifr.addEventListener('load',()=>{ try{ ifr.contentWindow.postMessage(JSON.stringify({event:'listening',id:key,channel:'widget'}),'*'); }catch(e){} });
  ifr.src=ytSrc(key,true);
  slot.appendChild(ifr); modalTrailer=ifr;
}
/* The YouTube embed posts IFrame-API messages once its player is live. We reveal the
   trailer ONLY when it reports the PLAYING state (1) — a video that's region-blocked,
   removed, private, or embedding-disabled loads its player and posts messages too, but
   never reaches PLAYING (it shows a "Video unavailable" screen and/or fires onError). So
   those degrade to the backdrop "cover" instead of revealing the error. On ENDED (0) we
   seek to 0 and replay (loop without the playlist param + its chrome). Source-identity
   check means we only react to OUR iframe. */
window.addEventListener('message',e=>{
  if(!modalTrailer||!e.source||e.source!==modalTrailer.contentWindow)return;
  let d=e.data; if(typeof d==='string'){ try{ d=JSON.parse(d); }catch(_){ return; } }
  if(!d)return;
  if(d.event==='onError'){ teardownTrailer(); return; }   // unavailable/blocked/removed → keep the cover
  const st=d.event==='onStateChange'?d.info:(d.event==='infoDelivery'&&d.info?d.info.playerState:undefined);
  if(st===1&&!trailerLive){                                // actually PLAYING
    trailerLive=true;
    // Let it play HIDDEN for a beat first. YouTube flashes its centre play/pause button while
    // playback starts (the intro) and auto-hides it a few seconds in; we keep the iframe
    // invisible until well past that window, so the trailer cross-dissolves in already
    // chrome-free. The backdrop cover stays up throughout — an intentional, Netflix-style
    // "art → trailer" beat — so the wait reads as design, not lag.
    const ifr=modalTrailer;
    setTimeout(()=>{
      if(modalTrailer!==ifr)return;                        // a different title opened / closed meanwhile
      ifr.classList.add('on');
      const hero=document.getElementById('mHero'); if(hero)hero.classList.add('has-trailer');
    },TRAILER_REVEAL_DELAY);
  }
  if(st===0){ ytPost('seekTo',[0,true]); ytPost('playVideo'); }   // ENDED → loop
});
document.getElementById('mMuteBtn').addEventListener('click',()=>{
  if(!modalTrailer)return;
  modalMuted=!modalMuted;
  // Seamless via the IFrame API (the channel is proven live — the trailer revealed through
  // it). No src reload, so toggling sound never restarts the trailer. setVolume guards
  // against an unmute landing at volume 0.
  if(modalMuted){ ytPost('mute'); }
  else{ ytPost('unMute'); ytPost('setVolume',[100]); }
  const mb=document.getElementById('mMuteBtn'), ic=mb.querySelector('.m-mute-ic');
  mb.setAttribute('aria-pressed',String(modalMuted));
  mb.setAttribute('aria-label',I18N.t(modalMuted?'modal.unmute':'modal.mute'));
  if(ic)ic.innerHTML=modalMuted?SVG_SPK_OFF:SVG_SPK_ON;
});

/* ---------- Casts & Credits (circular avatars + Show All) ---------- */
/* "Unknown person" silhouette — our own logo for cast/crew TMDB ships no headshot for.
   A head + rounded shoulders glyph that fills the circular avatar; styled via CSS
   (currentColor) so it inherits the muted, on-theme fallback look. */
const AVATAR_PLACEHOLDER='<span class="m-avatar-ph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 12.6a4.6 4.6 0 1 0 0-9.2 4.6 4.6 0 0 0 0 9.2ZM12 14.4c-5.2 0-9 3.1-9 7.4V24h18v-2.2c0-4.3-3.8-7.4-9-7.4Z"/></svg></span>';
/* Always render the silhouette fallback; overlay the photo when present. If the photo
   fails it removes itself, revealing the silhouette — robust with zero quote-escaping. */
function avatarHTML(name,profile){
  const alt=esc(name||'');
  return `<span class="m-avatar fallback" role="img" aria-label="${alt}">${AVATAR_PLACEHOLDER}`+
    (profile?`<img src="${esc(profile)}" alt="" loading="lazy" decoding="async" onerror="this.remove()"/>`:'')+
    `</span>`;
}
function renderCast(meta,isTv){
  const cast=meta.cast||[];
  const aside=document.getElementById('mCast'), dirWrap=document.getElementById('mCastDirector');
  const dirName=meta.director||((meta.creators||[])[0]&&meta.creators[0].name)||'';
  const dirPhoto=((meta.creators||[]).find(c=>c.name===dirName)||{}).profile||null;
  if(dirName){
    dirWrap.innerHTML=avatarHTML(dirName,dirPhoto)+
      `<div class="m-cast-body"><div class="m-cd-name">${esc(dirName)}</div>`+
      `<div class="m-cd-role">${esc(I18N.t(isTv?'modal.creator':'modal.director'))}</div></div>`;
    dirWrap.hidden=false;
  } else { dirWrap.hidden=true; dirWrap.innerHTML=''; }
  if(!cast.length&&!dirName){ aside.hidden=true; return; }
  aside.hidden=false;
  const LIMIT=5;
  document.getElementById('mCastList').innerHTML=cast.map((c,i)=>
    `<div class="m-cast-item${i>=LIMIT?' m-hidden':''}">${avatarHTML(c.name,c.profile)}`+
    `<div class="m-cast-body"><div class="m-cast-name">${esc(c.name||'')}</div>`+
    (c.character?`<div class="m-cast-char">${esc(I18N.t('modal.as',{name:c.character}))}</div>`:'')+
    `</div></div>`).join('');
  const more=document.getElementById('mCastMore');
  if(cast.length>LIMIT){ more.hidden=false; more.setAttribute('aria-expanded','false');
    more.querySelector('.m-showall-txt').textContent=I18N.t('modal.show_all'); }
  else more.hidden=true;
}
document.getElementById('mCastMore').addEventListener('click',e=>{
  const more=e.currentTarget, aside=document.getElementById('mCast');
  const open=more.getAttribute('aria-expanded')!=='true';
  more.setAttribute('aria-expanded',String(open));
  aside.classList.toggle('expanded',open);
  document.querySelectorAll('#mCastList .m-cast-item').forEach((el,i)=>{ if(i>=5)el.classList.toggle('m-hidden',!open); });
  more.querySelector('.m-showall-txt').textContent=I18N.t(open?'modal.show_less':'modal.show_all');
});

/* ---------- watchlist (+) + WATCH CTA — re-bound per open to the current title ---------- */
function wireModalActions(ds){
  const addBtn=document.getElementById('mAdd');
  const setAdd=on=>{ addBtn.classList.toggle('on',on); addBtn.textContent=on?'✓':'+';
    addBtn.setAttribute('aria-pressed',String(on));
    addBtn.setAttribute('aria-label',I18N.t(on?'mylist.remove':'mylist.add')); };
  setAdd(inMyList(ds.id));
  addBtn.onclick=()=>{ const on=toggleMyList({id:ds.id,title:ds.t}); setAdd(on);
    toast(on?t('toast.added',{t:ds.t}):t('toast.removed',{t:ds.t}), on?'var(--accent)':'var(--danger)'); };
  const watch=document.getElementById('mWatch');
  const watchLabel=watch.querySelector('[data-i18n="modal.watch"]');
  // Reset to the default WATCH label every open (a previous title may have set RESUME).
  if(watchLabel) watchLabel.textContent=I18N.t('modal.watch');
  watch.classList.remove('resume');
  // Saved timecode for THIS title? Relabel WATCH → RESUME and remember which episode to
  // jump back into. The auto-resume seek does the actual positioning once playback starts,
  // so even if the label can't show (e.g. mid language-switch), resume still works.
  const histEntry=(window.AUTH&&AUTH.user)?watchHistory().find(x=>String(x.id)===String(ds.id)):null;
  const rsm=histEntry?entryResume(histEntry):null;
  // for a series, the saved season/episode lets RESUME jump straight to the right episode
  window.__resumeEp=(rsm&&histEntry&&histEntry.season!=null&&histEntry.episode!=null)
    ? {season:histEntry.season, ep:histEntry.episode} : null;
  if(rsm&&watchLabel){
    const time=fmtClock(rsm.pos);
    // build the episode token deliberately from the numeric fields (consistent with the
    // __resumeEp gate above) rather than leaking the internal currentEpLabel snapshot
    watchLabel.textContent=(histEntry.season!=null&&histEntry.episode!=null)
      ? I18N.t('cta.resume_ep',{ep:'S'+histEntry.season+'E'+histEntry.episode, time:time})
      : I18N.t('cta.resume_time',{time:time});
    watch.classList.add('resume');
  }
  watch.onclick=()=>{
    const series=window.currentMediaType==='series';
    // series with a saved episode + the chooser already initialised → resume that exact
    // episode in one tap (auto-seek restores the position). Falls through otherwise.
    if(series&&window.__resumeEp&&window.seriesCtx&&seriesCtx.active){
      const re=window.__resumeEp; playEpisode(re.season,re.ep); return;
    }
    const tgt=document.getElementById(series?'epChooser':'streamList');
    if(tgt&&tgt.scrollIntoView)tgt.scrollIntoView({behavior:'smooth',block:'start'});
    // movies: kick off the best stream for the active language; series: user picks an episode
    if(!series){ const first=document.querySelector('#streamList .addon-stream'); if(first)first.click(); }
  };
}
/* keyboard: open a focused poster with Enter / Space */
addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  const p=document.activeElement;
  if(p&&p.classList&&p.classList.contains('poster')&&p.id!=='mPoster'){ e.preventDefault(); p.click(); }
});

/* ---------- functional streaming (ported from streamvault) ---------- */
function slugify(t){return (t||'').trim().replace(/[^\w\s]/g,'').replace(/\s+/g,'.')}
function buildStreams(title,year){
  const s=slugify(title)||'Title';
  const FROM=esc(t('stream.from')), DIRECT=esc(t('stream.direct_link'));
  const item=(q,qc)=>`<button class="addon-stream" onclick="openPlayer()" aria-label="${s}.${year}.${q}">
      <span class="quality-badge ${qc}">${q}</span>
      <span class="stream-info">
        <span class="stream-title">${s}.${year}.${q}</span>
        <span class="stream-detail">${DIRECT}</span>
      </span>
      <span class="addon-stream-chevron" aria-hidden="true">›</span>
    </button>`;
  return `
    <div class="stream-source-label">${FROM}Sample</div>
    ${item('1080p','q-1080')}
    ${item('720p','q-720')}`;
}
/* ====================== premium video player ====================== */
const VP=(function(){
  const ov=document.getElementById('playerOverlay');
  const v=document.getElementById('playerVideo');
  const $=id=>document.getElementById(id);
  const DEMO_SRC='/assets/demo.mp4';   // bundled sample (H.264 + AAC) so the demo player has real video + sound
  let hideTimer,currentSub=-1,curStream=null,dragging=false,scrubX=null,audioHintShown=false,hls=null,subsLoading=false;
  // automatic source fallback chain — see playCurrentCandidate
  let cand=[],candI=0,candTried=null,audioFailed=null,playGen=0,stallTimer=null,lastProg=0,lastProgClock=0,resolving=false,cacheRetried=false;
  // resume-by-timecode: the position the next source-load should seek to (survives auto-
  // fallback swaps + manual quality switches), the last-persisted position, and a one-time
  // "Resuming from…" toast latch
  let resumeTarget=0,lastSavePos=0,resumeToastPending=false;

  function fmt(t){ if(!isFinite(t)||t<0)t=0; t=Math.floor(t);
    const h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=t%60;
    return (h?h+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0'); }
  function setStatus(html){ $('playerStatus').innerHTML=html||''; }
  function vpToast(msg){ const el=$('vpToast'); el.textContent=msg; el.classList.add('show');
    clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),1800); }
  function showLoading(text,sub){ $('vpLoadingText').textContent=text||''; $('vpLoadingSub').textContent=sub||'';
    $('vpLoading').classList.add('show'); $('vpCenter').classList.add('hidden'); }
  function hideLoading(){ $('vpLoading').classList.remove('show'); }

  /* picture-enhance: a CSS contrast/saturation bump on the <video> plus the animated film-grain
     overlay. It adds no real detail (the browser can't reconstruct data the encoder discarded), but
     dithers banding and masks macroblocking so low-bitrate streams read sharper. Strength 0–100 from
     SETTINGS; grain opacity stays low (4–14%) so clean sources aren't visibly noisy. */
  function applyEnhance(){
    const gOn=!!SETTINGS.enhance, gLvl=Math.max(0,Math.min(100,+SETTINGS.enhanceLevel||0))/100;
    const cOn=!!SETTINGS.clarity,  cLvl=Math.max(0,Math.min(100,+SETTINGS.clarityLevel||0))/100;
    ov.classList.toggle('enhance-on',gOn);     // grain layer visibility
    if(cOn){
      // unsharp kernel parameterised by amount a (identity at 0): centre 1+4a, edges −a.
      // cap a≈0.85 at max so strong settings sharpen without harsh ringing/haloing.
      const a=0.85*cLvl, c=(1+4*a).toFixed(4), e=(-a).toFixed(4), k=$('vpSharpenK');
      if(k)k.setAttribute('kernelMatrix',`0 ${e} 0 ${e} ${c} ${e} 0 ${e} 0`);
    }
    // chain the sharpen convolution (if on) before the colour/contrast functions
    let f=cOn?'url(#vpSharpen) ':'';
    if(gOn)f+=`contrast(${(1+0.14*gLvl).toFixed(3)}) saturate(${(1+0.20*gLvl).toFixed(3)}) brightness(${(1+0.03*gLvl).toFixed(3)})`;
    v.style.filter=f.trim();
    ov.style.setProperty('--grain',(gOn?(0.04+0.10*gLvl):0).toFixed(3));
  }
  function open(title){ overlay.classList.remove('open'); ov.classList.add('open'); $('playerTitle').textContent=title||''; showUI(); applyEnhance();
    try{ const _g=$('vpGestures'); if(_g&&_g._resetBright)_g._resetBright(); }catch(e){}   // clear the gesture brightness dimmer per title
    refreshSeriesUI();
    if(window.__bg)window.__bg.stop(); }   // pause the background canvas while a video plays
  function close(){ try{ saveResume(); }catch(e){}   // flush the stop position before tearing the source down
    ov.classList.remove('open','hide-ui'); try{v.pause()}catch(e){} destroyHls(); clearStallWatch(); v.removeAttribute('src');
    clearSubs(); try{v.load()}catch(e){} closeMenu(); closeEpPanel(); hideSkip();
    dragging=false; scrubX=null;   // never leak an in-flight scrub across player sessions (freezes the next bar)
    if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
    try{ renderContinueWatching(); }catch(e){}      // returning home shows the freshly-advanced resume bar
    if(window.__bg)window.__bg.start(); }

  /* ---- resume by timecode ----------------------------------------------------
   * resumeTarget is the position the NEXT source-load should seek to. armResume() seeds
   * it from the saved progress on a fresh start; applyResume() (fired from 'loadedmetadata'
   * for EVERY source load) restores it — so the position survives an auto-fallback candidate
   * swap or a manual quality switch, not just the first load. While playing, maybeSaveResume
   * keeps resumeTarget tracking the LIVE position (so a mid-watch swap resumes where the user
   * actually is) and persists it every few seconds; reaching the end clears it. On-device,
   * signed-in only — mirrors the watch-history store. */
  function armResume(){
    lastSavePos=0;
    const key=curMediaKey(); const p=key?getProgress(key):null;
    resumeTarget=(p&&p.pos>PROGRESS_MIN)?p.pos:0;    // 0 → start from the beginning
    resumeToastPending=resumeTarget>0;               // show "Resuming from…" once, on the first restore
  }
  function applyResume(){
    if(v.loop) return;                               // demo clip — nothing to restore
    if(!(resumeTarget>PROGRESS_MIN)) return;
    const d=v.duration||0;
    if(d&&resumeTarget>=d-15){ resumeTarget=0; resumeToastPending=false; return; }  // essentially finished → from start
    try{ v.currentTime=resumeTarget; }catch(e){}
    if(resumeToastPending){ resumeToastPending=false; vpToast(t('player.resuming',{time:fmt(resumeTarget)})); }
  }
  function saveResume(){
    if(!(window.AUTH&&AUTH.user)) return;            // resume/history is a signed-in feature
    if(!curStream||v.loop) return;                   // skip the looping demo clip / no real source
    const d=v.duration||0, pos=v.currentTime||0;
    if(!d||pos<PROGRESS_MIN) return;
    if(pos>=d-12||pos/d>=PROGRESS_DONE){ finishResume(); return; }   // near the end → mark finished
    putProgress(curMediaKey(), pos, d);
  }
  function maybeSaveResume(){
    if(v.paused||v.seeking) return;
    const pos=v.currentTime||0;
    if(pos>1) resumeTarget=pos;                      // track live position so a source swap resumes HERE, not the stale point
    if(Math.abs(pos-lastSavePos)<4.5) return;        // throttle: persist ~once per 4–5s of playback
    lastSavePos=pos; saveResume();
  }
  function finishResume(){
    const key=curMediaKey(); if(key) delProgress(key);
    lastSavePos=0; resumeTarget=0; resumeToastPending=false;
    // a finished MOVIE leaves Continue Watching; a SERIES stays on the rail (you'll likely
    // roll into / pick the next episode) — just drop its now-stale progress bar.
    try{
      if(window.currentMediaType!=='series'){ if(window.currentTitleMeta&&currentTitleMeta.id) removeFromHistory(currentTitleMeta.id); }
      else renderContinueWatching();
    }catch(e){}
  }

  /* ---- source loading ---- */
  function destroyHls(){ if(hls){ try{hls.destroy();}catch(e){} hls=null; } }
  // Attach any per-stream subtitles the addon supplied (e.g. an addon's eng/rus VTT).
  // Fetched in the browser and turned into a same-document blob: <track> — no server
  // A subtitle host without CORS simply can't be read and is skipped.
  function addStreamSubs(s){
    if(!s||!Array.isArray(s.subtitles))return;
    s.subtitles.forEach(async sub=>{ if(!sub||!sub.url)return;
      let blobUrl; try{ blobUrl=await subtitleBlobUrl(sub.url); }catch(e){ return; }
      const tr=document.createElement('track'); tr.kind='subtitles';
      tr.label=sub.lang||'Subtitle'; tr.srclang=String(sub.lang||'und').slice(0,3);
      tr.src=blobUrl; v.appendChild(tr); });
  }
  // Settings › Advanced "Play in external player": hand a real http(s) stream off
  // to a native app via its deep-link scheme. In-browser playback continues as a
  // fallback so the page is never left blank if the app isn't installed.
  const EXT_DEEPLINK={
    vlc:u=>'vlc://'+u,
    infuse:u=>'infuse://x-callback-url/play?url='+encodeURIComponent(u),
    outplayer:u=>'outplayer://'+encodeURIComponent(u),
    nplayer:u=>'nplayer-'+u
  };
  function maybeExternalPlayer(url){
    const app=SETTINGS.externalPlayer;
    if(!app||app==='disabled'||!EXT_DEEPLINK[app])return;
    if(!/^https?:\/\//i.test(url||''))return;     // schemes only handle plain http(s) sources
    try{
      const a=document.createElement('a'); a.href=EXT_DEEPLINK[app](url);
      a.style.display='none'; document.body.appendChild(a); a.click(); a.remove();
      vpToast(t('settings.ext_opening',{app:app.toUpperCase()}));
    }catch(e){}
  }
  // On the split deploy (frontend on Vercel, backend on Render) any root-relative
  // '/api/...' URL (e.g. a subtitle endpoint) resolves against the PAGE origin
  // (Vercel), which has no /api/ — so it 404s. A <video>.src or hls.loadSource() can't
  // use the fetch() wrapper (these aren't fetch calls), so resolve '/api/...' URLs
  // against the backend explicitly. Direct add-on stream URLs are already absolute
  // (CORS-enabled) and are left untouched.
  function mediaSrc(u){
    return (window.API_BASE && typeof u==='string' && u.lastIndexOf('/api/',0)===0) ? window.API_BASE+u : u;
  }
  function load(url,title){
    if(title)$('playerTitle').textContent=title;
    maybeExternalPlayer(url);           // external-player handoff (no-op when disabled)
    destroyHls();                       // tear down any HLS engine from a previous source
    v.loop=false;                       // real streams play through once (openDemo re-enables loop for the sample)
    audioHintShown=false;               // re-arm the "no audio decoded" check for the new source
    clearSubs();
    setStatus('<span class="spinner"></span> '+t('status.buffering'));
    // the #vpLoading overlay already shows the spinner for this initial-load phase —
    // don't also light up the center buffering ring (two overlapping loaders). The
    // center ring is reserved for mid-playback stalls via the 'waiting' listener.
    v.src=mediaSrc(url); v.load();
    const p=v.play(); if(p&&p.catch)p.catch(()=>{});
    addStreamSubs(curStream); loadSubs(); buildMenu();
  }
  // Some HLS masters carry several audio renditions (e.g. multiple languages)
  // and usually DEFAULT to Russian. Each stream row tells us which language it's for
  // (s.audioLang); we switch the player to that audio track so the chosen language
  // actually plays. Matching is by track name/lang; falls back to Georgian.
  let desiredAudioLang='ka';
  const AUDIO_LANG_RE={
    ka:/georgian|ქართ|(^|[^a-z])(geor?|kat|ka)([^a-z]|$)/i,
    en:/english|ინგ|(^|[^a-z])(eng|en)([^a-z]|$)/i,
    ru:/russian|рус|რუს|(^|[^a-z])(rus|ru)([^a-z]|$)/i,
  };
  function selectAudioLang(code){
    if(!hls||!hls.audioTracks||!hls.audioTracks.length)return;
    const re=AUDIO_LANG_RE[code||'ka']; if(!re)return;
    const i=hls.audioTracks.findIndex(a=>re.test((a.name||'')+' '+(a.lang||'')));
    if(i>=0&&hls.audioTrack!==i){ try{hls.audioTrack=i;}catch(e){} }
  }
  function loadHls(url,title,audioLang){
    desiredAudioLang=audioLang||'ka';
    if(title)$('playerTitle').textContent=title;
    v.loop=false; audioHintShown=false; clearSubs();
    setStatus('<span class="spinner"></span> '+t('status.buffering'));
    // see load(): the #vpLoading overlay covers this phase; skip the center ring here.
    destroyHls();
    if(window.Hls&&Hls.isSupported()){
      // Generous buffers so seeking is reliable: keep ~3min of back-buffer (instant rewind
      // into recently-watched content instead of a re-fetch) and let it buffer well ahead so
      // short forward jumps land in already-loaded video. A small maxBufferLength is what made
      // rewinds/forward-seeks stall and snap back.
      hls=new Hls({maxBufferLength:60,maxMaxBufferLength:600,backBufferLength:180,
        manifestLoadingTimeOut:20000,levelLoadingTimeOut:20000});
      hls.loadSource(mediaSrc(url)); hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED,()=>{ selectAudioLang(desiredAudioLang); buildMenu(); const p=v.play(); if(p&&p.catch)p.catch(()=>{}); });
      // The audio-track list/selection can settle AFTER manifest parse (DEFAULT=YES wins
      // otherwise) — re-apply the desired language once tracks are updated.
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED,()=>{ selectAudioLang(desiredAudioLang); if($('vpMenu').classList.contains('open'))buildMenu(); });
      hls.on(Hls.Events.LEVEL_SWITCHED,()=>{ if($('vpMenu').classList.contains('open'))buildMenu(); });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED,()=>{ if($('vpMenu').classList.contains('open'))buildMenu(); });
      hls.on(Hls.Events.ERROR,(ev,data)=>{ if(!data||!data.fatal)return;
        if(data.type===Hls.ErrorTypes.NETWORK_ERROR){ try{hls.startLoad();}catch(e){} }
        else if(data.type===Hls.ErrorTypes.MEDIA_ERROR){ try{hls.recoverMediaError();}catch(e){} }
        else { destroyHls(); showLoading(t('player.cant_play'),t('player.try_another')); setStatus('✕ '+t('status.failed')); }
      });
    } else if(v.canPlayType('application/vnd.apple.mpegurl')){
      v.src=mediaSrc(url); v.load(); const p=v.play(); if(p&&p.catch)p.catch(()=>{});
    } else {
      showLoading(t('player.cant_play'),t('player.try_another')); setStatus('✕ '+t('status.failed')); return;
    }
    addStreamSubs(curStream); loadSubs(); buildMenu();
  }
  function titleLabel(){
    // series: title bar shows just the show name — the S·E·name line is carried by the
    // accent subtitle (set in refreshSeriesUI), so we don't repeat it here.
    if(window.seriesCtx&&seriesCtx.active&&seriesCtx.season!=null) return currentTitle;
    const ep=window.currentEpLabel; return ep?`${currentTitle} ${ep} (${currentYear})`:`${currentTitle} (${currentYear})`;
  }

  /* ---- automatic source fallback ------------------------------------------ *
   * The server returns a ranked, cached-first fallback CHAIN per language. We play
   * the best candidate and, if it stalls / errors / plays silent (AC-3/DTS the browser
   * can't decode), silently advance to the next one — so the user no longer has to
   * manually retry. Georgian HLS is a single working source and is left untouched. */
  function setupCandidates(s){
    const lang=window.currentLang||(s&&streamLangs(s)[0])||'en';
    const all=window.currentStreams||[];
    const sameLang=all.filter(x=>streamLangs(x).includes(lang));
    // clicked stream first, then the ranked order (deduped by url)
    cand=[s].concat(sameLang.filter(x=>x!==s&&x.url!==s.url));
    candI=0; candTried=new Set(); audioFailed=new Set(); cacheRetried=false;
  }
  function clearStallWatch(){ if(stallTimer){ clearInterval(stallTimer); stallTimer=null; } }
  function armStallWatch(){
    clearStallWatch();
    lastProg=0; lastProgClock=Date.now();
    if(!curStream||curStream.kind!=='url')return;   // watch progressive (direct-file) playback; HLS self-recovers
    stallTimer=setInterval(()=>{
      if(!ov.classList.contains('open')){ clearStallWatch(); return; }
      if(v.paused||v.ended)return;                       // user paused → not a stall
      if(v.currentTime>lastProg+0.25){ lastProg=v.currentTime; lastProgClock=Date.now(); return; }
      if(Date.now()-lastProgClock>18000){ clearStallWatch(); onPlaybackTrouble('stall'); }
    },2000);
  }
  function nextCandidateIdx(preferAudioOk){
    const free=i=>i>=0&&i<cand.length&&!candTried.has(i);
    if(preferAudioOk){ for(let i=0;i<cand.length;i++) if(free(i)&&!audioFailed.has(i)&&cand[i].audioOk) return i; }
    for(let i=0;i<cand.length;i++) if(free(i)&&!audioFailed.has(i)) return i;   // any untried, not-known-silent
    for(let i=0;i<cand.length;i++) if(free(i)) return i;                        // last resort: any untried
    return -1;
  }
  function advanceCandidate(reason){
    if(!ov.classList.contains('open'))return;
    clearStallWatch();
    const next=nextCandidateIdx(reason==='audio');
    if(next<0){   // exhausted — honest message
      // audio-only exhaustion: the current source still shows WATCHABLE (silent) video, so
      // surface a non-destructive toast instead of covering it with the error overlay.
      if(reason==='audio'){ vpToast(t('player.no_audio_hint')); setStatus('<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:5px"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>'+t('status.live')); return; }
      showLoading(t('player.cant_play'),t('player.try_another')); setStatus('✕ '+t('status.failed')); return;
    }
    candI=next;
    vpToast(t('player.trying_next',{n:candI+1,total:cand.length}));
    setStatus('<span class="spinner"></span> '+t('status.buffering'));
    playCurrentCandidate();
  }
  function onPlaybackTrouble(reason){
    if(!ov.classList.contains('open'))return;
    if(resolving)return;   // a candidate resolve is in flight — ignore a stray stall/error/audio event from the prior source
    if(reason==='audio'&&candI>=0)audioFailed.add(candI);   // don't revisit this silent source
    advanceCandidate(reason);
  }
  async function playCurrentCandidate(){
    ++playGen; const s=cand[candI]; if(!s)return;
    candTried.add(candI); curStream=s;
    if(s.kind==='hls'){ clearStallWatch(); loadHls(s.url,titleLabel(),s.audioLang); return; }
    load(s.url,titleLabel()); armStallWatch();   // direct (non-HLS) file
  }
  async function resolveAddonStream(s){
    curStream=s; open(titleLabel());
    try{ recordWatch(); }catch(e){}
    try{ armResume(); }catch(e){}        // resume from the saved timecode once metadata loads
    setupCandidates(s);
    await playCurrentCandidate();
  }
  function openDemo(){
    open(`${currentTitle} (${currentYear})`);
    try{ recordWatch(); }catch(e){}
    try{ resumeTarget=0; lastSavePos=0; resumeToastPending=false; }catch(e){}   // demo loops a 30s clip — nothing to resume/persist
    curStream=null; clearStallWatch();   // demo clip — no real source, so no fallback machinery
    setStatus(t('status.demo'));
    // No stream source installed → play the bundled sample clip so the player
    // actually shows video AND plays sound, with all controls live.
    load(DEMO_SRC, `${currentTitle} (${currentYear})`);
    v.loop=true;                        // set AFTER load() (which resets loop) so the short sample repeats
    vpToast(t('player.demo_sub'));      // make clear it's a sample; real sources need a stream add-on
  }
  async function switchStream(s){
    if(!s||s===curStream)return; const wasPlaying=!v.paused; curStream=s;
    // Capture the live position into resumeTarget (incl. a fresh scrub); applyResume() will
    // restore it on the new source's metadata — so we no longer need our own seek listener,
    // and it can't race/clobber the auto-resume seek. >1 guard keeps a saved-but-not-yet-
    // started resume point intact when switching during the initial resolve.
    if(v.currentTime>1) resumeTarget=v.currentTime;
    // re-anchor the fallback chain on the manually chosen source so a later stall still
    // auto-advances from here onward; ++playGen cancels any in-flight auto-resolve, and gen
    // guards this manual resolve against an out-of-order earlier switch clobbering it.
    ++playGen; setupCandidates(s); candTried.add(0); clearStallWatch();
    const resumePlay=()=>{ if(wasPlaying)v.play().catch(()=>{}); v.removeEventListener('loadedmetadata',resumePlay); };
    v.addEventListener('loadedmetadata',resumePlay);
    if(s.kind==='hls'){ loadHls(s.url,$('playerTitle').textContent,s.audioLang); }
    else { load(s.url,$('playerTitle').textContent); armStallWatch(); }
    vpToast(I18N.t('player.source')+(s.quality||'SD')+' · '+s.source);
  }
  // switch the playback LANGUAGE (multi-language sources: one stream per language). Picks that
  // language's best stream (the list arrives best-first), updates currentLang so the
  // Quality submenu re-filters, and hands off to switchStream. No-op if the language has
  // no stream or is already playing.
  function switchLang(l){
    if(!l)return;
    const list=(window.currentStreams||[]).filter(s=>streamLangs(s).includes(l));
    if(!list.length)return;
    const pick=list[0];
    window.currentLang=l;
    if(pick!==curStream) switchStream(pick);
    buildMenu();
  }

  /* ---- subtitles (addon + embedded) ---- */
  function subTracks(){ return [...v.textTracks].filter(t=>t.kind==='subtitles'||t.kind==='captions'); }
  function clearSubs(){ [...v.querySelectorAll('track')].forEach(t=>t.remove()); currentSub=-1; $('vpCC').classList.remove('active'); }
  async function loadSubs(){
    const id=window.currentImdb; if(!id){ buildMenu(); return; }
    subsLoading=true;
    try{
      // Browser → each installed subtitle add-on directly.
      const type=window.currentMediaType||'movie';
      const addons=(window.INSTALLED_ADDONS||[]).filter(a=>addonHasResource(a,'subtitles',type));
      const lists=await Promise.all(addons.map(async a=>{
        try{
          const data=await fetchAddonJSON(addonBaseUrl(a.url),'subtitles/'+type+'/'+encodeURIComponent(id)+'.json');
          return (data.subtitles||[]).filter(s=>s.url).map(s=>({
            lang:s.lang||s.id||'und',
            label:(subLangName(s.lang)||s.lang||'Subtitle')+(s.id&&/hi|sdh/i.test(s.id)?' (SDH)':''),
            url:s.url }));
        }catch(e){ return []; }
      }));
      const seen=new Set();
      for(const s of lists.flat()){ const k=(s.label||s.lang); if(seen.has(k)||seen.size>=12)continue; seen.add(k);
        let blobUrl; try{ blobUrl=await subtitleBlobUrl(s.url); }catch(e){ continue; }  // skip CORS-blocked hosts
        const tr=document.createElement('track'); tr.kind='subtitles'; tr.label=s.label||s.lang||'Subtitle';
        tr.srclang=(s.lang||'und').slice(0,3); tr.src=blobUrl; v.appendChild(tr); }
    }catch(e){}
    // finally so the flag always clears (incl. the early-return path) — honour Settings ›
    // "Default subtitles language" then rebuild the menu with the freshly loaded tracks
    finally{ subsLoading=false; autoSelectSub(); buildMenu(); }
  }
  // language matchers for the "Default subtitles language" preference
  const SUB_LANG_RE={
    en:/eng|english/i, ka:/geo|kat|ka\b|ქართ|georgian/i, ru:/rus|ru\b|рус|russian/i
  };
  function autoSelectSub(){
    if(currentSub>=0)return;                 // user/earlier pick wins
    const want=SETTINGS.subLang; if(!want||want==='off')return;
    const re=SUB_LANG_RE[want]; if(!re)return;
    const tts=subTracks(); if(!tts.length)return;
    const i=tts.findIndex(tt=>re.test((tt.label||'')+' '+(tt.language||'')));
    if(i>=0)applySub(i);
  }
  function applySub(idx){ const tts=subTracks(); tts.forEach((tt,i)=>tt.mode=(i===idx?'showing':'disabled'));
    currentSub=idx; $('vpCC').classList.toggle('active',idx>=0); $('vpCC').setAttribute('aria-pressed',String(idx>=0)); buildMenu(); }
  function toggleCC(){ const tts=subTracks();
    if(currentSub<0 && !tts.length && subsLoading){ vpToast(t('status.buffering')); return; }   // addon subs still loading — don't claim "none"
    if(currentSub>=0){ applySub(-1); vpToast(t('player.subs_off')); }
    else if(tts.length){ let i=tts.findIndex(tt=>/eng|english/i.test((tt.label||'')+(tt.language||''))); if(i<0)i=0; applySub(i); vpToast(t('player.subs_on')+(tts[i].label||'on')); }
    else vpToast(window.currentImdb?t('player.no_subs_install'):t('player.no_subs')); }

  /* ---- audio tracks ---- */
  function audioTracks(){ return v.audioTracks?[...v.audioTracks]:[]; }
  function applyAudio(idx){ audioTracks().forEach((a,i)=>a.enabled=(i===idx)); buildMenu(); vpToast(t('player.audio_track')+(idx+1)); }

  /* ---- series: in-player episode panel + skip / next-episode ---- */
  // heuristic windows (seconds) — no real chapter markers, so approximate the
  // opening title sequence and the end-credits tail.
  const INTRO_FROM=8, INTRO_TO=92;
  // how early the contextual "Next episode" button surfaces — driven by the
  // Settings › Auto-Play "Next video popup duration" preference (seconds).
  const creditsTail=()=>Math.max(5,Math.min(120,+SETTINGS.nextPopupSecs||35));
  let curNextEp=null, skipMode=null, epPanelSeason=null;
  // Real intro/outro markers for the playing episode, from IntroDB (proxied via
  // /api/introdb). null until fetched / when none exist — updateSkip then falls
  // back to the INTRO_FROM…INTRO_TO + creditsTail heuristic. segToken guards
  // against a slow response for a previous episode clobbering the current one.
  let curSegments=null, segToken=0;
  async function loadSegments(imdb,s,e){
    const tok=++segToken; curSegments=null;
    try{
      const r=await fetch(`/api/introdb/${encodeURIComponent(imdb)}/${s}/${e}`);
      if(!r.ok)return;
      const d=await r.json();
      if(tok===segToken) curSegments=d;   // ignore if the episode changed meanwhile
    }catch(_){}
  }
  const ctx=()=>window.seriesCtx||{};
  // refresh everything that depends on series state: the ▦ button, the title subline,
  // and the next-episode lookahead. Called whenever a new source starts.
  function refreshSeriesUI(){
    const isSeries=!!ctx().active;
    $('vpEpisodes').style.display=isSeries?'':'none';
    const sub=$('vpSubtitle');
    if(isSeries&&ctx().season!=null){
      sub.textContent='S'+ctx().season+' · E'+ctx().ep+(ctx().epName?'  ·  '+ctx().epName:'');
      sub.style.display='block';   // override the CSS default (display:none)
    }else{ sub.style.display='none'; sub.textContent=''; }
    curNextEp=isSeries?nextEpisodeInfo():null;
    curSegments=null; ++segToken;   // invalidate any in-flight fetch from the last source
    if(isSeries&&ctx().imdb&&ctx().season!=null&&ctx().ep!=null) loadSegments(ctx().imdb,ctx().season,ctx().ep);
    hideSkip();
  }
  function hideSkip(){ const b=$('vpSkip'); b.classList.remove('show'); b.dataset.mode=''; skipMode=null; }
  // contextual button: Skip Intro early, Next Episode during the end-credits tail
  function updateSkip(){
    const b=$('vpSkip'), dur=v.duration, ct=v.currentTime;
    if(!ctx().active||!isFinite(dur)||dur<300||v.loop){ if(skipMode)hideSkip(); return; }
    const seg=curSegments||{};
    // Use IntroDB markers only when they're sane for THIS file (the source must run
    // long enough to contain them); otherwise fall back to the heuristic window.
    const intro=(seg.intro&&seg.intro.end<dur)?seg.intro:null;
    const outroStart=(seg.outro&&seg.outro.start>0&&seg.outro.start<dur)?seg.outro.start:null;
    // Next Episode: surface at the real credits marker, else the heuristic tail.
    const nextAt=(outroStart!=null)?outroStart:dur-creditsTail();
    if(curNextEp&&ct>=nextAt&&dur-ct>0.5){
      if(skipMode!=='next'){ skipMode='next'; b.dataset.mode='next';
        b.textContent=t('player.next_episode'); b.classList.add('show'); }
      return;
    }
    // Skip Intro: inside the real intro range, else the heuristic window.
    const inIntro=intro?(ct>=intro.start&&ct<=intro.end):(ct>=INTRO_FROM&&ct<=INTRO_TO);
    if(inIntro){
      if(skipMode!=='intro'){ skipMode='intro'; b.dataset.mode='intro';
        b.dataset.to=intro?intro.end:INTRO_TO;   // where onSkipClick jumps to
        b.textContent=t('player.skip_intro'); b.classList.add('show'); }
      return;
    }
    if(skipMode)hideSkip();
  }
  function onSkipClick(){
    if($('vpSkip').dataset.mode==='next'){ if(curNextEp)playEpisode(curNextEp.season,curNextEp.ep); }
    else { const to=+$('vpSkip').dataset.to||INTRO_TO;   // real intro end when known, else heuristic
      try{ v.currentTime=Math.min((v.duration||0)-1,Math.max(v.currentTime,to)); }catch(e){} }
    hideSkip(); showUI();
  }
  function closeEpPanel(){ $('vpEpPanel').classList.remove('open'); $('vpEpPanel').setAttribute('aria-hidden','true'); }
  function openEpPanel(){
    if(!ctx().active)return;
    $('vpEpShow').textContent=currentTitle||'';
    epPanelSeason=ctx().season!=null?ctx().season:((ctx().seasons[0]||{}).season);
    buildEpSeasons(); selectEpPanelSeason(epPanelSeason);
    $('vpEpPanel').classList.add('open'); $('vpEpPanel').setAttribute('aria-hidden','false'); showUI();
  }
  function buildEpSeasons(){
    $('vpEpSeasons').innerHTML=(ctx().seasons||[]).map(s=>{
      const label=s.name||t('modal.season',{n:s.season});
      return `<button class="vp-season-tab ${s.season===epPanelSeason?'on':''}" type="button" data-season="${s.season}">${esc(label)}</button>`;
    }).join('');
  }
  async function selectEpPanelSeason(n){
    epPanelSeason=n; buildEpSeasons();
    const list=$('vpEpListPlayer');
    list.innerHTML=`<div class="ep-loading"><span class="spinner"></span> ${esc(t('modal.loading_episodes'))}</div>`;
    const eps=await fetchSeasonEpisodes(n);
    if(!$('vpEpPanel').classList.contains('open'))return;
    if(!eps.length){ list.innerHTML=`<div class="ep-loading">${esc(t('modal.episodes_unavailable'))}</div>`; return; }
    list.innerHTML=eps.map(e=>{
      const on=ctx().season===n&&ctx().ep===e.episode;
      const watched=isEpWatched(ctx().imdb,n,e.episode);
      const nm=esc(e.name||('Episode '+e.episode));
      const still=e.still
        ? `<span class="ep-still"><img src="${esc(e.still)}" loading="lazy" decoding="async" alt="" onerror="this.parentNode.classList.add('no-still');this.parentNode.setAttribute('data-n','E'+${e.episode});this.remove()"/></span>`
        : `<span class="ep-still no-still" data-n="E${e.episode}"></span>`;
      return `<button class="ep-row ${on?'on':''} ${watched?'watched':''}" type="button" data-season="${n}" data-ep="${e.episode}">
        ${still}
        <span class="ep-num">E${e.episode}</span>
        <span class="ep-body"><span class="ep-name">${nm}</span></span>
      </button>`;
    }).join('');
  }

  /* ---- settings menu ---- */
  function optRow(on,label,attrs,sub,badge){ return `<div class="vp-opt ${on?'on':''}" ${attrs}><span class="ck">${on?'✓':''}</span>${esc(label)}${badge||''}${sub?`<span class="sub">${esc(sub)}</span>`:''}</div>`; }
  // friendly name for an hls.js audio track / quality level
  const AUDIO_LABELS={eng:'English',en:'English',rus:'Russian',ru:'Russian',geo:'ქართული',ka:'ქართული',kat:'ქართული',ukr:'Ukrainian',tur:'Turkish',fre:'French',ger:'German',ita:'Italian',jpn:'Japanese',kor:'Korean',spa:'Spanish'};
  function audioLabel(a,i){ return a.name||AUDIO_LABELS[(a.lang||'').toLowerCase()]||a.lang||(t('menu.track')+(i+1)); }
  // friendly, UI-localized name for a stream language code (streams may carry s.lang).
  // Prefer the i18n langtab.* string; fall back to a full-name map / the raw code uppercased.
  const LANG_FULL={ka:'Georgian',en:'English',ru:'Russian',uk:'Ukrainian',tr:'Turkish',fr:'French',de:'German',it:'Italian',es:'Spanish',ja:'Japanese',ko:'Korean',hi:'Hindi',zh:'Chinese',pl:'Polish',pt:'Portuguese'};
  function langName(l){ const k='langtab.'+l, v=t(k); return (v&&v!==k)?v:(LANG_FULL[l]||AUDIO_LABELS[l]||(l||'').toUpperCase()); }
  // Map an HLS level to a standard quality tier. Sources use cinematic heights
  // (e.g. 1920x816, 1280x544, 854x362) so we derive a 16:9-equivalent height from
  // the width and snap to the nearest common label → 1080p / 720p / 480p …
  function levelLabel(l){
    if(!l) return '?';
    const eq=Math.max(l.height||0, l.width?Math.round(l.width*9/16):0);
    if(eq>=1900) return '2160p';
    if(eq>=1300) return '1440p';
    if(eq>=900)  return '1080p';
    if(eq>=650)  return '720p';
    if(eq>=400)  return '480p';
    if(eq>=300)  return '360p';
    if(eq>0)     return '240p';
    return l.bitrate?Math.round(l.bitrate/1000)+'k':'?';
  }
  // gear/cog icon used as each section's expander affordance
  const GEAR_SVG='<svg class="vp-acc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  // which accordion sections are expanded (persisted across rebuilds)
  const accOpen=new Set();
  // wrap a section's options behind a collapsible gear-icon header
  function accSection(key,label,val,body){
    const open=accOpen.has(key);
    return `<div class="vp-acc ${open?'open':''}">`
      +`<button class="vp-acc-head" data-act="acc" data-sec="${key}" aria-expanded="${open}">`
      +GEAR_SVG
      +`<span class="vp-acc-label">${esc(label)}</span>`
      +(val?`<span class="vp-acc-val">${esc(val)}</span>`:'')
      +`</button><div class="vp-acc-body">${body}</div></div>`;
  }
  function buildMenu(){
    let h=''; const tts=subTracks();
    /* subtitles */
    let subBody=optRow(currentSub<0,t('menu.off'),'data-act="sub" data-i="-1"');
    if(!tts.length)subBody+=`<div class="vp-opt" style="opacity:.5">${esc(window.currentImdb?t('menu.no_subs_found'):t('menu.install_sub_addon'))}</div>`;
    tts.forEach((tt,i)=>subBody+=optRow(i===currentSub,tt.label||tt.language||(t('menu.track')+(i+1)),`data-act="sub" data-i="${i}"`));
    const subVal=currentSub<0?t('menu.off'):(tts[currentSub]&&(tts[currentSub].label||tts[currentSub].language))||'';
    h+=accSection('subs',t('menu.subtitles'),subVal,subBody);
    /* audio language — HLS renditions (hls.js) live on hls.audioTracks, not v.audioTracks
       (hls.js attaches a single rendition to the media element), so prefer the HLS list when
       streaming HLS and fall back to the native track list otherwise. */
    const ats=audioTracks();
    if(hls&&hls.audioTracks&&hls.audioTracks.length>1){
      let aBody='',aVal='';
      hls.audioTracks.forEach((a,i)=>{ const lbl=audioLabel(a,i); const on=hls.audioTrack===i; if(on)aVal=lbl;
        aBody+=optRow(on,lbl,`data-act="hlsaudio" data-i="${i}"`); });
      h+=accSection('audio',t('menu.audio_lang'),aVal,aBody);
    } else if(ats.length>1){
      let aBody=''; let aVal='';
      ats.forEach((a,i)=>{ const lbl=a.label||a.language||(t('menu.track')+(i+1)); if(a.enabled)aVal=lbl;
        aBody+=optRow(a.enabled,lbl,`data-act="audio" data-i="${i}"`); });
      h+=accSection('audio',t('menu.audio_lang'),aVal,aBody);
    } else {
      // Multi-language sources: each language is a SEPARATE stream (single embedded
      // audio track), so derive the available languages from the stream list and let the user
      // switch language straight from the player. Selecting one swaps to that language's best
      // (cached-first) stream. Only the languages that actually have a stream are listed.
      const all=window.currentStreams||[]; const langs=[];
      all.forEach(s=>{ const l=s.lang||'en'; if(!langs.includes(l))langs.push(l); });
      if(langs.length>1&&curStream){   // curStream guard: never show stale langs on the demo clip
        const cur=window.currentLang||(curStream&&curStream.lang)||'en';
        let aBody='',aVal='';
        langs.forEach(l=>{ const on=l===cur, lbl=langName(l);
          if(on)aVal=lbl;
          aBody+=optRow(on,lbl,`data-act="lang" data-lang="${l}"`,'',''); });
        h+=accSection('audio',t('menu.audio_lang'),aVal,aBody);
      }
    }
    /* playback speed */
    let spBody='<div class="vp-speeds">';
    [0.5,0.75,1,1.25,1.5,1.75,2].forEach(sp=>spBody+=`<button class="vp-speed ${v.playbackRate===sp?'on':''}" data-act="speed" data-v="${sp}">${sp}×</button>`);
    spBody+='</div>';
    h+=accSection('speed',t('menu.speed'),v.playbackRate+'×',spBody);
    /* quality — HLS levels (hls.js) when streaming HLS, else switch addon sources */
    const levels=(hls&&hls.levels)?hls.levels:[];
    if(levels.length>1){
      let qBody=optRow(hls.autoLevelEnabled,t('menu.auto'),'data-act="hlslevel" data-i="-1"',
        (hls.autoLevelEnabled&&levels[hls.currentLevel])?levelLabel(levels[hls.currentLevel]):'');
      levels.map((l,i)=>({l,i})).sort((a,b)=>(b.l.height||0)-(a.l.height||0))
        .forEach(({l,i})=>qBody+=optRow(!hls.autoLevelEnabled&&hls.currentLevel===i,levelLabel(l),`data-act="hlslevel" data-i="${i}"`));
      const qVal=hls.autoLevelEnabled?(t('menu.auto')+(levels[hls.currentLevel]?(' · '+levelLabel(levels[hls.currentLevel])):'')):levelLabel(levels[hls.currentLevel]||{});
      h+=accSection('quality',t('menu.quality'),qVal,qBody);
    } else {
      // Source picker for the CURRENT language only — the server's ranked fallback chain.
      // window.currentQualityList keeps the displayed order so the click handler resolves
      // the right stream by index.
      const lng=window.currentLang||'en';
      const qlist=(window.currentStreams||[]).filter(s=>streamLangs(s).includes(lng)).slice(0,10);
      window.currentQualityList=qlist;
      if(qlist.length>1){
        let qBody='',qVal='';
        qlist.forEach((s,i)=>{ const on=curStream&&curStream.url===s.url&&(curStream.lang||'en')===(s.lang||'en');
          const lbl=(s.quality||'SD')+' · '+s.source;
          if(on)qVal=(s.quality||'SD');
          qBody+=optRow(on,lbl,`data-act="quality" data-i="${i}"`,s.size||'',''); });
        h+=accSection('quality',t('menu.quality'),qVal,qBody);
      }
    }
    /* picture enhance — separate toggles: film-grain+colour (masks banding) and clarity (sharpen) */
    {
      const clampL=v=>Math.max(0,Math.min(100,Math.round(+v||0)));
      const gl=clampL(SETTINGS.enhanceLevel), cl=clampL(SETTINGS.clarityLevel);
      const slider=(lvl,on,act)=>`<div class="vp-enh-slider${on?'':' off'}">`
        +`<input type="range" min="0" max="100" step="5" value="${lvl}"${on?'':' disabled'} data-act="${act}" aria-label="${esc(t('menu.intensity'))}"/>`
        +`<span class="vp-enh-val">${lvl}%</span></div>`;
      let eBody=optRow(!!SETTINGS.enhance,t('menu.enhance_on'),'data-act="enhance"')+slider(gl,SETTINGS.enhance,'enhlevel')
        +optRow(!!SETTINGS.clarity,t('menu.clarity'),'data-act="clarity"')+slider(cl,SETTINGS.clarity,'claritylevel');
      const sum=[SETTINGS.enhance?gl+'%':null,SETTINGS.clarity?cl+'%':null].filter(Boolean);
      h+=accSection('enhance',t('menu.enhance'),sum.length?sum.join(' · '):t('menu.off'),eBody);
    }
    $('vpMenu').innerHTML=h;
  }
  function closeMenu(){ $('vpMenu').classList.remove('open'); $('vpGear').classList.remove('active'); }
  function toggleMenu(){ const o=$('vpMenu').classList.toggle('open'); $('vpGear').classList.toggle('active',o); $('vpGear').setAttribute('aria-expanded',String(o)); if(o)buildMenu(); }

  /* ---- transport ---- */
  function togglePlay(){ if(v.paused)v.play().catch(()=>{}); else v.pause(); }
  function syncPlay(){ const playing=!v.paused&&!v.ended;
    var _pause='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
    var _play='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    $('vpPlay').innerHTML=playing?_pause:_play;
    $('vpCenterIc').innerHTML=playing?_pause.replace(/width="18" height="18"/,'width="34" height="34"'):_play.replace(/width="18" height="18"/,'width="34" height="34"'); $('vpCenter').classList.toggle('hidden',playing&&!$('vpCenter').classList.contains('buffering')); }
  function syncVol(){ const vol=v.muted?0:v.volume; $('vpVol').value=vol;
    var _spk='<path d="M4 9v6h4l5 5V4L8 9H4z"/>';
    var _muted='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">'+_spk+'<path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    var _low='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">'+_spk+'<path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    var _high='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">'+_spk+'<path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.5 6a7 7 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    $('vpMute').innerHTML=vol===0?_muted:vol<.5?_low:_high;
    $('vpMute').setAttribute('aria-pressed',String(v.muted||vol===0)); }
  function toggleFs(){
    // iPhone Safari implements the Fullscreen API on <video> ONLY (never on a <div>), so the
    // standard ov.requestFullscreen() path silently no-ops there. Detect the standard API and
    // fall back to the non-standard video.webkitEnterFullscreen()/webkitExitFullscreen() — note
    // iOS takes over with its NATIVE fullscreen player, so our custom overlay UI is hidden while
    // fullscreen (an unavoidable iOS limitation), but the control finally works.
    if(document.fullscreenElement){ document.exitFullscreen(); return; }
    if(ov.requestFullscreen){ ov.requestFullscreen().catch(()=>{}); return; }
    if(typeof v.webkitEnterFullscreen==='function'){
      // webkitDisplayingFullscreen tells us if it's already up; webkitEnterFullscreen throws
      // (InvalidStateError) if metadata isn't loaded yet, so guard on readyState.
      try{ if(v.webkitDisplayingFullscreen) v.webkitExitFullscreen?.();
        else v.webkitEnterFullscreen(); }catch(e){}
    }
  }
  // the fullscreenchange listener (below) is the single source of truth for #vpFs .active —
  // toggling it synchronously here read a stale state and stuck 'active' on a rejected request
  function seekAt(x){
    if(!v.duration||!isFinite(v.duration))return;
    const r=$('vpProgress').getBoundingClientRect();
    let p=Math.max(0,Math.min(1,(x-r.left)/r.width));
    let target=p*v.duration;
    // Don't land on the very last frame: setting currentTime to (or within a hair of) the
    // duration fires `ended` — which stops a movie or jumps a series to the next episode.
    // A click near the right edge should play the final seconds, not skip them.
    target=Math.min(target,v.duration-0.25);
    // A source that isn't fully available yet (an HLS availability window)
    // reports a SEEKABLE range narrower than its duration. Setting currentTime past that
    // range makes the browser silently snap the playhead back to the buffered edge (or, in
    // some browsers, to 0) — which is exactly the "I scrub forward but it barely moves /
    // jumps back" the user sees. Clamp to the furthest seekable point so the playhead lands
    // as far forward as it actually can, and say why it stopped short instead of failing mute.
    try{ const sk=v.seekable;
      if(sk&&sk.length){ const end=sk.end(sk.length-1);
        if(target>end+0.5){ target=end; vpToast(t('player.seek_buffering')); } } }catch(e){}
    v.currentTime=Math.max(0,target);
  }
  function showUI(){ ov.classList.remove('hide-ui'); clearTimeout(hideTimer);
    // keep the UI up while the settings menu OR the episodes panel is open — both live inside
    // .vp-ui, so hide-ui's opacity:0/pointer-events:none would fade them out and swallow clicks.
    hideTimer=setTimeout(()=>{ if(!v.paused&&!$('vpMenu').classList.contains('open')&&!$('vpEpPanel').classList.contains('open'))ov.classList.add('hide-ui'); },2800); }

  /* ---- wiring (once) ---- */
  $('vpPlay').onclick=togglePlay; $('vpCenter').onclick=togglePlay;
  v.addEventListener('click',()=>{ if($('vpEpPanel').classList.contains('open')||$('vpMenu').classList.contains('open'))return;
    if(ov.classList.contains('hide-ui')){ showUI(); return; }   // first tap on hidden chrome reveals it, doesn't toggle
    togglePlay(); });
  $('vpBack').onclick=()=>{v.currentTime=Math.max(0,v.currentTime-10);showUI();};
  $('vpFwd').onclick=()=>{v.currentTime=Math.min(v.duration||1e9,v.currentTime+10);showUI();};
  $('vpMute').onclick=()=>{v.muted=!v.muted;syncVol();};
  $('vpVol').addEventListener('input',e=>{v.volume=+e.target.value;v.muted=(+e.target.value===0);syncVol();});
  $('vpClose').onclick=close; $('vpFs').onclick=toggleFs; $('vpCC').onclick=toggleCC;
  $('vpGear').addEventListener('click',e=>{e.stopPropagation();toggleMenu();});
  $('vpPip').onclick=async()=>{ try{
      // Standard PiP API (desktop Chrome/Safari, Android). iPhone/iPad Safari don't implement it
      // and instead expose the non-standard webkitSetPresentationMode on the <video> element.
      if(typeof v.requestPictureInPicture==='function'){
        document.pictureInPictureElement?await document.exitPictureInPicture():await v.requestPictureInPicture();
      } else if(typeof v.webkitSetPresentationMode==='function'
                && typeof v.webkitSupportsPresentationMode==='function'
                && v.webkitSupportsPresentationMode('picture-in-picture')){
        v.webkitSetPresentationMode(v.webkitPresentationMode==='picture-in-picture'?'inline':'picture-in-picture');
      } else { vpToast(t('player.pip_unavailable')); }
    }catch(e){ vpToast(t('player.pip_unavailable')); } };
  // series: episode panel + contextual skip / next-episode
  $('vpEpisodes').onclick=e=>{ e.stopPropagation(); $('vpEpPanel').classList.contains('open')?closeEpPanel():openEpPanel(); };
  $('vpEpClose').onclick=closeEpPanel;
  $('vpSkip').onclick=onSkipClick;
  $('vpEpSeasons').addEventListener('click',e=>{ const b=e.target.closest('.vp-season-tab'); if(b)selectEpPanelSeason(+b.dataset.season); });
  // keep the panel open on select — moving the highlight (see playEpisode) makes the click
  // feel responsive; the user dismisses the panel with ✕ / the ▦ button when they're done.
  $('vpEpListPlayer').addEventListener('click',e=>{ const b=e.target.closest('.ep-row'); if(b){ playEpisode(+b.dataset.season,+b.dataset.ep); } });
  $('vpMenu').addEventListener('click',e=>{ const o=e.target.closest('[data-act]'); if(!o)return;
    const a=o.dataset.act;
    if(a==='acc'){ const s=o.dataset.sec; accOpen.has(s)?accOpen.delete(s):accOpen.add(s); buildMenu(); return; }
    if(a==='sub')applySub(+o.dataset.i);
    else if(a==='audio')applyAudio(+o.dataset.i);
    else if(a==='hlsaudio'){ if(hls){ try{hls.audioTrack=+o.dataset.i;}catch(e){} } buildMenu(); }
    else if(a==='lang'){ switchLang(o.dataset.lang); }
    else if(a==='hlslevel'){ if(hls){ const i=+o.dataset.i; hls.currentLevel=i; vpToast(i<0?t('menu.auto'):levelLabel(hls.levels[i]||{})); } buildMenu(); }
    else if(a==='speed'){v.playbackRate=+o.dataset.v;buildMenu();vpToast(o.dataset.v+'×');}
    else if(a==='enhance'){ setSetting('enhance',!SETTINGS.enhance); buildMenu(); }
    else if(a==='clarity'){ setSetting('clarity',!SETTINGS.clarity); buildMenu(); }
    else if(a==='quality'){switchStream((window.currentQualityList||window.currentStreams||[])[+o.dataset.i]);closeMenu();} });
  // intensity sliders live inside the menu — live-update on drag without a full rebuild (keeps focus)
  $('vpMenu').addEventListener('input',e=>{ const o=e.target.closest('input[type=range][data-act]'); if(!o)return;
    const act=o.dataset.act, val=Math.max(0,Math.min(100,Math.round(+o.value||0)));
    if(act==='enhlevel')setSetting('enhanceLevel',val);          // → applySetting → VP.applyEnhance() (live preview)
    else if(act==='claritylevel')setSetting('clarityLevel',val);
    else return;
    const lab=o.parentNode&&o.parentNode.querySelector('.vp-enh-val'); if(lab)lab.textContent=val+'%';
    // refresh the accordion header summary live (both effects' percentages)
    const sec=o.closest('.vp-acc'),hv=sec&&sec.querySelector('.vp-acc-val');
    if(hv){ const sum=[SETTINGS.enhance?Math.round(+SETTINGS.enhanceLevel||0)+'%':null,
                       SETTINGS.clarity?Math.round(+SETTINGS.clarityLevel||0)+'%':null].filter(Boolean);
      hv.textContent=sum.length?sum.join(' · '):t('menu.off'); } });
  ov.addEventListener('click',e=>{
    // ignore clicks whose target was detached mid-dispatch — e.g. a season tab the
    // handler re-rendered before this bubbled up (its .closest() would wrongly read
    // "outside the panel" and close it).
    if(!ov.contains(e.target))return;
    if(!e.target.closest('.vp-menu-wrap'))closeMenu();
    if(!e.target.closest('.vp-eppanel')&&e.target.id!=='vpEpisodes')closeEpPanel(); });
  const prog=$('vpProgress');
  // Scrub = PREVIEW while dragging, then ONE seek on release.
  // Seeking on every mousemove fired v.currentTime 10+×/sec; dragging across an
  // un-buffered span made each seek cancel the previous fragment/range load, so HLS
  // (and range-limited progressive sources) never settled and the element snapped back
  // to its last buffered position — the "I scrub forward but it jumps back" bug. Moving
  // only the thumb/fill during the drag and committing a single atomic seek on mouseup
  // lets the source load one target cleanly.
  function scrubPreview(x){ const r=prog.getBoundingClientRect(); const p=Math.max(0,Math.min(1,(x-r.left)/r.width));
    scrubX=x; $('vpPlayed').style.width=(p*100)+'%'; $('vpThumb').style.left=(p*100)+'%';
    const tip=$('vpTooltip'); tip.style.left=(p*100)+'%'; tip.textContent=fmt((v.duration||0)*p); }
  // Scrub via Pointer Events (mouse + touch + pen on ONE code path) with pointer capture, so
  // the drag tracks outside the bar and a release anywhere commits cleanly — and so touch
  // devices (which never fire mousedown/mousemove) can finally scrub at all. closeMenu() on
  // press so an open settings menu can't sit over the bar mid-seek.
  prog.style.touchAction='none';
  prog.addEventListener('pointerdown',e=>{ if(e.pointerType==='mouse'&&e.button!==0)return; e.preventDefault(); closeMenu(); dragging=true; try{prog.setPointerCapture(e.pointerId);}catch(_){} scrubPreview(e.clientX); });
  prog.addEventListener('pointermove',e=>{
    if(dragging){ scrubPreview(e.clientX); return; }
    if(e.pointerType!=='mouse')return;                 // hover tooltip is desktop-only
    const r=prog.getBoundingClientRect(); let p=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
    const tip=$('vpTooltip'); tip.style.left=(p*100)+'%'; tip.textContent=fmt((v.duration||0)*p); });
  const endScrub=()=>{ if(!dragging)return; dragging=false; if(scrubX!=null)seekAt(scrubX); scrubX=null; };
  prog.addEventListener('pointerup',endScrub);
  prog.addEventListener('pointercancel',endScrub);
  // BUG (user-reported): an OPEN settings menu floats up over the RIGHT of the progress bar;
  // a press meant to rewind there lands on a speed pill and changes playback SPEED. Intercept
  // in the CAPTURE phase: if the menu is open and the press falls geometrically inside the bar,
  // swallow it before the pill sees it, close the menu, and start a scrub from that x — so the
  // press seeks, never changes speed.
  // preventDefault()ing the pointerdown does NOT cancel the browser's synthesised click, so the
  // pill's bubble-phase click handler (changing speed) still fired. Stamp the intercept and
  // swallow the trailing click in capture, before it reaches the menu.
  let progInterceptTs=0;
  ov.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse'&&e.button!==0)return;   // ignore right/middle-click (matches the direct scrub path)
    if(!$('vpMenu').classList.contains('open'))return;
    const r=prog.getBoundingClientRect();
    if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom){
      e.stopPropagation(); e.preventDefault(); progInterceptTs=e.timeStamp; closeMenu();
      dragging=true; try{prog.setPointerCapture(e.pointerId);}catch(_){} scrubPreview(e.clientX);
    } },true);
  ov.addEventListener('click',e=>{
    if(progInterceptTs&&e.timeStamp-progInterceptTs<700){ progInterceptTs=0; e.stopPropagation(); e.preventDefault(); }
  },true);
  ov.addEventListener('mousemove',showUI);

  /* ===== mobile gesture layer (touch only) ============================================
     Double-tap left/right third = ∓10s (ripple + toast); horizontal drag = seek with live
     preview then ONE commit (shares the scrub path → no HLS jump-back); vertical drag on the
     RIGHT half = volume, LEFT half = brightness (CSS dimmer — web can't set device brightness);
     single tap = reveal chrome (if hidden) else toggle play. Desktop is untouched: the layer
     only acts on pointerType==='touch'; the mouse scrub still owns mouse/pen. ============= */
  (function initGestures(){
    const isTouch=matchMedia('(pointer:coarse)').matches||('ontouchstart' in window);
    if(!isTouch) return;
    ov.classList.add('gestures-on');
    const g=$('vpGestures'); if(!g) return;
    const briv=$('vpBright'),hud=$('vpVHud'),hudIc=$('vpVHudIc'),hudFill=$('vpVHudFill'),pulL=$('vpPulseL'),pulR=$('vpPulseR');
    let bright=1;
    function applyBright(){ briv.style.opacity=String(Math.min(.85,1-bright)); }
    const TAP_MS=260, MOVE_PX=10, DT_SLOP=28;
    let active=null,lastTap=0,lastTapX=0,lastTapY=0,singleTimer=null;
    function chromeBusy(){ return $('vpEpPanel').classList.contains('open')||$('vpMenu').classList.contains('open'); }
    function showPulse(side){ const el=side<0?pulL:pulR; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
      clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),520); }
    function doSeek(delta){ if(!isFinite(v.duration))return;
      v.currentTime=Math.max(0,Math.min((v.duration||1e9)-0.25,v.currentTime+delta));
      showPulse(delta<0?-1:1); showUI(); vpToast((delta<0?'-':'+')+Math.abs(delta)+'s  ·  '+fmt(v.currentTime)); }
    function showHud(kind,frac){ hudIc.innerHTML=kind==='vol'?(frac===0?SVG_HUD_VOL0:frac<.5?SVG_HUD_VOLLO:SVG_HUD_VOLHI):SVG_HUD_BRIGHT;
      hudFill.style.width=Math.round(frac*100)+'%'; hud.classList.add('show'); clearTimeout(hud._t); hud._t=setTimeout(()=>hud.classList.remove('show'),700); }
    g.addEventListener('pointerdown',e=>{
      if(e.pointerType!=='touch'){                // mouse/pen on a touch-capable (hybrid) device: this surface shadows
        if(chromeBusy())return;                   // the <video>, so its click handler can't fire — reproduce it here
        if(ov.classList.contains('hide-ui')){ showUI(); return; }
        togglePlay(); showUI(); return;
      }
      if(chromeBusy())return;                      // menu/episode panel open → let taps close them
      const r=ov.getBoundingClientRect();
      active={ id:e.pointerId, x0:e.clientX, y0:e.clientY, x:e.clientX, y:e.clientY, mode:null,
               leftHalf:(e.clientX-r.left)<r.width/2, startVol:(v.muted?0:v.volume), startBright:bright, wasDouble:false };
      const now=performance.now();
      if(now-lastTap<TAP_MS && Math.abs(e.clientX-lastTapX)<DT_SLOP && Math.abs(e.clientY-lastTapY)<DT_SLOP){ active.wasDouble=true; clearTimeout(singleTimer); singleTimer=null; }
      try{ g.setPointerCapture(e.pointerId); }catch(_){}
    },{passive:false});
    g.addEventListener('pointermove',e=>{
      if(!active||e.pointerId!==active.id)return;
      const dx=e.clientX-active.x0, dy=e.clientY-active.y0; active.x=e.clientX; active.y=e.clientY;
      if(!active.mode && (Math.abs(dx)>MOVE_PX||Math.abs(dy)>MOVE_PX)){   // a moving 2nd-tap still latches a drag mode
        if(Math.abs(dx)>Math.abs(dy)){ active.mode='seek'; dragging=true; scrubPreview(e.clientX); }   // horizontal → scrub
        else active.mode=active.leftHalf?'bright':'vol';                                                // vertical → brightness/volume
      }
      if(!active.mode)return;
      e.preventDefault();
      if(active.mode==='seek'){ scrubPreview(e.clientX); }
      else if(active.mode==='vol'){ const dh=ov.getBoundingClientRect().height||1;
        const nv=Math.max(0,Math.min(1,active.startVol+(-dy/(dh*0.6)))); v.volume=nv; v.muted=(nv===0); syncVol(); showHud('vol',nv); }
      else if(active.mode==='bright'){ const dh=ov.getBoundingClientRect().height||1;
        bright=Math.max(.2,Math.min(1,active.startBright+(-dy/(dh*0.6)))); applyBright(); showHud('bright',(bright-.2)/.8); }
    },{passive:false});
    function endGesture(e){
      if(!active||e.pointerId!==active.id)return;
      const a=active; active=null;
      try{ g.releasePointerCapture(e.pointerId); }catch(_){}
      if(a.mode==='seek'){ dragging=false; if(scrubX!=null)seekAt(scrubX); scrubX=null; return; }   // ONE atomic commit
      if(a.mode==='vol'||a.mode==='bright')return;   // already applied live
      if(a.wasDouble && Math.abs(a.x-a.x0)<MOVE_PX && Math.abs(a.y-a.y0)<MOVE_PX){   // a genuine 2nd TAP (not a drag)
        const r=ov.getBoundingClientRect(), rel=(a.x-r.left)/r.width;
        if(rel<0.40)doSeek(-10); else if(rel>0.60)doSeek(10); else togglePlay();
        lastTap=0; return; }
      // potential single tap → wait TAP_MS for a second tap (double-tap) before acting
      lastTap=performance.now(); lastTapX=a.x; lastTapY=a.y; clearTimeout(singleTimer);
      singleTimer=setTimeout(()=>{ singleTimer=null; if(!ov.classList.contains('open'))return; if(chromeBusy())return;
        if(ov.classList.contains('hide-ui')){ showUI(); return; }   // reveal chrome first, don't pause
        togglePlay(); showUI(); },TAP_MS);
    }
    g.addEventListener('pointerup',endGesture,{passive:false});
    g.addEventListener('pointercancel',e=>{ if(active&&active.mode==='seek'){ dragging=false; scrubX=null; } active=null; });
    g.addEventListener('dblclick',e=>e.preventDefault());   // kill synthetic double-tap zoom on the surface
    g._resetBright=()=>{ bright=1; applyBright(); };
  })();

  v.addEventListener('loadedmetadata',()=>{ $('vpDur').textContent=fmt(v.duration); syncVol(); buildMenu();
    try{ applyResume(); }catch(e){} });   // restore the saved/live position on EVERY source load (initial, fallback, switch)
  v.addEventListener('timeupdate',()=>{ $('vpCur').textContent=fmt(v.currentTime);
    try{ maybeSaveResume(); }catch(e){}   // persist the stop position (throttled) for Continue Watching
    // while the user is scrubbing, the fill/thumb track the drag preview — don't let
    // background playback yank them back to the live position mid-drag.
    if(!dragging){ const p=v.duration?v.currentTime/v.duration*100:0; $('vpPlayed').style.width=p+'%'; $('vpThumb').style.left=p+'%'; }
    updateSkip();   // surface Skip Intro / Next Episode at the right moments
    // "video plays but no sound": once a few seconds have actually played with audio
    // up, if the decoder reports zero audio bytes the source's audio codec (AC3/E-AC3/
    // DTS, common in BluRay rips) isn't supported here. Surface a one-time, actionable
    // hint — can't be decoded in-browser, so point at another source / external player.
    if(!audioHintShown && v.loop===false && v.currentTime>6 && !v.muted && v.volume>0
       && typeof v.webkitAudioDecodedByteCount==='number' && v.webkitAudioDecodedByteCount===0){
      audioHintShown=true;
      // browser decoded ZERO audio bytes → this source's audio (AC-3/E-AC-3/DTS) can't be
      // decoded in-browser. Surface the one-time hint pointing at another source.
      vpToast(t('player.no_audio_hint'));
    } });
  v.addEventListener('progress',()=>{ try{ if(v.duration&&v.buffered.length){ const e=v.buffered.end(v.buffered.length-1);
    $('vpBuffered').style.width=(e/v.duration*100)+'%'; } }catch(e){} });
  v.addEventListener('waiting',()=>{
    // while the #vpLoading overlay owns the initial-load phase, don't also raise the
    // center buffering ring (avoids two overlapping loaders on episode switch).
    if(!$('vpLoading').classList.contains('show')){ $('vpCenter').classList.add('buffering');$('vpCenter').classList.remove('hidden'); }
    setStatus('<span class="spinner"></span> '+t('status.buffering')); });
  v.addEventListener('playing',()=>{ $('vpCenter').classList.remove('buffering'); hideLoading(); setStatus(''); syncPlay(); });
  v.addEventListener('canplay',()=>{ $('vpCenter').classList.remove('buffering'); hideLoading(); });
  v.addEventListener('play',syncPlay); v.addEventListener('pause',()=>{syncPlay();showUI(); try{ saveResume(); }catch(e){}});
  v.addEventListener('ended',()=>{ $('vpCenter').classList.remove('hidden','buffering'); syncPlay();
    try{ finishResume(); }catch(e){}   // credits rolled → clear this title/episode's resume point
    // series: roll straight into the next episode when the credits finish (demo loops, so v.loop guards it)
    // gated by Settings › Auto-Play "Auto-play next episode"
    if(!v.loop&&ctx().active&&curNextEp&&SETTINGS.autoplayNext){ const nx=curNextEp; playEpisode(nx.season,nx.ep); } });
  v.addEventListener('volumechange',syncVol);
  // re-anchor the stall watchdog on every seek — a backward scrub must NOT look like a stall
  v.addEventListener('seeking',()=>{ lastProg=v.currentTime; lastProgClock=Date.now(); });
  v.addEventListener('error',()=>{ if(!v.src)return;
    showLoading(t('player.cant_play'),t('player.cant_play_sub')); setStatus('✕ '+t('status.playback_error')); });
  if('pictureInPictureEnabled' in document){
    v.addEventListener('enterpictureinpicture',()=>$('vpPip').classList.add('active'));
    v.addEventListener('leavepictureinpicture',()=>$('vpPip').classList.remove('active'));
  } else if(typeof v.webkitSetPresentationMode==='function'){
    // iOS Safari: no enter/leavepictureinpicture events — track presentation mode instead.
    v.addEventListener('webkitpresentationmodechanged',()=>$('vpPip').classList.toggle('active',v.webkitPresentationMode==='picture-in-picture'));
  }
  document.addEventListener('fullscreenchange',()=>$('vpFs').classList.toggle('active',!!document.fullscreenElement));
  // iOS native <video> fullscreen fires its own webkit events (no fullscreenchange) — mirror them
  // so the ⛶ button reflects state and exits cleanly.
  v.addEventListener('webkitbeginfullscreen',()=>$('vpFs').classList.add('active'));
  v.addEventListener('webkitendfullscreen',()=>$('vpFs').classList.remove('active'));
  // The phone CSS hides #vpPip (assumes phones only have OS-level PiP gestures). iOS Safari does
  // support per-video PiP via webkitSetPresentationMode, so re-expose the button when it's real.
  if(!('pictureInPictureEnabled' in document)
     && typeof v.webkitSupportsPresentationMode==='function'
     && v.webkitSupportsPresentationMode('picture-in-picture')){
    ov.classList.add('vp-has-webkit-pip');
  }
  addEventListener('keydown',e=>{ if(!ov.classList.contains('open'))return;
    if(['INPUT','TEXTAREA'].includes((e.target.tagName||'')))return;
    // playback-mutating LETTER shortcuts shouldn't fire while the gear menu / episode panel
    // owns focus (those aren't INPUT/TEXTAREA); Space/Escape/arrows stay live so the panel
    // can still be toggled/closed.
    const inPanel=e.target.closest&&e.target.closest('.vp-menu, .vp-eppanel');
    switch(e.key){
      case ' ': case 'k': e.preventDefault(); togglePlay(); showUI(); break;
      case 'ArrowLeft': e.preventDefault(); v.currentTime=Math.max(0,v.currentTime-10); showUI(); break;
      case 'ArrowRight': e.preventDefault(); v.currentTime=Math.min(v.duration||1e9,v.currentTime+10); showUI(); break;
      case 'ArrowUp': e.preventDefault(); v.volume=Math.min(1,v.volume+.1); v.muted=false; syncVol(); break;
      case 'ArrowDown': e.preventDefault(); v.volume=Math.max(0,v.volume-.1); syncVol(); break;
      case 'm': if(inPanel)break; v.muted=!v.muted; syncVol(); break;
      case 'f': if(inPanel)break; toggleFs(); break;
      case 'c': if(inPanel)break; toggleCC(); break;
      case 'e': if(ctx().active){ $('vpEpPanel').classList.contains('open')?closeEpPanel():openEpPanel(); } break;
      case 'n': if(ctx().active&&curNextEp){ const nx=curNextEp; playEpisode(nx.season,nx.ep); } break;
      case 'Escape': $('vpEpPanel').classList.contains('open')?closeEpPanel():($('vpMenu').classList.contains('open')?closeMenu():close()); break;
    } });

  return { resolveAddonStream, openDemo, close, setStatus, loading:showLoading, refreshSeriesUI,
           current:()=>curStream, applyEnhance };
})();
/* globals used by stream rows / demo onclick / Esc */
/* The single, add-on-agnostic entry point: hand it one stream object (a `streamLink`
   plus its manifest `behaviors`) and the renderer resolves it. There is no separate
   "play" command — this just acts on a data object the add-ons returned. */
function resolveAddonStream(addonStream){ return VP.resolveAddonStream(addonStream); }
function openPlayer(){ return VP.openDemo(); }
function closePlayer(){ return VP.close(); }
function toggleExtMenu(btn){
  const menu=btn.parentElement.querySelector('.ext-menu');
  document.querySelectorAll('.ext-menu.open').forEach(m=>{if(m!==menu)m.classList.remove('open')});
  menu.classList.toggle('open');
}
function toast(msg,color){
  const el=document.createElement('div');
  el.setAttribute('role','status'); el.setAttribute('aria-live','polite');
  el.style.cssText=`position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#16131f;border:1px solid ${color};border-radius:4px;padding:10px 20px;font-family:var(--font-mono);font-size:16px;color:${color};z-index:9999`;
  el.textContent=msg;document.body.appendChild(el);setTimeout(()=>el.remove(),2400);
}

/* ================= client-side add-on transport =================
   Architecture: the BROWSER talks to each installed add-on directly.
   STREDIO's server is never in the path — it neither lists, fetches, proxies,
   ranks, nor filters streams/subtitles/catalogs. It only stores the user's
   installed-collection (the add-on URLs) so the collection syncs across the
   account's devices. Every resource request below goes browser → add-on, and
   the stream then plays straight in the browser — through the user's OWN debrid
   account if they installed a debrid-configured add-on URL (the key lives only
   in that URL, which STREDIO stores but never uses). Any community add-on the
   user installs works the same way. Add-ons send `Access-Control-Allow-Origin:*`
   (they're built for browser clients), so these cross-origin fetches succeed;
   the page CSP already allows connect-src https: + media-src blob: https:. */
window.INSTALLED_ADDONS = window.INSTALLED_ADDONS || [];
/* Resource URLs are relative to the directory holding manifest.json. */
function addonBaseUrl(manifestUrl){ return String(manifestUrl||'').replace(/[^/]*$/,''); }
function addonHasResource(a,resource,type){
  const m=(a&&a.manifest)||{};
  const res=(m.resources||[]).map(r=>typeof r==='string'?r:(r&&r.name)).filter(Boolean);
  return res.includes(resource) && (!type || (m.types||[]).includes(type));
}
/* Browser → add-on, JSON resource fetch. Absolute https URL → the fetch shim
   leaves it untouched and sends NO credentials, so wildcard CORS is honoured. */
async function fetchAddonJSON(base,path){
  const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(),20000);
  try{
    const r=await fetch(base+path,{headers:{accept:'application/json'},signal:ctrl.signal});
    if(!r.ok) throw new Error('addon '+r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}
function detectQualityC(t){ t=(t||'').toLowerCase();
  if(/(2160|\b4k\b|uhd)/.test(t))return'4K'; if(/1080/.test(t))return'1080p';
  if(/720/.test(t))return'720p'; if(/480/.test(t))return'480p'; return''; }
function extractSizeC(t){ const m=(t||'').match(/(\d+(?:\.\d+)?)\s?(gb|mb)/i); return m?m[1]+' '+m[2].toUpperCase():null; }
/* Audio languages a stream offers. Add-ons signal them two ways:
    an explicit behaviorHints.lang (some add-ons tag one language per stream row);
   audio tracks. We map the flags STREDIO has tabs for (en/ru/uk/ka) and ignore the
   rest. This is what lets the language tabs mirror the SOURCE. */
/* Country (ISO-3166) → language (ISO-639) for the flag emoji an add-on may embed
   in a stream label. This is ONLY a hint map for the most common dub flags; it is
   NOT an allow-list. Any flag whose country is missing falls back to the country
   code itself, and any add-on-declared behaviorHints.lang is taken verbatim — so
   the language buckets always mirror whatever the installed add-ons return rather
   than a fixed, hard-coded set. */
const FLAG_COUNTRY_LANG={GB:'en',US:'en',AU:'en',CA:'en',IE:'en',NZ:'en',
  RU:'ru',UA:'uk',GE:'ka',FR:'fr',DE:'de',IT:'it',ES:'es',MX:'es',PT:'pt',BR:'pt',
  JP:'ja',KR:'ko',CN:'zh',TW:'zh',IN:'hi',TR:'tr',PL:'pl',NL:'nl',SE:'sv',NO:'no',
  DK:'da',FI:'fi',CZ:'cs',GR:'el',IL:'he',SA:'ar',AE:'ar',IR:'fa',TH:'th',VN:'vi',
  ID:'id',RO:'ro',HU:'hu',BG:'bg',RS:'sr',HR:'hr',SK:'sk'};
/* Pull every language signal out of an add-on's free-text stream label: each pair
   of regional-indicator characters → a country code → a language. Unknown countries
   keep their lowercased code so nothing is silently dropped or remapped. */
function parseStreamLangs(text){
  const out=[]; const re=/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu; let m;
  while((m=re.exec(text||''))){
    const cc=String.fromCharCode(m[1].codePointAt(0)-0x1F1E6+65)+String.fromCharCode(m[2].codePointAt(0)-0x1F1E6+65);
    const l=FLAG_COUNTRY_LANG[cc]||cc.toLowerCase();
    if(l&&out.indexOf(l)<0) out.push(l);
  }
  return out;
}
/* The languages to bucket a mapped stream under — defaults to English when a source
   gives no language signal, so language-agnostic add-ons keep working unchanged. */
function streamLangs(s){
  if(s&&Array.isArray(s.langs)&&s.langs.length) return s.langs;
  if(s&&s.lang) return [s.lang];
  return ['en'];
}
/* Normalise ONE raw stream object from an add-on into the shape the UI lists.
   The add-on's own description/title is preserved VERBATIM in `label` — we never
   substitute the movie/series name for it. `streamLink` is the add-on-supplied URL,
   used as-is (never fetched or rewritten here). `behaviors` carries the add-on's
   manifest.behaviorHints through untouched so the player can read streamType etc. */
function mapAddonStream(s,addonName){
  // the add-on's own caption, kept exactly as delivered (multi-line collapsed to
  // single spaces only for display) — this is the title we render, unmodified.
  const label=[s.name,s.title,s.description].filter(Boolean).join('\n');
  const streamLink=s.url||null; const behaviors=s.behaviorHints||{};
  const isHls=!!streamLink&&(behaviors.streamType==='hls'||/\.(m3u8|txt)(\?|$)/i.test(streamLink)||/\/hls\//i.test(streamLink));
  const flagLangs=parseStreamLangs(label);
  // honour an explicit per-stream language hint verbatim; otherwise fall back to the
  // flags parsed from the label. No language is filtered out or forced to a fixed set.
  const langs=behaviors.lang?[behaviors.lang]:flagLangs;
  return {
    source:addonName,
    label:label||'Source',                              // add-on's verbatim caption (what we display)
    title:label||'Source',                              // kept for back-compat callers
    quality:detectQualityC(label), size:extractSizeC(label),
    kind:isHls?'hls':'url', lang:behaviors.lang||flagLangs[0]||null, langs,
    audioLang:behaviors.audioLang||null,
    url:streamLink, link:streamLink, behaviors,
    subtitles:Array.isArray(s.subtitles)?s.subtitles.map(x=>({url:x.url,lang:x.lang})).filter(x=>x.url):undefined,
  };
}
/* Ask every installed stream add-on for ITS array of stream objects for one video
   id, in parallel, entirely in the browser (server is never involved). This is the
   core request: "all installed add-ons, hand me your stream objects for this id."
   The returned list is just data — a flat array of add-on-supplied sources plus the
   union of whatever languages they happened to declare. Returns {streams, addons, langs}. */
async function collectAddonStreams(videoId,type){
  const addons=(window.INSTALLED_ADDONS||[]).filter(a=>addonHasResource(a,'stream',type));
  if(!addons.length) return {streams:[],addons:0,langs:[]};
  const path='stream/'+type+'/'+encodeURIComponent(videoId)+'.json';
  const per=await Promise.all(addons.map(async a=>{
    try{
      const data=await fetchAddonJSON(addonBaseUrl(a.url),path);
      return (data.streams||[]).map(s=>mapAddonStream(s,(a.manifest&&a.manifest.name)||'Add-on')).filter(s=>s.url);
    }catch(e){ return []; }   // one slow/broken add-on must not sink the rest
  }));
  const streams=per.flat();
  // union of every language present across the returned streams — NOT clamped to a
  // fixed list, so the language picker mirrors exactly what the add-ons provide.
  const langs=[...new Set(streams.flatMap(streamLangs))];
  return {streams,addons:addons.length,langs};
}
/* normalise a catalog meta into the poster-card shape (ids are IMDb tt…) */
function mapStremioMetaC(m){
  const genres=m.genres||m.genre||[];
  return { id:m.id, title:m.name||'Untitled',
    year:String(m.releaseInfo||m.year||'').slice(0,4)||'—',
    rating:m.imdbRating?+parseFloat(m.imdbRating).toFixed(1):0,
    genre:(Array.isArray(genres)?genres[0]:genres)||'—', poster:m.poster||null };
}
/* ---- subtitles, fully client-side: fetch from the add-on/source, gunzip if
   needed, convert SRT→VTT, hand the player a same-document blob: URL. No server
   hop. (A subtitle host without permissive CORS can't be read from the browser; such tracks are simply skipped.) */
const SUB_LANG_NAMES={en:'English',eng:'English',es:'Spanish',spa:'Spanish',fr:'French',fre:'French',fra:'French',de:'German',ger:'German',deu:'German',it:'Italian',ita:'Italian',pt:'Portuguese',por:'Portuguese','pt-br':'Portuguese (BR)',pob:'Portuguese (BR)',ru:'Russian',rus:'Russian',ar:'Arabic',ara:'Arabic',hi:'Hindi',hin:'Hindi',ja:'Japanese',jpn:'Japanese',ko:'Korean',kor:'Korean',zh:'Chinese',chi:'Chinese',zho:'Chinese',nl:'Dutch',dut:'Dutch',nld:'Dutch',pl:'Polish',pol:'Polish',tr:'Turkish',tur:'Turkish',sv:'Swedish',swe:'Swedish',uk:'Ukrainian',ukr:'Ukrainian',ka:'Georgian',kat:'Georgian',geo:'Georgian',fa:'Persian',per:'Persian',fas:'Persian',he:'Hebrew',heb:'Hebrew',ro:'Romanian',rum:'Romanian',ron:'Romanian',el:'Greek',gre:'Greek'};
function subLangName(code){ if(!code)return null; const c=String(code).toLowerCase();
  return SUB_LANG_NAMES[c]||SUB_LANG_NAMES[c.split(/[-_]/)[0]]||null; }
function srtToVttC(srt){
  const body=String(srt).replace(/\r+/g,'').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2');
  return /^\s*WEBVTT/.test(body)?body:'WEBVTT\n\n'+body;
}
async function subtitleBlobUrl(srcUrl){
  const r=await fetch(srcUrl); if(!r.ok) throw new Error('sub '+r.status);
  let buf=new Uint8Array(await r.arrayBuffer());
  const gz=/\.gz($|\?)/i.test(srcUrl)||(buf[0]===0x1f&&buf[1]===0x8b);
  if(gz && 'DecompressionStream' in window){
    try{
      const stream=new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      buf=new Uint8Array(await new Response(stream).arrayBuffer());
    }catch(e){}
  }
  const vtt=srtToVttC(new TextDecoder('utf-8').decode(buf));
  return URL.createObjectURL(new Blob([vtt],{type:'text/vtt'}));
}

/* ---------- real streams from installed addons (browser → add-on direct) ---------- */
function setStreams(html){document.getElementById('streamList').innerHTML=html;}

/* ---------- season + episode chooser (TV / anime) ---------- */
/* Shared series state — drives both the modal chooser AND the in-player episode
   panel / next-episode button. epCache holds fetched episode lists per season so
   "next episode" and the in-player list don't re-fetch. */
window.seriesCtx={active:false,imdb:null,tvId:null,seasons:[],season:null,ep:null,epName:'',epCache:{}};
function clearSeriesCtx(){
  seriesCtx.active=false; seriesCtx.imdb=null; seriesCtx.tvId=null; seriesCtx.seasons=[];
  seriesCtx.season=null; seriesCtx.ep=null; seriesCtx.epName=''; seriesCtx.epCache={};
}
function resetEpChooser(){
  const c=document.getElementById('epChooser'); if(!c)return;
  c.hidden=true;
  document.getElementById('seasonTabs').innerHTML='';
  document.getElementById('epList').innerHTML='';
  c._tvId=null; c._imdb=null; c._seasons=null; c._activeSeason=null; c._activeEp=null;
}
/* fetch + cache a season's episode list (used by the in-player panel + next-episode calc) */
async function fetchSeasonEpisodes(season){
  if(seriesCtx.epCache[season])return seriesCtx.epCache[season];
  try{
    const data=await fetch('/api/tv/'+encodeURIComponent(seriesCtx.tvId)+'/season/'+season+'?lang='+I18N.lang()).then(r=>r.ok?r.json():null);
    seriesCtx.epCache[season]=(data&&data.episodes)||[];
  }catch(e){ seriesCtx.epCache[season]=[]; }
  return seriesCtx.epCache[season];
}
/* compute the episode that follows the one currently playing (within the season,
   then rolling over to the next season). Returns {season,ep,name} or null. */
function nextEpisodeInfo(){
  if(!seriesCtx.active||seriesCtx.season==null||seriesCtx.ep==null)return null;
  const s=seriesCtx.season,e=seriesCtx.ep;
  const eps=seriesCtx.epCache[s];
  if(eps&&eps.length){
    const i=eps.findIndex(x=>x.episode===e);
    if(i>=0&&i+1<eps.length)return {season:s,ep:eps[i+1].episode,name:eps[i+1].name||''};
  }else{
    const meta=(seriesCtx.seasons||[]).find(x=>x.season===s);
    if(meta&&meta.episodes&&e<meta.episodes)return {season:s,ep:e+1,name:''};
  }
  const list=(seriesCtx.seasons||[]).map(x=>x.season).sort((a,b)=>a-b);
  const si=list.indexOf(s);
  if(si>=0&&si+1<list.length)return {season:list[si+1],ep:1,name:''};
  return null;
}
/* load + auto-play a specific episode (from the in-player panel or next-episode button) */
async function playEpisode(season,ep){
  if(!seriesCtx.active||!seriesCtx.imdb)return;
  const eps=await fetchSeasonEpisodes(season);
  const found=eps.find(x=>x.episode===ep);
  seriesCtx.season=season; seriesCtx.ep=ep; seriesCtx.epName=found?(found.name||''):'';
  markEpWatched(seriesCtx.imdb,season,ep);   // for the blur-unwatched feature
  window.currentEpLabel='S'+season+'E'+ep; window.currentMediaType='series';
  // keep the modal chooser in sync (highlight + active state) for when the player closes
  const c=document.getElementById('epChooser'); if(c){ c._activeSeason=season; c._activeEp=ep; }
  document.querySelectorAll('#epList .ep-row').forEach(b=>b.classList.toggle('on',+b.dataset.season===season&&+b.dataset.ep===ep));
  // mirror the active state into the in-player side panel so selecting an episode there
  // moves the red highlight immediately (the panel now stays open after a pick).
  document.querySelectorAll('#vpEpListPlayer .ep-row').forEach(b=>b.classList.toggle('on',+b.dataset.season===season&&+b.dataset.ep===ep));
  // Remember what's playing now so the new episode resumes on the SAME source + language
  // instead of re-prompting or jumping languages.
  const prev=(VP.current&&VP.current())||null;
  const lang=(prev&&prev.lang)||window.currentLang||'en';
  const prevSource=prev?prev.source:null;
  // No stream source installed → there are no real streams to resolve; play the bundled
  // sample for the chosen episode straight away (openDemo refreshes the S·E title) rather
  // than spinning "Preparing…" into a "failed" status.
  if(!streamSourceInstalled()){ VP.openDemo(); return; }
  try{ document.getElementById('playerVideo').pause(); }catch(_){}
  VP.loading(I18N.t('player.preparing'),''); VP.setStatus('<span class="spinner"></span> '+I18N.t('status.buffering'));
  await loadRealStreams(seriesCtx.imdb+':'+season+':'+ep,'series');
  const all=window.currentStreams||[];
  // prefer the same source AND language, then same language, then anything available
  const pick=all.find(x=>streamLangs(x).includes(lang)&&x.source===prevSource)
           ||all.find(x=>streamLangs(x).includes(lang))||all[0];
  if(pick)resolveAddonStream(pick);
  else VP.openDemo();   // graceful fallback — keep playing instead of a dead "failed" screen
}
function setupSeriesChooser(tvId,meta,token){
  const c=document.getElementById('epChooser'); if(!c||!modalAlive(token))return;
  if(!meta.imdb){
    // No IMDb id → installed series addons can't be queried for this title.
    demoOrCatalogOnly(`<div class="demo-note">${esc(I18N.t('modal.no_imdb'))}</div>`);
    return;
  }
  let seasons=(meta.seasonList&&meta.seasonList.length)?meta.seasonList
    :(meta.seasons?Array.from({length:meta.seasons},(_,i)=>({season:i+1,episodes:0,name:I18N.t('modal.season',{n:i+1})})):[]);
  c._tvId=tvId; c._imdb=meta.imdb; c._seasons=seasons;
  seriesCtx.active=true; seriesCtx.imdb=meta.imdb; seriesCtx.tvId=tvId; seriesCtx.seasons=seasons; seriesCtx.epCache={};
  if(!seasons.length){ loadRealStreams(meta.imdb,'series'); return; }   // no season data → treat like a single id
  document.getElementById('seasonTabs').innerHTML=seasons.map(s=>{
    const label=s.name||I18N.t('modal.season',{n:s.season});
    return `<button class="season-tab" type="button" data-season="${s.season}">${esc(label)}</button>`;
  }).join('');
  c.hidden=false;
  // If this title has a saved resume episode, open ITS season so RESUME / the highlighted
  // episode lands where the user left off. Otherwise default to the first real season —
  // skipping a season-0 "Specials" block (often dozens of webisodes) — so the grid opens
  // on Episode 1.
  const want=window.__resumeEp;
  const wantSeason=want&&seasons.find(s=>+s.season===+want.season);
  const firstSeason=wantSeason||seasons.find(s=>+s.season>=1)||seasons[0];
  selectSeason(firstSeason.season,token);
}
async function selectSeason(n,token){
  const c=document.getElementById('epChooser'); if(!c)return;
  const tok=token!=null?token:modalToken;
  if(!modalAlive(tok))return;
  c._activeSeason=n;
  document.querySelectorAll('#seasonTabs .season-tab').forEach(b=>b.classList.toggle('on',+b.dataset.season===n));
  const list=document.getElementById('epList');
  // skeleton cards while the season loads (grid-friendly)
  list.innerHTML=Array.from({length:8}).map(()=>'<div class="ep-skel"></div>').join('');
  try{
    const data=await fetch('/api/tv/'+encodeURIComponent(c._tvId)+'/season/'+n+'?lang='+I18N.lang()).then(r=>r.ok?r.json():null);
    if(!modalAlive(tok))return;
    if(!data||!data.episodes||!data.episodes.length){ list.innerHTML=`<div class="ep-empty">${esc(I18N.t('modal.episodes_unavailable'))}</div>`; return; }
    seriesCtx.epCache[n]=data.episodes;   // cache for the in-player panel + next-episode calc
    // 16:9 still-card grid. Class stays .ep-row so selectEpisode() + the delegated #epList
    // click listener + the .on highlight all keep working unchanged — only the markup grows a still.
    list.innerHTML=data.episodes.map(e=>{
      const nm=esc(e.name||I18N.t('modal.episode_n',{n:e.episode}));
      const watched=isEpWatched(c._imdb,n,e.episode);
      const still=e.still
        ? `<span class="ep-still"><img src="${esc(e.still)}" loading="lazy" decoding="async" alt="" onerror="this.parentNode.classList.add('no-still');this.parentNode.setAttribute('data-n','E'+${e.episode});this.remove()"/></span>`
        : `<span class="ep-still no-still" data-n="E${e.episode}"></span>`;
      return `<button class="ep-row ${watched?'watched':''}" type="button" data-season="${n}" data-ep="${e.episode}">
        ${still}
        <span class="ep-num">E${e.episode}</span>
        <span class="ep-body"><span class="ep-name">${nm}</span></span>
      </button>`;
    }).join('');
  }catch(e){ if(modalAlive(tok))list.innerHTML=`<div class="ep-empty">${esc(I18N.t('modal.episodes_unavailable'))}</div>`; }
}
function selectEpisode(season,ep){
  const c=document.getElementById('epChooser'); if(!c||!c._imdb)return;
  c._activeEp=ep;
  window.__resumeEp=null;   // a manual pick supersedes the top RESUME button's saved episode

  document.querySelectorAll('#epList .ep-row').forEach(b=>b.classList.toggle('on',+b.dataset.season===season&&+b.dataset.ep===ep));
  // mark watched + clear its blur immediately (for the blur-unwatched feature)
  markEpWatched(c._imdb,season,ep);
  const cur=document.querySelector(`#epList .ep-row[data-season="${season}"][data-ep="${ep}"]`); if(cur)cur.classList.add('watched');
  window.currentEpLabel=`S${season}E${ep}`;
  // record which episode is active so the in-player panel + next-episode button know where we are
  const eps=seriesCtx.epCache[season]||[]; const found=eps.find(x=>x.episode===ep);
  seriesCtx.season=season; seriesCtx.ep=ep; seriesCtx.epName=found?(found.name||''):'';
  loadRealStreams(c._imdb+':'+season+':'+ep,'series');   // Stredio series id: tt…:season:episode
  // picking an episode should bring the freshly-loaded sources into view
  const sec=document.querySelector('.m-streams');
  if(sec)sec.scrollIntoView({behavior:'smooth',block:'start'});
}
document.getElementById('seasonTabs').addEventListener('click',e=>{
  const b=e.target.closest('.season-tab'); if(b)selectSeason(+b.dataset.season);
});
document.getElementById('epList').addEventListener('click',e=>{
  const b=e.target.closest('.ep-row'); if(b)selectEpisode(+b.dataset.season,+b.dataset.ep);
});
function qualClass(q){return q==='4K'?'q-4k':q==='1080p'?'q-1080':'q-720';}
/* Render the data returned by the installed add-ons as a list of selectable items.
   This is NOT a "play" control: each item is one stream object an add-on handed us,
   drawn as its own select box. The label shown is the add-on's OWN caption, verbatim
   — we never overwrite it with the movie/series title. Choosing an item just resolves
   the add-on-supplied link; nothing here is a hard-coded "Watch"/"Stream" command. */
function renderStreamList(streams){
  const src=(streams[0]&&streams[0].source)||'';
  const items=streams.map(s=>{
    const q=s.quality||'SD';
    // the add-on's verbatim caption is the primary line; codec/size details follow it.
    const caption=s.label||s.title||s.source||'';
    const detail=[s.size, s.source].filter(Boolean).join(' · ');
    return `<button class="addon-stream" data-act="addonStream" data-kind="${esc(s.kind||'url')}" data-url="${esc(s.url)}" aria-label="${esc(caption)}">
      <span class="quality-badge ${qualClass(q)}">${esc(q)}</span>
      <span class="stream-info">
        <span class="stream-title">${esc(caption)}</span>
        <span class="stream-detail">${esc(detail)}</span>
      </span>
      <span class="addon-stream-chevron" aria-hidden="true">›</span>
    </button>`;
  }).join('');
  return `<div class="stream-source-label">⬡ ${esc(t('stream.from'))}${esc(src)}</div>${items}`;
}
/* Friendly names for the language codes we can name; NOT an allow-list — any code we
   don't recognise simply shows its uppercased self, so unknown add-on languages still
   appear in the picker rather than being dropped. */
const LANG_DISPLAY={ka:'Georgian',en:'English',ru:'Russian',uk:'Ukrainian',fr:'French',
  de:'German',it:'Italian',es:'Spanish',pt:'Portuguese',ja:'Japanese',ko:'Korean',
  zh:'Chinese',hi:'Hindi',tr:'Turkish',pl:'Polish',nl:'Dutch',sv:'Swedish',no:'Norwegian',
  da:'Danish',fi:'Finnish',cs:'Czech',el:'Greek',he:'Hebrew',ar:'Arabic',fa:'Persian',
  th:'Thai',vi:'Vietnamese',id:'Indonesian',ro:'Romanian',hu:'Hungarian',bg:'Bulgarian',
  sr:'Serbian',hr:'Croatian',sk:'Slovak'};
/* The label to show for one language code in the picker — localized via i18n when we
   have a translation, otherwise the friendly English name, otherwise the raw code. */
function langTabLabel(l){
  const k='langtab.'+l, v=I18N.t(k);
  if(v&&v!==k) return v;
  return LANG_DISPLAY[l]||(l||'').toUpperCase();
}
/* One <li> option for a language code. The flag art only exists for a few locales;
   any other code just gets the (blank) base flag chip — it is still listed. */
function langOptHTML(l){
  return '<li class="lang-opt" role="option" data-lang="'+esc(l)+'"><i class="flag flag-'+esc(l)+'"></i>'+esc(langTabLabel(l))+'</li>';
}
/* Show the language picker, exposing EVERY language present in the returned streams.
   The option list is rebuilt from the data each time — never a fixed set of languages. */
function closeLangMenu(el){
  el.classList.remove('open');
  const tr=el.querySelector('.lang-select-trigger'); if(tr)tr.setAttribute('aria-expanded','false');
}
/* The stream-language tabs name each audio track in the CURRENT UI language
   (English UI → "Georgian"/"Russian"; ქართული UI → "ინგლისური"/"რუსული"),
   not in each track's own native script. We can't drive this with [data-i18n]
   because each label sits beside a <i class="flag"> icon that textContent would
   wipe — so re-render the flag + localized name together. */
function localizeLangTabs(){
  const el=document.getElementById('langTabs'); if(!el)return;
  el.querySelectorAll('.lang-cur,.lang-opt').forEach(o=>{
    const l=o.dataset.lang; if(!l)return;
    o.innerHTML='<i class="flag flag-'+l+'"></i>'+esc(langTabLabel(l));
  });
}
I18N.onChange(localizeLangTabs);
function showLangTabs(on,langs){
  const el=document.getElementById('langTabs'); if(!el)return;
  el.hidden=!on;
  if(on){
    // Rebuild the option list from exactly the languages the add-ons returned — no
    // fixed/limited set. The picker only appears at all when there's a choice to make.
    const set=(Array.isArray(langs)&&langs.length)?langs:[];
    const menu=el.querySelector('.lang-menu');
    if(menu) menu.innerHTML=set.map(langOptHTML).join('');
    // seed the trigger's current label with the first language
    const cur=el.querySelector('.lang-cur');
    if(cur&&set.length){ cur.dataset.lang=set[0]; cur.innerHTML='<i class="flag flag-'+set[0]+'"></i>'+esc(langTabLabel(set[0])); }
  }
  closeLangMenu(el);
}
/* render only the streams for the currently-selected language tab, or a
   "not dubbed yet" notice when that language has no source. */
function renderStreamsForLang(lang){
  window.currentLang=lang;
  const sel=document.getElementById('langTabs');
  if(sel){
    sel.querySelectorAll('.lang-opt').forEach(o=>o.setAttribute('aria-selected',o.dataset.lang===lang?'true':'false'));
    const cur=sel.querySelector('.lang-cur'), opt=sel.querySelector('.lang-opt[data-lang="'+lang+'"]');
    if(cur&&opt){ cur.innerHTML=opt.innerHTML; cur.dataset.lang=lang; }
    closeLangMenu(sel);
  }
  const list=(window.currentStreams||[]).filter(s=>streamLangs(s).includes(lang));
  if(list.length){ setStreams(renderStreamList(list)); }
  else{ setStreams(`<div class="lang-empty">${esc(I18N.t('modal.not_dubbed',{lang:langTabLabel(lang)}))}</div>`); }
}
/* No community streaming add-on installed → the platform is a pure media catalog &
   discovery interface. Surface NO third-party streams (not even demo rows); invite
   the user to install a community streaming add-on at their own discretion. */
function renderCatalogOnly(){
  showLangTabs(false);   // never leave stale language tabs from a prior streamed title
  setStreams(`<div class="streams-locked">
    <div class="sl-title">${esc(I18N.t('streams.catalog_only_title'))}</div>
    <div class="sl-sub">${esc(I18N.t('streams.catalog_only_sub'))}</div>
    <button class="sl-btn" type="button" data-act="open-addons">${esc(I18N.t('streams.browse_addons'))}</button>
  </div>`);
}
/* Demo/sample rows are only meaningful once a stream source exists; with none
   installed, fall back to the catalog-only notice. */
function demoOrCatalogOnly(prefixHtml){
  if(!streamSourceInstalled()){ renderCatalogOnly(); return; }
  setStreams((prefixHtml||'')+buildStreams(currentTitle,currentYear));
}
async function loadRealStreams(videoId,mediaType){
  const t=modalToken;                       // ignore responses for a modal the user has since left
  const type=mediaType||window.currentMediaType||'movie';
  window.currentImdb=videoId; window.currentStreams=[]; window.currentMediaType=type;
  showLangTabs(false);
  // Pure-catalog gate: with no community stream source installed, never query or
  // surface third-party streams — the site operates solely as a catalog & UI.
  if(!streamSourceInstalled()){ renderCatalogOnly(); return; }
  setStreams(`<div class="stream-source-label"><span class="spinner"></span> ${esc(I18N.t('modal.searching_addons'))}</div>`);
  try{
    // Browser → each installed add-on directly. STREDIO's server never sees this.
    const data=await collectAddonStreams(videoId,type);
    // Relevance guard. A stale token (user opened a different title) is always discarded.
    // But switching episodes from the in-player panel runs AFTER the detail modal has closed
    // (the player's open() clears the modal), so also accept the response while the player is
    // showing this title — otherwise currentStreams stays empty and the new episode wrongly
    // falls back to the demo clip instead of playing from the same source.
    if(t!==modalToken)return;
    if(!overlay.classList.contains('open')&&!document.getElementById('playerOverlay').classList.contains('open'))return;
    if(data.addons===0){
      demoOrCatalogOnly(`<div class="demo-note">${I18N.t('modal.no_stream_addons_html')}</div>`);
      return;
    }
    window.currentStreams=data.streams||[];
    // Exactly the languages the installed add-ons declared — not clamped to any set.
    const langs=(Array.isArray(data.langs)&&data.langs.length)?data.langs:[];
    window.currentLangs=langs;
    // Only surface the picker when there's more than one language to choose between.
    showLangTabs(langs.length>1,langs);
    // default to the user's last-picked language if it's present, else the first available
    let def=window.currentLang;
    if(!langs.includes(def)) def=langs[0]||def;
    renderStreamsForLang(def);
  }catch(e){ if(modalAlive(t)) demoOrCatalogOnly(''); }
}
/* language dropdown: shows the languages present in the returned streams —
   only the enabled languages show; selecting one renders that language's streams. */
(function(){
  const sel=document.getElementById('langTabs');
  sel.addEventListener('click',e=>{
    const opt=e.target.closest('.lang-opt');
    if(opt){ renderStreamsForLang(opt.dataset.lang); return; }
    if(e.target.closest('.lang-select-trigger')){
      const open=sel.classList.toggle('open');
      sel.querySelector('.lang-select-trigger').setAttribute('aria-expanded',open?'true':'false');
    }
  });
  document.addEventListener('click',e=>{ if(!sel.contains(e.target)) closeLangMenu(sel); });
})();
/* actions for real stream rows (delegated so it survives re-render) */
document.getElementById('streamList').addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');if(!b)return;
  if(b.dataset.act==='addonStream'){
    // The user selected one add-on-supplied stream object from the list. Resolve it to
    // the full object (it carries subtitles + audioLang + correct kind). Some HLS rows
    // for different languages SHARE one master URL, so disambiguate by the active
    // language tab — otherwise selecting "English" could grab the Georgian row.
    const all=window.currentStreams||[], lang=window.currentLang;
    const addonStream=all.find(x=>x.url===b.dataset.url&&streamLangs(x).includes(lang))||all.find(x=>x.url===b.dataset.url);
    resolveAddonStream(addonStream?{...addonStream,title:`${currentTitle} (${currentYear})`}:{kind:b.dataset.kind,url:b.dataset.url||'',title:`${currentTitle} (${currentYear})`});
  }else if(b.dataset.act==='open-addons'){
    // Catalog-only notice → send the user to the Add-on catalog to install a stream source.
    try{ closeInfoModal(); }catch(_){}
    navigate('addons');
  }
});

/* ---------- direct-to-sources sheet (add-on catalog cards) ----------
   Items from an installed add-on's catalog (sports/channels/etc.) usually carry
   custom ids that don't resolve to a TMDB detail page, so we skip the detail
   modal entirely: open a lightweight sheet, query the add-on directly for that
   type, and hand the chosen source to the same player movies/series use. */
(function(){
  const ov=document.getElementById('sourcesOverlay'); if(!ov)return;
  const listEl=document.getElementById('sourcesList');
  let lastFocus=null;
  function setBody(html){ listEl.innerHTML=html; }
  function closeSheet(){
    ov.classList.remove('open'); ov.setAttribute('aria-hidden','true');
    setBody('');                                   // drop stale rows so a fast re-open never flashes them
    if(lastFocus&&lastFocus.focus){ try{ lastFocus.focus(); }catch(_){} }
  }
  window.closeAddonSources=closeSheet;
  window.openAddonSources=async function(ds){
    lastFocus=document.activeElement;
    const type=ds.type||'movie', id=ds.id||'';
    // snapshot title/state the player + play handler read
    currentTitle=ds.t||''; currentYear=ds.y||'';
    window.currentImdb=id; window.currentStreams=[]; window.currentMediaType=type; window.currentLang='en';
    window.currentTitleMeta={ id, title:ds.t||'', year:ds.y||'', type, genre:ds.g||'', rating:ds.r||'', poster:ds.p||'' };
    document.getElementById('sourcesTitle').textContent=ds.t||'';
    document.getElementById('sourcesSub').textContent=I18N.t('sources.sub',{name:ds.addonName||ds.t||''});
    setBody(`<div class="stream-source-label"><span class="spinner"></span> ${esc(I18N.t('sources.searching'))}</div>`);
    ov.classList.add('open'); ov.setAttribute('aria-hidden','false');
    setTimeout(()=>{ try{ document.getElementById('sourcesDismiss').focus(); }catch(_){} },40);
    if(!id){ setBody(`<div class="lang-empty">${esc(I18N.t('sources.none'))}</div>`); return; }
    try{
      const data=await collectAddonStreams(id,type);   // browser → add-on direct
      if(!ov.classList.contains('open'))return;     // user already left
      const streams=data.streams||[];
      window.currentStreams=streams;
      if(!streams.length){ setBody(`<div class="lang-empty">${esc(I18N.t('sources.none'))}</div>`); return; }
      setBody(renderStreamList(streams));
    }catch(e){ if(ov.classList.contains('open')) setBody(`<div class="lang-empty">${esc(I18N.t('sources.none'))}</div>`); }
  };
  // pick a source → play it in the shared player; or follow a locked-state CTA
  listEl.addEventListener('click',e=>{
    const b=e.target.closest('[data-act]'); if(!b)return;
    if(b.dataset.act==='addonStream'){
      const all=window.currentStreams||[];
      const addonStream=all.find(x=>x.url===b.dataset.url)||{kind:b.dataset.kind,url:b.dataset.url||''};
      closeSheet();
      resolveAddonStream({...addonStream,title:currentTitle+(currentYear?` (${currentYear})`:'')});
    }
  });
  document.getElementById('sourcesDismiss').addEventListener('click',closeSheet);
  ov.addEventListener('click',e=>{ if(e.target===ov)closeSheet(); });
  addEventListener('keydown',e=>{ if(e.key==='Escape'&&ov.classList.contains('open'))closeSheet(); });
})();

/* close external-player menu on outside click */
document.addEventListener('click',e=>{
  if(!e.target.closest('.ext-trigger')&&!e.target.closest('.ext-menu'))
    document.querySelectorAll('.ext-menu.open').forEach(m=>m.classList.remove('open'));
});

/* ---------- add-on catalog: Official + Community sections ---------- *
 * Functional model (ties into the Terms & DMCA framing):
 *   • The official cards are all metadata/discovery helpers built on TMDB — they
 *     drive home rows (Upcoming marquee, Studios, Trending/Top, Providers). None of
 *     them host or fetch media; they only arrange catalog metadata.
 *   • STREDIO ships NO stream sources. Out of the box it is a pure media catalog &
 *     UI with NO third-party streams. A user may add their own stream add-on by URL
 *     in the Community section; only then does the player surface sources
 *     (see streamSourceInstalled()).                        */
const ADDONS=[
  /* — OFFICIAL (metadata / discovery only) — */
  {id:'upcoming', section:'official', name:'Upcoming Movies & Series scrolling addon', iconCls:'puzzle', glyph:'✦', ver:'v1.3.0',
   tags:['catalog','metadata'], installed:true, noConfig:true, preview:true},
  {id:'studios', section:'official', name:'Studios row addon', iconCls:'puzzle', glyph:'▷', ver:'v1.0.0',
   tags:['catalog','metadata'], installed:true, noConfig:true, preview:true},
  {id:'catalog', section:'official', name:'Trending & Top Rated rows addon', iconCls:'puzzle', glyph:'▤', ver:'v1.0.0',
   tags:['catalog','metadata'], installed:true},
  {id:'providers', section:'official', name:'Streaming Services rows addon', iconCls:'puzzle', glyph:'▭', ver:'v1.0.0',
   tags:['catalog','metadata'], installed:false},
  /* — COMMUNITY — user-installed third-party add-ons appear here (none ship with STREDIO) — */
];
/* persist install state locally so it survives reloads */
const ADDON_KEY='stredio.addons';
(function loadAddonState(){
  try{const raw=localStorage.getItem(ADDON_KEY);const s=raw?JSON.parse(raw):{};
    ADDONS.forEach(a=>{if(!a.locked&&typeof s[a.id]==='boolean')a.installed=s[a.id]});}
  catch(e){ try{localStorage.removeItem(ADDON_KEY);}catch(_){} } // reset corrupt state instead of failing forever
})();
/* Install state syncs per-account (so the toggled home rows follow you across
   devices), last-write-wins by timestamp. localStorage stays the source of truth
   for guests/offline; `owner` guards against one account inheriting another's
   toggles on a shared browser. */
const ADDON_AT_KEY='stredio.addons.at', ADDON_OWNER_KEY='stredio.addons.owner';
function addonStateMap(){ const s={}; ADDONS.forEach(a=>{ if(!a.locked) s[a.id]=a.installed; }); return s; }
function localAddonAt(){ try{ return +localStorage.getItem(ADDON_AT_KEY)||0; }catch(e){ return 0; } }
function writeAddonState(map,at){
  try{ localStorage.setItem(ADDON_KEY,JSON.stringify(map)); }catch(e){}
  try{ localStorage.setItem(ADDON_AT_KEY,String(at)); }catch(e){}
}
function pushAddonState(at){
  if(!_wAuthed()) return;
  try{ fetch('/api/addon-state',{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({map:addonStateMap(),at:at||localAddonAt()||Date.now()})}).catch(()=>{}); }catch(e){}
}
function saveAddonState(){
  const at=Date.now();
  writeAddonState(addonStateMap(),at);
  try{ localStorage.setItem(ADDON_OWNER_KEY,(window.AUTH&&AUTH.user&&AUTH.user.email)||''); }catch(e){}
  pushAddonState(at);
}
function applyAddonsUI(){
  try{ if(typeof renderAddons==='function') renderAddons(); }catch(e){}
  try{ if(typeof renderUpcomingSection==='function') renderUpcomingSection(); }catch(e){}
  try{ if(typeof renderStudioSection==='function') renderStudioSection(); }catch(e){}
  try{ if(typeof renderCatalogSection==='function') renderCatalogSection(); }catch(e){}
  try{ if(typeof renderProviderSection==='function') renderProviderSection(); }catch(e){}
  try{ if(typeof syncStreamReady==='function') syncStreamReady(); }catch(e){}
}
async function pullAddonState(){
  if(!_wAuthed()) return;
  const email=(AUTH.user&&AUTH.user.email)||'';
  let owner=''; try{ owner=localStorage.getItem(ADDON_OWNER_KEY)||''; }catch(e){}
  const diffUser=owner&&owner!==email;
  try{
    const r=await fetch('/api/addon-state'); if(!r.ok) return;
    const remote=await r.json(); const rAt=+remote.at||0, lAt=localAddonAt();
    const hasRemote=remote.map&&typeof remote.map==='object'&&Object.keys(remote.map).length>0;
    if(hasRemote&&(rAt>lAt||diffUser)){            // server is newer, or a different account → adopt it
      ADDONS.forEach(a=>{ if(!a.locked&&typeof remote.map[a.id]==='boolean') a.installed=remote.map[a.id]; });
      writeAddonState(addonStateMap(),rAt); applyAddonsUI();
    } else if(!diffUser&&(!hasRemote||lAt>=rAt)){  // we own it and local is newer/first → upload
      pushAddonState(lAt||Date.now());
    }
    try{ localStorage.setItem(ADDON_OWNER_KEY,email); }catch(e){}
  }catch(e){}
}
/* Is a third-party stream source installed? True once the account has installed at
   least one add-on that provides streams (via the Add-on catalog). With none installed
   the player surfaces NO third-party streams and the site stays a pure catalog & UI. */
function streamSourceInstalled(){
  return (window.STREAM_SOURCES||0) > 0;
}
/* Is the "Upcoming Radar" add-on installed? It powers the home Upcoming marquee.
   Defaults to true if ADDONS isn't ready yet (it's installed-by-default), so an
   early renderHome() during page boot still shows the row. */
function upcomingInstalled(){
  try{ const a=(typeof ADDONS!=='undefined')&&ADDONS.find(x=>x.id==='upcoming'); return a?!!a.installed:true; }
  catch(e){ return true; }
}
/* Is the "Studios" add-on installed? It powers the home STUDIOS logo row. Defaults
   to true if ADDONS isn't ready yet (installed-by-default), so an early renderHome()
   during page boot still builds the row. */
function studiosInstalled(){
  try{ const a=(typeof ADDONS!=='undefined')&&ADDONS.find(x=>x.id==='studios'); return a?!!a.installed:true; }
  catch(e){ return true; }
}
function addonIconHTML(a){
  // Community add-ons always use the Stredio puzzle/flower glyph tinted green;
  // official add-ons keep the red puzzle / their own icon.
  const community=a.section==='community';
  const usePuzzle=a.iconCls==='puzzle'||community;
  const cls='ic'+(usePuzzle?' puzzle':(a.iconCls?(' '+a.iconCls):''))+(community?' green':'');
  if(usePuzzle) return `<div class="${esc(cls)}" aria-hidden="true"><svg class="pzPieceIc" viewBox="0 0 120 120" focusable="false"><defs><mask id="pzMaskIc"><rect width="120" height="120" fill="#000"/><rect x="24" y="24" width="72" height="72" rx="13" fill="#fff"/><circle cx="60" cy="24" r="13" fill="#fff"/><circle cx="96" cy="60" r="13" fill="#fff"/><circle cx="60" cy="96" r="13" fill="#000"/><circle cx="24" cy="60" r="13" fill="#000"/></mask></defs><rect data-fill width="120" height="120" mask="url(#pzMaskIc)"/></svg></div>`;
  if(a.img) return `<div class="${esc(cls)}"><img src="${esc(a.img)}" alt="" loading="lazy" decoding="async" onerror="this.parentNode.textContent=''"/></div>`;
  return `<div class="${esc(cls)}" aria-hidden="true">${esc(a.glyph||'')}</div>`;
}
function addonCardHTML(a){
  const status=a.installed
    ? `<span class="badge ok">${esc(t('addons.installed_tag'))}</span>`
    : `<span class="badge muted">${esc(t('addons.available'))}</span>`;
  let acts;
  if(a.locked){                       // default add-on: auto-installed, not removable/configurable
    acts=`<span class="minibtn is-default" aria-disabled="true" title="${esc(t('addons.default_hint'))}">${esc(t('addons.default_tag'))}</span>`;
  }else{
    const cfg=a.noConfig?'':`<button class="minibtn" type="button" data-configure="${a.id}">${esc(t('addons.configure'))}</button>`;
    // Preview-only add-ons (Upcoming, Studios) have no settings — they get a Preview
    // button in the Configure slot that opens a live "home screen" peek of their row.
    const prv=a.preview?`<button class="minibtn" type="button" data-preview="${a.id}">${esc(t('addons.preview'))}</button>`:'';
    const tog=a.installed
      ? `<button class="minibtn danger" type="button" data-toggle="${a.id}">${esc(t('addons.remove'))}</button>`
      : `<button class="minibtn install" type="button" data-toggle="${a.id}">${esc(t('addons.install_short'))}</button>`;
    acts=prv+cfg+tog;
  }
  return `<div class="addon${a.installed?' installed':''}" data-addon="${a.id}">
    ${addonIconHTML(a)}
    <div class="body">
      <div class="name">${esc(a.name)} <span class="ver">${esc(a.ver)}</span> ${status}</div>
      <div class="desc"><span class="mono">${esc(t('addon.'+a.id+'.type'))}</span> — ${esc(t('addon.'+a.id+'.desc'))}</div>
      <div class="tags">${a.tags.map(tg=>`<span class="tag">${esc(t('tag.'+tg))}</span>`).join('')}</div>
    </div>
    <div class="acts">${acts}</div>
  </div>`;
}
function renderAddons(){
  const off=ADDONS.filter(a=>a.section==='official');
  const com=ADDONS.filter(a=>a.section==='community');
  const oEl=document.getElementById('officialAddons'); if(oEl)oEl.innerHTML=off.map(addonCardHTML).join('');
  const cEl=document.getElementById('communityAddons'); if(cEl)cEl.innerHTML=com.map(addonCardHTML).join('');
  const oc=document.getElementById('officialCount'); if(oc)oc.textContent=t('addons.count_installed',{n:off.filter(a=>a.installed).length,total:off.length});
  const cc=document.getElementById('communityCount'); if(cc)cc.textContent=t('addons.count_installed',{n:com.filter(a=>a.installed).length,total:com.length});
  const ic=document.getElementById('installedCount'); if(ic)ic.textContent=t('addons.installed_count',{n:ADDONS.filter(a=>a.installed).length});
}
renderAddons();
/* Reconcile the home Upcoming marquee with the now-loaded add-on state: if a fast
   (no-intro) boot painted the home before ADDONS was ready, upcomingInstalled()
   defaulted to "show" — re-run now that the persisted state is applied so a removed
   add-on correctly hides the section. */
if(typeof renderUpcomingSection==='function') renderUpcomingSection();
if(typeof renderStudioSection==='function') renderStudioSection();
if(typeof renderCatalogSection==='function') renderCatalogSection();
if(typeof renderProviderSection==='function') renderProviderSection();
/* delegated on the whole #addons section so it survives re-render and covers both
   grids; ignores the install-by-URL box (which has its own wiring). */
const _addonsSection=document.getElementById('addons');
_addonsSection&&_addonsSection.addEventListener('click',e=>{
  const prev=e.target.closest('[data-preview]');
  if(prev){ if(typeof openAddonPreview==='function')openAddonPreview(prev.dataset.preview); return; }
  const cfg=e.target.closest('[data-configure]');
  if(cfg){
    const a=ADDONS.find(x=>x.id===cfg.dataset.configure); if(!a)return;
    if(a.id==='catalog'){ if(typeof openCatalogConfig==='function')openCatalogConfig(); }
    else if(a.id==='providers'){ if(typeof openProvidersConfig==='function')openProvidersConfig(); }
    else toast(t('addons.no_config',{name:a.name}),'var(--accent)');
    return;
  }
  const btn=e.target.closest('[data-toggle]');if(!btn)return;
  const a=ADDONS.find(x=>x.id===btn.dataset.toggle);if(!a||a.locked)return;
  a.installed=!a.installed;
  saveAddonState();renderAddons();
  if(a.id==='upcoming'&&typeof renderUpcomingSection==='function') renderUpcomingSection();  // show/hide home marquee live
  if(a.id==='studios'&&typeof renderStudioSection==='function') renderStudioSection();       // show/hide home studios row live
  if(a.id==='catalog'&&typeof renderCatalogSection==='function') renderCatalogSection();     // show/hide the six catalog rows live
  if(a.id==='providers'&&typeof renderProviderSection==='function') renderProviderSection(); // show/hide the seven provider rows live
  syncStreamReady();                    // footer playback line + play gate follow stream-source availability
  if(a.installed) toast(t('addons.toast_installed',{name:a.name}),'var(--success)');
  else            toast(t('addons.toast_removed',{name:a.name}),'var(--danger)');
});

/* ---------- official add-on list: driven by the Stredio-Heart core (WASM) ----------
 * The inline `const ADDONS` above stays the synchronous boot source, the offline
 * fallback, and the source of truth for the four behavior-critical ids + their install
 * state — like `const EN` / `const DICT` anchor i18n. This upgrade layer reads the
 * canonical official collection from the Stredio official-addons repo and MERGES it
 * through the Stredio-Heart core compiled to WebAssembly — the SAME Rust merge_official
 * rules every shell uses (https://github.com/Shon1a/Stredio-Heart). It only REFINES the
 * four's display metadata / APPENDS new curated cards; it can never flip a toggle, and
 * it never touches the Render server (browser -> jsDelivr -> GitHub). Free-tier safe.
 * If the WASM core can't load (old browser / strict CSP), it falls back to an identical
 * pure-JS merge; if the CDN is unreachable, the inline four stand. */
(function(){
  var ADDONS_CDN='https://cdn.jsdelivr.net/gh/Shon1a/Stredio-official-addons@master/';
  var HEART_JS='https://cdn.jsdelivr.net/gh/Shon1a/Stredio-Heart@master/web/stredio_heart.js';
  var DISPLAY=['name','ver','iconCls','glyph','tags','img'];   // fields the CDN may refine on a known id (NOT installed/locked/noConfig/preview/section/id)
  async function fetchText(file){ try{ var r=await fetch(ADDONS_CDN+file,{cache:'force-cache'}); if(r.ok) return await r.text(); }catch(e){} return null; }
  function parse(txt){ try{ return txt?JSON.parse(txt):null; }catch(e){ return null; } }
  /* re-adopt persisted per-account toggles for any NEW id the merge appended (the four
     already did at ~7716); keeps localStorage authoritative over CDN defaults. */
  function reapplyLocal(){
    try{ var raw=localStorage.getItem(ADDON_KEY); var s=raw?JSON.parse(raw):{};
      ADDONS.forEach(function(a){ if(!a.locked&&typeof s[a.id]==='boolean') a.installed=s[a.id]; }); }catch(e){}
  }
  /* Pull the core's merged list back into the live ADDONS array IN PLACE. Only display
     fields are copied onto known ids (never installed/locked/etc.), so a toggle the user
     hits mid-load is never clobbered; genuinely new curated cards are pushed whole. Ids
     stay stable, so localStorage / /api/addon-state and home-row gating keep resolving. */
  function applyMerged(merged){
    if(!Array.isArray(merged)) return;
    merged.forEach(function(m){
      if(!m||typeof m.id!=='string'||!m.id) return;
      var cur=ADDONS.find(function(x){return x.id===m.id;});
      if(cur){ DISPLAY.forEach(function(f){ if(f in m) cur[f]=m[f]; }); if(!Array.isArray(cur.tags)) cur.tags=[]; }
      else   { if(!Array.isArray(m.tags)) m.tags=[]; ADDONS.push(m); }
    });
  }
  /* PRIMARY: drive the Stredio-Heart WASM core. Resolves true once it has handled the
     official collection; throws only if the core itself can't load, so the caller can
     fall back to the JS path. */
  async function loadViaCore(){
    var mod=await import(HEART_JS); await mod.default();          // instantiate the wasm core (fetched from jsDelivr)
    var rt=new mod.AddonRuntime(JSON.stringify(ADDONS));          // seed with the inline four (+ localStorage state)
    rt.load_official();                                           // -> [FetchOfficialManifest]
    var fx1=parse(rt.official_manifest_fetched(await fetchText('index.json')))||[];
    var pf=fx1.find(function(e){return e&&e.FetchOfficialPayload;});  // core tells us the payload file
    if(pf){
      var fx2=parse(rt.official_payload_fetched(await fetchText(pf.FetchOfficialPayload.file)))||[];
      applyMerged(parse(rt.addons_json()));                       // merge happened in Rust; adopt the result
      reapplyLocal();
      if(fx2.indexOf('Repaint')>=0){ try{ if(typeof renderAddons==='function') renderAddons(); }catch(e){} }
    }
    try{ rt.free(); }catch(e){}                                   // release the wasm object
    return true;
  }
  /* FALLBACK: identical merge in pure JS (used only when the WASM core can't load). */
  var ICON_OK=/^[a-z0-9 _-]{0,40}$/i;
  function safeIcon(v){ return (typeof v==='string'&&ICON_OK.test(v))?v:null; }
  function hasStream(raw){ return raw.transportUrl!=null || (Array.isArray(raw.resources)&&raw.resources.some(function(r){return r==='stream'||(r&&r.name==='stream');})); }
  function verOf(raw){ if(typeof raw.ver==='string') return raw.ver; if(typeof raw.version==='string') return 'v'+raw.version; return undefined; }
  function upsertKnown(cur,raw){
    var changed=false;
    DISPLAY.forEach(function(f){
      if(f==='tags'){ if(Array.isArray(raw.tags)){ var tg=raw.tags.filter(function(t){return typeof t==='string';}); if(JSON.stringify(tg)!==JSON.stringify(cur.tags)){ cur.tags=tg; changed=true; } } return; }
      if(f==='ver'){ var vv=verOf(raw); if(typeof vv==='string'&&vv!==cur.ver){ cur.ver=vv; changed=true; } return; }
      if(f==='iconCls'){ var ic=safeIcon(raw.iconCls); if(ic!=null&&ic!==cur.iconCls){ cur.iconCls=ic; changed=true; } return; }
      if(!(f in raw)) return;
      var v=raw[f]; if((typeof v==='string'||v===null)&&v!==cur[f]){ cur[f]=v; changed=true; }
    });
    if(!Array.isArray(cur.tags)) cur.tags=[];
    return changed;
  }
  function coerceNew(raw){
    var v=verOf(raw);
    return { id:raw.id, section:'official',
      name:typeof raw.name==='string'?raw.name:raw.id,
      ver:(typeof v==='string'?v:''),
      iconCls:safeIcon(raw.iconCls)||'puzzle',
      glyph:typeof raw.glyph==='string'?raw.glyph:'',
      tags:Array.isArray(raw.tags)?raw.tags.filter(function(t){return typeof t==='string';}):[],
      installed:(raw.defaultInstalled===true)||(raw.installed===true)||false,
      noConfig:!!raw.noConfig, preview:!!raw.preview, locked:!!raw.locked,
      img:typeof raw.img==='string'?raw.img:undefined };
  }
  function mergeJs(list){
    var changed=false;
    list.forEach(function(raw){
      if(!raw||typeof raw.id!=='string'||!raw.id) return;
      if(raw.section!=='official') return;
      if(hasStream(raw)) return;
      var cur=ADDONS.find(function(x){return x.id===raw.id;});
      if(cur){ if(upsertKnown(cur,raw)) changed=true; } else { ADDONS.push(coerceNew(raw)); changed=true; }
    });
    return changed;
  }
  async function loadViaJs(){
    var man=parse(await fetchText('index.json'));
    if(!man||man.schema!==1||!Array.isArray(man.collections)) return;
    var off=man.collections.find(function(c){return c&&c.section==='official'&&typeof c.file==='string';});
    if(!off) return;
    var data=parse(await fetchText(off.file));
    if(!data||data.schema!==1||!Array.isArray(data.addons)) return;
    if(!mergeJs(data.addons)) return;
    reapplyLocal();
    try{ if(typeof renderAddons==='function') renderAddons(); }catch(e){}
  }
  async function loadOfficialAddons(){
    try{ if(await loadViaCore()){ window.__STREDIO_CORE='wasm'; return; } }catch(e){}  // core unavailable -> fall back
    window.__STREDIO_CORE='js';
    try{ await loadViaJs(); }catch(e){}
  }
  loadOfficialAddons();                               // fire-and-forget, exactly like loadManifest() at ~3803
})();

/* ---------- live "home screen" preview shared by the catalog/provider configs ----------
   Reads each checkbox's own label + category so the preview mirrors what's on screen,
   then hydrates each ghost row with real covers from the same /api/browse the home
   rows use (gracefully stays as gradient placeholders if the backend is offline).
   rowsEl = the .optrow-list group of checkboxes; screenEl = the preview viewport. */
const PREVIEW_POSTERS={};   // cat -> [{poster,backdrop}] cache, so toggles don't refetch
function previewPosters(cat){
  if(PREVIEW_POSTERS[cat]) return Promise.resolve(PREVIEW_POSTERS[cat]);
  return fetch(`/api/browse?cat=${encodeURIComponent(cat)}&page=1&lang=${I18N.lang()}`)
    .then(r=>r.ok?r.json():null)
    .then(d=>{
      const list=((d&&d.results)||[]).filter(m=>m.poster||m.backdrop).slice(0,10)
        .map(m=>({poster:m.poster||'',backdrop:m.backdrop||''}));
      PREVIEW_POSTERS[cat]=list; return list;
    })
    .catch(()=>{ PREVIEW_POSTERS[cat]=[]; return []; });
}
function renderCfgPreview(rowsEl,screenEl){
  if(!rowsEl||!screenEl)return;
  const rows=[...rowsEl.querySelectorAll('.optrow')]
    .filter(lab=>lab.querySelector('input').checked)
    .map(lab=>({cat:lab.querySelector('input').value, label:lab.querySelector('span').textContent}));
  if(!rows.length){
    screenEl.innerHTML=`<div class="cfg-preview-empty">${esc(t('cfg.preview_empty'))}</div>`;
    return;
  }
  const TILES=7;
  // bump a token each render so async cover fills from a stale (superseded) toggle bail out
  const token=(screenEl._pvToken=(screenEl._pvToken||0)+1);
  screenEl.innerHTML=rows.map(r=>`<div class="cfg-preview-row" data-cat="${esc(r.cat)}">
    <div class="cfg-row-label">${esc(r.label)}</div>
    <div class="cfg-row-strip">${'<span class="cfg-tile"></span>'.repeat(TILES)}</div>
  </div>`).join('');
  rows.forEach(r=>{
    previewPosters(r.cat).then(list=>{
      if(screenEl._pvToken!==token||!list.length)return;
      const strip=screenEl.querySelector(`.cfg-preview-row[data-cat="${CSS.escape(r.cat)}"] .cfg-row-strip`);
      if(!strip)return;
      strip.querySelectorAll('.cfg-tile').forEach((tile,i)=>{
        const it=list[i%list.length]; if(!it)return;
        const url=it.poster||it.backdrop;
        if(!url)return;
        const img=new Image(); img.alt=''; img.loading='lazy'; img.decoding='async';
        img.onerror=()=>img.remove();
        img.src=url; tile.appendChild(img);
      });
    });
  });
}

/* ---------- Preview-only modal shared by the Upcoming + Studios add-ons ----------
   Each adds a single, non-configurable home row, so instead of a Configure modal they
   get a read-only "home screen" peek of exactly the row(s) they contribute. Upcoming
   reuses the REAL home marquee (um-rail/um-track/upcoming-card + fillUpcoming +
   startUpcomingAnim), so the two rows auto-scroll in opposite directions and pause on
   hover exactly like the home page; Studios shows the real studio-logo rail. Reuses the
   .cfg-preview chrome. */
const ADDON_PREVIEW_ROWS={
  upcoming:[
    {kind:'marquee', cat:'upcoming_movie',  key:'sec.upcoming_movies', track:'pvUmTrack'},
    // second row carries no heading — it reads as one continuous marquee under the first label
    {kind:'marquee', cat:'upcoming_series', track:'pvUmTrack2', rev:true, noLabel:true},
  ],
  studios:[
    {kind:'studios', key:'sec.studios'},
  ],
};
/* full /api/browse results (title/year/genre + art) the marquee cards need — separate
   from previewPosters() (which keeps only art) and cached so re-opening doesn't refetch. */
const PREVIEW_UPCOMING={};
function previewUpcoming(cat){
  if(PREVIEW_UPCOMING[cat]) return Promise.resolve(PREVIEW_UPCOMING[cat]);
  return fetch(`/api/browse?cat=${encodeURIComponent(cat)}&page=1&lang=${I18N.lang()}`)
    .then(r=>r.ok?r.json():null)
    .then(d=>{ const list=((d&&d.results)||[]).filter(m=>m.backdrop||m.poster); PREVIEW_UPCOMING[cat]=list; return list; })
    .catch(()=>{ PREVIEW_UPCOMING[cat]=[]; return []; });
}
function renderAddonPreview(id){
  const screenEl=document.getElementById('addonPreviewScreen');
  if(!screenEl)return;
  const a=(typeof ADDONS!=='undefined')&&ADDONS.find(x=>x.id===id);
  const titleEl=document.getElementById('addonPreviewTitle');
  if(titleEl&&a) titleEl.textContent=a.name;
  const rows=ADDON_PREVIEW_ROWS[id]||[];
  // marquee preview is full-bleed (so the um-rail edge-fade reaches the modal edges)
  screenEl.classList.toggle('is-marquee', id==='upcoming');
  // bump a token each render so an async fill from a stale open bails out
  const token=(screenEl._pvToken=(screenEl._pvToken||0)+1);
  screenEl.innerHTML=rows.map(r=>{
    if(r.kind==='studios'){
      // mini white-plate studio cards — same markup shape as the home studioRowHTML()
      const logos=STUDIOS.map(s=>`<div class="cfg-studio-card" title="${esc(s.name)}"><img src="${LOGO_BASE}${esc(s.logo)}" alt="${esc(s.name)} logo" loading="lazy" decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.opacity='1'" style="--logo-scale:${s.scale||1}"/><span class="cfg-studio-name">${esc(s.name)}</span></div>`).join('');
      return `<div class="cfg-preview-row"><div class="cfg-row-label">${esc(t(r.key))}</div>
        <div class="cfg-studio-row">${logos}</div></div>`;
    }
    // marquee: the real home rail markup (filled + animated below); some rows omit the label
    const lbl=r.noLabel?'':`<div class="cfg-row-label">${esc(t(r.key))}</div>`;
    return `<div class="cfg-preview-row">${lbl}<div class="um-rail"><div class="um-track${r.rev?' um-rev':''}" id="${esc(r.track)}"></div></div></div>`;
  }).join('');
  rows.filter(r=>r.kind==='marquee').forEach(r=>{
    previewUpcoming(r.cat).then(list=>{
      if(screenEl._pvToken!==token)return;          // a newer open superseded this one
      const track=document.getElementById(r.track);
      if(track) fillUpcoming(track, list);          // builds cards + WAAPI scroll (once visible)
    });
  });
}
(function(){
  const ov=document.getElementById('addonPreviewOverlay');
  if(!ov)return;
  let lastFocus=null;
  window.openAddonPreview=function(id){
    lastFocus=document.activeElement;
    renderAddonPreview(id);
    ov.classList.add('open'); ov.setAttribute('aria-hidden','false');
    setTimeout(()=>{ try{ document.getElementById('addonPreviewDone').focus(); }catch(e){} },40);
  };
  function close(){
    ov.classList.remove('open'); ov.setAttribute('aria-hidden','true');
    try{ if(lastFocus)lastFocus.focus(); }catch(e){}
  }
  document.getElementById('addonPreviewDismiss').addEventListener('click',close);
  document.getElementById('addonPreviewDone').addEventListener('click',close);
  ov.addEventListener('click',e=>{ if(e.target===ov)close(); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&ov.classList.contains('open'))close(); });
})();

/* ---------- Catalog Rows configure modal: check which home rows show ---------- */
(function(){
  const ov=document.getElementById('catalogOverlay');
  if(!ov)return;
  const $=id=>document.getElementById(id);
  let lastFocus=null;
  const preview=()=>renderCfgPreview($('catalogRows'),$('catalogPreviewScreen'));
  function paint(){
    ov.querySelectorAll('#catalogRows .optrow').forEach(lab=>{
      const cb=lab.querySelector('input');
      cb.checked=catalogRowEnabled(cb.value);
      lab.classList.toggle('on',cb.checked);
    });
    preview();
  }
  window.openCatalogConfig=function(){
    lastFocus=document.activeElement;
    paint();
    ov.classList.add('open'); ov.setAttribute('aria-hidden','false');
    setTimeout(()=>{ try{ $('catalogSaveBtn').focus(); }catch(e){} },40);
  };
  function close(){
    ov.classList.remove('open'); ov.setAttribute('aria-hidden','true');
    try{ if(lastFocus)lastFocus.focus(); }catch(e){}
  }
  $('catalogDismiss').addEventListener('click',close);
  ov.addEventListener('click',e=>{ if(e.target===ov)close(); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&ov.classList.contains('open'))close(); });
  // toggling a checkbox updates that row on the home screen immediately (and persists)
  ov.querySelectorAll('#catalogRows input').forEach(cb=>{
    cb.addEventListener('change',()=>{
      cb.closest('.optrow').classList.toggle('on',cb.checked);
      CATALOG_ROWS_ON[cb.value]=cb.checked;
      saveCatalogRows();
      renderCatalogSection();
      preview();
    });
  });
  $('catalogSaveBtn').addEventListener('click',()=>{ saveCatalogRows(); renderCatalogSection(); close(); toast(t('catalog.saved'),'var(--success)'); });
})();

/* ---------- Streaming Services configure modal: check which provider rows show ---------- */
(function(){
  const ov=document.getElementById('providersOverlay');
  if(!ov)return;
  const $=id=>document.getElementById(id);
  let lastFocus=null;
  const preview=()=>renderCfgPreview($('providerRows'),$('providersPreviewScreen'));
  function paint(){
    ov.querySelectorAll('#providerRows .optrow').forEach(lab=>{
      const cb=lab.querySelector('input');
      cb.checked=providerRowEnabled(cb.value);
      lab.classList.toggle('on',cb.checked);
    });
    preview();
  }
  window.openProvidersConfig=function(){
    lastFocus=document.activeElement;
    paint();
    ov.classList.add('open'); ov.setAttribute('aria-hidden','false');
    setTimeout(()=>{ try{ $('providersSaveBtn').focus(); }catch(e){} },40);
  };
  function close(){
    ov.classList.remove('open'); ov.setAttribute('aria-hidden','true');
    try{ if(lastFocus)lastFocus.focus(); }catch(e){}
  }
  $('providersDismiss').addEventListener('click',close);
  ov.addEventListener('click',e=>{ if(e.target===ov)close(); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&ov.classList.contains('open'))close(); });
  ov.querySelectorAll('#providerRows input').forEach(cb=>{
    cb.addEventListener('change',()=>{
      cb.closest('.optrow').classList.toggle('on',cb.checked);
      PROVIDER_ROWS_ON[cb.value]=cb.checked;
      saveProviderRows();
      renderProviderSection();
      preview();
    });
  });
  $('providersSaveBtn').addEventListener('click',()=>{ saveProviderRows(); renderProviderSection(); close(); toast(t('providers.saved'),'var(--success)'); });
})();

/* ---------- backend addon round-trip (real /api/addons) ---------- */
/* The curated cards above represent the backend's default metadata/subtitle add-ons
   (Cinemeta, OpenSubtitles v3). This round-trip surfaces any *extra* add-ons a user
   installed by URL and recomputes whether a third-party stream source is available. */
const CURATED_BACKEND_IDS=['com.linvo.cinemeta','org.stremio.opensubtitlesv3'];
const backendId=a=>(a.manifest&&a.manifest.id)||a.id;
const providesStream=a=>(((a.manifest&&a.manifest.resources)||a.resources||[]).includes('stream'));
window.STREAM_SOURCES=0;
/* Streaming is ready once the account has installed an add-on that provides streams.
   Mirrors into the footer playback status line. */
function syncStreamReady(){
  window.STREAM_READY=streamSourceInstalled();
  try{renderFooter();}catch(e){}
}
async function loadRemoteAddons(){
  const wrap=document.getElementById('remoteAddons');
  let list=[];
  try{ list=(await fetch('/api/addons').then(r=>r.json())).addons||[]; }
  catch(e){ window.INSTALLED_ADDONS=[]; window.STREAM_SOURCES=0; syncStreamReady(); if(wrap)wrap.innerHTML=''; return; } // backend not running → curated cards still render
  // The client's source of truth for the add-on collection. Every stream/subtitle/
  // catalog request is made by the browser straight to these add-ons' own URLs.
  window.INSTALLED_ADDONS=list;
  window.STREAM_SOURCES=list.filter(providesStream).length;
  syncStreamReady();
  renderAddons();
  if(!wrap)return;
  const extra=list.filter(a=>!CURATED_BACKEND_IDS.includes(backendId(a)));
  if(!extra.length){ wrap.innerHTML=''; return; }
  wrap.innerHTML=`<h4 style="font-size:14px;letter-spacing:.18em;color:var(--text-muted);margin:20px 0 12px">${esc(t('addons.installed_via_url'))}</h4>`+
    extra.map(a=>{
      const m=a.manifest||{};
      const tags=[...(m.types||[]),...(m.resources||[])];
      return `<div class="addon installed">
        <div class="ic">⬡</div>
        <div class="body">
          <div class="name">${esc(m.name||a.id)} <span class="ver">${esc(m.version||'')}</span> <span class="badge ok">${esc(t('addons.installed_tag'))}</span></div>
          <div class="desc">${esc(m.description||a.url||'')}</div>
          <div class="tags">${tags.map(tg=>`<span class="tag">${esc(tg)}</span>`).join('')}</div>
        </div>
        <div class="acts"><button class="minibtn danger" type="button" data-remove="${esc(a.id)}">${esc(t('addons.remove'))}</button></div>
      </div>`;
    }).join('');
}
const _remoteAddonsEl=document.getElementById('remoteAddons');
_remoteAddonsEl&&_remoteAddonsEl.addEventListener('click',async e=>{
  const btn=e.target.closest('[data-remove]');if(!btn)return;
  try{
    const r=await fetch('/api/addons/'+encodeURIComponent(btn.dataset.remove),{method:'DELETE'});
    if(r.ok){toast(t('addons.removed'),'var(--danger)');loadRemoteAddons();}
    else toast(t('addons.remove_fail'),'var(--danger)');
  }catch(e){toast(t('common.backend_unreachable'),'var(--danger)');}
});

/* loadRemoteAddons() runs from refreshAuth() once the user is authenticated */

/* Normalise the many shapes a user may paste into a fetchable manifest URL, and
   validate a manifest's shape — both done in the BROWSER so the install request,
   like every other add-on request, goes browser → add-on. */
function normalizeManifestUrlC(raw){
  let url=(raw||'').trim(); if(!url)return null;
  if(url.indexOf('stremio://')===0) url='https://'+url.slice('stremio://'.length);
  if(!/^https?:\/\//i.test(url))return null;
  let p; try{ p=new URL(url); }catch(e){ return null; }   // validate only
  // Keep the URL byte-for-byte. Configured add-ons pack options into the path
  // URL.toString() would percent-encode the `|`/`,` and mangle the config.
  if(/\.json($|\?)/i.test(p.pathname)) return url;
  const i=url.indexOf('?'), path=i<0?url:url.slice(0,i), qs=i<0?'':url.slice(i);
  return path.replace(/\/+$/,'')+'/manifest.json'+qs;
}
function validateManifestC(m){
  if(!m||typeof m!=='object')return 'Manifest is not a JSON object';
  if(typeof m.id!=='string'||!/^[a-z0-9][a-z0-9._-]{0,200}$/i.test(m.id))return 'Manifest "id" is missing or malformed';
  if(typeof m.name!=='string'||!m.name.trim()||m.name.length>200)return 'Manifest "name" is missing or too long';
  if(!Array.isArray(m.resources)||!m.resources.length)return 'Manifest missing "resources"';
  if(!Array.isArray(m.types)||!m.types.length)return 'Manifest missing "types"';
  return null;
}
/* wire addon install box → browser fetches + validates the manifest, then POSTs the
   sanitised record to /api/addons purely so the collection syncs across devices. */
document.querySelectorAll('.install-box button').forEach(b=>{
  b.addEventListener('click',async()=>{
    const inp=b.closest('.install-box').querySelector('input');
    const raw=inp?inp.value.trim():'';
    if(!raw){toast(t('addons.paste_url'),'var(--danger)');return;}
    const url=normalizeManifestUrlC(raw);
    if(!url){toast(t('addons.invalid_url'),'var(--danger)');return;}
    toast(t('addons.fetching'),'var(--accent)');
    // 1) Browser fetches the add-on manifest directly (CORS).
    let manifest;
    try{
      const r=await fetch(url,{headers:{accept:'application/json'}});
      if(!r.ok){toast('✕ '+t('addons.install_fail')+' ('+r.status+')','var(--danger)');return;}
      manifest=await r.json();
    }catch(e){ toast('✕ '+t('addons.install_fail'),'var(--danger)'); return; }
    const problem=validateManifestC(manifest);
    if(problem){ toast('✕ '+problem,'var(--danger)'); return; }
    // 2) Sanitise to the stored shape; POST for cross-device sync only.
    const safeManifest={
      id:manifest.id, name:manifest.name, version:manifest.version||'—',
      description:manifest.description||'', types:manifest.types,
      resources:manifest.resources.map(x=>typeof x==='string'?x:(x&&x.name)).filter(Boolean),
      catalogs:Array.isArray(manifest.catalogs)?manifest.catalogs.map(c=>({type:c.type,id:c.id,name:c.name||c.id})):[],
    };
    try{
      const r=await fetch('/api/addons',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,manifest:safeManifest})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok){toast('✕ '+(data.error||t('addons.install_fail')),'var(--danger)');return;}
      toast(t('addons.installed_ok',{name:(data.addon?.manifest?.name||'addon')}),'var(--success)');
      if(inp)inp.value='';
      loadRemoteAddons();
    }catch(e){
      toast(t('common.backend_unreachable_start'),'var(--danger)');
    }
  });
});

/* ================= authentication + route guards (Phase 1/2) ================= */
(function(){
  const $=id=>document.getElementById(id);
  window.AUTH={user:null};
  let authMode='login', authIntent=null, lastFocus=null;

  const validEmail=e=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const validPass=p=>p.length>=8&&/[a-zA-Z]/.test(p)&&/[0-9]/.test(p);
  // dob is an <input type=date> value (YYYY-MM-DD); true when the person is >= minAge
  const validAge=(dob,minAge)=>{
    const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(dob||''); if(!m) return false;
    const d=new Date(dob); if(isNaN(d)||d>new Date()) return false;
    const now=new Date(); let age=now.getFullYear()-d.getFullYear();
    if(now.getMonth()<d.getMonth()||(now.getMonth()===d.getMonth()&&now.getDate()<d.getDate())) age--;
    return age>=minAge&&age<=120;
  };
  window.isGated=p=>p==='addons'||p==='settings';

  /* ---- topbar user control + nav gating ---- */
  function updateAuthUI(){
    const authed=!!AUTH.user;
    document.body.classList.toggle('authed',authed);
    document.body.classList.toggle('is-admin',!!(AUTH.user&&AUTH.user.isAdmin));
    const ctl=$('authControl'); if(!ctl)return;
    if(authed){
      const email=AUTH.user.email||'account';
      const initial=esc((email.trim()[0]||'?'));
      const menuLabel=esc(t('authctl.account_menu'));
      ctl.innerHTML=`<div class="user-menu" id="userMenu">`+
        `<button class="user-chip" id="userChipBtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${menuLabel}" title="${esc(email)}">`+
          `<span class="u-avatar" aria-hidden="true">${initial}</span>`+
          `<span class="u-caret mono" aria-hidden="true">&#9662;</span>`+
        `</button>`+
        `<div class="user-dropdown" id="userDropdown" role="menu" aria-label="${menuLabel}">`+
          `<div class="ud-email"><span class="ud-label">${esc(t('authctl.signed_in_as'))}</span><span class="ud-addr" title="${esc(email)}">${esc(email)}</span></div>`+
          `<button class="ud-item" type="button" role="menuitem" data-act="addons"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>${esc(t('nav.addons'))}</span></button>`+
          `<button class="ud-item" type="button" role="menuitem" data-act="settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>${esc(t('nav.settings'))}</span></button>`+
          `<button class="ud-item ud-logout" type="button" role="menuitem" data-act="logout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>${esc(t('authctl.logout'))}</span></button>`+
        `</div>`+
      `</div>`;
      const menu=$('userMenu'), chipBtn=$('userChipBtn'), dd=$('userDropdown');
      const onDoc=e=>{ if(!menu.contains(e.target)) closeMenu(); };
      const onKey=e=>{ if(e.key==='Escape'){ closeMenu(); chipBtn.focus(); } };
      function closeMenu(){ menu.classList.remove('open'); chipBtn.setAttribute('aria-expanded','false');
        document.removeEventListener('click',onDoc); document.removeEventListener('keydown',onKey); }
      function openMenu(){ menu.classList.add('open'); chipBtn.setAttribute('aria-expanded','true');
        document.addEventListener('click',onDoc); document.addEventListener('keydown',onKey); }
      chipBtn.addEventListener('click',e=>{ e.stopPropagation(); menu.classList.contains('open')?closeMenu():openMenu(); });
      dd.addEventListener('click',e=>{ const it=e.target.closest('.ud-item'); if(!it) return;
        const act=it.dataset.act; closeMenu(); if(act==='logout') doLogout(); else navigate(act); });
    }else{
      ctl.innerHTML=`<button class="signin-btn" id="signinBtn" type="button">${esc(t('authctl.signin'))}</button>`;
      $('signinBtn').addEventListener('click',()=>openAuth(null));
    }
    // the resume rail keys off AUTH.user, so refresh it whenever the session flips
    try{ renderContinueWatching(); }catch(e){}
    // settings › PROFILE card mirrors the session
    try{
      const av=$('profileAvatar'), nm=$('profileName'), sub=$('profileSub'), badge=$('profileBadge');
      if(av&&nm&&sub){
        if(authed){
          const email=AUTH.user.email||'account';
          const disp=(AUTH.user.name||'').trim()||prettyNameFromEmail(email);
          av.textContent=((disp.trim()[0]||email.trim()[0]||'?'));
          nm.textContent=disp; nm.removeAttribute('data-i18n');
          sub.textContent=email; sub.removeAttribute('data-i18n');
          if(badge) badge.hidden=!AUTH.user.isAdmin;
        }else{
          av.textContent='?';
          nm.textContent=t('settings.profile_guest'); nm.setAttribute('data-i18n','settings.profile_guest');
          sub.textContent=t('settings.profile_local'); sub.setAttribute('data-i18n','settings.profile_local');
          if(badge) badge.hidden=true;
        }
      }
    }catch(e){}
  }

  async function refreshAuth(){
    try{
      const r=await fetch('/api/auth/me');
      const data=r.ok?await r.json():{user:null};
      AUTH.user=data.user||null;
      // The server reachably said "no user" → the stored token is expired/invalid;
      // drop it. (A network error throws below and leaves the token untouched.)
      if(r.ok && !AUTH.user) window.setSessionToken('');
    }catch(e){ AUTH.user=null; }
    updateAuthUI();
    if(AUTH.user){ try{loadRemoteAddons();}catch(e){} try{syncPull();syncPush();}catch(e){} try{pullAddonState();}catch(e){} }
  }

  /* ---- routing with guards (direct #addons/#settings URLs are blocked too) ---- */
  window.navigate=function(p){
    const target='#'+(p||'browse');
    if(location.hash===target) routeTo(p||'browse');
    else location.hash=target;
  };
  function routeTo(p){
    p=p||'browse';
    if(!['browse','addons','settings','legal','terms'].includes(p)||!document.getElementById(p)) p='browse';
    if(isGated(p)&&!AUTH.user){
      openAuth(p);                 // remember where they were headed
      gotoPage('browse');          // keep the public catalog visible behind the dialog
      if(location.hash!=='#browse') history.replaceState(null,'','#browse');
      return;
    }
    gotoPage(p);
  }
  addEventListener('hashchange',()=>routeTo((location.hash||'').slice(1)||'browse'));

  /* ---- auth overlay ---- */
  function setMode(mode){
    authMode=mode; const login=mode==='login';
    $('tabLogin').classList.toggle('on',login); $('tabLogin').setAttribute('aria-selected',login);
    $('tabSignup').classList.toggle('on',!login); $('tabSignup').setAttribute('aria-selected',!login);
    $('authTitle').textContent=login?t('auth.title_login'):t('auth.title_signup');
    $('authPassword').setAttribute('autocomplete',login?'current-password':'new-password');
    $('passHint').hidden=login;
    $('signupFields').hidden=login;
    $('authSubmit').querySelector('.auth-submit-label').innerHTML=esc(login?t('auth.submit_login'):t('auth.submit_signup'))+' &#9654;';
    $('authSwitchText').textContent=login?t('auth.switch_no_account'):t('auth.switch_have_account');
    $('authSwitch').innerHTML=esc(login?t('auth.switch_create'):t('auth.switch_login'))+' &rarr;';
    clearErrors();
  }
  function clearErrors(){
    $('emailErr').textContent='';$('passErr').textContent='';$('authError').textContent='';
    $('nameErr').textContent='';$('surnameErr').textContent='';$('dobErr').textContent='';
    ['authEmail','authPassword','authName','authSurname','authDob'].forEach(id=>$(id).classList.remove('invalid'));
  }
  function openAuth(intent){
    authIntent=intent||null; lastFocus=document.activeElement;
    const ov=$('authOverlay'); ov.classList.add('open'); ov.setAttribute('aria-hidden','false');
    $('authForm').reset(); setMode('login'); clearErrors();
    setTimeout(()=>{try{$('authEmail').focus();}catch(e){}},60);
  }
  window.openAuth=openAuth;
  function closeAuth(){
    const ov=$('authOverlay'); ov.classList.remove('open'); ov.setAttribute('aria-hidden','true');
    authIntent=null; setLoading(false);
    if(lastFocus&&lastFocus.focus){try{lastFocus.focus();}catch(e){}}
  }
  function setLoading(on){
    const b=$('authSubmit'); if(!b)return; b.disabled=on;
    b.querySelector('.auth-submit-label').style.visibility=on?'hidden':'';
    b.querySelector('.auth-submit-spin').hidden=!on;
  }

  async function submitAuth(ev){
    ev.preventDefault(); clearErrors();
    const email=$('authEmail').value.trim(), password=$('authPassword').value;
    const name=$('authName').value.trim(), surname=$('authSurname').value.trim(), dob=$('authDob').value;
    let bad=false;
    if(!validEmail(email)){ $('emailErr').textContent=t('auth.err_email'); $('authEmail').classList.add('invalid'); bad=true; }
    if(authMode==='signup'){
      if(!name){ $('nameErr').textContent=t('auth.err_name'); $('authName').classList.add('invalid'); bad=true; }
      if(!surname){ $('surnameErr').textContent=t('auth.err_surname'); $('authSurname').classList.add('invalid'); bad=true; }
      if(!dob){ $('dobErr').textContent=t('auth.err_dob'); $('authDob').classList.add('invalid'); bad=true; }
      else if(!validAge(dob,13)){ $('dobErr').textContent=t('auth.err_dob_age'); $('authDob').classList.add('invalid'); bad=true; }
      if(!validPass(password)){ $('passErr').textContent=t('auth.err_pass_signup'); $('authPassword').classList.add('invalid'); bad=true; }
    }
    else if(!password){ $('passErr').textContent=t('auth.err_pass_login'); $('authPassword').classList.add('invalid'); bad=true; }
    if(bad){ const f=document.querySelector('#authForm input.invalid'); if(f)f.focus(); return; }
    setLoading(true);
    try{
      const path=authMode==='signup'?'/api/auth/signup':'/api/auth/login';
      const body=authMode==='signup'?{email,password,name,surname,dob}:{email,password};
      const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await r.json().catch(()=>({}));
      if(!r.ok){ $('authError').textContent=data.error||t('auth.err_generic'); setLoading(false); return; }
      AUTH.user=data.user||null;
      window.setSessionToken(data.token||'');   // persist for cross-restart sign-in
      const intent=authIntent;
      closeAuth(); updateAuthUI();
      try{loadRemoteAddons();}catch(e){} try{syncPull();syncPush();}catch(e){} try{pullAddonState();}catch(e){}
      toast(t('auth.signed_in')+(AUTH.user&&AUTH.user.email?(' · '+AUTH.user.email):''),'var(--success)');
      navigate(intent||'browse');
    }catch(e){ $('authError').textContent=t('auth.err_backend'); setLoading(false); }
  }

  async function doLogout(){
    try{ syncFlush(true); _wStop(); }catch(e){}   // save any pending watch progress before the session ends
    try{ await fetch('/api/auth/logout',{method:'POST'}); }catch(e){}
    window.setSessionToken('');   // drop the persisted token so we don't re-auth
    AUTH.user=null; window.STREAM_READY=false; window.STREAM_SOURCES=0;
    updateAuthUI(); try{renderFooter();}catch(e){}
    const ra=$('remoteAddons'); if(ra) ra.innerHTML='';
    toast(t('auth.signed_out'),'var(--accent)');
    const cur=(location.hash||'#browse').slice(1);
    navigate(isGated(cur)?'browse':(cur||'browse'));
  }

  /* ---- Google Sign-In (Google Identity Services) ---- *
   * The button only appears when the server reports a configured GOOGLE_CLIENT_ID
   * (/api/auth/config). The GIS library is loaded lazily on first need. On success
   * Google hands us an ID token ("credential") which the backend verifies. */
  let GOOGLE_CLIENT_ID='';
  function loadGsi(cb){
    if(window.google&&google.accounts&&google.accounts.id){ cb(); return; }
    let s=document.getElementById('gsiScript');
    if(s){ s.addEventListener('load',cb); return; }
    s=document.createElement('script'); s.id='gsiScript';
    s.src='https://accounts.google.com/gsi/client'; s.async=true; s.defer=true;
    s.onload=cb; s.onerror=()=>{}; document.head.appendChild(s);
  }
  async function initGoogle(){
    try{
      const r=await fetch('/api/auth/config'); const cfg=r.ok?await r.json():{};
      GOOGLE_CLIENT_ID=(cfg&&cfg.googleClientId)||'';
    }catch(e){ GOOGLE_CLIENT_ID=''; }
    if(!GOOGLE_CLIENT_ID) return;            // feature dormant — leave the block hidden
    loadGsi(()=>{
      if(!(window.google&&google.accounts&&google.accounts.id)) return;
      try{
        google.accounts.id.initialize({ client_id:GOOGLE_CLIENT_ID, callback:onGoogleCredential, ux_mode:'popup' });
        const wrap=$('googleBtnWrap'); if(wrap) wrap.innerHTML='';
        google.accounts.id.renderButton(wrap,{ theme:'filled_black', size:'large', shape:'pill', text:'continue_with', logo_alignment:'center', width:300 });
        $('googleBlock').hidden=false;
      }catch(e){}
    });
  }
  async function onGoogleCredential(resp){
    if(!resp||!resp.credential) return;
    clearErrors();
    try{
      const r=await fetch('/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:resp.credential})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok){ $('authError').textContent=data.error||t('auth.err_generic'); return; }
      AUTH.user=data.user||null; window.setSessionToken(data.token||''); const intent=authIntent;
      closeAuth(); updateAuthUI();
      try{loadRemoteAddons();}catch(e){} try{syncPull();syncPush();}catch(e){} try{pullAddonState();}catch(e){}
      toast(t('auth.signed_in')+(AUTH.user&&AUTH.user.email?(' · '+AUTH.user.email):''),'var(--success)');
      navigate(intent||'browse');
    }catch(e){ $('authError').textContent=t('auth.err_backend'); }
  }

  /* ---- focus trap inside the dialog ---- */
  function trap(e){
    if(e.key!=='Tab')return;
    const ov=$('authOverlay');
    const items=[...ov.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>el.offsetParent!==null);
    if(!items.length)return;
    const first=items[0], last=items[items.length-1];
    if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
  }

  /* ---- wiring ---- */
  $('authForm').addEventListener('submit',submitAuth);
  try{ initGoogle(); }catch(e){}
  $('tabLogin').addEventListener('click',()=>setMode('login'));
  $('tabSignup').addEventListener('click',()=>setMode('signup'));
  $('authSwitch').addEventListener('click',()=>setMode(authMode==='login'?'signup':'login'));
  $('authSwitch').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); setMode(authMode==='login'?'signup':'login'); } });
  $('authDismiss').addEventListener('click',()=>{ closeAuth(); navigate('browse'); });
  $('passToggle').addEventListener('click',()=>{
    const i=$('authPassword'),btn=$('passToggle'),show=i.type==='password';
    i.type=show?'text':'password'; btn.textContent=show?t('auth.hide'):t('auth.show');
    btn.setAttribute('aria-pressed',String(show)); btn.setAttribute('aria-label',show?t('auth.hide_aria'):t('auth.show_aria'));
  });
  $('authOverlay').addEventListener('keydown',trap);
  $('authOverlay').addEventListener('mousedown',e=>{ if(e.target===$('authOverlay')){ closeAuth(); navigate('browse'); } });
  addEventListener('keydown',e=>{ if(e.key==='Escape'&&$('authOverlay').classList.contains('open')){ closeAuth(); navigate('browse'); } });

  /* ---- language toggle (EN | ქარ): wire buttons, apply on boot, re-render on switch ---- */
  // language-toggle clicks are delegated inside the I18N module (survives picker re-render)
  I18N.onChange(()=>{
    // re-translate everything that's rendered dynamically (static [data-i18n] is
    // handled by I18N.apply() inside I18N.set before this hook runs)
    try{ relabelGenrePills(); }catch(e){}
    try{ updateYrLabel(); updateRtLabel(); }catch(e){}
    try{ renderAddons(); }catch(e){}
    try{ renderTerms(); }catch(e){}
    try{ renderFooter(); }catch(e){}
    try{ setDocTitle(); }catch(e){}
    try{ updateAuthUI(); }catch(e){}
    try{ setMode(authMode); }catch(e){}
    // rebuild the seven home rows (section labels + titles come back localized)
    try{ renderHome(); }catch(e){}
    // if a drill-down is open, re-translate its title and re-fetch in the new language
    try{
      if(GRID.kind){
        const titleEl=document.getElementById('catTitle');
        if(titleEl&&GRID.params){
          if(GRID.kind==='category') titleEl.textContent=t(GRID.params.titleKey||'');
          else if(GRID.kind==='search') titleEl.textContent=t('cat.results',{q:GRID.params.query});
          else if(GRID.kind==='filter') titleEl.textContent=t('cat.filtered');
        }
        loadGridPage(true);
      }
    }catch(e){}
    // logged-in-only surfaces (avoid spurious 401s when signed out)
    if(window.AUTH&&AUTH.user){ try{ loadRemoteAddons(); }catch(e){} }
  });
  // boot: paint static strings + active toggle, and translate the filter sliders
  I18N.apply(); I18N.syncButtons();
  if(I18N.lang()!=='en') I18N.set(I18N.lang()); // CDN-load persisted language, then re-localize dynamic UI
  try{ updateYrLabel(); updateRtLabel(); }catch(e){}
  // user settings: apply persisted prefs (subtitle styling + blur class) and wire controls
  try{ applyAllSettings(); initSettingsControls(); }catch(e){}

  /* boot: learn the session state, then route the initial hash through the guard */
  refreshAuth().then(()=>routeTo((location.hash||'').slice(1)||'browse'));
})();
