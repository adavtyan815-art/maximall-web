import type { LlmTool } from '../providers/llm';

const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

const partialConfig = obj({
  productId: { type: 'string' },
  sizeIndex: { type: 'integer', minimum: 0 },
  colourIndex: { type: 'integer', minimum: 0 },
  countertopSizeIndex: { type: 'integer', minimum: 0 },
  countertopColourIndex: { type: 'integer', minimum: 0 },
  closetSizeIndex: { type: 'integer', minimum: -1, description: '-1 removes the wall cabinet (пенал/навесной шкаф)' },
  closetColourIndex: { type: 'integer', minimum: 0 },
  sinkSizeIndex: { type: 'integer', minimum: 0 },
  sinkColourIndex: { type: 'integer', minimum: 0 },
  faucetSizeIndex: { type: 'integer', minimum: 0 },
  faucetColourIndex: { type: 'integer', minimum: 0 },
  mirrorSizeIndex: { type: 'integer', minimum: 0 },
  mirrorColourIndex: { type: 'integer', minimum: 0 },
});

/** Tools the model may call. Every tool maps to fit-checked, catalogue-validated UE commands executed on the server. */
export const TOOLS: LlmTool[] = [
  {
    name: 'get_state',
    description: 'Read the current planner room: walls with free spans, openings, placed sets (setId + config), finishes. Use before changing things you are not sure about.',
    input_schema: obj({}),
  },
  {
    name: 'build_room',
    description: 'Draw a rectangular bathroom (replaces the current planner layout of this visitor). Sizes in centimetres. Add a door/window only when the visitor mentioned one.',
    input_schema: obj(
      {
        widthCm: { type: 'number', minimum: 120, maximum: 1200 },
        depthCm: { type: 'number', minimum: 120, maximum: 1200 },
        heightCm: { type: 'number' },
        openings: {
          type: 'array',
          items: obj(
            {
              kind: { enum: ['door', 'window'] },
              wallIndex: { type: 'integer', minimum: 0, maximum: 3 },
              offsetCm: { type: 'number' },
              widthCm: { type: 'number' },
              heightCm: { type: 'number' },
              sillCm: { type: 'number' },
            },
            ['kind'],
          ),
        },
      },
      ['widthCm', 'depthCm'],
    ),
  },
  {
    name: 'propose_sets',
    description:
      'Propose up to three complete cabinet sets (tiers: best_fit, best_value, premium) that the server has fit-checked on a wall. Cards appear in the visitor chat with real catalogue prices. Use whenever the visitor wants options, a different style or a different budget.',
    input_schema: obj({
      budgetBYN: { type: 'number', description: 'Upper budget in BYN, only if the visitor named one' },
      style: { type: 'string', enum: ['light', 'dark', 'wood', 'white', 'grey', 'modern', 'warm', 'any'] },
      collection: { type: 'string', enum: ['Milu', 'Urban', 'Avenu', 'Terra', 'Tuma'] },
      withCloset: { type: 'boolean', description: 'Include a wall cabinet (пенал / навесной шкаф)' },
      segmentId: { type: 'integer', description: 'Wall segment; omit to let the solver pick the wall with the most free length' },
    }),
  },
  {
    name: 'apply_card',
    description: 'Place one of the cards proposed in this conversation (when the visitor chooses it by voice, e.g. «давай второй» / "the second one"). Cards tapped on screen are applied without you.',
    input_schema: obj({ cardId: { type: 'string' }, tier: { enum: ['best_fit', 'best_value', 'premium'] }, position: { type: 'integer', minimum: 1, maximum: 3 } }),
  },
  {
    name: 'configure_set',
    description:
      'Change a placed set like the configurator: cabinet width (sizeCm), colour, a part model by its id from list_options (part + option + colourId), wall cabinet on/off, RAL/NCS paint (paintCode) or removing it (clearPaint), doors open/closed. Only what you give changes; the server checks the catalogue rules and the wall. Omit setId for the last placed set. Use styleHint «lighter»/«darker» for lighter/darker. (config with raw indices is the legacy form.)',
    input_schema: obj({
      setId: { type: 'string' },
      part: { enum: ['cabinet', 'closet', 'countertop', 'sink', 'faucet', 'mirror'] },
      option: { type: 'string', description: 'Model id of that part from list_options (e.g. «NewRow_3», «ForMiluStoleshka», cabinet width «80»)' },
      colourId: { type: 'string', description: 'Colour id from list_options (SKU or catalogue id)' },
      colour: { type: 'string', description: 'Colour (cabinet / closet / part): a catalogue colour id (e.g. «walnut», «black_mdf»), or its name in Russian (e.g. «орех») or English (e.g. «walnut», «black MDF»)' },
      sizeCm: { type: 'number', description: 'Cabinet width in cm' },
      closet: { type: 'boolean', description: 'true = add the wall cabinet, false = remove it' },
      paintSystem: { enum: ['RAL', 'NCS'] },
      paintCode: { type: 'string' },
      clearPaint: { type: 'boolean', description: 'Remove the RAL/NCS paint of the part (back to the catalogue colour)' },
      doors: { enum: ['open', 'closed'], description: 'Open or close the doors (of the cabinet; with part «closet» of the wall cabinet)' },
      collection: { type: 'string', enum: ['Milu', 'Urban', 'Avenu', 'Terra', 'Tuma'], description: 'Another collection = proposals to replace the set' },
      styleHint: { enum: ['lighter', 'darker'] },
      config: partialConfig,
      addCloset: { type: 'boolean', description: 'The visitor asked to ADD a wall cabinet (пенал): if the set already has one, nothing changes (it is not resized).' },
    }),
  },
  {
    name: 'move_set',
    description:
      'Move a placed set (the same set: config and colours kept; fit-checked). direction left/right + distanceCm = along its wall as the visitor sees it standing in the room facing the set («чуть левее» = 10 cm); or position start/end/centre of its wall; or segmentId (+ offsetCm, the set centre from the wall start) to put it on another wall. If it does not fit, the result says how far it can go (maxShiftCm).',
    input_schema: obj({
      setId: { type: 'string' },
      direction: { enum: ['left', 'right'] },
      distanceCm: { type: 'number', minimum: 1, maximum: 1000 },
      position: { enum: ['start', 'end', 'centre'] },
      segmentId: { type: 'integer', description: 'Another wall (get_state walls)' },
      side: { enum: ['left', 'right'], description: 'Wall face (only for a wall with rooms on both sides)' },
      offsetCm: { type: 'number', description: 'Set centre distance from the wall start' },
    }),
  },
  {
    name: 'add_opening',
    description: 'Add a door or a window to a wall of the planner room (sizes in cm; offsetCm = near edge from the wall start). A door never goes over a set.',
    input_schema: obj(
      { kind: { enum: ['door', 'window'] }, segmentId: { type: 'integer' }, offsetCm: { type: 'number' }, widthCm: { type: 'number' }, heightCm: { type: 'number' }, sillCm: { type: 'number' } },
      ['kind'],
    ),
  },
  {
    name: 'update_opening',
    description:
      'Change a door or window: move it along its wall (direction left/right + distanceCm as seen from inside the room facing that wall, or offsetCm = near edge), change width/height or the window sill height. Identify it by openingId (get_state) or by kind when there is only one.',
    input_schema: obj({
      openingId: { type: 'string' },
      kind: { enum: ['door', 'window'] },
      segmentId: { type: 'integer' },
      direction: { enum: ['left', 'right'] },
      distanceCm: { type: 'number', minimum: 1, maximum: 1000 },
      offsetCm: { type: 'number' },
      widthCm: { type: 'number' },
      heightCm: { type: 'number' },
      sillCm: { type: 'number' },
    }),
  },
  {
    name: 'remove_opening',
    description: 'Remove a door or window (by openingId, or by kind when there is only one).',
    input_schema: obj({ openingId: { type: 'string' }, kind: { enum: ['door', 'window'] }, segmentId: { type: 'integer' } }),
  },
  {
    name: 'list_options',
    description:
      'The allowed options of the booth in focus (salon) or of a placed set (Constructor), exactly as the configurator offers them for its collection and width: cabinet sizes and colours, wall cabinet, countertops, sinks, faucets, mirrors — each with an id, a display name in the session language (Russian or English) and price. Use before changing a part, then pass option/colourId (ids work in every language).',
    input_schema: obj({ part: { enum: ['cabinet', 'closet', 'countertop', 'sink', 'faucet', 'mirror'] }, setId: { type: 'string' }, boothId: { type: 'string' } }),
  },
  {
    name: 'swap_set',
    description: 'Replace a placed set with a different product on the same wall (fit-checked).',
    input_schema: obj({ setId: { type: 'string' }, cardId: { type: 'string', description: 'Use the configuration of this proposed card' } }),
  },
  {
    name: 'remove_set',
    description: 'Remove a placed set.',
    input_schema: obj({ setId: { type: 'string' } }),
  },
  {
    name: 'finish_surface',
    description:
      'Paint walls / ceiling / baseboard / a door or window frame (opening_trim) or tile the floor and walls. Paint codes must be RAL (e.g. «RAL 9010») or NCS (e.g. «S 0502-Y»); tiles by DT_PlannerTiles row id. clear = back to the default finish.',
    input_schema: obj(
      {
        target: { enum: ['all_walls', 'wall_face', 'floor', 'ceiling', 'baseboard', 'opening_trim'] },
        segmentId: { type: 'integer' },
        side: { enum: ['left', 'right'] },
        openingId: { type: 'string', description: 'opening_trim: the door/window (or give kind when there is only one)' },
        kind: { enum: ['door', 'window'], description: 'opening_trim without openingId' },
        clear: { type: 'boolean', description: 'Remove the finish (back to the default material)' },
        paintSystem: { enum: ['RAL', 'NCS'] },
        paintCode: { type: 'string' },
        tileId: { type: 'string', description: 'DT_PlannerTiles row id: Tile_White30 (белая 30×30 / glossy white 30×30), Tile_Beige20 (бежевая 20×20 / beige 20×20), Tile_Sand45 (песочная 45×45 / sand 45×45), Tile_Grey60 (серый керамогранит 60×60 / grey porcelain stoneware 60×60)' },
      },
      ['target'],
    ),
  },
  {
    name: 'check_fit',
    description: 'Dry-run: does a configuration fit on a wall? Returns spare centimetres or the obstacle. No change to the room.',
    input_schema: obj({ config: partialConfig, segmentId: { type: 'integer' } }, ['config']),
  },
  { name: 'undo', description: 'Undo the last change made by the consultant.', input_schema: obj({}) },
  { name: 'reset_room', description: 'Start over: restore the room to how it was before the consultant started (visitor says «начнём сначала», «сбрось» / "start over", "clear the room").', input_schema: obj({}) },
  {
    name: 'save_project',
    description: 'Save the room and prepare the dossier (PDF with plan, specification, prices and photos) with a QR code for the visitor. Use when the visitor asks to send/save everything.',
    input_schema: obj({ projectName: { type: 'string' } }),
  },
  {
    name: 'take_photo',
    description:
      'Constructor: an AI-enhanced photo of the room (preview in a few seconds, high quality later). Showroom: a clean 3D photo of the salon booth in focus, or of the booth with the collection the visitor named (no AI); without a booth nearby the result says so.',
    input_schema: obj({ preset: { enum: ['corner', 'frontal', 'wide'] }, collection: { type: 'string', description: 'Showroom: the collection the visitor named (photo of that booth)' } }),
  },
  {
    name: 'catalog_lookup',
    description: 'Look up products, sizes, colours, dimensions and prices in the synced catalogue. The only source of prices.',
    input_schema: obj({ query: { type: 'string' } }, ['query']),
  },
  // ── v2.0 (two modes) ──
  {
    name: 'catalog_suggest',
    description: 'Showroom: suggest up to three complete sets from the catalogue as INFORMATION only (price BYN, dimensions, materials, «цена уточняется»). No placement, no fit check.',
    input_schema: obj({
      budgetBYN: { type: 'number' },
      style: { type: 'string', enum: ['light', 'dark', 'wood', 'white', 'grey', 'modern', 'warm', 'any'] },
      collection: { type: 'string', enum: ['Milu', 'Urban', 'Avenu', 'Terra', 'Tuma'] },
      withCloset: { type: 'boolean' },
    }),
  },
  { name: 'booth_get', description: 'Read the salon booth in focus (or boothId): its collection, configuration and the options of THIS booth.', input_schema: obj({ boothId: { type: 'string' } }) },
  {
    name: 'booth_configure',
    description:
      'Change the salon booth in focus like the right-click configurator (persistent). Give what the visitor asked: another collection, a cabinet width in cm, a colour, a part model by its id from list_options (part + option + colourId: countertop, sink, faucet, mirror, wall cabinet), closet on/off, a RAL/NCS paint code or removing it (clearPaint), doors open/closed, or lighter/darker.',
    input_schema: obj({
      boothId: { type: 'string' },
      collection: { type: 'string', enum: ['Milu', 'Urban', 'Avenu', 'Terra', 'Tuma'] },
      sizeCm: { type: 'number' },
      colour: { type: 'string', description: 'Colour from the booth options: a catalogue colour id (e.g. «white», «walnut», «black_mdf») or its name in Russian (e.g. «белый», «орех») or English (e.g. «white», «walnut»)' },
      part: { enum: ['cabinet', 'closet', 'countertop', 'sink', 'faucet', 'mirror'] },
      option: { type: 'string', description: 'Model id of that part from list_options' },
      colourId: { type: 'string', description: 'Colour id from list_options (SKU or catalogue id)' },
      closet: { type: 'boolean', description: 'true = add the wall cabinet, false = remove it' },
      paintSystem: { enum: ['RAL', 'NCS'] },
      paintCode: { type: 'string' },
      clearPaint: { type: 'boolean', description: 'Remove the RAL/NCS paint of the part' },
      doors: { enum: ['open', 'closed'], description: 'Open or close the doors (of the cabinet; with part «closet» of the wall cabinet)' },
      styleHint: { enum: ['lighter', 'darker'] },
    }),
  },
  { name: 'booth_undo', description: 'Undo the last change of the booth in focus («верни как было» / "put it back").', input_schema: obj({ boothId: { type: 'string' } }) },
  {
    name: 'offer_constructor',
    description: 'Showroom: offer to show the model in real size in the Constructor room (the room planner; buttons «Да, перейти» / «Нет, остаться», in English "Yes, open the room planner" / "Stay here"). The move happens only after the visitor says yes. One offer per topic.',
    input_schema: obj({ topic: { type: 'string' } }),
  },
  { name: 'exit_constructor', description: 'Constructor: leave the room and return to the salon (visitor asks to go back).', input_schema: obj({}) },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** v2.0: the tools the model sees in a mode. */
export function toolsFor(allowed: Set<string>): LlmTool[] {
  return TOOLS.filter((t) => allowed.has(t.name));
}
