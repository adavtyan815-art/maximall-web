/**
 * Contracts v2.5 §7 — UE refusal texts by (reasonCode, reasonParams.detail), from
 * docs/AI_Consultant_Expo/contracts/UE_REASON_CODES_v2.5.md (UE, 2026-10-07).
 *
 * UE keeps sending today's Russian `reason` byte for byte; Russian sessions keep showing it (Russian output unchanged).
 * English sessions render the template below with `reasonParams`. Lookup: `<CODE>.<DETAIL>` (a code-specific wording),
 * then `<DETAIL>`. A detail missing here falls back to the generic English line of the reasonCode (and is logged);
 * `PLANNER_REJECTED` has no template by contract and always shows UE's `reason`.
 * Russian templates are kept next to the English ones (used only when UE sends no `reason`); add a row to both maps to extend.
 */
type P = Record<string, any>;
type Tpl = (p: P) => string;

const q = (v: unknown) => `«${v ?? ''}»`;
const dq = (v: unknown) => `"${v ?? ''}"`;

const OBSTACLE_RU: Record<string, string> = { WINDOW: 'окно', DOOR: 'дверной проём', SET: 'другой гарнитур', WALL: 'примыкающая стена', OBSTACLE: 'препятствие' };
const OBSTACLE_EN: Record<string, string> = { WINDOW: 'a window', DOOR: 'a doorway', SET: 'another set', WALL: 'the adjoining wall', OBSTACLE: 'an obstacle' };
const COMPONENT_GEN_RU: Record<string, string> = { countertop: 'столешницы', sink: 'раковины', faucet: 'смесителя', mirror: 'зеркала' };
const COMPONENT_EN: Record<string, string> = { cabinet: 'vanity unit', closet: 'wall cabinet', countertop: 'worktop', sink: 'basin', faucet: 'tap', mirror: 'mirror', doors: 'doors' };
const CAUSE_RU: Record<string, string> = {
  CAMERA_TIMEOUT: 'нет ответа камеры за 15 с',
  BOOTH_OR_CAMERA_UNAVAILABLE: 'стенд или камера недоступны',
  CAPTURE_NOT_STARTED: 'снимок не удалось начать',
  CAMERA_UNAVAILABLE: 'камера недоступна',
};
const CAUSE_EN: Record<string, string> = {
  CAMERA_TIMEOUT: 'the camera did not answer within 15 s',
  BOOTH_OR_CAMERA_UNAVAILABLE: 'the booth or the camera is not available',
  CAPTURE_NOT_STARTED: 'the shot could not be started',
  CAMERA_UNAVAILABLE: 'the camera is not available',
  ABORTED: 'it was aborted',
};
const whereRu = (w: unknown) => (w === 'envelope' ? 'конверте' : String(w ?? ''));
const kindPrefixRu = (p: P, s: string) => (p.wallIndex !== undefined && p.kind ? `${p.kind === 'window' ? 'Окно' : 'Дверь'}: ${s}` : s);
const kindPrefixEn = (p: P, s: string) => (p.wallIndex !== undefined && p.kind ? `${p.kind === 'window' ? 'Window' : 'Door'}: ${s}` : s);

export const REASON_DETAILS_RU: Record<string, Tpl> = {
  // §1 argument reader
  UNKNOWN_FIELD: (p) => `Неизвестное поле ${q(p.field)} в ${whereRu(p.where)}`,
  MISSING_FIELD: (p) => `Не указано поле ${q(p.field)}`,
  NOT_A_NUMBER: (p) => `Поле ${q(p.field)} должно быть числом`,
  OUT_OF_RANGE: (p) => `Поле ${q(p.field)} = ${p.value} вне диапазона ${p.min}…${p.max}`,
  NOT_AN_INTEGER: (p) => `Поле ${q(p.field)} должно быть целым`,
  NOT_A_STRING: (p) => `Поле ${q(p.field)} должно быть строкой`,
  STRING_TOO_LONG: (p) => `Поле ${q(p.field)} длиннее ${p.maxLength} символов`,
  BAD_ENUM_VALUE: (p) => `Недопустимое значение ${q(p.value)} поля ${q(p.field)}`,
  NOT_A_BOOLEAN: (p) => `Поле ${q(p.field)} должно быть true/false`,
  NOT_AN_OBJECT: (p) => `Поле ${q(p.field)} должно быть объектом`,
  NOT_AN_ARRAY: (p) => `Поле ${q(p.field)} должно быть массивом`,
  MISSING_CONFIG: () => 'Не указана конфигурация (config)',
  // §2 command rules
  NOT_JSON_OBJECT: () => 'Команда не является JSON-объектом',
  BAD_ENVELOPE_TYPE: () => 'Тип конверта должен быть MaxiMallAI',
  CLIENT_SIDE_COMMAND: () => 'Эта команда выполняется на клиенте, а не на сервере',
  OFFSET_NEEDS_SEGMENT: () => 'offsetCm задаётся только вместе с segmentId',
  OPENING_NOT_OBJECT: (p) => `openings[${p.index}] должен быть объектом`,
  WHICH_SET: () => 'Уточните, какой комплект изменить',
  NOTHING_TO_CHANGE: (p) => (p.cmd === 'booth_configure' ? 'Укажите productId, config, customColour, clearCustomColour или doors' : 'Укажите config, customColour, clearCustomColour или doors'),
  USE_SWAP_SET: () => 'Смена товара выполняется командой swap_set',
  TRIM_NO_TILE: () => 'Наличник проёма красится, плитка на него не кладётся',
  TOO_MANY_CANDIDATES: (p) => `Не больше ${p.max ?? 40} кандидатов за раз`,
  CANDIDATE_NOT_OBJECT: () => 'Кандидат должен быть объектом',
  VISITOR_NOT_FOUND: () => 'Посетитель не найден',
  GESTURE_TARGET_NOT_FOUND: (p) => `Цель жеста ${p.id} не найдена`,
  PRODUCT_MISMATCH: () => 'productId и config.productId различаются',
  UNKNOWN_COMPONENT: (p) => `Неизвестная часть ${q(p.component)}`,
  DOORS_EMPTY: () => 'doors: укажите cabinet или closet',
  PLACEMENT_OR_SHIFT: () => 'Укажите либо placement, либо direction + distanceCm',
  OFFSET_OR_SHIFT: () => 'Укажите либо offsetCm, либо direction + distanceCm',
  OPENING_NOTHING_TO_CHANGE: () => 'Укажите, что изменить: положение или размер проёма',
  DOOR_HAS_NO_SILL: () => 'У двери нет подоконника',
  // §3 envelope, mode, ownership
  UNKNOWN_COMMAND: (p) => `Неизвестная команда ${q(p.cmd)}`,
  PLANNER_NOT_RUNNING: () => 'Планировщик комнаты не запущен',
  OPEN_CONSTRUCTOR_FIRST: () => 'Комнату меняют в «Конструкторе». Сначала откройте его.',
  PLANNER_BUSY: () => 'Конструктор сейчас занят другим посетителем. Подождите немного или попросите консультанта в салоне.',
  RATE_LIMITED: (p) => `Слишком много команд: не больше ${p.maxPerSecond} в секунду`,
  SERVER_ONLY: () => 'Команды ИИ выполняются только на сервере',
  INTERNAL_ERROR: () => 'Внутренняя ошибка',
  // §4
  ROOM_NOT_BUILT: () => 'Сначала нужно построить комнату',
  NO_CLOSED_ROOM: () => 'В плане нет замкнутой комнаты',
  ROOM_NOT_FOUND: (p) => `Комнаты ${p.roomId} нет`,
  NO_ROOM_WALLS: () => 'В плане нет стен, обращённых в комнату',
  CARRY_WAITS_FOR_ROOM: () => 'Комнаты ещё нет: комплект поставим, когда она будет построена',
  WALL_NOT_FOUND: (p) => (p.segmentId !== undefined ? `Стены ${p.segmentId} нет в плане` : 'Стена не найдена'),
  WALL_NOT_SPECIFIED: () => 'Не указана стена (segmentId)',
  SET_NOT_ON_WALL: () => 'Комплект не стоит у стены — передвинуть его не получится',
  SET_NOT_FOUND: (p) => `Гарнитура ${p.setId} нет в комнате`,
  UNDO_EMPTY: () => 'Нечего отменять',
  AI_CHANGED_NOTHING: () => 'ИИ ещё ничего не менял',
  // §5 NO_FIT
  WALL_TOO_SHORT: (p) => `Гарнитуру нужно ${p.requiredCm} см вдоль стены, а стена в свету — ${p.availableCm} см`,
  NO_FREE_SPAN: (p) => `Гарнитуру нужно ${p.requiredCm} см вдоль стены, а самый большой свободный участок — ${p.availableCm} см`,
  BLOCKED_AT_POSITION: (p) => `В этом месте гарнитуру мешает ${OBSTACLE_RU[String(p.obstacle)] ?? 'препятствие'}`,
  BEYOND_WALL_END: () => 'В этом месте гарнитур выходит за пределы стены',
  FITS_NO_WALL: (p) => `Гарнитур шириной ${p.requiredCm} см не помещается ни на одну стену комнаты`,
  // §6 openings
  OPENING_TOO_SMALL: (p) => kindPrefixRu(p, `Минимальный размер проёма — ${p.minCm ?? 10} см`),
  NEGATIVE_SILL: (p) => kindPrefixRu(p, 'Высота от пола не может быть отрицательной'),
  OPENING_TALLER_THAN_WALL: (p) => kindPrefixRu(p, `Проём выше стены (макс. ${p.maxCm} см)`),
  OPENING_BEYOND_WALL: (p) => kindPrefixRu(p, `Проём (${p.widthCm} см) не помещается на стене (${p.wallLengthCm} см)`),
  OPENING_OVERLAP: (p) => kindPrefixRu(p, 'Проём пересекается с соседним проёмом'),
  OPENING_OVER_SET: (p) => kindPrefixRu(p, p.kind === 'window' ? 'Окно перекрывает гарнитур у этой стены' : 'Дверь перекрывает гарнитур у этой стены'),
  OPENING_RESIZE_REJECTED: () => 'Размер проёма не изменился',
  OPENING_MOVE_REJECTED: () => 'Проём не сдвинулся',
  OPENING_NOT_FOUND: (p) => `Проёма ${q(p.openingId)} нет в плане`,
  // §7 catalog
  UNKNOWN_PRODUCT: (p) => `Товара ${q(p.productId)} нет в каталоге`,
  BAD_SIZE_INDEX: (p) => `У товара ${q(p.productId)} нет размера с индексом ${p.sizeIndex} (доступно: ${p.available})`,
  COLOUR_NOT_FOR_SIZE: (p) => `Цвет ${p.colourIndex} недоступен для размера ${p.sizeIndex} товара ${q(p.productId)}`,
  NO_COLOUR_OPTIONS: () => 'У этого товара нет вариантов цвета',
  NO_CLOSET_OPTION: () => 'У этого гарнитура нет навесного шкафа',
  BAD_CLOSET_INDEX: (p) => `Нет варианта навесного шкафа с индексом ${p.closetSizeIndex}`,
  BAD_CLOSET_COLOUR_INDEX: (p) => `Нет цвета навесного шкафа с индексом ${p.closetColourIndex}`,
  BAD_COMPONENT_INDEX: (p) => `Нет варианта ${COMPONENT_GEN_RU[p.component] ?? p.component} с индексом ${p.index} (доступно: ${p.available})`,
  COMPONENT_NOT_FOR_SIZE: (p) => `Вариант ${COMPONENT_GEN_RU[p.component] ?? p.component} ${p.index} недоступен для этого размера тумбы`,
  BAD_COMPONENT_COLOUR_INDEX: (p) => `Нет цвета ${COMPONENT_GEN_RU[p.component] ?? p.component} с индексом ${p.index} (доступно: ${p.available})`,
  COLLECTION_NOT_IN_BOOTH: (p) => `Коллекции ${q(p.productId)} нет в каталоге тумб этой витрины`,
  UNKNOWN_TILE: (p) => `Плитки ${p.tileId} нет в каталоге`,
  UNKNOWN_COLOUR: (p) => `Цвета ${p.system} ${p.code} нет в каталоге`,
  CUSTOM_COLOUR_NOT_ALLOWED: (p) => (p.target === 'booth' ? `Для части ${q(p.component)} этой витрины цвет RAL / NCS не выбирается` : `Для части ${q(p.component)} цвет RAL / NCS не выбирается`),
  NO_CLOSET_TO_PAINT: () => 'Навесного шкафа нет — красить нечего',
  CABINET_HAS_NO_DOORS: () => 'У тумбы нет дверец',
  NO_CLOSET: () => 'Навесного шкафа нет',
  CLOSET_HAS_NO_DOORS: () => 'У навесного шкафа нет дверец',
  // §8 booths
  NO_BOOTH_SELECTED: () => 'Не выбрана витрина: подойдите к тумбе или откройте её настройки',
  BOOTH_NOT_FOUND: (p) => `Витрины ${q(p.boothId)} нет в салоне`,
  BOOTH_UNDO_EMPTY: () => 'Для этой витрины нечего отменять',
  BOOTH_CHANGED_SINCE: () => 'Стенд уже изменили — вернуть прежний вид не получится',
  // §9 internal
  COLOUR_CATALOG_UNAVAILABLE: () => 'Каталог цветов RAL/NCS недоступен на сервере',
  CONFIG_CHECK_FAILED: () => 'Не удалось проверить конфигурацию гарнитура',
  MEASURE_FAILED: () => 'Не удалось измерить гарнитур',
  WALL_BUILD_FAILED: () => 'Не удалось построить стену',
  OPENING_ADD_FAILED: () => 'Проём не добавлен',
  OPENING_REMOVE_FAILED: () => 'Проём не удалён',
  OPENING_LOST: () => 'Проём пропал после изменения',
  SET_PLACE_FAILED: () => 'Не удалось разместить гарнитур',
  SET_CONFIGURE_FAILED: () => 'Не удалось настроить гарнитур',
  SET_SWAP_FAILED: () => 'Не удалось заменить гарнитур',
  SET_LOST: (p) => `Гарнитур пропал после ${p.cmd === 'swap_set' ? 'замены' : p.cmd === 'move_set' ? 'перемещения' : 'настройки'}`,
  FINISH_NOT_APPLIED: () => 'Отделка не применена',
  UNDO_RESTORE_FAILED: () => 'Не удалось восстановить предыдущее состояние',
  RESET_RESTORE_FAILED: () => 'Не удалось вернуть исходное состояние',
  CONSULTANT_SPAWN_FAILED: () => 'Не удалось вызвать консультанта',
  CONSULTANT_NOT_FOUND: () => 'Консультант не найден',
  NO_BOOTH_ACTOR: () => 'Нет витрины',
  NO_DISPATCHER: () => 'Диспетчер команд ИИ недоступен',
  // §10 client side
  BAD_REQUEST_ID: () => 'Нет корректного id запроса',
  NO_ARGS: () => 'Нет аргументов',
  MISSING_RENDER_ID: () => 'Не указан renderId',
  BAD_PRESET: (p) => `Недопустимый preset ${q(p.preset)}`,
  BAD_BOOTH_ID: () => 'boothId должен быть непустой строкой',
  BOOTH_PRESET_NEEDS_BOOTH_ID: () => 'Для preset «booth» нужен boothId',
  BOOTH_ID_ONLY_WITH_BOOTH_PRESET: () => 'boothId указывается только с preset «booth»',
  FRAME_SIZE_OUT_OF_RANGE: () => 'Размер кадра вне диапазона 256…3840 × 256…2160',
  BOOTH_PHOTO_SALON_ONLY: () => 'Фото стенда делается в салоне',
  NO_ROOM_FOR_PHOTO: () => 'Нет комнаты для снимка',
  CAPTURE_BUSY: () => 'Снимок уже делается',
  CAMERA_UNAVAILABLE: () => 'Камера для снимка недоступна',
  CAPTURE_ABORTED: (p) => `Снимок не получился: ${CAUSE_RU[String(p.cause)] ?? String(p.cause ?? '')}`,
  CAPTURE_FAILED: (p) => `Снимок не получился (${p.cause})`,
  PHOTO_UPLOAD_FAILED: (p) => `Не удалось отправить снимок (HTTP ${p.httpStatus})`,
  SAVE_UPLOAD_FAILED: (p) => `Не удалось сохранить проект (HTTP ${p.httpStatus})`,
  NOT_A_CLIENT_COMMAND: (p) => `${q(p.cmd)} не клиентская команда`,
};

const whereEn = (w: unknown) => (w === 'envelope' ? 'the envelope' : String(w ?? 'the command'));
export const REASON_DETAILS_EN: Record<string, Tpl> = {
  // §1 argument reader (the model sent bad arguments: the visitor sees a short neutral line)
  UNKNOWN_FIELD: (p) => `the command had an unknown field ${dq(p.field)} in ${whereEn(p.where)}`,
  MISSING_FIELD: (p) => `the field ${dq(p.field)} is missing`,
  NOT_A_NUMBER: (p) => `the field ${dq(p.field)} must be a number`,
  OUT_OF_RANGE: (p) => `${p.field} = ${p.value ?? '?'} is outside ${p.min}…${p.max}`,
  NOT_AN_INTEGER: (p) => `the field ${dq(p.field)} must be a whole number`,
  NOT_A_STRING: (p) => `the field ${dq(p.field)} must be text`,
  STRING_TOO_LONG: (p) => `the field ${dq(p.field)} is longer than ${p.maxLength} characters`,
  BAD_ENUM_VALUE: (p) => `${dq(p.value)} is not an allowed value of ${dq(p.field)}`,
  NOT_A_BOOLEAN: (p) => `the field ${dq(p.field)} must be true or false`,
  NOT_AN_OBJECT: (p) => `the field ${dq(p.field)} must be an object`,
  NOT_AN_ARRAY: (p) => `the field ${dq(p.field)} must be a list`,
  MISSING_CONFIG: () => 'the configuration (config) is missing',
  // §2
  NOT_JSON_OBJECT: () => 'the command is not a JSON object',
  BAD_ENVELOPE_TYPE: () => 'the envelope type must be MaxiMallAI',
  CLIENT_SIDE_COMMAND: () => 'this command runs on the client, not on the server',
  OFFSET_NEEDS_SEGMENT: () => 'offsetCm needs a segmentId',
  OPENING_NOT_OBJECT: (p) => `openings[${p.index}] must be an object`,
  WHICH_SET: () => 'which set should I change?',
  NOTHING_TO_CHANGE: () => 'nothing to change was given',
  USE_SWAP_SET: () => 'another product needs swap_set',
  TRIM_NO_TILE: () => 'a door or window frame can only be painted, not tiled',
  TOO_MANY_CANDIDATES: (p) => `no more than ${p.max ?? 40} candidates at once`,
  CANDIDATE_NOT_OBJECT: () => 'a candidate must be an object',
  VISITOR_NOT_FOUND: () => 'the visitor was not found',
  GESTURE_TARGET_NOT_FOUND: (p) => `the gesture target ${p.id} was not found`,
  PRODUCT_MISMATCH: () => 'productId and config.productId differ',
  UNKNOWN_COMPONENT: (p) => `unknown part ${dq(p.component)}`,
  DOORS_EMPTY: () => 'doors: give cabinet or closet',
  PLACEMENT_OR_SHIFT: () => 'give either a position or a direction with a distance',
  OFFSET_OR_SHIFT: () => 'give either offsetCm or a direction with a distance',
  OPENING_NOTHING_TO_CHANGE: () => 'say what to change: the position or the size of the opening',
  DOOR_HAS_NO_SILL: () => 'a door has no sill',
  // §3
  UNKNOWN_COMMAND: (p) => `the room does not know the command ${dq(p.cmd)}`,
  PLANNER_NOT_RUNNING: () => 'the room planner is not running',
  OPEN_CONSTRUCTOR_FIRST: () => 'the room is changed in the room planner — please open it first',
  PLANNER_BUSY: () => 'another visitor is using the room planner — please try again shortly',
  RATE_LIMITED: (p) => `too many commands: no more than ${p.maxPerSecond} per second`,
  SERVER_ONLY: () => 'an internal error in the room',
  INTERNAL_ERROR: () => 'an internal error in the room',
  // §4
  ROOM_NOT_BUILT: () => 'the room has to be built first',
  NO_CLOSED_ROOM: () => 'the plan has no closed room',
  ROOM_NOT_FOUND: (p) => `there is no room ${p.roomId}`,
  NO_ROOM_WALLS: () => 'the plan has no walls facing the room',
  CARRY_WAITS_FOR_ROOM: () => "there is no room yet: I'll place the set once it is built",
  WALL_NOT_FOUND: (p) => (p.segmentId !== undefined ? `there is no wall ${p.segmentId} in the plan` : 'the wall was not found'),
  WALL_NOT_SPECIFIED: () => 'no wall was given',
  SET_NOT_ON_WALL: () => "the set is not against a wall, so it can't be moved",
  SET_NOT_FOUND: (p) => `there is no set ${p.setId} in the room`,
  UNDO_EMPTY: () => 'there is nothing to undo',
  AI_CHANGED_NOTHING: () => "I haven't changed anything yet",
  // §5 NO_FIT
  WALL_TOO_SHORT: (p) => `the set needs ${p.requiredCm} cm along the wall, but the wall is only ${p.availableCm} cm`,
  NO_FREE_SPAN: (p) =>
    `the set needs ${p.requiredCm} cm along the wall, but the longest free stretch is ${p.availableCm} cm${p.obstacle && OBSTACLE_EN[String(p.obstacle)] ? ` (${OBSTACLE_EN[String(p.obstacle)]} is in the way)` : ''}`,
  BLOCKED_AT_POSITION: (p) => `${OBSTACLE_EN[String(p.obstacle)] ?? 'something'} is in the way at that spot`,
  BEYOND_WALL_END: () => 'at that spot the set would go past the end of the wall',
  FITS_NO_WALL: (p) => `a ${p.requiredCm} cm set doesn't fit on any wall of the room`,
  'NO_FIT.maxShift': (p) => `it can only move ${p.maxShiftCm} cm`,
  // §6 openings
  OPENING_TOO_SMALL: (p) => kindPrefixEn(p, `an opening must be at least ${p.minCm ?? 10} cm`),
  NEGATIVE_SILL: (p) => kindPrefixEn(p, "the sill height can't be below the floor"),
  OPENING_TALLER_THAN_WALL: (p) => kindPrefixEn(p, `the opening is taller than the wall (max ${p.maxCm} cm)`),
  OPENING_BEYOND_WALL: (p) => kindPrefixEn(p, `the opening (${p.widthCm} cm) doesn't fit on the wall (${p.wallLengthCm} cm)`),
  OPENING_OVERLAP: (p) => kindPrefixEn(p, 'the opening overlaps the neighbouring opening'),
  OPENING_OVER_SET: (p) => kindPrefixEn(p, `the ${p.kind === 'window' ? 'window' : 'door'} would cover the set on this wall`),
  OPENING_RESIZE_REJECTED: () => "the opening's size did not change",
  OPENING_MOVE_REJECTED: () => 'the opening did not move',
  OPENING_NOT_FOUND: (p) => `there is no opening ${dq(p.openingId)} in the plan`,
  // §7 catalog
  UNKNOWN_PRODUCT: (p) => `the product ${dq(p.productId)} is not in the catalogue`,
  BAD_SIZE_INDEX: (p) => `${p.productId} has no size with index ${p.sizeIndex} (available: ${p.available})`,
  COLOUR_NOT_FOR_SIZE: (p) => `colour ${p.colourIndex} is not available for size ${p.sizeIndex} of ${p.productId}`,
  NO_COLOUR_OPTIONS: () => 'this product has no colour options',
  NO_CLOSET_OPTION: () => 'this set has no wall cabinet',
  BAD_CLOSET_INDEX: (p) => `there is no wall cabinet option ${p.closetSizeIndex}`,
  BAD_CLOSET_COLOUR_INDEX: (p) => `there is no wall cabinet colour ${p.closetColourIndex}`,
  BAD_COMPONENT_INDEX: (p) => `there is no ${COMPONENT_EN[p.component] ?? p.component} option ${p.index} (available: ${p.available})`,
  COMPONENT_NOT_FOR_SIZE: (p) => `${COMPONENT_EN[p.component] ?? p.component} option ${p.index} is not available for this vanity width`,
  BAD_COMPONENT_COLOUR_INDEX: (p) => `there is no ${COMPONENT_EN[p.component] ?? p.component} colour ${p.index} (available: ${p.available})`,
  COLLECTION_NOT_IN_BOOTH: (p) => `${p.productId} is not offered on this display`,
  UNKNOWN_TILE: (p) => `the tile ${p.tileId} is not in the catalogue`,
  UNKNOWN_COLOUR: (p) => `${p.system} ${p.code} is not in the colour catalogue`,
  CUSTOM_COLOUR_NOT_ALLOWED: (p) => `a RAL / NCS colour can't be chosen for the ${COMPONENT_EN[p.component] ?? p.component}${p.target === 'booth' ? ' of this display' : ''}`,
  NO_CLOSET_TO_PAINT: () => 'there is no wall cabinet to paint',
  CABINET_HAS_NO_DOORS: () => 'the vanity unit has no doors',
  NO_CLOSET: () => 'there is no wall cabinet',
  CLOSET_HAS_NO_DOORS: () => 'the wall cabinet has no doors',
  // §8 booths
  NO_BOOTH_SELECTED: () => 'no display is selected: walk up to a vanity unit or open its settings',
  BOOTH_NOT_FOUND: () => 'that display is not in the showroom',
  BOOTH_UNDO_EMPTY: () => 'there is nothing to undo on this display',
  BOOTH_CHANGED_SINCE: () => "the display was changed since, so it can't be put back",
  // §9 internal: one generic sentence
  COLOUR_CATALOG_UNAVAILABLE: () => 'the RAL/NCS colour catalogue is not available on the server',
  CONFIG_CHECK_FAILED: () => 'an internal error in the room',
  MEASURE_FAILED: () => 'an internal error in the room',
  WALL_BUILD_FAILED: () => 'an internal error in the room',
  OPENING_ADD_FAILED: () => 'the opening was not added',
  OPENING_REMOVE_FAILED: () => 'the opening was not removed',
  OPENING_LOST: () => 'an internal error in the room',
  SET_PLACE_FAILED: () => 'the set could not be placed',
  SET_CONFIGURE_FAILED: () => 'the set could not be changed',
  SET_SWAP_FAILED: () => 'the set could not be replaced',
  SET_LOST: () => 'an internal error in the room',
  FINISH_NOT_APPLIED: () => 'the finish was not applied',
  UNDO_RESTORE_FAILED: () => 'the previous state could not be restored',
  RESET_RESTORE_FAILED: () => 'the initial state could not be restored',
  CONSULTANT_SPAWN_FAILED: () => 'an internal error in the room',
  CONSULTANT_NOT_FOUND: () => 'an internal error in the room',
  NO_BOOTH_ACTOR: () => 'an internal error in the room',
  NO_DISPATCHER: () => 'the room is not ready for commands',
  // §10 client side
  BAD_REQUEST_ID: () => 'the request had no valid id',
  NO_ARGS: () => 'the command had no arguments',
  MISSING_RENDER_ID: () => 'no renderId was given',
  BAD_PRESET: (p) => `${dq(p.preset)} is not a camera preset`,
  BAD_BOOTH_ID: () => 'boothId must be a non-empty string',
  BOOTH_PRESET_NEEDS_BOOTH_ID: () => 'the booth preset needs a boothId',
  BOOTH_ID_ONLY_WITH_BOOTH_PRESET: () => 'boothId goes only with the booth preset',
  FRAME_SIZE_OUT_OF_RANGE: () => 'the frame size is outside 256…3840 × 256…2160',
  BOOTH_PHOTO_SALON_ONLY: () => 'display photos are taken in the showroom',
  NO_ROOM_FOR_PHOTO: () => 'there is no room to photograph',
  CAPTURE_BUSY: () => 'a photo is already being taken',
  CAMERA_UNAVAILABLE: () => 'the camera is not available',
  CAPTURE_ABORTED: (p) => `the photo didn't work: ${CAUSE_EN[String(p.cause)] ?? 'it was interrupted'}`,
  CAPTURE_FAILED: () => "the photo didn't work",
  PHOTO_UPLOAD_FAILED: (p) => `the photo could not be uploaded (HTTP ${p.httpStatus})`,
  SAVE_UPLOAD_FAILED: (p) => `the project could not be saved (HTTP ${p.httpStatus})`,
  NOT_A_CLIENT_COMMAND: (p) => `${dq(p.cmd)} is not a client command`,
};

/** Details with no template by contract: always UE's `reason`. */
export const NO_TEMPLATE_DETAILS = new Set(['PLANNER_REJECTED']);

/** The template for (code, detail) in a table, or undefined. */
export function detailTemplate(table: Record<string, Tpl>, code: string | undefined, detail: string | undefined, params: P): string | undefined {
  if (!detail || NO_TEMPLATE_DETAILS.has(detail)) return undefined;
  const tpl = (code && table[`${code}.${detail}`]) || table[detail];
  if (!tpl) return undefined;
  let s = tpl(params);
  // move_set (v2.5 §5): when the set can go part of the way, the backend adds «it can only move N cm»
  if (code === 'NO_FIT' && typeof params.maxShiftCm === 'number' && params.maxShiftCm >= 1 && table['NO_FIT.maxShift']) s += `; ${table['NO_FIT.maxShift'](params)}`;
  return s;
}
