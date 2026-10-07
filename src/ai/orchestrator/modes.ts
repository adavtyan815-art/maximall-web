/**
 * Contracts v2.0 (PHASE 2): two consultant modes, consent to move into «Конструктор», booth dialogue phrases.
 * Pure helpers (no I/O); the orchestrator owns the state.
 */
import { t, type Lang } from '../i18n';

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

/** Artur's wording: «эту модель» only when a specific model is the topic. (v2.5: the texts live in the locale tables.) */
export const OFFER_CONSTRUCTOR_RU = t('ru', 'offer.constructor');
export const OFFER_CONSTRUCTOR_MODEL_RU = t('ru', 'offer.constructorModel');
/** v2.5: the yes/no buttons in the session language (ids stay `yes` / `no`). */
export const constructorOptions = (lang: Lang = 'ru') => [
  { id: 'yes', label: t(lang, 'offer.yes') },
  { id: 'no', label: t(lang, 'offer.no') },
];
export const OFFER_CONSTRUCTOR_OPTIONS = constructorOptions('ru');
export const STAY_RU = t('ru', 'stay');
export const NO_BOOTH_RU = t('ru', 'booth.none');

export const scopeQuestionRu = (collection: string) => t('ru', 'scope.question', { collection });
export const scopeOptions = (collection: string, lang: Lang = 'ru') => [
  { id: 'this', label: t(lang, 'scope.this', { collection }) },
  { id: 'other', label: t(lang, 'scope.other') },
];
export const pickQuestionRu = (collection: string) => t('ru', 'pick.question', { collection });

export const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е').trim();
/** v2.5: English text — lower case, typographic apostrophes as «'». */
const normEn = (t: string) => t.toLowerCase().replace(/[’`]/g, "'").trim();

/**
 * v2.5 (English alongside Russian): every deterministic rule below keeps its Russian word list unchanged; with
 * `lang = 'en'` an English word list is checked as well (a bilingual visitor may still answer «да»). Russian sessions
 * never see the English lists, so their behaviour does not change.
 */
const EN_SIZE = /(\d+(?:\.\d+)?)\s*(?:m|cm|metres?|meters?|centimet(?:re|er)s?)?\s*(?:by|x|×|\*)\s*\d/;

/** Dimensions / fitting / «в моей ванной» / room / layout: the constructor topic. */
export function isFitTopic(text: string, lang: Lang = 'ru'): boolean {
  const s = norm(text);
  if (/(размер|габарит|влез|помест|впиш|войдет|встанет|в мо(ей|ю) ванн|моя ванн|у меня ванн|у меня (в )?санузел|моей комнат|комнат|планировк|расстанов|сколько места|по ширине|в реальн[а-я]* размер|примерить|как (это )?будет (смотреться|выглядеть) у меня|(\d+(?:[.,]\d+)?)\s*(?:м|см|метр[а-я]*)?\s*(?:на|x|х|×)\s*\d)/.test(s)) return true;
  if (lang !== 'en') return false;
  const e = normEn(text);
  return /(\bsizes?\b|dimension|\bfits?\b|will it go|would it go|in my (bathroom|room|flat|apartment)|my bathroom|\broom\b|\blayout|arrange|how much (space|room)|\bwidth\b|\bwide\b|real size|actual size|full size|true size|try it|how (it|this|that) (would|will) look (at|in) my|\bspace\b)/.test(e) || EN_SIZE.test(e);
}

/** The visitor asks to go into the constructor (still answered with an offer: consent is a yes to the offer). */
export function asksForConstructor(text: string, lang: Lang = 'ru'): boolean {
  const s = norm(text);
  if (/(конструктор|построй (мне )?комнату|покажи (это |е[её] |его )?в комнате|перейти в комнат|хочу в комнату|открой комнату|в реальн[а-я]* размер)/.test(s)) return true;
  if (lang !== 'en') return false;
  const e = normEn(text);
  return /(constructor|room planner|\bplanner\b|room designer|design my (bathroom|room)|build (me )?(a |my |the )?(room|bathroom)|show (it|this|that|them) in (a|the|my) room|go (in)?to the room|open the room|real size|actual size|full size|true size)/.test(e);
}

const YES_CORE = new Set(['да', 'давай', 'давайте', 'покажи', 'покажите', 'переходим', 'перейдем', 'перейти', 'хочу', 'конечно']);
const YES_FILLER = new Set(['да', 'давай', 'давайте', 'покажи', 'покажите', 'переходим', 'перейдем', 'перейти', 'хочу', 'конечно', 'в', 'комнату', 'комнате', 'конструктор', 'конструкторе', 'пожалуйста', 'туда', 'сейчас', 'можно']);

/**
 * QA pointer 1: the visitor's own explicit request to go into the Constructor is consent (no re-offer):
 * «Давайте всё-таки перейдём в конструктор», «Хочу в конструктор», «Открой конструктор». A question about it or a hedge is not.
 */
export function isExplicitConstructorRequest(text: string, lang: Lang = 'ru'): boolean {
  if (lang === 'en' && isExplicitConstructorRequestEn(text)) return true;
  const s = norm(text);
  if (!/конструктор/.test(s)) return false;
  if (/(^|[^а-я])(не|нет|потом|позже|может|наверное|подума|что так|что за|зачем|а что)([^а-я]|$)/.test(s)) return false;
  if (s.includes('?') && !/^(можно|давай|давайте)/.test(s)) return false;
  return /(перейд|переход|перейти|пойд|пошли|идем|хочу|давай|открой|откройте|включи|веди|ведите|перемест|отправ|в конструктор)/.test(s);
}
/** v2.5: «Let's go to the Constructor», «Open the room planner», «Take me to the designer», «Design my bathroom». */
function isExplicitConstructorRequestEn(text: string): boolean {
  const s = normEn(text);
  if (!/(constructor|room planner|\bplanner\b|room designer|\bdesigner\b|design my (bathroom|room))/.test(s)) return false;
  if (/(^|\W)(not|no|don't|dont|later|maybe|perhaps|what is|what's|whats|why|how does|what does)(\W|$)/.test(s)) return false;
  if (s.includes('?') && !/^(can we|could we|can you|could you|shall we|let's|lets|may we)/.test(s)) return false;
  return /(\bgo\b|going|\bopen\b|take me|take us|switch|\bmove\b|let's|lets|\bwant\b|i'd like|start|launch|enter|bring me|show me|into the|to the|design my)/.test(s);
}

/** An unambiguous verbal yes (only the very next visitor turn after the offer counts). */
export function isVerbalYes(text: string, lang: Lang = 'ru'): boolean {
  if (lang === 'en' && isVerbalYesEn(text)) return true;
  const s = norm(text);
  if (!s || s.includes('?')) return false;
  if (/(^|[^а-я])(не|нет|может|наверное|потом|позже|подума|если|но)([^а-я]|$)/.test(s)) return false;
  const words = s.replace(/[.,!…:;"«»()-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  return words.some((w) => YES_CORE.has(w)) && words.every((w) => YES_FILLER.has(w));
}
const YES_CORE_EN = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', "let's", 'lets', 'go', 'absolutely', 'definitely', 'course', 'please', 'alright', 'fine', 'show']);
const YES_FILLER_EN = new Set([
  ...YES_CORE_EN,
  'of', 'do', 'it', 'that', 'us', 'me', 'the', 'a', 'to', 'into', 'there', 'now', 'right', 'away', 'constructor', 'room', 'planner', 'designer', 'switch', 'move', 'thanks', 'thank', 'you', 'great', 'good', 'why', 'not', 'i', 'want', 'would', 'like', 'love', 'and',
]);
/** v2.5: «yes», «sure», «ok, let's go», «yes please», «of course», «why not». Hedges and questions are not a yes. */
function isVerbalYesEn(text: string): boolean {
  const s = normEn(text);
  if (!s || s.includes('?')) return false;
  if (/(^|\W)(no|nope|don't|dont|maybe|perhaps|later|if|but|rather|not now|not yet|wait)(\W|$)/.test(s) && !/^why not\W*$/.test(s)) return false;
  const words = s.replace(/[.,!…:;"«»()-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  if (/^why not$/.test(words.join(' '))) return true;
  return words.some((w) => YES_CORE_EN.has(w)) && words.every((w) => YES_FILLER_EN.has(w));
}

/** An explicit no (gets a short «остаёмся» answer); anything not a yes is a no anyway. */
export function isVerbalNo(text: string, lang: Lang = 'ru'): boolean {
  const s = norm(text).replace(/[.,!…]+/g, ' ').trim();
  if (/^(нет|не надо|не нужно|не хочу|не сейчас|остаемся|останемся|остаться|нет,? спасибо|нет спасибо|потом|позже)(\s|$)/.test(s)) return true;
  if (lang !== 'en') return false;
  const e = normEn(text).replace(/[.,!…]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(no|nope|nah|not now|not yet|no thanks|no thank you|stay|let's stay|lets stay|we'll stay|i'll stay|i'd rather stay|later|maybe later|don't|do not|i don't want)(\s|$)/.test(e);
}

/** Answer to «эту коллекцию или другие?» (verbal). */
export function boothScopeAnswer(text: string, lang: Lang = 'ru'): 'this' | 'other' | null {
  const s = norm(text);
  // only a short answer to the question (a fitting / price question about «эта тумба» is not an answer)
  if (isFitTopic(text, lang) || s.includes('?')) return null;
  if (lang === 'en') {
    const e = normEn(text).replace(/[.,!…]+/g, ' ').trim();
    const n = e.split(/\s+/).filter(Boolean).length;
    if (n <= 5 || /(this collection|other collections?)/.test(e)) {
      if (/(\bother|another|different|something else|not this|change the collection|switch (the )?collection)/.test(e)) return 'other';
      if (/(^|\W)(this|this one|this collection|it|yes|yeah|sure|discuss|tell me|about it|that one)(\W|$)/.test(e)) return 'this';
    }
  }
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
export function wantsOtherCollection(text: string, lang: Lang = 'ru'): boolean {
  const s = norm(text);
  if (collectionFromText(text)) return false; // a named collection switches directly
  if (/(друг(ие|ую|ая|ой|их|ое)|ин(ую|ые|ой|ое))\s+(коллекц|модел|тумб|вариант|комплект)|(постав|замен|смен|покаж|посмотр|давай|хочу|можно)[а-я]*\s+(на\s+|сюда\s+)?(друг|ин)(ие|ую|ая|ой|их|ое|ые)(?![а-я])|друг[а-я]* сюда|не эту коллекц/.test(s)) return true;
  if (lang !== 'en') return false;
  const e = normEn(text);
  return /((other|another|different)\s+(collections?|models?|vanit(y|ies)|units?|options?|sets?|ones?)|(show|see|put|swap|change|switch|try|want)( me| us)?\s+(an?\s+)?(other|another|different)|something else here|not this collection)/.test(e);
}

/** QA-077: leave «Конструктор» (constructor mode): «Выйдите, пожалуйста, из конструктора», «закрой конструктор», «вернёмся в салон», «хочу обратно в салон». */
export function isExitRequest(text: string, lang: Lang = 'ru'): boolean {
  if (lang === 'en' && isExitRequestEn(text)) return true;
  const s = norm(text);
  if (/(^|[^а-я])(не|нет)\s+(выход|выйд|закры|возвращ)/.test(s)) return false;
  if (/(выйд|выйт|выход|закрой|закройте|закрыть|вернем|вернит|вернись|вернуться|обратно|уйд|уйти|пойдем|пошли|назад)[^.?!]{0,30}(салон|из конструктор|конструктор)/.test(s)) return /(салон|конструктор)/.test(s);
  return false;
}
/** v2.5: «Exit the Constructor», «Back to the showroom», «Let's go back to the salon», «Close the room planner». */
function isExitRequestEn(text: string): boolean {
  const s = normEn(text);
  if (/(^|\W)(don't|dont|do not|not)\s+(exit|leave|close|quit|go back|return)/.test(s)) return false;
  return /(exit|leave|close|quit|go back|going back|get back|back|return|get out)[^.?!]{0,30}(showroom|salon|show room|constructor|planner)/.test(s);
}

/** QA-077: a room action asked for in the salon (build / room size / layout / walls / floor / place in the room / photo / dossier). */
export function isRoomAction(text: string, lang: Lang = 'ru'): 'room' | 'photo' | null {
  const s = norm(text);
  if (/(фото|сфотограф|снимок|рендер|досье|pdf|пдф|сохрани проект|пришли (мне )?(всё|все|проект)|отправь (мне )?(всё|все|проект))/.test(s)) return 'photo';
  // live 2026-10-03: «Открой двери», «Открой дверь тумбе» in the salon are the booth's doors (double-click), not a room door
  if (/(откр|закр)[а-я]*\s+([а-я«»]+\s+){0,2}двер/.test(s)) return null;
  if (/((построй|постройте|собери|соберите|нарисуй|нарисуйте|сделай|сделайте|создай|создайте)[а-я]*\s+(мне\s+)?(комнат|ванн|санузел|планировк)|планировк|расстав|покрас[а-я]*\s+стен|(?<![а-я])стен[ыу]?(?![а-я])|плитк|кафел|(?<![а-я])пол(?![а-я])|двер(?![цк])|окн|в комнат[уе]|(^|\s)(у меня )?(ванная|комната|санузел)\s+\d|(\d+(?:[.,]\d+)?)\s*(?:м|см|метр[а-я]*)?\s*(?:на|x|х|×)\s*\d)/.test(s)) return 'room';
  if (lang !== 'en') return null;
  const e = normEn(text);
  if (/(photo|picture|snapshot|render|dossier|\bpdf\b|save (the |my )?project|send (me )?(everything|it all|the project|all of it))/.test(e)) return 'photo';
  if (/(open|close)\w*\s+(\w+\s+){0,2}doors?/.test(e)) return null; // the booth's doors
  if (/((build|make|draw|create|design|put together)\s+(me\s+)?(a\s+|my\s+|the\s+)?(room|bathroom|layout|floor ?plan)|\blayout\b|floor ?plan|paint (the )?walls?|\bwalls?\b(?! cabinet)|\btiles?\b|\btiling\b|\bfloor\b|\bdoor\b|\bwindows?\b|in (the|my) room|(my )?(bathroom|room) is \d)/.test(e) || EN_SIZE.test(e)) return 'room';
  return null;
}
export const ROOM_OFFER_RU = t('ru', 'offer.room');
export const PHOTO_OFFER_RU = t('ru', 'offer.photo');

/**
 * P3-02 (contracts v2.2): a photo of a salon booth («Сфотографируй», «Сделай фото этого стенда», «Снимок Urban»). A photo of
 * the room / the bathroom / the project and the dossier stay in «Конструктор».
 */
export function isBoothPhotoRequest(text: string, lang: Lang = 'ru'): boolean {
  const s = norm(text);
  if (/(фото|сфотограф|снимок|сними(те)?(?![а-я])|рендер|кадр(?![а-я])|картинк)/.test(s)) return !/(досье|pdf|пдф|сохрани|пришли|отправ|комнат|ванн|санузел|конструктор|проект|в реальн)/.test(s);
  if (lang !== 'en') return false;
  const e = normEn(text);
  if (!/(photo|picture|snapshot|\bpic\b|take a shot|\bshot\b|render|\bimage\b)/.test(e)) return false;
  return !/(dossier|\bpdf\b|save|send|\broom\b|bathroom|constructor|planner|project|real size)/.test(e);
}
export const BOOTH_PHOTO_NO_FOCUS_RU = t('ru', 'photo.boothNoFocus');
export const BOOTH_PHOTO_OFFER_RU = t('ru', 'offer.boothPhoto');

/** QA-080: an explicit change of the booth («сделайте 100 см», «поставьте 80», «поменяйте на …») — never a question. */
export function isExplicitBoothChange(text: string, lang: Lang = 'ru'): boolean {
  const s = norm(text);
  if (lang === 'en') {
    const e = normEn(text);
    if (!e.includes('?') && !/(\bfits?\b|will it go|would it go)/.test(e) && /(^|\W)(make|put|set|change|switch|replace|swap|let's|lets|i want|i'd like|increase|decrease|add|remove|paint|use|give me)(\W|$)/.test(e)) return true;
  }
  if (s.includes('?') || /(помест|влез|подойд|впиш|войдет|встанет)/.test(s)) return false;
  return /(^|[^а-я])(сделай|сделайте|поставь|поставьте|поменяй|поменяйте|замени|замените|смени|смените|давай|давайте|хочу|переставь|переставьте|увеличь|уменьши|добавь|добавьте|убери|уберите|покрась|покрасьте)([^а-я]|$)/.test(s);
}

/** QA-080: a fit / size / "would it fit" question — informational, never a booth change. */
export function isFitQuestion(text: string, lang: Lang = 'ru'): boolean {
  if (isExplicitBoothChange(text, lang)) return false;
  const s = norm(text);
  if (/(помест|влез|подойд|впиш|войдет|встанет|габарит|какой ширин|какая ширин|какая глубин|какой глубин|какие размер|какой размер|сколько места|по ширине|по глубине)/.test(s)) return true;
  if (lang !== 'en') return false;
  return /(\bfits?\b|will it go|would it go|room for it|how wide|how deep|how tall|how high|what size|which size|what are the (sizes|dimensions)|dimensions|how much (space|room)|\bwidth\b|\bdepth\b)/.test(normEn(text));
}

export const FIT_HINT_RU = t('ru', 'fit.hint');

/** «Верни как было» on a booth. */
export function isRevert(text: string, lang: Lang = 'ru'): boolean {
  if (/(верни как было|верни обратно|верни(те)? назад|как было|отмени|отмена)/.test(norm(text))) return true;
  return lang === 'en' && /(\bundo\b|put it back|as it was|\brevert\b|change it back|cancel (that|the last))/.test(normEn(text));
}
