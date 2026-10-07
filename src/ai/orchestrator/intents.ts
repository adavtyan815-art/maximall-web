/**
 * Deterministic Russian keyword rules. Used by the mock LLM (no keys) and by the scripted fallback after an LLM timeout.
 * Output: an ordered list of intended tool calls (name + input) and a reply kind.
 */
export interface PlannedCall {
  name: string;
  input: Record<string, any>;
}
export type ReplyKind =
  | 'greeting'
  | 'guard_discount'
  | 'guard_delivery'
  | 'off_topic'
  | 'ask_room'
  | 'ask_budget'
  | 'actions'
  | 'unknown'
  | 'showroom_unknown'
  | 'need_constructor';

export interface ParsedTurn {
  calls: PlannedCall[];
  reply: ReplyKind;
  budgetBYN?: number;
  style?: string;
}

const lc = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

const ORDINALS: [RegExp, number][] = [
  [/(?<![а-яa-z0-9])(перв[а-я]*|1-?[йы][а-я]*|один)(?![а-яa-z0-9])/, 1],
  [/(?<![а-яa-z0-9])(втор[а-я]*|2-?[йо][а-я]*|два)(?![а-яa-z0-9])/, 2],
  [/(?<![а-яa-z0-9])(трет[а-я]*|3-?[ий][а-я]*|три)(?![а-яa-z0-9])/, 3],
];

function num(s: string) {
  return Number(s.replace(/\s/g, '').replace(',', '.'));
}

/** "2 на 3", "2,5 x 1,8 м", "250 на 180 см", "два на три метра" */
export function parseRoomSize(t: string, lang: 'ru' | 'en' = 'ru'): { widthCm: number; depthCm: number } | null {
  if (lang === 'en') {
    const en = parseRoomSizeEn(t);
    if (en) return en;
  }
  const words: Record<string, number> = { 'полтора': 1.5, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6 };
  let s = lc(t);
  for (const [w, v] of Object.entries(words)) s = s.replace(new RegExp(`(^|\\s)${w}(?=\\s|$)`, 'g'), `$1${v}`);
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:м\.?|метр[а-я]*|см|сантиметр[а-я]*)?\s*(?:на|x|х|×|\*)\s*(\d+(?:[.,]\d+)?)\s*(м(?![а-я])|метр[а-я]*|см|сантиметр[а-я]*)?/);
  if (!m) return null;
  let a = num(m[1]);
  let b = num(m[2]);
  const unitCm = /см|сантим/.test(m[3] ?? '') || (a > 30 && b > 30);
  if (!unitCm) {
    a *= 100;
    b *= 100;
  }
  if (a < 120 || b < 120 || a > 1200 || b > 1200) return null;
  return { widthCm: Math.round(a), depthCm: Math.round(b) };
}

/** v2.5: «2 by 2.5 metres», «2 x 2.5 m», «200 by 250 cm», «two by three meters», «2.5m x 1.8m». */
export function parseRoomSizeEn(t: string): { widthCm: number; depthCm: number } | null {
  const words: Record<string, number> = { 'one and a half': 1.5, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6 };
  let s = t.toLowerCase();
  for (const [w, v] of Object.entries(words)) s = s.replace(new RegExp(`(^|\\s)${w}(?=\\s|$)`, 'g'), `$1${v}`);
  s = s.replace(/(\d+) and a half/g, (_m, d: string) => `${d}.5`); // «two and a half» -> 2.5
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:m\b|metres?|meters?|cm\b|centimet(?:re|er)s?)?\s*(?:by|x|×|\*)\s*(\d+(?:\.\d+)?)\s*(m\b|metres?|meters?|cm\b|centimet(?:re|er)s?)?/);
  if (!m) return null;
  let a = Number(m[1]);
  let b = Number(m[2]);
  const unitCm = /cm|centi/.test(m[3] ?? '') || (a > 30 && b > 30);
  if (!unitCm) {
    a *= 100;
    b *= 100;
  }
  if (a < 120 || b < 120 || a > 1200 || b > 1200) return null;
  return { widthCm: Math.round(a), depthCm: Math.round(b) };
}

export function parseBudget(t: string): number | undefined {
  const s = lc(t);
  const m =
    s.match(/(?:бюджет[а-я]*|(?<![а-я])до|не больше|максимум|в пределах|около|примерно|(?<![а-я])за)\s*(\d[\d\s]{1,7})\s*(?:byn|бел[а-я]*|руб[а-я]*|р(?![а-я])|br(?![a-z]))?/) ??
    s.match(/(\d[\d\s]{2,7})\s*(?:byn|бел[а-я]*\s*руб[а-я]*|руб[а-я]*|р\.|br(?![a-z]))/);
  if (!m) {
    const k = s.match(/(\d+(?:[.,]\d+)?)\s*(?:тыс[а-я]*|к(?![а-я]))/);
    if (k) return Math.round(num(k[1]) * 1000);
    return undefined;
  }
  const v = num(m[1]);
  return v >= 100 ? v : undefined;
}

export function parseStyle(t: string): string | undefined {
  const s = lc(t);
  if (/светл|(?<![а-я])бел|воздушн|скандинав/.test(s)) return /(?<![а-я])бел/.test(s) ? 'white' : 'light';
  if (/темн|черн|графит/.test(s)) return 'dark';
  if (/дерев|орех|дуб|натурал|тепл/.test(s)) return 'wood';
  if (/сер|бетон|лофт|минимал|современ/.test(s)) return 'modern';
  return undefined;
}

const PAINT: [RegExp, { paintSystem: 'RAL' | 'NCS'; paintCode: string }][] = [
  [/(?<![а-я])бел/, { paintSystem: 'RAL', paintCode: 'RAL 9010' }],
  [/сер/, { paintSystem: 'RAL', paintCode: 'RAL 7035' }],
  [/беж|песоч|тепл/, { paintSystem: 'RAL', paintCode: 'RAL 1013' }],
  [/зелен|олив|шалфе/, { paintSystem: 'RAL', paintCode: 'RAL 6021' }],
  [/голуб|син/, { paintSystem: 'RAL', paintCode: 'RAL 5024' }],
  [/темн|графит|антрацит/, { paintSystem: 'RAL', paintCode: 'RAL 7016' }],
];

/** DT_PlannerTiles row ids (UE export 2026-09-30). */
const TILES: [RegExp, string][] = [
  [/(?<![а-я])бел/, 'Tile_White30'],
  [/беж/, 'Tile_Beige20'],
  [/песоч|тепл/, 'Tile_Sand45'],
  [/сер|керамогранит|темн/, 'Tile_Grey60'],
];

/** Colour words of the five collections (DT_FurnitureCatalog, Russian names). */
const COLOUR_WORDS = /(бел[а-я]*|черн[а-я]*|бежев[а-я]*|бетон[а-я]*|браун|графит[а-я]*|оранжев[а-я]*|сер[ыо][а-я]*|тауп|хаки|орех[а-я]*|дуб[а-я]*|палисандр[а-я]*)/;
const COLLECTION_WORDS = /(?<![а-яa-z])(milu|urban|avenu|terra|tuma|милу|урбан|авеню|терра|тума)(?![а-яa-z])/;
const COLLECTION_MAP: Record<string, string> = { милу: 'Milu', урбан: 'Urban', авеню: 'Avenu', терра: 'Terra', тума: 'Tuma', milu: 'Milu', urban: 'Urban', avenu: 'Avenu', terra: 'Terra', tuma: 'Tuma' };

/**
 * v2.4 (Phase 4) scripted policy for the new manual actions (mock / LLM-timeout fallback only; the live model decides itself):
 * shifting the set or a door/window, removing an opening, doors of the cabinet, listing a part's options. Runs only when no
 * older rule produced a call, so the existing phrase behaviour is unchanged.
 */
function v24Calls(s: string, mode: 'showroom' | 'constructor'): PlannedCall | null {
  const dir = /(лев|влево)/.test(s) ? 'left' : /(прав|вправо)/.test(s) ? 'right' : undefined;
  const cm = s.match(/(\d{1,3})\s*(см|сантиметр)/);
  const dist = cm ? Number(cm[1]) : /(чуть|немного|слегка)/.test(s) ? 10 : undefined;
  const moveVerb = /(сдвин|подвин|передвин|перенес|перемест|отодвин|двинь)/.test(s);
  const opening = /окн|окошк/.test(s) ? 'window' : /двер(?!ц)/.test(s) ? 'door' : undefined;
  const doors = /(откр[а-я]*|закр[а-я]*)\s+([а-я«»]+\s+){0,2}(дверц|створк|дверк|двер[иьяе])/.exec(s);
  const part = /раковин/.test(s) ? 'sink' : /смесител|кран(?![а-я])/.test(s) ? 'faucet' : /зеркал/.test(s) ? 'mirror' : /столешниц/.test(s) ? 'countertop' : undefined;
  if (doors) {
    const input: Record<string, any> = { doors: /^откр/.test(doors[1]) ? 'open' : 'closed' };
    if (/(шкаф|пенал)/.test(s)) input.part = 'closet';
    return { name: mode === 'showroom' ? 'booth_configure' : 'configure_set', input };
  }
  if (part && /(какие|покажи|варианты|выбор|есть ли|что есть|другие)/.test(s)) return { name: 'list_options', input: { part } };
  if (mode === 'showroom') return null;
  if (opening && /(убер|убрать|удал)/.test(s)) return { name: 'remove_opening', input: { kind: opening } };
  if (opening && moveVerb && dir) return { name: 'update_opening', input: { kind: opening, direction: dir, distanceCm: dist ?? 10 } };
  if (moveVerb && dir && !opening) return { name: 'move_set', input: { direction: dir, distanceCm: dist ?? 10 } };
  if (moveVerb && !opening && /(к краю|в угол|к стене|на другую стену)/.test(s)) return { name: 'move_set', input: { position: /в угол|к краю/.test(s) ? 'start' : 'centre' } };
  return null;
}

function guards(s: string): ParsedTurn | null {
  // Guardrails first: haggling, discounts, delivery dates -> no tool, fixed policy reply.
  if (/скидк|скинете|скиньте(?! мне)|скинь(?! мне)|дешевле отда|поторг|торгу|уступ|акци|промокод|рассрочк/.test(s)) return { calls: [], reply: 'guard_discount' };
  // QA-012: delivery, installation, lead times and warranty terms -> honest hand-off to the salon manager.
  if (/достав|привез|монтаж|установк|установите|срок|гаранти|в наличии|когда (будет|сможете|привез|получ)/.test(s)) return { calls: [], reply: 'guard_delivery' };
  return null;
}

/**
 * v2.0 showroom policy: catalogue information and the salon booth in focus only (no room tools). Dimensions / fitting
 * topics are answered by the orchestrator with ONE constructor offer per topic before this policy runs.
 */
export function parseShowroom(text: string): ParsedTurn {
  const s = lc(text).trim();
  const g = guards(s);
  if (g) return g;
  const calls: PlannedCall[] = [];
  const out: ParsedTurn = { calls, reply: 'actions' };
  if (/(верни как было|верни обратно|верни(те)? назад|как было|отмени)/.test(s)) return { calls: [{ name: 'booth_undo', input: {} }], reply: 'actions' };
  const budget = parseBudget(s);
  const style = parseStyle(s);
  const col = s.match(COLLECTION_WORDS);
  const collection = col ? COLLECTION_MAP[col[1]] : undefined;
  const verb = /(постав|замени|поменя|смени|сделай|сделать|хочу|давай|покрас|перекрас|добав|убер|убрать|без|нужн|в цвет|цвет|размер|ширин)/.test(s);
  const part = /(пенал|навесн|шкаф)/.test(s) ? 'closet' : undefined;
  const paint = s.match(/(ral\s?\d{4}|(?<![a-z])s\s?\d{4}-[a-z]\d{2}[a-z]?)/i);
  const booth: Record<string, any> = {};
  if (collection && /(постав|замен|поменя|смен|давай|хочу|вместо|на стенд|сюда|переставь|выбира|беру|возьм)/.test(s) && !/(сколько|цен|стоит|почем|расскаж|размер|габарит)/.test(s)) booth.collection = collection;
  if (paint) {
    const code = paint[1].toUpperCase().replace(/^RAL\s?/, 'RAL ').replace(/^S\s?/, 'S ');
    booth.paintCode = code;
    booth.paintSystem = code.startsWith('RAL') ? 'RAL' : 'NCS';
    if (part) booth.part = part;
  }
  const sizeM = s.match(/(?<![\d.,])(\d{2,3})\s*(?:см|сантиметр[а-я]*)?(?![\d.,]|\s*(?:byn|руб|бел|р\.|тыс|на\s*\d))/);
  // QA-080: a size number changes the booth only with an explicit imperative, never inside a question
  if (sizeM && /(сделай|сделайте|постав|поменя|хочу|давай|переставь|увелич|уменьш)/.test(s) && !s.includes('?') && !/(помест|влез|подойд|впиш)/.test(s) && budget === undefined && !paint) {
    const n = Number(sizeM[1]);
    if (n >= 40 && n <= 200) booth.sizeCm = n;
  }
  const colourM = s.match(COLOUR_WORDS);
  if (colourM && verb && !/(стен|пол(?![а-я])|плитк)/.test(s) && !paint) {
    booth.colour = colourM[1];
    if (part) booth.part = part;
  }
  const addCloset = /(добав[а-я]*|постав[а-я]*|нуж[а-я]*|хочу|(?<![а-я])с)\s+([а-я]+\s+)?(пенал|навесн[а-я]* шкаф|шкаф[а-я]*)/.test(s);
  const removeCloset = /(убер[а-я]*|убрать|без|удал[а-я]*)\s+([а-я]+\s+)?(пенал|навесн[а-я]* шкаф|шкаф[а-я]*)/.test(s);
  if (removeCloset) booth.closet = false;
  else if (addCloset && !booth.colour && !booth.paintCode) booth.closet = true;
  if (/светле|посветле/.test(s)) booth.styleHint = 'lighter';
  else if (/темне|потемне/.test(s)) booth.styleHint = 'darker';
  const v24 = Object.keys(booth).length ? null : v24Calls(s, 'showroom');
  if (v24) calls.push(v24);
  else if (Object.keys(booth).length) calls.push({ name: 'booth_configure', input: booth });
  else if (/(что (можно )?(поменять|изменить|настроить)|какие (есть )?(вариант|цвет|размер|опци)|расскажи(те)? (про |об )?(эт|стенд)|этот стенд|эта коллекц|об этой)/.test(s)) calls.push({ name: 'booth_get', input: {} });
  else if (/(подбер|предлож|покажи|вариант|что есть|посоветуй|комплект)/.test(s) || budget !== undefined || (style && !/(светле|темне)/.test(s))) {
    const input: Record<string, any> = {};
    if (budget !== undefined) input.budgetBYN = budget;
    if (style) input.style = style;
    if (collection) input.collection = collection;
    if (/(пенал|навесн|шкаф)/.test(s)) input.withCloset = true;
    calls.push({ name: 'catalog_suggest', input });
  } else if (/(сколько ([а-я]+ )?стои|цена|почем|стоимост|расскаж|из чего|материал|размер|габарит|влез|помест|подойд|ширин|глубин|высот)/.test(s) || collection) calls.push({ name: 'catalog_lookup', input: { query: text } });
  if (calls.length) return out;
  if (/(фото|сфотограф|снимок|досье|pdf|пдф|сохрани|отправ|пришли|построй|комнат)/.test(s)) return { calls: [], reply: 'need_constructor' };
  if (/^(привет|здравств|добрый|доброе|хай|алло)/.test(s)) return { calls: [], reply: 'greeting' };
  if (/(погод|анекдот|футбол|политик|курс валют|кто ты|как дела|рецепт|стих)/.test(s)) return { calls: [], reply: 'off_topic' };
  return { calls: [], reply: 'showroom_unknown' };
}

export function parseTurn(text: string, mode: 'showroom' | 'constructor' = 'constructor'): ParsedTurn {
  if (mode === 'showroom') return parseShowroom(text);
  const s = lc(text).trim();
  const calls: PlannedCall[] = [];
  const out: ParsedTurn = { calls, reply: 'actions' };
  const g = guards(s);
  if (g) return g;
  // v2.0: back to the salon
  if (/(выйд|выйт|выход|закрой|закройте|закрыть|вернем|вернит|вернись|вернуться|обратно|назад)[^.?!]{0,30}(салон|конструктор)/.test(s) && !/(^|[^а-я])не\s+(выход|выйд|закры)/.test(s)) return { calls: [{ name: 'exit_constructor', input: {} }], reply: 'actions' };
  // QA-012: start over
  if (/(начн[её]м|начать|давай(те)?)\s+(сначала|с начала|заново)|^(сначала|с начала|заново)(?![а-я])|сбрось|сброс(ить)?(?![а-я])|очисти(ть)? комнату/.test(s)) return { calls: [{ name: 'reset_room', input: {} }], reply: 'actions' };

  const room = parseRoomSize(s);
  const budget = parseBudget(s);
  const style = parseStyle(s);
  out.budgetBYN = budget;
  out.style = style;

  if (/отмен|верни как было|верни обратно|назад|не то(?![а-я])/.test(s)) calls.push({ name: 'undo', input: {} });

  if (room) {
    const openings: any[] = [];
    if (/двер/.test(s)) openings.push({ kind: 'door', wallIndex: 0 });
    if (/окн/.test(s)) openings.push({ kind: 'window', wallIndex: 2 });
    calls.push({ name: 'build_room', input: { ...room, ...(openings.length ? { openings } : {}) } });
  }

  const pickN = /(вариант|карточк|этот|беру|давай|возьм|выбира|нрав|ставь|поставь)/.test(s) ? ORDINALS.find(([re]) => re.test(s))?.[1] : undefined;
  if (pickN) calls.push({ name: 'apply_card', input: { position: pickN } });

  const wantsCloset = /(добав[а-я]*|постав[а-я]*|нуж[а-я]*|хочу|(?<![а-я])с)\s+([а-я]+\s+)?(пенал|навесн[а-я]* шкаф|шкаф[а-я]*)/.test(s);
  const removeCloset = /(убер[а-я]*|без|удал[а-я]*)\s+([а-я]+\s+)?(пенал|шкаф[а-я]*)/.test(s);
  const lighter = /светле|посветле|светлее/.test(s);
  const darker = /темне|потемне/.test(s);

  // QA-011: finishes only on an explicit request (never because the visitor said «дверь на короткой стене»).
  const wantsFinish = /(покрас|перекрас|краск|отделк|обои|цвет стен|стены (в|сделай|покрась)|сделай стены|плитк|кафел|пол (сделай|в |плитк)|(бел|сер|беж|зелен|голуб|син|темн|песоч|светл)[а-я]*\s+(стен|пол(?![а-я])))/.test(s);
  const wantsPhoto = /(фото|сфотограф|снимок|сними|рендер|картинк|как (это )?будет выглядеть)/.test(s);
  const wantsOptions = /(предлож|подбер|покажи|вариант|что есть|что посовет|посоветуй|подойдет|идеи|хочу тумбу|нужна тумба|мебель)/.test(s) && !pickN && !wantsFinish && !wantsPhoto && !/(раковин|смесител|зеркал|столешниц)/.test(s); // v2.4: a part's options = list_options
  const hasSet = true; // resolved by the orchestrator (no set -> configure falls back to propose)

  if (removeCloset) calls.push({ name: 'configure_set', input: { config: { closetSizeIndex: -1 } } });
  else if (wantsCloset && !wantsOptions && !room && budget === undefined) calls.push({ name: 'configure_set', input: { config: { closetSizeIndex: 0 }, addCloset: true } });
  if (lighter || darker) calls.push({ name: 'configure_set', input: { styleHint: lighter ? 'lighter' : 'darker' } });

  if (wantsOptions || (budget !== undefined && !pickN) || (room && budget !== undefined) || (style && !lighter && !darker && !wantsFinish)) {
    const input: Record<string, any> = {};
    if (budget !== undefined) input.budgetBYN = budget;
    if (style) input.style = style;
    if (wantsCloset) input.withCloset = true;
    const col = s.match(/(?<![а-яa-z])(milu|urban|avenu|terra|tuma|милу|урбан|авеню|терра|тума)(?![а-яa-z])/);
    if (col) {
      const map: Record<string, string> = { милу: 'Milu', урбан: 'Urban', авеню: 'Avenu', терра: 'Terra', тума: 'Tuma' };
      input.collection = map[col[1]] ?? col[1][0].toUpperCase() + col[1].slice(1);
    }
    calls.push({ name: 'propose_sets', input });
  }

  if (wantsFinish) {
    // Split into clauses so «белые стены и серый пол» paints walls white and tiles the floor grey.
    const clauses = s.split(/,|;|(?<![а-я])и(?![а-я])|(?<![а-я])а(?![а-я])/);
    const wallText = clauses.filter((c) => /стен|покрас|краск|обои/.test(c)).join(' ');
    const floorText = clauses.filter((c) => /(?<![а-я])пол|плитк|кафел/.test(c)).join(' ');
    // v2.4: «покрась плинтус …» paints the baseboard, not the walls
    const baseboardText = clauses.filter((c) => /плинтус/.test(c)).join(' ');
    if (baseboardText) {
      const p = PAINT.find(([re]) => re.test(baseboardText))?.[1] ?? { paintSystem: 'RAL' as const, paintCode: 'RAL 9010' };
      calls.push({ name: 'finish_surface', input: { target: 'baseboard', ...p } });
    }
    const wantWalls = (/стен|покрас|краск|обои/.test(s) && !(baseboardText && !/стен/.test(s))) || (/отделк/.test(s) && !floorText);
    const wantFloor = !!floorText;
    if (wantWalls) {
      const p = PAINT.find(([re]) => re.test(wallText))?.[1] ?? { paintSystem: 'RAL' as const, paintCode: 'RAL 9010' };
      calls.push({ name: 'finish_surface', input: { target: 'all_walls', ...p } });
    }
    if (wantFloor) {
      const t = TILES.find(([re]) => re.test(floorText))?.[1] ?? 'Tile_Grey60';
      calls.push({ name: 'finish_surface', input: { target: 'floor', tileId: t } });
    }
  }

  if (wantsPhoto) calls.push({ name: 'take_photo', input: { preset: 'corner' } });
  if (/(отправ|пришли|скинь мне|досье|pdf|пдф|сохрани|забрать|qr|куар)/.test(s)) calls.push({ name: 'save_project', input: {} });
  if (/(сколько стоит|цена|почем|стоимост)/.test(s) && calls.length === 0) calls.push({ name: 'catalog_lookup', input: { query: text } });

  if (calls.length === 0) {
    const v24 = v24Calls(s, 'constructor');
    if (v24) calls.push(v24);
  }
  if (calls.length > 0) return out;
  if (/^(привет|здравств|добрый|доброе|хай|алло)/.test(s)) return { calls: [], reply: 'greeting' };
  if (/(погод|анекдот|футбол|политик|курс валют|кто ты|как дела|рецепт|стих)/.test(s)) return { calls: [], reply: 'off_topic' };
  if (/ванн|санузел|комнат/.test(s)) return { calls: [], reply: 'ask_room' };
  void hasSet;
  return { calls: [], reply: 'unknown' };
}
