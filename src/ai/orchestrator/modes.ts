/**
 * Contracts v2.0 (PHASE 2): two consultant modes, consent to move into «Конструктор», booth dialogue phrases.
 * Pure helpers (no I/O); the orchestrator owns the state.
 */
export type Mode = 'showroom' | 'constructor';

/** UE room / planner commands: never sent in showroom (UE would refuse NOT_IN_PLANNER). */
export const ROOM_COMMANDS = new Set([
  'build_room',
  'add_opening',
  'check_fit',
  'apply_config',
  'configure_set',
  'swap_set',
  'remove_set',
  'finish_surface',
  'undo',
  'reset',
  'save_project',
  'capture',
  // v2.4
  'move_set',
  'update_opening',
  'remove_opening',
]);

/** Tools per mode (the LLM only sees these; runTool refuses the rest). */
export const SHOWROOM_TOOLS = new Set(['catalog_lookup', 'catalog_suggest', 'booth_get', 'booth_configure', 'booth_undo', 'offer_constructor', 'take_photo', 'list_options']);
export const CONSTRUCTOR_TOOLS = new Set([
  'get_state',
  'build_room',
  'propose_sets',
  'apply_card',
  'configure_set',
  'swap_set',
  'remove_set',
  'finish_surface',
  'check_fit',
  'undo',
  'reset_room',
  'save_project',
  'take_photo',
  'catalog_lookup',
  'booth_get',
  'booth_configure',
  'booth_undo',
  'exit_constructor',
  // v2.4 (Phase 4)
  'list_options',
  'move_set',
  'add_opening',
  'update_opening',
  'remove_opening',
]);
export const toolsAllowed = (mode: Mode) => (mode === 'showroom' ? SHOWROOM_TOOLS : CONSTRUCTOR_TOOLS);

/** Artur's wording: «эту модель» only when a specific model is the topic. */
export const OFFER_CONSTRUCTOR_RU = 'Могу показать в реальных размерах в комнате нашего Конструктора. Перейдём?';
export const OFFER_CONSTRUCTOR_MODEL_RU = 'Могу показать эту модель в реальных размерах в комнате нашего Конструктора. Перейдём?';
export const OFFER_CONSTRUCTOR_OPTIONS = [
  { id: 'yes', label: 'Да, перейти' },
  { id: 'no', label: 'Нет, остаться' },
];
export const STAY_RU = 'Хорошо, остаёмся в салоне. Спрашивайте о любой коллекции или стенде.';
export const NO_BOOTH_RU = 'Подойдите к любому стенду салона или откройте его настройки — и я расскажу о нём. Или спросите о каталоге в целом: цены, размеры, материалы.';

export const scopeQuestionRu = (collection: string) => `Обсудим эту коллекцию (${collection}) или посмотрим другие?`;
export const scopeOptions = (collection: string) => [
  { id: 'this', label: `Эту коллекцию (${collection})` },
  { id: 'other', label: 'Другие коллекции' },
];
export const pickQuestionRu = (collection: string) => `Какую коллекцию поставить вместо ${collection}?`;

export const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е').trim();

/** Dimensions / fitting / «в моей ванной» / room / layout: the constructor topic. */
export function isFitTopic(text: string): boolean {
  const s = norm(text);
  return /(размер|габарит|влез|помест|впиш|войдет|встанет|в мо(ей|ю) ванн|моя ванн|у меня ванн|у меня (в )?санузел|моей комнат|комнат|планировк|расстанов|сколько места|по ширине|в реальн[а-я]* размер|примерить|как (это )?будет (смотреться|выглядеть) у меня|(\d+(?:[.,]\d+)?)\s*(?:м|см|метр[а-я]*)?\s*(?:на|x|х|×)\s*\d)/.test(s);
}

/** The visitor asks to go into the constructor (still answered with an offer: consent is a yes to the offer). */
export function asksForConstructor(text: string): boolean {
  const s = norm(text);
  return /(конструктор|построй (мне )?комнату|покажи (это |е[её] |его )?в комнате|перейти в комнат|хочу в комнату|открой комнату|в реальн[а-я]* размер)/.test(s);
}

const YES_CORE = new Set(['да', 'давай', 'давайте', 'покажи', 'покажите', 'переходим', 'перейдем', 'перейти', 'хочу', 'конечно']);
const YES_FILLER = new Set(['да', 'давай', 'давайте', 'покажи', 'покажите', 'переходим', 'перейдем', 'перейти', 'хочу', 'конечно', 'в', 'комнату', 'комнате', 'конструктор', 'конструкторе', 'пожалуйста', 'туда', 'сейчас', 'можно']);

/**
 * QA pointer 1: the visitor's own explicit request to go into the Constructor is consent (no re-offer):
 * «Давайте всё-таки перейдём в конструктор», «Хочу в конструктор», «Открой конструктор». A question about it or a hedge is not.
 */
export function isExplicitConstructorRequest(text: string): boolean {
  const s = norm(text);
  if (!/конструктор/.test(s)) return false;
  if (/(^|[^а-я])(не|нет|потом|позже|может|наверное|подума|что так|что за|зачем|а что)([^а-я]|$)/.test(s)) return false;
  if (s.includes('?') && !/^(можно|давай|давайте)/.test(s)) return false;
  return /(перейд|переход|перейти|пойд|пошли|идем|хочу|давай|открой|откройте|включи|веди|ведите|перемест|отправ|в конструктор)/.test(s);
}

/** An unambiguous verbal yes (only the very next visitor turn after the offer counts). */
export function isVerbalYes(text: string): boolean {
  const s = norm(text);
  if (!s || s.includes('?')) return false;
  if (/(^|[^а-я])(не|нет|может|наверное|потом|позже|подума|если|но)([^а-я]|$)/.test(s)) return false;
  const words = s.replace(/[.,!…:;"«»()-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  return words.some((w) => YES_CORE.has(w)) && words.every((w) => YES_FILLER.has(w));
}

/** An explicit no (gets a short «остаёмся» answer); anything not a yes is a no anyway. */
export function isVerbalNo(text: string): boolean {
  const s = norm(text).replace(/[.,!…]+/g, ' ').trim();
  return /^(нет|не надо|не нужно|не хочу|не сейчас|остаемся|останемся|остаться|нет,? спасибо|нет спасибо|потом|позже)(\s|$)/.test(s);
}

/** Answer to «эту коллекцию или другие?» (verbal). */
export function boothScopeAnswer(text: string): 'this' | 'other' | null {
  const s = norm(text);
  // only a short answer to the question (a fitting / price question about «эта тумба» is not an answer)
  if (isFitTopic(text) || s.includes('?')) return null;
  if (s.replace(/[.,!…]+/g, ' ').split(/\s+/).filter(Boolean).length > 5 && !/(эту коллекц|други[ея] коллекц)/.test(s)) return null;
  if (/(друг(ие|ую|ая|ой)|ин(ую|ые|ой)|не эту|не эта|что[- ]нибудь друг|смен(и|ить) коллекц|замен)/.test(s)) return 'other';
  if (/(^|[^а-я])(эту|эта|этой|ее|ее же|давай(те)? эту|обсудим|эту коллекц|про нее|она|да)([^а-я]|$)/.test(s)) return 'this';
  return null;
}

const COLLECTIONS: [RegExp, string][] = [
  [/(milu|милу)/, 'Milu'],
  [/(urban|урбан)/, 'Urban'],
  [/(avenu|авеню|авеню)/, 'Avenu'],
  [/(terra|терра|тера)/, 'Terra'],
  [/(tuma|тума)/, 'Tuma'],
];
export function collectionFromText(text: string): string | undefined {
  const s = norm(text);
  return COLLECTIONS.find(([re]) => re.test(s))?.[1];
}

/**
 * WEB integration finding: «Посмотрим другие коллекции», «Поставьте другую», «Другую коллекцию сюда», the chip «Покажи другие
 * коллекции» -> another collection on the booth in focus (any time, not only as the answer to the scope question).
 */
export function wantsOtherCollection(text: string): boolean {
  const s = norm(text);
  if (collectionFromText(text)) return false; // a named collection switches directly
  return /(друг(ие|ую|ая|ой|их|ое)|ин(ую|ые|ой|ое))\s+(коллекц|модел|тумб|вариант|комплект)|(постав|замен|смен|покаж|посмотр|давай|хочу|можно)[а-я]*\s+(на\s+|сюда\s+)?(друг|ин)(ие|ую|ая|ой|их|ое|ые)(?![а-я])|друг[а-я]* сюда|не эту коллекц/.test(s);
}

/** QA-077: leave «Конструктор» (constructor mode): «Выйдите, пожалуйста, из конструктора», «закрой конструктор», «вернёмся в салон», «хочу обратно в салон». */
export function isExitRequest(text: string): boolean {
  const s = norm(text);
  if (/(^|[^а-я])(не|нет)\s+(выход|выйд|закры|возвращ)/.test(s)) return false;
  if (/(выйд|выйт|выход|закрой|закройте|закрыть|вернем|вернит|вернись|вернуться|обратно|уйд|уйти|пойдем|пошли|назад)[^.?!]{0,30}(салон|из конструктор|конструктор)/.test(s)) return /(салон|конструктор)/.test(s);
  return false;
}

/** QA-077: a room action asked for in the salon (build / room size / layout / walls / floor / place in the room / photo / dossier). */
export function isRoomAction(text: string): 'room' | 'photo' | null {
  const s = norm(text);
  if (/(фото|сфотограф|снимок|рендер|досье|pdf|пдф|сохрани проект|пришли (мне )?(всё|все|проект)|отправь (мне )?(всё|все|проект))/.test(s)) return 'photo';
  // live 2026-10-03: «Открой двери», «Открой дверь тумбе» in the salon are the booth's doors (double-click), not a room door
  if (/(откр|закр)[а-я]*\s+([а-я«»]+\s+){0,2}двер/.test(s)) return null;
  if (/((построй|постройте|собери|соберите|нарисуй|нарисуйте|сделай|сделайте|создай|создайте)[а-я]*\s+(мне\s+)?(комнат|ванн|санузел|планировк)|планировк|расстав|покрас[а-я]*\s+стен|(?<![а-я])стен[ыу]?(?![а-я])|плитк|кафел|(?<![а-я])пол(?![а-я])|двер(?![цк])|окн|в комнат[уе]|(^|\s)(у меня )?(ванная|комната|санузел)\s+\d|(\d+(?:[.,]\d+)?)\s*(?:м|см|метр[а-я]*)?\s*(?:на|x|х|×)\s*\d)/.test(s)) return 'room';
  return null;
}
export const ROOM_OFFER_RU = 'Комнату можно собрать в Конструкторе — перейдём?';
export const PHOTO_OFFER_RU = 'Досье и фото вашей ванной делаются в Конструкторе — перейдём?';

/**
 * P3-02 (contracts v2.2): a photo of a salon booth («Сфотографируй», «Сделай фото этого стенда», «Снимок Urban»). A photo of
 * the room / the bathroom / the project and the dossier stay in «Конструктор».
 */
export function isBoothPhotoRequest(text: string): boolean {
  const s = norm(text);
  if (!/(фото|сфотограф|снимок|сними(те)?(?![а-я])|рендер|кадр(?![а-я])|картинк)/.test(s)) return false;
  return !/(досье|pdf|пдф|сохрани|пришли|отправ|комнат|ванн|санузел|конструктор|проект|в реальн)/.test(s);
}
export const BOOTH_PHOTO_NO_FOCUS_RU = 'Сфотографировать могу стенд салона: подойдите к нему или откройте его настройки — и скажите «сфотографируй». А фото вашей ванной делается в Конструкторе.';
export const BOOTH_PHOTO_OFFER_RU = 'Перейдём в Конструктор?';

/** QA-080: an explicit change of the booth («сделайте 100 см», «поставьте 80», «поменяйте на …») — never a question. */
export function isExplicitBoothChange(text: string): boolean {
  const s = norm(text);
  if (s.includes('?') || /(помест|влез|подойд|впиш|войдет|встанет)/.test(s)) return false;
  return /(^|[^а-я])(сделай|сделайте|поставь|поставьте|поменяй|поменяйте|замени|замените|смени|смените|давай|давайте|хочу|переставь|переставьте|увеличь|уменьши|добавь|добавьте|убери|уберите|покрась|покрасьте)([^а-я]|$)/.test(s);
}

/** QA-080: a fit / size / "would it fit" question — informational, never a booth change. */
export function isFitQuestion(text: string): boolean {
  if (isExplicitBoothChange(text)) return false;
  const s = norm(text);
  return /(помест|влез|подойд|впиш|войдет|встанет|габарит|какой ширин|какая ширин|какая глубин|какой глубин|какие размер|какой размер|сколько места|по ширине|по глубине)/.test(s);
}

export const FIT_HINT_RU = 'Проверить точно можно в Конструкторе — скажите, если захотите.';

/** «Верни как было» on a booth. */
export function isRevert(text: string): boolean {
  return /(верни как было|верни обратно|верни(те)? назад|как было|отмени|отмена)/.test(norm(text));
}
