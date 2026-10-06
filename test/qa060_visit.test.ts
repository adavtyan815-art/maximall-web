import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { DossierService, VISIT_CONSENT_RU } from '../src/ai/dossier/service';
import { buildReport } from '../src/ai/analytics/report';

/** QA-060: «Записаться на визит в салон» on /d/:shortId — consent required, recorded on the existing lead, guests need a login. */
const f = fixtureIndex();

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-'));
  const svc = new DossierService(() => f.catalog, path.join(tmp, 'saves'), path.join(tmp, 'renders'), () => 'https://expo.example', path.join(tmp, 'dossiers'));
  const base = { sessionId: 's', saveId: 'save-1', renderIds: [], createdAt: '2026-10-01T05:00:00.000Z', total: 3127, sets: ['Milu 80, белый — 3127 BYN'], hasFlags: false };
  const recs = [
    { ...base, dossierId: 'd-' + 'a'.repeat(32), shortId: 'AnnaShort123', username: 'anna', lead: true },
    { ...base, dossierId: 'd-' + 'b'.repeat(32), shortId: 'GuestShort12', username: 'guest_tester', lead: false },
  ];
  fs.writeFileSync(path.join(svc.dir, 'index.json'), JSON.stringify(recs));
  for (const r of recs) fs.writeFileSync(path.join(svc.dir, `${r.dossierId}.pdf`), '%PDF-1.4'); // not expired (QA-058)
  fs.writeFileSync(path.join(svc.dir, 'leads.jsonl'), JSON.stringify({ ts: base.createdAt, username: 'anna', saveId: 'save-1', dossierId: recs[0].dossierId }) + '\n');
  return { svc, tmp };
}

describe('QA-060 visit request on the short page', () => {
  it('a named lead: consent checkbox + disabled button; the inline script parses; «Позвонить» and the reopen hint stay', () => {
    const { svc } = setup();
    const html = svc.shortPage('AnnaShort123')!;
    expect(html).toContain('Записаться на визит в салон');
    expect(html).toContain(VISIT_CONSENT_RU);
    expect(html).toMatch(/<input type="checkbox" id="consent">/);
    expect(html).toMatch(/id="visitBtn"[^>]*disabled/);
    expect(html).toContain('Позвонить в салон');
    expect(html).toContain('Чтобы снова открыть комнату');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it('consent is required; the request is recorded once on the lead file; the page then shows the confirmation', () => {
    const { svc } = setup();
    expect(svc.requestVisit('AnnaShort123', false)).toMatchObject({ ok: false, status: 400, code: 'CONSENT_REQUIRED' });
    expect(svc.requestVisit('AnnaShort123', 'true')).toMatchObject({ ok: false, status: 400 });
    const r = svc.requestVisit('AnnaShort123', true);
    expect(r).toMatchObject({ ok: true, already: false });
    expect(svc.requestVisit('AnnaShort123', true)).toMatchObject({ ok: true, already: true });
    const lines = fs.readFileSync(path.join(svc.dir, 'leads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const visits = lines.filter((l) => l.type === 'visit_request');
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ type: 'visit_request', username: 'anna', dossierId: 'd-' + 'a'.repeat(32), saveId: 'save-1', consent: true, consentText: VISIT_CONSENT_RU });
    expect(Object.keys(visits[0]).sort()).toEqual(['consent', 'consentText', 'dossierId', 'saveId', 'ts', 'type', 'username']); // no new personal data
    expect(svc.shortPage('AnnaShort123')).toContain('Заявка на визит отправлена');
    expect(svc.shortPage('AnnaShort123')).not.toContain('id="visitBtn"');
    // the post-Expo report counts it separately, not as another lead
    const rep = buildReport(path.join(svc.dir, 'nologs'), { leadsFile: path.join(svc.dir, 'leads.jsonl') });
    expect(rep.totals.leads).toBe(1);
    expect(rep.totals.visitRequests).toBe(1);
  });

  it('a guest: the button explains that a login is needed and nothing is recorded', () => {
    const { svc } = setup();
    const html = svc.shortPage('GuestShort12')!;
    expect(html).toMatch(/войдите в приложение MaxiMall под своим логином/);
    expect(html).not.toContain('id="consent"');
    expect(svc.requestVisit('GuestShort12', true)).toMatchObject({ ok: false, status: 403, code: 'LOGIN_REQUIRED' });
    expect(svc.requestVisit('nope', true)).toMatchObject({ ok: false, status: 404 });
    expect(fs.readFileSync(path.join(svc.dir, 'leads.jsonl'), 'utf8')).not.toContain('visit_request');
  });
});
