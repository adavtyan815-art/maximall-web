/**
 * X4: Day-1 phrase set — 50 realistic Russian visitor phrases with the expected tool behaviour.
 * `setup` turns run first (not scored) to put the room into the right state.
 * expect.tools: every listed tool must be called in the scored turn; expect.none: no tool at all;
 * expect.not: tools that must NOT be called; expect.reply: regex the consultant reply must match.
 */
export interface Phrase {
  id: string;
  group: string;
  /** the scored visitor text (or `answer`: a button under the last offer) */
  text: string;
  answer?: string;
  /** setup turns (text) or button answers ({ answer: optionId }) */
  setup?: (string | { answer: string })[];
  /** v2.0: start mode (default constructor, the v1 phrases) and the salon booth in focus (productId) */
  mode?: 'showroom' | 'constructor';
  focus?: string;
  expect: {
    tools?: string[];
    none?: boolean;
    not?: string[];
    reply?: string;
    /** v2.0: offer shown in the scored step ('none' = no offer) */
    offer?: 'constructor' | 'booth_scope' | 'collection_pick' | 'none';
    offerNot?: string[];
    /** mode after the scored step */
    modeAfter?: 'showroom' | 'constructor';
    /** UE commands that must / must not be sent in the scored step; noRoom = no room command at all */
    cmds?: string[];
    notCmds?: string[];
    noRoom?: boolean;
  };
}

const ROOM = 'Ванная 2 на 2,5 метра, дверь на короткой стене';
const ROOM_CARDS = [ROOM, 'Покажи варианты до 5000 BYN'];
const WITH_SET = [...ROOM_CARDS, 'Давай первый вариант'];

export const PHRASES: Phrase[] = [
  // room sizes
  { id: 'room-01', group: 'room', text: 'У меня ванная два на три метра', expect: { tools: ['build_room'] } },
  { id: 'room-02', group: 'room', text: 'Ванная 1,8 на 2,2 м, дверь есть', expect: { tools: ['build_room'] } },
  { id: 'room-03', group: 'room', text: 'Размер 250 на 180 см, окно на длинной стене', expect: { tools: ['build_room'], not: ['finish_surface'] } },
  { id: 'room-04', group: 'room', text: 'Комната 3 на 2,4 метра, бюджет 4000 BYN', expect: { tools: ['build_room', 'propose_sets'] } },
  { id: 'room-05', group: 'room', text: 'Санузел полтора на два метра', expect: { tools: ['build_room'] } },
  { id: 'room-06', group: 'room', text: 'Ванная 2,4 на 3 метра, дверь на короткой стене, окно на длинной', expect: { tools: ['build_room'], not: ['finish_surface'] } },
  // budgets
  { id: 'budget-01', group: 'budget', setup: [ROOM], text: 'Бюджет до 3000 рублей', expect: { tools: ['propose_sets'] } },
  { id: 'budget-02', group: 'budget', setup: [ROOM], text: 'Хочу уложиться в 4 тысячи', expect: { tools: ['propose_sets'] } },
  { id: 'budget-03', group: 'budget', setup: [ROOM], text: 'Покажи варианты не больше 6000 BYN', expect: { tools: ['propose_sets'] } },
  { id: 'budget-04', group: 'budget', setup: [ROOM], text: 'Что есть примерно за 3500?', expect: { tools: ['propose_sets'] } },
  { id: 'budget-05', group: 'budget', setup: [ROOM], text: 'Подберите что-нибудь недорогое', expect: { tools: ['propose_sets'] } },
  // styles
  { id: 'style-01', group: 'style', setup: [ROOM], text: 'Хочу светлую мебель', expect: { tools: ['propose_sets'], not: ['finish_surface'] } },
  { id: 'style-02', group: 'style', setup: [ROOM], text: 'Нравится натуральное дерево, орех', expect: { tools: ['propose_sets'] } },
  { id: 'style-03', group: 'style', setup: [ROOM], text: 'Что-нибудь современное, серое', expect: { tools: ['propose_sets'] } },
  { id: 'style-04', group: 'style', setup: [ROOM], text: 'Покажи коллекцию Milu', expect: { tools: ['propose_sets'] } },
  { id: 'style-05', group: 'style', setup: [ROOM], text: 'А что есть в коллекции Urban?', expect: { tools: ['propose_sets'] } },
  // choose by voice
  { id: 'pick-01', group: 'pick', setup: ROOM_CARDS, text: 'Давай второй вариант', expect: { tools: ['apply_card'] } },
  { id: 'pick-02', group: 'pick', setup: ROOM_CARDS, text: 'Беру первый', expect: { tools: ['apply_card'] } },
  { id: 'pick-03', group: 'pick', setup: ROOM_CARDS, text: 'Поставь третий вариант', expect: { tools: ['apply_card'] } },
  // refine
  { id: 'refine-01', group: 'refine', setup: WITH_SET, text: 'Сделай светлее', expect: { tools: ['configure_set'] } },
  { id: 'refine-02', group: 'refine', setup: WITH_SET, text: 'А можно потемнее?', expect: { tools: ['configure_set'] } },
  { id: 'refine-03', group: 'refine', setup: WITH_SET, text: 'Добавь пенал', expect: { tools: ['configure_set'] } },
  { id: 'refine-04', group: 'refine', setup: WITH_SET, text: 'Добавь навесной шкаф над тумбой', expect: { tools: ['configure_set'] } },
  { id: 'refine-05', group: 'refine', setup: WITH_SET, text: 'Убери шкаф', expect: { tools: ['configure_set'] } },
  { id: 'refine-06', group: 'refine', setup: [ROOM, 'Покажи коллекцию Terra', 'Давай первый вариант'], text: 'Добавь пенал', expect: { reply: 'нет|есть в коллекциях' } },
  // finishes
  { id: 'finish-01', group: 'finish', setup: WITH_SET, text: 'Покрась стены в белый', expect: { tools: ['finish_surface'] } },
  { id: 'finish-02', group: 'finish', setup: WITH_SET, text: 'Стены сделай бежевыми', expect: { tools: ['finish_surface'] } },
  { id: 'finish-03', group: 'finish', setup: WITH_SET, text: 'Подбери отделку стен и пол', expect: { tools: ['finish_surface'] } },
  { id: 'finish-04', group: 'finish', setup: WITH_SET, text: 'Положи на пол серую плитку', expect: { tools: ['finish_surface'] } },
  { id: 'finish-05', group: 'finish', setup: WITH_SET, text: 'Белые стены и песочный пол', expect: { tools: ['finish_surface'] } },
  // photo
  { id: 'photo-01', group: 'photo', setup: WITH_SET, text: 'Сделай фото', expect: { tools: ['take_photo'] } },
  { id: 'photo-02', group: 'photo', setup: WITH_SET, text: 'Покажи, как это будет выглядеть', expect: { tools: ['take_photo'] } },
  { id: 'photo-03', group: 'photo', setup: WITH_SET, text: 'Сфотографируй комнату', expect: { tools: ['take_photo'] } },
  // send / save
  { id: 'save-01', group: 'save', setup: WITH_SET, text: 'Отправь мне всё', expect: { tools: ['save_project'] } },
  { id: 'save-02', group: 'save', setup: WITH_SET, text: 'Сохрани проект', expect: { tools: ['save_project'] } },
  { id: 'save-03', group: 'save', setup: WITH_SET, text: 'Скинь мне PDF', expect: { tools: ['save_project'] } },
  // undo / start over / summon
  { id: 'undo-01', group: 'undo', setup: WITH_SET, text: 'Отмени', expect: { tools: ['undo'] } },
  { id: 'undo-02', group: 'undo', setup: WITH_SET, text: 'Верни как было', expect: { tools: ['undo'] } },
  { id: 'undo-03', group: 'undo', setup: WITH_SET, text: 'Начнём сначала', expect: { tools: ['reset_room'] } },
  { id: 'exit-01', group: 'undo', setup: [ROOM], text: 'Вернись в салон', expect: { cmds: ['exit_constructor'], modeAfter: 'showroom' } },
  // guardrails: discounts and haggling
  { id: 'guard-01', group: 'guard', setup: WITH_SET, text: 'Сделайте мне скидку 20 процентов', expect: { none: true, reply: 'менеджер' } },
  { id: 'guard-02', group: 'guard', setup: WITH_SET, text: 'А дешевле отдадите?', expect: { none: true, reply: 'менеджер' } },
  { id: 'guard-03', group: 'guard', setup: WITH_SET, text: 'Есть промокод или акция?', expect: { none: true, reply: 'менеджер' } },
  { id: 'guard-04', group: 'guard', setup: WITH_SET, text: 'Давайте поторгуемся', expect: { none: true, reply: 'менеджер' } },
  // delivery / warranty
  { id: 'deliv-01', group: 'delivery', setup: WITH_SET, text: 'Когда вы сможете доставить?', expect: { none: true, reply: 'менеджер' } },
  { id: 'deliv-02', group: 'delivery', setup: WITH_SET, text: 'Сколько стоит доставка и монтаж?', expect: { none: true, reply: 'менеджер' } },
  { id: 'deliv-03', group: 'delivery', setup: WITH_SET, text: 'Какая гарантия на тумбу?', expect: { none: true, reply: 'менеджер' } },
  // off-topic
  { id: 'off-01', group: 'offtopic', text: 'Какая завтра погода?', expect: { none: true, reply: 'ванн' } },
  { id: 'off-02', group: 'offtopic', text: 'Расскажи анекдот', expect: { none: true, reply: 'ванн' } },
  { id: 'off-03', group: 'offtopic', text: 'Кто ты такая?', expect: { none: true, reply: 'ванн|Ольга' } },
  ...SHOWROOM_PHRASES(),
  ...V24_PHRASES(),
];

/** Contracts v2.4 (Phase 4): the manual actions by voice — for the next approved paid run of the real model (the mock policy covers them too). */
function V24_PHRASES(): Phrase[] {
  const S = 'showroom' as const;
  const C = 'constructor' as const;
  const WINDOW_ROOM = ['Ванная 2 на 2,5 метра с окном'];
  return [
    { id: 'v24-move-01', group: 'v24', mode: C, setup: WITH_SET, text: 'Сдвинь комплект левее на 20 см', expect: { tools: ['move_set'], cmds: ['move_set'], reply: 'левее' } },
    { id: 'v24-move-02', group: 'v24', mode: C, setup: WITH_SET, text: 'Подвинь тумбу чуть правее', expect: { tools: ['move_set'], cmds: ['move_set'] } },
    { id: 'v24-doors-01', group: 'v24', mode: C, setup: WITH_SET, text: 'Открой дверцы', expect: { tools: ['configure_set'], cmds: ['configure_set'], reply: 'Открыла дверцы' } },
    { id: 'v24-options-01', group: 'v24', mode: C, setup: WITH_SET, text: 'Какие есть зеркала?', expect: { tools: ['list_options'], reply: 'Зеркало' } },
    { id: 'v24-opening-01', group: 'v24', mode: C, setup: WINDOW_ROOM, text: 'Сдвинь окно вправо на 30 сантиметров', expect: { tools: ['update_opening'], cmds: ['update_opening'], reply: 'окно' } },
    { id: 'v24-opening-02', group: 'v24', mode: C, setup: WINDOW_ROOM, text: 'Убери окно', expect: { tools: ['remove_opening'], cmds: ['remove_opening'] } },
    { id: 'v24-finish-01', group: 'v24', mode: C, setup: [ROOM], text: 'Покрась плинтус в белый', expect: { tools: ['finish_surface'], cmds: ['finish_surface'], reply: 'плинтус' } },
    { id: 'v24-sr-doors', group: 'v24', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Открой дверцы', expect: { cmds: ['booth_configure'], offer: 'none', reply: 'Открыла дверцы' } },
    { id: 'v24-sr-options', group: 'v24', mode: S, focus: 'Urban', setup: [{ answer: 'this' }], text: 'Какие есть смесители?', expect: { tools: ['list_options'], noRoom: true, reply: 'Смеситель' } },
  ];
}

/** v2.0 (PHASE 2): the salon (showroom) — consent to the Constructor, the booth dialogue for all five collections, «верни как было». */
function SHOWROOM_PHRASES(): Phrase[] {
  const FIT = 'А влезет ли эта тумба в мою ванную?';
  const S = 'showroom' as const;
  return [
    // consent: one offer per topic; move only on a button yes or an unambiguous verbal yes in the very next turn
    { id: 'sr-fit-01', group: 'consent', mode: S, focus: 'Milu', text: FIT, expect: { offer: 'constructor', modeAfter: S, noRoom: true, reply: 'Конструктор' } },
    { id: 'sr-fit-02', group: 'consent', mode: S, text: 'У меня ванная 2 на 2,5 метра', expect: { offer: 'constructor', modeAfter: S, noRoom: true, not: ['build_room'] } },
    { id: 'sr-yes-01', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Да', expect: { modeAfter: 'constructor', cmds: ['enter_constructor'], reply: 'Перешли в Конструктор' } },
    { id: 'sr-yes-02', group: 'consent', mode: S, focus: 'Urban', setup: [FIT], text: 'Давай', expect: { modeAfter: 'constructor', cmds: ['enter_constructor'] } },
    { id: 'sr-yes-03', group: 'consent', mode: S, focus: 'Avenu', setup: [FIT], text: 'Переходим!', expect: { modeAfter: 'constructor', cmds: ['enter_constructor'] } },
    { id: 'sr-yes-04', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Хочу', expect: { modeAfter: 'constructor', cmds: ['enter_constructor'] } },
    { id: 'sr-yes-btn', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: '', answer: 'yes', expect: { modeAfter: 'constructor', cmds: ['enter_constructor'] } },
    { id: 'sr-no-01', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Нет, спасибо', expect: { modeAfter: S, notCmds: ['enter_constructor'], reply: 'остаёмся' } },
    { id: 'sr-no-02', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Может быть', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
    { id: 'sr-no-03', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Не знаю', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
    { id: 'sr-no-04', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'А сколько она стоит?', expect: { modeAfter: S, notCmds: ['enter_constructor'], tools: ['catalog_lookup'] } },
    { id: 'sr-no-05', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Да, но потом', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
    { id: 'sr-no-btn', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: '', answer: 'no', expect: { modeAfter: S, notCmds: ['enter_constructor'], reply: 'остаёмся' } },
    { id: 'sr-late-yes', group: 'consent', mode: S, focus: 'Milu', setup: [FIT, 'Сколько стоит Milu?'], text: 'Да', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
    { id: 'sr-nonag', group: 'consent', mode: S, focus: 'Milu', setup: [FIT, 'Нет'], text: 'А по размеру она подойдёт?', expect: { offer: 'none', modeAfter: S } },
    { id: 'sr-ask', group: 'consent', mode: S, focus: 'Milu', setup: [FIT, 'Нет'], text: 'Давайте всё-таки перейдём в конструктор', expect: { offer: 'none', modeAfter: 'constructor', cmds: ['enter_constructor'] } },
    { id: 'sr-ask-q', group: 'consent', mode: S, focus: 'Milu', text: 'А что такое конструктор?', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
    { id: 'sr-late-btn', group: 'consent', mode: S, focus: 'Milu', setup: [FIT, 'Сколько стоит Milu?'], text: '', answer: 'yes', expect: { modeAfter: 'constructor', cmds: ['enter_constructor'] } },
    { id: 'sr-photo', group: 'consent', mode: S, text: 'Сделай фото', expect: { noRoom: true, offer: 'constructor', notCmds: ['capture'], reply: 'стенд салона.*Конструктор' } },
    // v2.2 P3-02: the salon photo = the clean capture of the booth in focus (capture preset booth, no AI render)
    { id: 'sr-photo-booth', group: 'photo', mode: S, focus: 'Milu', text: 'Сфотографируй этот стенд', expect: { cmds: ['capture'], noRoom: true, offer: 'none', modeAfter: S, reply: 'Фотографирую стенд Milu' } },
    { id: 'sr-photo-booth-2', group: 'photo', mode: S, focus: 'Urban', setup: [{ answer: 'this' }], text: 'Сделай фото', expect: { cmds: ['capture'], noRoom: true, offer: 'none', reply: 'Urban' } },
    { id: 'sr-photo-named', group: 'photo', mode: S, focus: 'Milu', text: 'Сделай снимок стенда Terra', expect: { notCmds: ['capture'], noRoom: true, reply: 'Стенд Terra сейчас не рядом' } },
    { id: 'sr-photo-room', group: 'photo', mode: S, focus: 'Milu', text: 'Сделай фото комнаты', expect: { notCmds: ['capture'], noRoom: true, offer: 'constructor', reply: 'Конструктор' } },
    // booth dialogue: «эта коллекция или другие» for all five collections
    { id: 'sr-this-milu', group: 'booth', mode: S, focus: 'Milu', text: '', answer: 'this', expect: { cmds: ['booth_get'], reply: 'Milu.*BYN' } },
    { id: 'sr-this-urban', group: 'booth', mode: S, focus: 'Urban', text: 'Эту', expect: { cmds: ['booth_get'], reply: 'Urban.*BYN' } },
    { id: 'sr-this-avenu', group: 'booth', mode: S, focus: 'Avenu', text: '', answer: 'this', expect: { cmds: ['booth_get'], reply: 'Avenu.*BYN' } },
    { id: 'sr-this-terra', group: 'booth', mode: S, focus: 'Terra', text: 'Давайте эту', expect: { cmds: ['booth_get'], reply: 'Terra.*BYN' } },
    { id: 'sr-this-tuma', group: 'booth', mode: S, focus: 'Tuma', text: '', answer: 'this', expect: { cmds: ['booth_get'], reply: 'Tuma.*BYN' } },
    { id: 'sr-other', group: 'booth', mode: S, focus: 'Milu', text: '', answer: 'other', expect: { offer: 'collection_pick', offerNot: ['Tuma', 'Milu'], noRoom: true } },
    { id: 'sr-pick-btn', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'other' }], text: '', answer: 'Urban', expect: { cmds: ['booth_configure'], reply: 'Urban' } },
    { id: 'sr-pick-verbal', group: 'booth', mode: S, focus: 'Avenu', setup: ['Другие'], text: 'Terra', expect: { cmds: ['booth_configure'], reply: 'Terra' } },
    { id: 'sr-other-later', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }, 'Сделай 100 см'], text: 'Посмотрим другие коллекции', expect: { offer: 'collection_pick', offerNot: ['Milu', 'Tuma'], notCmds: ['booth_configure'] } },
    { id: 'sr-other-put', group: 'booth', mode: S, focus: 'Urban', setup: [{ answer: 'this' }], text: 'Поставьте другую', expect: { offer: 'collection_pick', offerNot: ['Urban'] } },
    { id: 'sr-other-here', group: 'booth', mode: S, focus: 'Avenu', setup: [{ answer: 'this' }], text: 'Другую коллекцию сюда', expect: { offer: 'collection_pick' } },
    { id: 'sr-other-chip', group: 'booth', mode: S, focus: 'Terra', setup: [{ answer: 'this' }], text: 'Покажи другие коллекции', expect: { offer: 'collection_pick', notCmds: ['booth_configure'] } },
    { id: 'sr-chip-nofocus', group: 'booth', mode: S, text: 'Покажи другие коллекции', expect: { offer: 'none', tools: ['catalog_suggest'], noRoom: true } },
    { id: 'sr-named-direct', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Поставьте сюда Urban', expect: { offer: 'none', cmds: ['booth_configure'], reply: 'Поставила на стенд Urban' } },
    { id: 'sr-named-replace', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Замените на Avenu', expect: { offer: 'none', cmds: ['booth_configure'], reply: 'Avenu' } },
    // QA-077: room phrases in the salon -> the honest offer; leaving the Constructor by text
    { id: 'sr-room-build', group: 'consent', mode: S, text: 'Построй мне комнату', expect: { offer: 'constructor', noRoom: true, reply: 'Комнату можно собрать в Конструкторе — перейдём\\?' } },
    { id: 'sr-room-walls', group: 'consent', mode: S, focus: 'Milu', setup: [FIT, 'Нет'], text: 'Покрась стены в белый', expect: { offer: 'constructor', noRoom: true, notCmds: ['booth_configure'], reply: 'Комнату можно собрать в Конструкторе' } },
    { id: 'sr-room-floor', group: 'consent', mode: S, text: 'Положи плитку на пол', expect: { offer: 'constructor', noRoom: true, reply: 'Конструктор' } },
    { id: 'sr-room-dossier', group: 'consent', mode: S, text: 'Пришли мне всё', expect: { offer: 'constructor', noRoom: true, reply: 'Досье и фото вашей ванной делаются в Конструкторе' } },
    { id: 'cr-exit-polite', group: 'exit', mode: 'constructor', text: 'Выйдите, пожалуйста, из конструктора', expect: { modeAfter: S, cmds: ['exit_constructor'], reply: 'Вернулись в салон' } },
    { id: 'cr-exit-close', group: 'exit', mode: 'constructor', text: 'Закрой конструктор', expect: { modeAfter: S, cmds: ['exit_constructor'] } },
    { id: 'cr-exit-back', group: 'exit', mode: 'constructor', text: 'Вернёмся в салон', expect: { modeAfter: S, cmds: ['exit_constructor'] } },
    { id: 'cr-exit-want', group: 'exit', mode: 'constructor', text: 'Хочу обратно в салон', expect: { modeAfter: S, cmds: ['exit_constructor'] } },
    { id: 'cr-exit-not', group: 'exit', mode: 'constructor', text: 'Не выходи из конструктора, покажи варианты', expect: { modeAfter: 'constructor', notCmds: ['exit_constructor'] } },
    // QA-080: fit / size questions with a booth in focus are informational (never booth_configure); one offer per topic,
    // after a decline a factual answer + a short hint without buttons
    { id: 'sr-fitq-01', group: 'consent', mode: S, focus: 'Milu', text: 'Поместится ли тумба 100 см в мою ванную 1,7 на 1,5?', expect: { offer: 'constructor', notCmds: ['booth_configure'], noRoom: true, reply: 'Milu 100.*170 см.*помещается' } },
    { id: 'sr-fitq-02', group: 'consent', mode: S, focus: 'Milu', setup: ['Поместится ли тумба 100 см в мою ванную 1,7 на 1,5?', 'Нет'], text: 'А 80 см поместится?', expect: { offer: 'none', notCmds: ['booth_configure'], reply: 'Milu 80.*Проверить точно можно в Конструкторе' } },
    { id: 'sr-fitq-03', group: 'consent', mode: S, focus: 'Milu', setup: ['Поместится ли тумба 100 см в мою ванную 1,7 на 1,5?', { answer: 'no' }], text: 'А если комната 2 на 2?', expect: { offer: 'none', notCmds: ['booth_configure'], noRoom: true } },
    { id: 'sr-fitq-04', group: 'consent', mode: S, focus: 'Urban', setup: ['Влезет ли Urban в ванную 1,5 на 1,5?', 'Нет'], text: 'Какая глубина у Milu?', expect: { offer: 'none', notCmds: ['booth_configure'], reply: 'Milu.*глубина' } },
    { id: 'sr-fitq-05', group: 'consent', mode: S, focus: 'Avenu', setup: ['Поместится ли Avenu 100 в ванную 1,7 на 1,5?', 'Может быть'], text: 'А 80 поместится?', expect: { offer: 'none', notCmds: ['booth_configure', 'enter_constructor'] } },
    { id: 'sr-fitq-change', group: 'booth', mode: S, focus: 'Milu', setup: ['А 80 см поместится?'], text: 'Сделайте 100 см', expect: { cmds: ['booth_configure'], reply: 'Поменяла размер на 100 см' } },
    { id: 'sr-size', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Сделай 100 см', expect: { tools: ['booth_configure'], cmds: ['booth_configure'], reply: '100' } },
    { id: 'sr-colour', group: 'booth', mode: S, focus: 'Urban', setup: [{ answer: 'this' }], text: 'Хочу белый цвет', expect: { cmds: ['booth_configure'], reply: 'бел' } },
    { id: 'sr-closet-add', group: 'booth', mode: S, focus: 'Avenu', setup: [{ answer: 'this' }], text: 'Добавь пенал', expect: { cmds: ['booth_configure'], reply: 'Добавила навесной шкаф' } },
    { id: 'sr-closet-none', group: 'booth', mode: S, focus: 'Terra', setup: [{ answer: 'this' }], text: 'Добавь пенал', expect: { notCmds: ['booth_configure'], reply: 'нет' } },
    { id: 'sr-ral', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Покрась тумбу в RAL 9010', expect: { cmds: ['booth_configure'], reply: 'RAL 9010' } },
    { id: 'sr-revert', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }, 'Сделай 100 см'], text: 'Верни как было', expect: { tools: ['booth_undo'], cmds: ['booth_undo'], reply: 'Вернула' } },
    { id: 'sr-nofocus', group: 'booth', mode: S, text: 'Сделай белый цвет', expect: { reply: 'стенду', notCmds: ['booth_configure'] } },
    { id: 'sr-catalog-01', group: 'booth', mode: S, text: 'Покажи варианты до 3000 BYN', expect: { tools: ['catalog_suggest'], noRoom: true, reply: 'BYN' } },
    { id: 'sr-catalog-02', group: 'booth', mode: S, text: 'Сколько стоит Avenu?', expect: { tools: ['catalog_lookup'], noRoom: true, reply: 'Avenu' } },
  ];
}
