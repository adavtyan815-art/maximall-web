import type { Spec } from './spec';
import { componentName } from './spec';
import { t, type Lang } from '../i18n';
import { articleName } from '../i18n/names';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** «2 773 BYN» (Russian, unchanged) / «2,773 BYN» (English, v2.5). */
export const byn = (v: number, lang: Lang = 'ru') =>
  lang === 'en'
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v)} BYN`
    : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v).replace(/[  ]/g, ' ')} BYN`;

export interface DossierView {
  dossierId: string;
  username: string;
  createdAt: Date;
  catalogSyncedAt: string;
  spec: Spec;
  floorPlanSvg: string;
  images: { src: string; caption: string }[]; // data URIs
  qrDataUri: string;
  shortUrl: string;
  notes: string[];
  consultantName: string;
  /** v2.5: the visitor's language (default ru). */
  lang?: Lang;
}

/**
 * Consultant's notes without an LLM call. QA-016: facts only from the scraped product page of the exact article
 * (material and warranty features as printed on oliveeka.by); nothing for estimated items; the "light walls" remark only
 * for light finishes. v2.5: in the spec's language (the scraped material is Russian text, so English notes keep only
 * the warranty years — TODO(owner): English material names).
 */
export function consultantNotes(spec: Spec, products: { articleCode: string; features?: Record<string, string> }[] = [], lang: Lang = spec.lang ?? 'ru'): string[] {
  const n: string[] = [];
  const byCode = new Map(products.map((p) => [p.articleCode, p]));
  for (const s of spec.sets) {
    const line = s.quote.lines.find((l) => l.component === 'cabinet');
    const w = line?.dimensionsCm?.width;
    const head = `${s.title}${w ? t(lang, 'dossier.note.width', { cm: Math.round(w) }) : ''}`;
    const p = line && !line.estimated && line.articleCode ? byCode.get(line.articleCode) ?? byCode.get(line.articleCode.split('+')[0]) : undefined;
    const facts: string[] = [];
    const mat = p?.features?.['Материал каркаса'] ?? p?.features?.['Материал фасада'];
    if (mat && (lang === 'ru' || !/[А-Яа-яЁё]/.test(mat))) facts.push(t(lang, 'dossier.note.material', { v: mat.toLowerCase() }));
    const war = p?.features?.['Гарантия, лет'];
    if (war) facts.push(t(lang, 'dossier.note.warranty', { v: war }));
    if (facts.length) n.push(t(lang, 'dossier.note.facts', { head, facts }));
    else n.push(t(lang, 'dossier.note.ask', { head }));
    if (s.config.closetSizeIndex >= 0) n.push(t(lang, 'dossier.note.closet'));
  }
  const wallsWord = t(lang, 'surface.walls');
  const walls = spec.finishes.find((f) => f.surface.startsWith(lang === 'ru' ? 'стен' : wallsWord) || f.surface.startsWith(lang === 'ru' ? 'стен' : 'wall'));
  if (walls) {
    const light = /RAL (9010|9016|9001|9003|1013|1015)|Tile_White|Tile_Beige|Tile_Sand|бел|беж|песоч/i.test(walls.label) || (lang === 'en' && /\b(white|beige|sand)\b/i.test(walls.label));
    n.push(t(lang, 'dossier.note.walls', { label: walls.label, light }));
  }
  if (spec.hasEstimated || spec.hasUnpriced) n.push(t(lang, 'dossier.note.flags'));
  n.push(t(lang, 'dossier.note.terms'));
  return n;
}

export function dossierHtml(v: DossierView): string {
  const lang = v.lang ?? 'ru';
  const L = (k: Parameters<typeof t>[1], p?: Record<string, any>) => t(lang, k, p);
  const locale = lang === 'en' ? 'en-GB' : 'ru-RU';
  const date = v.createdAt.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const synced = new Date(v.catalogSyncedAt).toLocaleDateString(locale);
  const hero = v.images[0];
  const priceTbc = esc(L('dossier.priceTbc'));
  const specRows = v.spec.sets
    .map((s) => {
      const rows = s.quote.lines
        .map(
          (l) => `<tr><td>${esc(componentName(l.component, lang))}${l.includes?.length === 2 ? esc(L('dossier.withTop')) : ''}</td><td>${esc(lang === 'ru' ? l.name : articleName(lang, l.name, s.title))}</td><td class="mono">${l.articleCode && !l.articleCode.includes(':') ? esc(l.articleCode) : `<span class="flag">${esc(L('dossier.articleTbc'))}</span>`}</td><td class="num">${
            l.unpriced ? `<span class="flag">${priceTbc}</span>` : `${byn(l.price, lang)}${l.estimated ? `<br><span class="flag">${priceTbc}</span>` : ''}`
          }</td></tr>`,
        )
        .join('');
      const colours = s.customColours.length ? `<tr><td colspan="4" class="muted">${esc(L('dossier.ownColour', { list: s.customColours.map((c) => c.code ?? c.rgb ?? '').join(', ') }))}</td></tr>` : '';
      return `<tr class="set"><td colspan="3">${esc(s.title)}</td><td class="num">${byn(s.quote.total, lang)}</td></tr>${rows}${colours}`;
    })
    .join('');
  const finishes = v.spec.finishes.map((f) => `<li>${esc(f.surface)}: ${esc(f.label)}${f.areaM2 ? esc(L('dossier.m2', { v: f.areaM2.toFixed(1) })) : ''}</li>`).join('');
  return `<!doctype html>
<html lang="${L('dossier.htmlLang')}"><head><meta charset="utf-8"><title>${esc(L('dossier.title'))}</title>
<style>
  @page { size: A4; margin: 14mm 14mm 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, "Helvetica Neue", sans-serif; color: #222; font-size: 11pt; margin: 0; }
  h1 { font-size: 24pt; font-weight: 600; margin: 0 0 4mm; letter-spacing: 0.2px; }
  h2 { font-size: 15pt; font-weight: 600; margin: 0 0 4mm; border-bottom: 2px solid #c9a77c; padding-bottom: 2mm; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .brand { font-size: 10pt; letter-spacing: 3px; text-transform: uppercase; color: #8a6d45; margin-bottom: 6mm; }
  .hero { width: 100%; height: 120mm; object-fit: cover; border-radius: 3mm; margin: 4mm 0; background: #eee; }
  .meta { display: flex; gap: 10mm; color: #555; font-size: 10pt; }
  .gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }
  .gallery img { width: 100%; height: 60mm; object-fit: cover; border-radius: 2mm; }
  .cap { font-size: 9pt; color: #666; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  td { padding: 1.6mm 2mm; border-bottom: 1px solid #e6e1d8; vertical-align: top; }
  tr.set td { background: #f4efe7; font-weight: 600; }
  .num { text-align: right; white-space: nowrap; }
  .mono { font-family: Consolas, "Courier New", monospace; font-size: 9pt; }
  .flag { color: #a0522d; font-size: 8.5pt; }
  .muted { color: #777; }
  .total { margin-top: 5mm; font-size: 14pt; font-weight: 700; text-align: right; }
  .note { font-size: 8.5pt; color: #666; margin-top: 2mm; }
  .plan { text-align: center; margin: 4mm 0; }
  .qr { display: flex; gap: 8mm; align-items: center; margin-top: 8mm; }
  .qr img { width: 42mm; height: 42mm; }
  ul { padding-left: 5mm; }
</style></head><body>
<section class="page">
  <div class="brand">${esc(L('dossier.brand'))}</div>
  <h1>${esc(L('dossier.h1'))}</h1>
  <div class="meta"><span>${esc(L('dossier.for', { username: v.username }))}</span><span>${esc(date)}</span><span>${esc(L('dossier.consultant', { name: v.consultantName }))}</span></div>
  ${hero ? `<img class="hero" src="${hero.src}" alt=""><div class="cap">${esc(hero.caption)}</div>` : ''}
  <div class="total">${esc(L('dossier.total', { total: byn(v.spec.total, lang) }))}</div>
  ${v.spec.hasEstimated || v.spec.hasUnpriced ? `<div class="note">${esc(L('dossier.totalNote'))}</div>` : ''}
</section>
<section class="page">
  <h2>${esc(L('dossier.plan'))}</h2>
  <div class="plan">${v.floorPlanSvg}</div>
  <div class="meta">${v.spec.floorAreaM2 ? `<span>${esc(L('dossier.floorArea', { v: v.spec.floorAreaM2.toFixed(1) }))}</span>` : ''}${v.spec.perimeterM ? `<span>${esc(L('dossier.perimeter', { v: v.spec.perimeterM.toFixed(1) }))}</span>` : ''}</div>
  ${finishes ? `<h2 style="margin-top:8mm">${esc(L('dossier.finishes'))}</h2><ul>${finishes}</ul>` : ''}
  ${v.images.length > 1 ? `<h2 style="margin-top:8mm">${esc(L('dossier.photos'))}</h2><div class="gallery">${v.images.slice(1, 5).map((i) => `<div><img src="${i.src}" alt=""><div class="cap">${esc(i.caption)}</div></div>`).join('')}</div>` : ''}
</section>
<section class="page">
  <h2>${esc(L('dossier.spec'))}</h2>
  <table><tbody>${specRows || `<tr><td>${esc(L('dossier.noSets'))}</td></tr>`}</tbody></table>
  <div class="total">${esc(L('dossier.total', { total: byn(v.spec.total, lang) }))}</div>
  <div class="note">${esc(L('dossier.priceNote', { synced }))}</div>
</section>
<section class="page">
  <h2>${esc(L('dossier.notes'))}</h2>
  <ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  <div class="qr"><img src="${v.qrDataUri}" alt="QR"><div><b>${esc(L('dossier.online'))}</b><br><span class="mono">${esc(v.shortUrl)}</span><br><span class="muted">${esc(L('dossier.onlineSub'))}</span></div></div>
  <div class="note">${esc(L('dossier.docNo', { id: v.dossierId, username: v.username }))}</div>
</section>
</body></html>`;
}

/** QA-058: a dossier whose files expired under the retention policy (the link was shared, so no bare 404). */
export function expiredPageHtml(lang: Lang = 'ru'): string {
  return `<!doctype html><html lang="${t(lang, 'dossier.htmlLang')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t(lang, 'expired.title'))}</title>
<style>
  :root { --bg:#fbfaf7; --fg:#222; --muted:#666; --accent:#8a6d45; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#eee; --muted:#aaa; --accent:#d2b48c; --card:#221f1b; } }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  .card { background:var(--card); border-radius:14px; padding:18px; max-width:520px; margin:0 auto; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size:22px; margin:0 0 6px; } .muted { color:var(--muted); font-size:15px; }
  .btn { display:block; text-align:center; text-decoration:none; padding:14px; border-radius:10px; margin-top:16px; font-weight:600; background:var(--accent); color:#fff; }
</style></head><body><div class="card">
<h1>${esc(t(lang, 'expired.h1'))}</h1>
<p class="muted">${esc(t(lang, 'expired.text'))}</p>
<a class="btn" href="tel:+375291099619">${esc(t(lang, 'page.call'))}</a>
</div></body></html>`;
}

export function shortPageHtml(v: {
  username: string;
  pdfUrl: string;
  total: number;
  sets: string[];
  hasFlags: boolean;
  saveName?: string;
  /** QA-060: visit request on the lead record (only for a real login). */
  shortId?: string;
  canRequestVisit?: boolean;
  visitRequestedAt?: string;
  consentText?: string;
  /** v2.5: the visitor's language (the dossier record's). */
  lang?: Lang;
}): string {
  const lang = v.lang ?? 'ru';
  const L = (k: Parameters<typeof t>[1], p?: Record<string, any>) => t(lang, k, p);
  // JS string literal inside the inline script (single quotes)
  const js = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const visitDone = `<div class="ok">${esc(L('page.visitDone'))}</div>`;
  const visit = !v.shortId
    ? ''
    : !v.canRequestVisit
      ? `<div class="visit"><button class="btn alt" style="width:100%;font-size:16px" disabled>${esc(L('page.visitBtn'))}</button>
<p class="muted">${esc(L('page.visitLogin'))}</p></div>`
      : v.visitRequestedAt
        ? `<div class="visit">${visitDone}</div>`
        : `<div class="visit" id="visit">
<label class="consent"><input type="checkbox" id="consent"> ${esc(v.consentText ?? '')}</label>
<button class="btn" id="visitBtn" style="width:100%;font-size:16px;border:0" disabled>${esc(L('page.visitBtn'))}</button>
<div class="muted" id="visitMsg" role="status"></div>
<script>
(function(){var c=document.getElementById('consent'),b=document.getElementById('visitBtn'),m=document.getElementById('visitMsg');
c.addEventListener('change',function(){b.disabled=!c.checked;});
b.addEventListener('click',function(){if(!c.checked)return;b.disabled=true;m.textContent='${js(L('page.sending'))}';
fetch(location.pathname.replace(/\\/$/,'')+'/visit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({consent:true})})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
.then(function(x){if(x.ok){document.getElementById('visit').innerHTML='${visitDone.replace(/'/g, "\\'")}';}else{m.textContent=(x.j&&x.j.message)||'${js(L('page.sendFailed'))}';b.disabled=!c.checked;}})
.catch(function(){m.textContent='${js(L('page.offline'))}';b.disabled=!c.checked;});});})();
</script></div>`;
  return `<!doctype html><html lang="${L('dossier.htmlLang')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(L('page.title'))}</title>
<style>
  :root { --bg:#fbfaf7; --fg:#222; --muted:#666; --accent:#8a6d45; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#eee; --muted:#aaa; --accent:#d2b48c; --card:#221f1b; } }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  .card { background:var(--card); border-radius:14px; padding:18px; max-width:520px; margin:0 auto; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size:22px; margin:0 0 6px; } .muted { color:var(--muted); font-size:14px; }
  .btn { display:block; text-align:center; text-decoration:none; padding:14px; border-radius:10px; margin-top:12px; font-weight:600; background:var(--accent); color:#fff; }
  .btn.alt { background:transparent; color:var(--accent); border:2px solid var(--accent); }
  ul { padding-left:18px; } .total { font-size:20px; font-weight:700; margin-top:8px; }
  .btn[disabled] { opacity:.5; } .consent { display:flex; gap:10px; align-items:flex-start; margin-top:16px; font-size:15px; }
  .consent input { width:22px; height:22px; flex:none; } .ok { margin-top:14px; padding:12px; border-radius:10px; background:rgba(60,140,80,.12); }
</style></head><body><div class="card">
<h1>${esc(L('page.h1'))}</h1>
<div class="muted">${esc(L('page.savedAs', { username: v.username, saveName: v.saveName }))}</div>
<ul>${v.sets.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<div class="total">${esc(L('dossier.total', { total: byn(v.total, lang) }))}</div>
${v.hasFlags ? `<div class="muted">${esc(L('page.flags'))}</div>` : ''}
<a class="btn" href="${esc(v.pdfUrl)}">${esc(L('page.pdf'))}</a>
${visit}
<a class="btn alt" href="tel:+375291099619">${esc(L('page.call'))}</a>
<button class="btn alt" style="width:100%;font-size:16px" onclick="navigator.share ? navigator.share({title:'${esc(js(L('page.shareTitle')))}', url: location.href}) : navigator.clipboard.writeText(location.href)">${esc(L('page.share'))}</button>
<p class="muted">${esc(L('page.reopen'))}</p>
</div></body></html>`;
}
