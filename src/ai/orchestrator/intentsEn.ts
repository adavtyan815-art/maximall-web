/**
 * v2.5: deterministic ENGLISH keyword rules — the English counterpart of intents.ts, used by the mock LLM (no keys) and by
 * the scripted fallback after an LLM timeout when the session language is English. Same output shape and the same tool
 * choices as the Russian rules; colours are passed as English names (the tools match English names and catalogue ids).
 */
import type { ParsedTurn, PlannedCall } from './intents';
import { parseRoomSizeEn } from './intents';

const lc = (s: string) => s.toLowerCase().replace(/[’`]/g, "'");

const ORDINALS: [RegExp, number][] = [
  [/\b(first|1st|one|number one|option one|#1)\b/, 1],
  [/\b(second|2nd|two|number two|option two|#2)\b/, 2],
  [/\b(third|3rd|three|number three|option three|#3)\b/, 3],
];

export function parseBudgetEn(t: string): number | undefined {
  const s = lc(t);
  const m =
    s.match(/(?:budget(?: is| of)?|up to|under|below|no more than|max(?:imum)?|within|around|about|for)\s*(?:byn\s*)?(\d[\d,]{1,8})\s*(?:byn|belarusian rubles?|rubles?|roubles?|br\b)?/) ??
    s.match(/(\d[\d,]{2,8})\s*(?:byn|belarusian rubles?|rubles?|roubles?|br\b)/);
  if (!m) {
    const k = s.match(/(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/);
    if (k) return Math.round(Number(k[1]) * 1000);
    return undefined;
  }
  const v = Number(m[1].replace(/,/g, ''));
  return v >= 100 ? v : undefined;
}

export function parseStyleEn(t: string): string | undefined {
  const s = lc(t);
  if (/\b(light|bright|airy|scandinavian|white)\b/.test(s)) return /\bwhite\b/.test(s) ? 'white' : 'light';
  if (/\b(dark|black|graphite)\b/.test(s)) return 'dark';
  if (/\b(wood|wooden|walnut|oak|natural|warm)\b/.test(s)) return 'wood';
  if (/\b(grey|gray|concrete|loft|minimal|modern)\b/.test(s)) return 'modern';
  return undefined;
}

const PAINT: [RegExp, { paintSystem: 'RAL' | 'NCS'; paintCode: string }][] = [
  [/\bwhite\b/, { paintSystem: 'RAL', paintCode: 'RAL 9010' }],
  [/\b(grey|gray)\b/, { paintSystem: 'RAL', paintCode: 'RAL 7035' }],
  [/\b(beige|sand|warm)\b/, { paintSystem: 'RAL', paintCode: 'RAL 1013' }],
  [/\b(green|olive|sage)\b/, { paintSystem: 'RAL', paintCode: 'RAL 6021' }],
  [/\b(blue|light blue)\b/, { paintSystem: 'RAL', paintCode: 'RAL 5024' }],
  [/\b(dark|graphite|anthracite)\b/, { paintSystem: 'RAL', paintCode: 'RAL 7016' }],
];
const TILES: [RegExp, string][] = [
  [/\bwhite\b/, 'Tile_White30'],
  [/\bbeige\b/, 'Tile_Beige20'],
  [/\b(sand|warm)\b/, 'Tile_Sand45'],
  [/\b(grey|gray|porcelain|stoneware|dark)\b/, 'Tile_Grey60'],
];

const COLOUR_WORDS = /\b(black mdf|black|white|beige|concrete|brown|graphite|orange|grey|gray|taupe|khaki|walnut|oak|rosewood)\b/;
const COLLECTION_WORDS = /\b(milu|urban|avenu|avenue|terra|tuma)\b/;
const COLLECTION_MAP: Record<string, string> = { milu: 'Milu', urban: 'Urban', avenu: 'Avenu', avenue: 'Avenu', terra: 'Terra', tuma: 'Tuma' };

function v24Calls(s: string, mode: 'showroom' | 'constructor'): PlannedCall | null {
  const dir = /\bleft\b/.test(s) ? 'left' : /\bright\b/.test(s) && !/\bright (now|away)\b/.test(s) ? 'right' : undefined;
  const cm = s.match(/(\d{1,3})\s*(cm|centimet)/);
  const dist = cm ? Number(cm[1]) : /\b(a little|a bit|slightly|a touch)\b/.test(s) ? 10 : undefined;
  const moveVerb = /\b(move|shift|slide|push|put it)\b/.test(s);
  const opening = /\bwindows?\b/.test(s) ? 'window' : /\bdoor\b/.test(s) && !/\bdoors\b/.test(s) && !/cabinet|vanity/.test(s) ? 'door' : undefined;
  const doors = /\b(open|close|shut)\b[^.?!]{0,30}\b(doors?|cabinet doors?)\b/.exec(s);
  const part = /\b(sinks?|basins?)\b/.test(s) ? 'sink' : /\b(faucets?|taps?|mixers?)\b/.test(s) ? 'faucet' : /\bmirrors?\b/.test(s) ? 'mirror' : /\b(countertops?|worktops?)\b/.test(s) ? 'countertop' : undefined;
  if (doors && (mode === 'showroom' || !opening)) {
    const input: Record<string, any> = { doors: /^open/.test(doors[1]) ? 'open' : 'closed' };
    if (/\b(wall cabinet|closet)\b/.test(s)) input.part = 'closet';
    return { name: mode === 'showroom' ? 'booth_configure' : 'configure_set', input };
  }
  if (part && /\b(which|what|show|options|choice|available|other|different)\b/.test(s)) return { name: 'list_options', input: { part } };
  if (mode === 'showroom') return null;
  if (opening && /\b(remove|delete|take away|get rid of)\b/.test(s)) return { name: 'remove_opening', input: { kind: opening } };
  if (opening && moveVerb && dir) return { name: 'update_opening', input: { kind: opening, direction: dir, distanceCm: dist ?? 10 } };
  if (moveVerb && dir && !opening) return { name: 'move_set', input: { direction: dir, distanceCm: dist ?? 10 } };
  if (moveVerb && !opening && /(to the edge|into the corner|to the corner|to the wall|another wall|other wall)/.test(s)) return { name: 'move_set', input: { position: /corner|edge/.test(s) ? 'start' : 'centre' } };
  return null;
}

function guards(s: string): ParsedTurn | null {
  if (/\b(discount|cheaper|bargain|haggle|deal|promo|coupon|sale|special offer|installments?|instalment)\b/.test(s)) return { calls: [], reply: 'guard_discount' };
  if (/\b(deliver|delivery|shipping|install|installation|lead time|how long|when (will|can|could)|warranty|guarantee|in stock)\b/.test(s)) return { calls: [], reply: 'guard_delivery' };
  return null;
}

/** Showroom: catalogue information and the booth in focus only (no room tools). */
export function parseShowroomEn(text: string): ParsedTurn {
  const s = lc(text).trim();
  const g = guards(s);
  if (g) return g;
  const calls: PlannedCall[] = [];
  const out: ParsedTurn = { calls, reply: 'actions' };
  if (/\b(undo|put it back|as it was|revert|change it back)\b/.test(s)) return { calls: [{ name: 'booth_undo', input: {} }], reply: 'actions' };
  const budget = parseBudgetEn(s);
  const style = parseStyleEn(s);
  const col = s.match(COLLECTION_WORDS);
  const collection = col ? COLLECTION_MAP[col[1]] : undefined;
  const verb = /\b(put|replace|change|switch|make|want|let's|paint|repaint|add|remove|without|need|in|colour|color|size|width)\b/.test(s);
  const part = /\b(wall cabinet|closet|tall cabinet)\b/.test(s) ? 'closet' : undefined;
  const paint = s.match(/(ral\s?\d{4}|(?<![a-z])s\s?\d{4}-[a-z]\d{2}[a-z]?)/i);
  const booth: Record<string, any> = {};
  if (collection && /\b(put|replace|change|switch|let's|want|instead|on the booth|here|take|choose|i'll take)\b/.test(s) && !/\b(how much|price|cost|tell me|size|dimension)\b/.test(s)) booth.collection = collection;
  if (paint) {
    const code = paint[1].toUpperCase().replace(/^RAL\s?/, 'RAL ').replace(/^S\s?/, 'S ');
    booth.paintCode = code;
    booth.paintSystem = code.startsWith('RAL') ? 'RAL' : 'NCS';
    if (part) booth.part = part;
  }
  const sizeM = s.match(/(?<![\d.,])(\d{2,3})\s*(?:cm|centimet\w*)?(?![\d.,]|\s*(?:byn|rubles?|k\b|thousand|by\s*\d))/);
  if (sizeM && /\b(make it|make|put|change|want|let's|switch|increase|decrease|set)\b/.test(s) && !s.includes('?') && !/\b(fit|fits)\b/.test(s) && budget === undefined && !paint) {
    const n = Number(sizeM[1]);
    if (n >= 40 && n <= 200) booth.sizeCm = n;
  }
  const colourM = s.match(COLOUR_WORDS);
  if (colourM && verb && !/\b(walls?|floor|tiles?)\b/.test(s) && !paint) {
    booth.colour = colourM[1];
    if (part) booth.part = part;
  }
  const addCloset = /\b(add|put|need|want|with)\b\s+(a\s+|the\s+)?(wall cabinet|closet)/.test(s);
  const removeCloset = /\b(remove|without|take away|delete|no)\b\s+(the\s+|a\s+)?(wall cabinet|closet)/.test(s);
  if (removeCloset) booth.closet = false;
  else if (addCloset && !booth.colour && !booth.paintCode) booth.closet = true;
  if (/\blighter\b/.test(s)) booth.styleHint = 'lighter';
  else if (/\bdarker\b/.test(s)) booth.styleHint = 'darker';
  const v24 = Object.keys(booth).length ? null : v24Calls(s, 'showroom');
  if (v24) calls.push(v24);
  else if (Object.keys(booth).length) calls.push({ name: 'booth_configure', input: booth });
  else if (/(what can (i|you|we) change|what (options|colours|colors|sizes) (are there|do you have)|tell me about (this|the booth|the display)|this booth|this display|this collection|about this one)/.test(s)) calls.push({ name: 'booth_get', input: {} });
  else if (/\b(suggest|recommend|show me|options|what do you have|propose|sets?)\b/.test(s) || budget !== undefined || (style && !/\b(lighter|darker)\b/.test(s))) {
    const input: Record<string, any> = {};
    if (budget !== undefined) input.budgetBYN = budget;
    if (style) input.style = style;
    if (collection) input.collection = collection;
    if (/\b(wall cabinet|closet)\b/.test(s)) input.withCloset = true;
    calls.push({ name: 'catalog_suggest', input });
  } else if (/(how much|price|cost|tell me|made of|material|size|dimension|fit|width|depth|height)/.test(s) || collection) calls.push({ name: 'catalog_lookup', input: { query: text } });
  if (calls.length) return out;
  if (/\b(photo|picture|dossier|pdf|save|send|build|room)\b/.test(s)) return { calls: [], reply: 'need_constructor' };
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(s)) return { calls: [], reply: 'greeting' };
  if (/\b(weather|joke|football|politics|exchange rate|who are you|how are you|recipe|poem)\b/.test(s)) return { calls: [], reply: 'off_topic' };
  return { calls: [], reply: 'showroom_unknown' };
}

export function parseTurnEn(text: string, mode: 'showroom' | 'constructor' = 'constructor'): ParsedTurn {
  if (mode === 'showroom') return parseShowroomEn(text);
  const s = lc(text).trim();
  const calls: PlannedCall[] = [];
  const out: ParsedTurn = { calls, reply: 'actions' };
  const g = guards(s);
  if (g) return g;
  if (/(exit|leave|close|go back|back|return)[^.?!]{0,30}(showroom|salon|constructor|planner)/.test(s) && !/(don't|do not|not)\s+(exit|leave|close|go back)/.test(s)) return { calls: [{ name: 'exit_constructor', input: {} }], reply: 'actions' };
  if (/\b(start over|start again|from scratch|reset|clear the room|empty the room)\b/.test(s)) return { calls: [{ name: 'reset_room', input: {} }], reply: 'actions' };

  const room = parseRoomSizeEn(s);
  const budget = parseBudgetEn(s);
  const style = parseStyleEn(s);
  out.budgetBYN = budget;
  out.style = style;

  if (/\b(undo|put it back|as it was|revert|not that one|cancel (that|the last))\b/.test(s)) calls.push({ name: 'undo', input: {} });

  if (room) {
    const openings: any[] = [];
    if (/\bdoor\b/.test(s)) openings.push({ kind: 'door', wallIndex: 0 });
    if (/\bwindow\b/.test(s)) openings.push({ kind: 'window', wallIndex: 2 });
    calls.push({ name: 'build_room', input: { ...room, ...(openings.length ? { openings } : {}) } });
  }

  const pickN = /\b(option|card|this one|i'll take|take|let's|choose|go with|like|put|place)\b/.test(s) ? ORDINALS.find(([re]) => re.test(s))?.[1] : undefined;
  if (pickN) calls.push({ name: 'apply_card', input: { position: pickN } });

  const wantsCloset = /\b(add|put|need|want|with)\b\s+(a\s+|the\s+)?(wall cabinet|closet)/.test(s);
  const removeCloset = /\b(remove|without|take away|delete)\b\s+(the\s+|a\s+)?(wall cabinet|closet)/.test(s);
  const lighter = /\blighter\b/.test(s);
  const darker = /\bdarker\b/.test(s);
  const wantsFinish = /(\bpaint\b|repaint|\bfinish\b|wallpaper|wall colou?r|\bwalls\b|\btiles?\b|tiling|\bfloor\b|baseboard|skirting)/.test(s) && !room;
  const wantsPhoto = /(photo|picture|snapshot|render|how (will|would) it look)/.test(s);
  const wantsOptions = /\b(suggest|recommend|show me|options|what do you have|propose|ideas|vanity|furniture)\b/.test(s) && !pickN && !wantsFinish && !wantsPhoto && !/\b(sinks?|basins?|faucets?|taps?|mixers?|mirrors?|countertops?|worktops?)\b/.test(s) && !/\b(move|shift|slide)\b/.test(s);

  if (removeCloset) calls.push({ name: 'configure_set', input: { config: { closetSizeIndex: -1 } } });
  else if (wantsCloset && !wantsOptions && !room && budget === undefined) calls.push({ name: 'configure_set', input: { config: { closetSizeIndex: 0 }, addCloset: true } });
  if (lighter || darker) calls.push({ name: 'configure_set', input: { styleHint: lighter ? 'lighter' : 'darker' } });

  if (wantsOptions || (budget !== undefined && !pickN) || (room && budget !== undefined) || (style && !lighter && !darker && !wantsFinish)) {
    const input: Record<string, any> = {};
    if (budget !== undefined) input.budgetBYN = budget;
    if (style) input.style = style;
    if (wantsCloset) input.withCloset = true;
    const col = s.match(COLLECTION_WORDS);
    if (col) input.collection = COLLECTION_MAP[col[1]];
    calls.push({ name: 'propose_sets', input });
  }

  if (wantsFinish) {
    const clauses = s.split(/,|;|\band\b|\bbut\b/);
    const wallText = clauses.filter((c) => /(wall|paint|wallpaper)/.test(c)).join(' ');
    const floorText = clauses.filter((c) => /(floor|tile|tiling)/.test(c)).join(' ');
    const baseboardText = clauses.filter((c) => /(baseboard|skirting)/.test(c)).join(' ');
    if (baseboardText) calls.push({ name: 'finish_surface', input: { target: 'baseboard', ...(PAINT.find(([re]) => re.test(baseboardText))?.[1] ?? { paintSystem: 'RAL', paintCode: 'RAL 9010' }) } });
    const wantWalls = (/(wall|paint|wallpaper)/.test(s) && !(baseboardText && !/wall/.test(s))) || (/\bfinish\b/.test(s) && !floorText);
    if (wantWalls) calls.push({ name: 'finish_surface', input: { target: 'all_walls', ...(PAINT.find(([re]) => re.test(wallText))?.[1] ?? { paintSystem: 'RAL', paintCode: 'RAL 9010' }) } });
    if (floorText) calls.push({ name: 'finish_surface', input: { target: 'floor', tileId: TILES.find(([re]) => re.test(floorText))?.[1] ?? 'Tile_Grey60' } });
  }

  if (wantsPhoto) calls.push({ name: 'take_photo', input: { preset: 'corner' } });
  if (/\b(send|email|dossier|pdf|save|qr)\b/.test(s)) calls.push({ name: 'save_project', input: {} });
  if (/\b(how much|price|cost)\b/.test(s) && calls.length === 0) calls.push({ name: 'catalog_lookup', input: { query: text } });

  if (calls.length === 0) {
    const v24 = v24Calls(s, 'constructor');
    if (v24) calls.push(v24);
  }
  if (calls.length > 0) return out;
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(s)) return { calls: [], reply: 'greeting' };
  if (/\b(weather|joke|football|politics|exchange rate|who are you|how are you|recipe|poem)\b/.test(s)) return { calls: [], reply: 'off_topic' };
  if (/\b(bathroom|room|toilet)\b/.test(s)) return { calls: [], reply: 'ask_room' };
  return { calls: [], reply: 'unknown' };
}
