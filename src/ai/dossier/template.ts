import type { Spec } from './spec';
import { componentRu } from './spec';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const byn = (v: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v).replace(/[  ]/g, ' ')} BYN`;

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
}

/**
 * Consultant's notes without an LLM call. QA-016: facts only from the scraped product page of the exact article
 * (material and warranty features as printed on oliveeka.by); nothing for estimated items; the "light walls" remark only
 * for light finishes.
 */
export function consultantNotes(spec: Spec, products: { articleCode: string; features?: Record<string, string> }[] = []): string[] {
  const n: string[] = [];
  const byCode = new Map(products.map((p) => [p.articleCode, p]));
  for (const s of spec.sets) {
    const line = s.quote.lines.find((l) => l.component === 'cabinet');
    const w = line?.dimensionsCm?.width;
    const head = `${s.title}${w ? ` — ширина около ${Math.round(w)} см` : ''}`;
    const p = line && !line.estimated && line.articleCode ? byCode.get(line.articleCode) ?? byCode.get(line.articleCode.split('+')[0]) : undefined;
    const facts: string[] = [];
    const mat = p?.features?.['Материал каркаса'] ?? p?.features?.['Материал фасада'];
    if (mat) facts.push(`материал каркаса — ${mat.toLowerCase()}`);
    const war = p?.features?.['Гарантия, лет'];
    if (war) facts.push(`гарантия производителя ${war} лет`);
    if (facts.length) n.push(`${head}: ${facts.join(', ')} (по данным oliveeka.by).`);
    else n.push(`${head}: характеристики и цену этой позиции уточнит менеджер салона.`);
    if (s.config.closetSizeIndex >= 0) n.push('Навесной шкаф даёт место для хранения полотенец и косметики над тумбой.');
  }
  const walls = spec.finishes.find((f) => f.surface.startsWith('стен'));
  if (walls) {
    const light = /RAL (9010|9016|9001|9003|1013|1015)|Tile_White|Tile_Beige|Tile_Sand|бел|беж|песоч/i.test(walls.label);
    n.push(`Отделка стен: ${walls.label}.${light ? ' Светлые стены визуально расширяют небольшую ванную.' : ''}`);
  }
  if (spec.hasEstimated || spec.hasUnpriced) n.push('Позиции с пометкой «цена уточняется» подтвердит менеджер салона.');
  n.push('Сроки изготовления, доставку и монтаж уточнит менеджер салона.');
  return n;
}

export function dossierHtml(v: DossierView): string {
  const date = v.createdAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const synced = new Date(v.catalogSyncedAt).toLocaleDateString('ru-RU');
  const hero = v.images[0];
  const specRows = v.spec.sets
    .map((s) => {
      const rows = s.quote.lines
        .map(
          (l) => `<tr><td>${esc(componentRu(l.component))}${l.includes?.length === 2 ? ' + столешница' : ''}</td><td>${esc(l.name)}</td><td class="mono">${l.articleCode && !l.articleCode.includes(':') ? esc(l.articleCode) : '<span class="flag">артикул уточняется</span>'}</td><td class="num">${
            l.unpriced ? '<span class="flag">цена уточняется</span>' : `${byn(l.price)}${l.estimated ? '<br><span class="flag">цена уточняется</span>' : ''}`
          }</td></tr>`,
        )
        .join('');
      const colours = s.customColours.length ? `<tr><td colspan="4" class="muted">Свой цвет: ${s.customColours.map((c) => esc(c.code ?? c.rgb ?? '')).join(', ')}</td></tr>` : '';
      return `<tr class="set"><td colspan="3">${esc(s.title)}</td><td class="num">${byn(s.quote.total)}</td></tr>${rows}${colours}`;
    })
    .join('');
  const finishes = v.spec.finishes.map((f) => `<li>${esc(f.surface)}: ${esc(f.label)}${f.areaM2 ? ` — ${f.areaM2.toFixed(1)} м²` : ''}</li>`).join('');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Проект ванной — Oliveeka</title>
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
  <div class="brand">Oliveeka · мебель для ванной</div>
  <h1>Проект вашей ванной</h1>
  <div class="meta"><span>Для: ${esc(v.username)}</span><span>${esc(date)}</span><span>Консультант: ${esc(v.consultantName)}</span></div>
  ${hero ? `<img class="hero" src="${hero.src}" alt=""><div class="cap">${esc(hero.caption)}</div>` : ''}
  <div class="total">Итого: ${byn(v.spec.total)}</div>
  ${v.spec.hasEstimated || v.spec.hasUnpriced ? '<div class="note">Сумма без позиций с пометкой «цена уточняется».</div>' : ''}
</section>
<section class="page">
  <h2>План помещения</h2>
  <div class="plan">${v.floorPlanSvg}</div>
  <div class="meta">${v.spec.floorAreaM2 ? `<span>Площадь пола: ${v.spec.floorAreaM2.toFixed(1)} м²</span>` : ''}${v.spec.perimeterM ? `<span>Периметр: ${v.spec.perimeterM.toFixed(1)} м</span>` : ''}</div>
  ${finishes ? `<h2 style="margin-top:8mm">Отделка</h2><ul>${finishes}</ul>` : ''}
  ${v.images.length > 1 ? `<h2 style="margin-top:8mm">Фото</h2><div class="gallery">${v.images.slice(1, 5).map((i) => `<div><img src="${i.src}" alt=""><div class="cap">${esc(i.caption)}</div></div>`).join('')}</div>` : ''}
</section>
<section class="page">
  <h2>Спецификация</h2>
  <table><tbody>${specRows || '<tr><td>В комнате нет комплектов</td></tr>'}</tbody></table>
  <div class="total">Итого: ${byn(v.spec.total)}</div>
  <div class="note">Цены в BYN с сайта oliveeka.by на ${esc(synced)}. Не является публичной офертой. Позиции «цена уточняется» подтвердит менеджер салона.</div>
</section>
<section class="page">
  <h2>Заметки консультанта</h2>
  <ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  <div class="qr"><img src="${v.qrDataUri}" alt="QR"><div><b>Ваш проект онлайн</b><br><span class="mono">${esc(v.shortUrl)}</span><br><span class="muted">PDF, повторное открытие проекта, запись в салон</span></div></div>
  <div class="note">Документ № ${esc(v.dossierId)}. Проект сохранён под вашим логином «${esc(v.username)}».</div>
</section>
</body></html>`;
}

/** QA-058: a dossier whose files expired under the retention policy (the link was shared, so no bare 404). */
export function expiredPageHtml(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ссылка устарела — Oliveeka</title>
<style>
  :root { --bg:#fbfaf7; --fg:#222; --muted:#666; --accent:#8a6d45; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#eee; --muted:#aaa; --accent:#d2b48c; --card:#221f1b; } }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  .card { background:var(--card); border-radius:14px; padding:18px; max-width:520px; margin:0 auto; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size:22px; margin:0 0 6px; } .muted { color:var(--muted); font-size:15px; }
  .btn { display:block; text-align:center; text-decoration:none; padding:14px; border-radius:10px; margin-top:16px; font-weight:600; background:var(--accent); color:#fff; }
</style></head><body><div class="card">
<h1>Ссылка устарела</h1>
<p class="muted">Файлы этого проекта больше не хранятся. Сам проект сохранён в приложении MaxiMall: войдите под своим логином и откройте его в «Сохранениях» — или позвоните в салон, мы поможем.</p>
<a class="btn" href="tel:+375291099619">Позвонить в салон</a>
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
}): string {
  const visitDone = '<div class="ok">Заявка на визит отправлена — салон свяжется с вами по этому проекту.</div>';
  const visit = !v.shortId
    ? ''
    : !v.canRequestVisit
      ? `<div class="visit"><button class="btn alt" style="width:100%;font-size:16px" disabled>Записаться на визит в салон</button>
<p class="muted">Чтобы записаться на визит, войдите в приложение MaxiMall под своим логином и сохраните проект — так салон узнает, о каком проекте речь.</p></div>`
      : v.visitRequestedAt
        ? `<div class="visit">${visitDone}</div>`
        : `<div class="visit" id="visit">
<label class="consent"><input type="checkbox" id="consent"> ${esc(v.consentText ?? '')}</label>
<button class="btn" id="visitBtn" style="width:100%;font-size:16px;border:0" disabled>Записаться на визит в салон</button>
<div class="muted" id="visitMsg" role="status"></div>
<script>
(function(){var c=document.getElementById('consent'),b=document.getElementById('visitBtn'),m=document.getElementById('visitMsg');
c.addEventListener('change',function(){b.disabled=!c.checked;});
b.addEventListener('click',function(){if(!c.checked)return;b.disabled=true;m.textContent='Отправляю…';
fetch(location.pathname.replace(/\\/$/,'')+'/visit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({consent:true})})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
.then(function(x){if(x.ok){document.getElementById('visit').innerHTML='${visitDone.replace(/'/g, "\\'")}';}else{m.textContent=(x.j&&x.j.message)||'Не получилось отправить, попробуйте позже.';b.disabled=!c.checked;}})
.catch(function(){m.textContent='Нет связи, попробуйте позже.';b.disabled=!c.checked;});});})();
</script></div>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ваш проект ванной — Oliveeka</title>
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
<h1>Ваш проект ванной</h1>
<div class="muted">Сохранён под логином «${esc(v.username)}»${v.saveName ? ` — «${esc(v.saveName)}»` : ''}</div>
<ul>${v.sets.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<div class="total">Итого: ${byn(v.total)}</div>
${v.hasFlags ? '<div class="muted">Часть позиций — «цена уточняется».</div>' : ''}
<a class="btn" href="${esc(v.pdfUrl)}">Скачать PDF</a>
${visit}
<a class="btn alt" href="tel:+375291099619">Позвонить в салон</a>
<button class="btn alt" style="width:100%;font-size:16px" onclick="navigator.share ? navigator.share({title:'Проект ванной', url: location.href}) : navigator.clipboard.writeText(location.href)">Отправить близким</button>
<p class="muted">Чтобы снова открыть комнату, войдите в приложение MaxiMall под этим логином и выберите проект в «Сохранениях».</p>
</div></body></html>`;
}
