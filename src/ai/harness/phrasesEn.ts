import type { Phrase } from './phrases';

/**
 * Contracts v2.5: ~55 realistic ENGLISH visitor phrases with the expected tool behaviour (mock policy = intentsEn.ts;
 * the same set is meant for the paid English harness run). Runs with the session language `en` (runHarness(..., 'en')).
 * Replies are checked against the English locale table (designer terminology: room planner, display, worktop, tap).
 */
const ROOM = 'My bathroom is 2 by 2.5 metres, door on the short wall';
const ROOM_CARDS = [ROOM, 'Show me options up to 5000 BYN'];
const WITH_SET = [...ROOM_CARDS, "Let's take the first option"];
const S = 'showroom' as const;
const C = 'constructor' as const;
const FIT = 'Would this vanity unit fit in my bathroom?';

export const PHRASES_EN: Phrase[] = [
  // room planner: sizes, budgets, styles
  { id: 'en-room-01', group: 'room', mode: C, text: 'My bathroom is two by three metres', expect: { tools: ['build_room'], reply: 'built a 200 by 300 cm room' } },
  { id: 'en-room-02', group: 'room', mode: C, text: 'The room is 250 by 180 cm with a window', expect: { tools: ['build_room'], not: ['finish_surface'] } },
  { id: 'en-room-03', group: 'room', mode: C, text: 'Bathroom 3 x 2.4 m, budget 4000 BYN', expect: { tools: ['build_room', 'propose_sets'] } },
  { id: 'en-budget-01', group: 'budget', mode: C, setup: [ROOM], text: 'My budget is up to 3000 rubles', expect: { tools: ['propose_sets'] } },
  { id: 'en-budget-02', group: 'budget', mode: C, setup: [ROOM], text: 'Show me options under 6,000 BYN', expect: { tools: ['propose_sets'], reply: 'BYN' } },
  { id: 'en-style-01', group: 'style', mode: C, setup: [ROOM], text: 'I would like light furniture', expect: { tools: ['propose_sets'], not: ['finish_surface'] } },
  { id: 'en-style-02', group: 'style', mode: C, setup: [ROOM], text: 'Show me the Milu collection', expect: { tools: ['propose_sets'], reply: 'Milu' } },
  // pick, refine
  { id: 'en-pick-01', group: 'pick', mode: C, setup: ROOM_CARDS, text: "Let's go with the second option", expect: { tools: ['apply_card'], reply: "I've placed" } },
  { id: 'en-pick-02', group: 'pick', mode: C, setup: ROOM_CARDS, text: "I'll take the first one", expect: { tools: ['apply_card'] } },
  { id: 'en-refine-01', group: 'refine', mode: C, setup: WITH_SET, text: 'Make it lighter', expect: { tools: ['configure_set'] } },
  { id: 'en-refine-02', group: 'refine', mode: C, setup: WITH_SET, text: 'Add a wall cabinet', expect: { tools: ['configure_set'], reply: 'wall cabinet' } },
  { id: 'en-refine-03', group: 'refine', mode: C, setup: WITH_SET, text: 'Remove the wall cabinet', expect: { tools: ['configure_set'] } },
  // finishes, photo, save
  { id: 'en-finish-01', group: 'finish', mode: C, setup: WITH_SET, text: 'Paint the walls white', expect: { tools: ['finish_surface'], reply: 'walls.*RAL 9010' } },
  { id: 'en-finish-02', group: 'finish', mode: C, setup: WITH_SET, text: 'Grey tiles on the floor', expect: { tools: ['finish_surface'], reply: 'floor.*grey porcelain' } },
  { id: 'en-photo-01', group: 'photo', mode: C, setup: WITH_SET, text: 'Take a photo', expect: { tools: ['take_photo'], reply: 'photo' } },
  { id: 'en-save-01', group: 'save', mode: C, setup: WITH_SET, text: 'Send me everything', expect: { tools: ['save_project'], reply: 'project summary' } },
  { id: 'en-save-02', group: 'save', mode: C, setup: WITH_SET, text: 'Save the project as a PDF', expect: { tools: ['save_project'] } },
  // undo, start over, v2.4 actions
  { id: 'en-undo-01', group: 'undo', mode: C, setup: WITH_SET, text: 'Undo that', expect: { tools: ['undo'] } },
  { id: 'en-undo-02', group: 'undo', mode: C, setup: WITH_SET, text: "Let's start over", expect: { tools: ['reset_room'], reply: 'Starting over' } },
  { id: 'en-move-01', group: 'v24', mode: C, setup: WITH_SET, text: 'Move the set 20 cm to the left', expect: { tools: ['move_set'], cmds: ['move_set'], reply: 'to the left' } },
  { id: 'en-doors-01', group: 'v24', mode: C, setup: WITH_SET, text: 'Open the doors', expect: { tools: ['configure_set'], cmds: ['configure_set'], reply: 'opened the doors' } },
  { id: 'en-options-01', group: 'v24', mode: C, setup: WITH_SET, text: 'Which mirrors are available?', expect: { tools: ['list_options'], reply: 'Mirror' } },
  { id: 'en-opening-01', group: 'v24', mode: C, setup: ['The bathroom is 2 by 2.5 metres with a window'], text: 'Remove the window', expect: { tools: ['remove_opening'], cmds: ['remove_opening'], reply: 'removed the window' } },
  // guardrails
  { id: 'en-guard-01', group: 'guard', mode: C, setup: WITH_SET, text: 'Can you give me a 20% discount?', expect: { none: true, reply: 'manager' } },
  { id: 'en-guard-02', group: 'guard', mode: C, setup: WITH_SET, text: 'Is there a promo code or a sale?', expect: { none: true, reply: 'manager' } },
  { id: 'en-deliv-01', group: 'delivery', mode: C, setup: WITH_SET, text: 'When can you deliver it?', expect: { none: true, reply: 'manager' } },
  { id: 'en-deliv-02', group: 'delivery', mode: C, setup: WITH_SET, text: 'What is the warranty on the vanity unit?', expect: { none: true, reply: 'manager' } },
  { id: 'en-off-01', group: 'offtopic', mode: C, text: "What's the weather tomorrow?", expect: { none: true, reply: 'bathroom' } },
  // leaving the room planner
  { id: 'en-exit-01', group: 'exit', mode: C, text: 'Please exit the room planner', expect: { modeAfter: S, cmds: ['exit_constructor'], reply: 'back in the showroom' } },
  { id: 'en-exit-02', group: 'exit', mode: C, text: 'Take me back to the showroom', expect: { modeAfter: S, cmds: ['exit_constructor'] } },
  { id: 'en-exit-not', group: 'exit', mode: C, text: "Don't leave the room planner, show me options", expect: { modeAfter: C, notCmds: ['exit_constructor'] } },
  // showroom: consent to the room planner
  { id: 'en-sr-fit-01', group: 'consent', mode: S, focus: 'Milu', text: FIT, expect: { offer: 'constructor', modeAfter: S, noRoom: true, reply: 'room planner' } },
  { id: 'en-sr-yes-01', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Yes', expect: { modeAfter: C, cmds: ['enter_constructor'], reply: "We're in the room planner" } },
  { id: 'en-sr-yes-02', group: 'consent', mode: S, focus: 'Urban', setup: [FIT], text: "Sure, let's go", expect: { modeAfter: C, cmds: ['enter_constructor'] } },
  { id: 'en-sr-yes-03', group: 'consent', mode: S, focus: 'Avenu', setup: [FIT], text: 'Ok', expect: { modeAfter: C, cmds: ['enter_constructor'] } },
  { id: 'en-sr-yes-btn', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: '', answer: 'yes', expect: { modeAfter: C, cmds: ['enter_constructor'] } },
  { id: 'en-sr-no-01', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'No, thanks', expect: { modeAfter: S, notCmds: ['enter_constructor'], reply: "stay in the showroom" } },
  { id: 'en-sr-no-02', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Maybe later', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
  { id: 'en-sr-no-03', group: 'consent', mode: S, focus: 'Milu', setup: [FIT], text: 'Yes, but not now', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
  { id: 'en-sr-ask', group: 'consent', mode: S, focus: 'Milu', setup: [FIT, 'No'], text: "Let's go to the room planner after all", expect: { offer: 'none', modeAfter: C, cmds: ['enter_constructor'] } },
  { id: 'en-sr-ask-q', group: 'consent', mode: S, focus: 'Milu', text: 'What is the room planner?', expect: { modeAfter: S, notCmds: ['enter_constructor'] } },
  { id: 'en-sr-design', group: 'consent', mode: S, text: 'Design my bathroom', expect: { modeAfter: C, cmds: ['enter_constructor'] } },
  { id: 'en-sr-room-walls', group: 'consent', mode: S, text: 'Paint the walls white', expect: { offer: 'constructor', noRoom: true, notCmds: ['booth_configure'], reply: 'room planner' } },
  { id: 'en-sr-dossier', group: 'consent', mode: S, text: 'Send me everything', expect: { offer: 'constructor', noRoom: true, reply: 'project summary' } },
  { id: 'en-sr-fitq', group: 'consent', mode: S, focus: 'Milu', text: 'Will the 100 cm vanity unit fit in my 1.7 by 1.5 bathroom?', expect: { offer: 'constructor', notCmds: ['booth_configure'], noRoom: true, reply: 'Milu 100.*170 cm.*fits' } },
  // showroom: the display dialogue
  { id: 'en-sr-this', group: 'booth', mode: S, focus: 'Urban', text: 'This one', expect: { cmds: ['booth_get'], reply: 'Urban.*BYN' } },
  { id: 'en-sr-other', group: 'booth', mode: S, focus: 'Milu', text: 'Other collections', expect: { offer: 'collection_pick', noRoom: true } },
  { id: 'en-sr-other-later', group: 'booth', mode: S, focus: 'Terra', setup: [{ answer: 'this' }], text: 'Show me other collections', expect: { offer: 'collection_pick', notCmds: ['booth_configure'] } },
  { id: 'en-sr-named', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Put Urban here instead', expect: { offer: 'none', cmds: ['booth_configure'], reply: "I've put Urban on the display" } },
  { id: 'en-sr-size', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Make it 100 cm', expect: { cmds: ['booth_configure'], reply: 'changed the size to 100 cm' } },
  { id: 'en-sr-colour', group: 'booth', mode: S, focus: 'Urban', setup: [{ answer: 'this' }], text: 'I want it in white', expect: { cmds: ['booth_configure'], reply: 'white' } },
  { id: 'en-sr-closet', group: 'booth', mode: S, focus: 'Avenu', setup: [{ answer: 'this' }], text: 'Add a wall cabinet', expect: { cmds: ['booth_configure'], reply: 'added the wall cabinet' } },
  { id: 'en-sr-closet-none', group: 'booth', mode: S, focus: 'Terra', setup: [{ answer: 'this' }], text: 'Add a wall cabinet', expect: { notCmds: ['booth_configure'], reply: 'no wall cabinet' } },
  { id: 'en-sr-ral', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }], text: 'Paint the vanity unit RAL 9010', expect: { cmds: ['booth_configure'], reply: 'RAL 9010' } },
  { id: 'en-sr-revert', group: 'booth', mode: S, focus: 'Milu', setup: [{ answer: 'this' }, 'Make it 100 cm'], text: 'Put it back as it was', expect: { tools: ['booth_undo'], cmds: ['booth_undo'], reply: 'back as it was' } },
  { id: 'en-sr-photo', group: 'photo', mode: S, focus: 'Milu', text: 'Take a photo of this display', expect: { cmds: ['capture'], noRoom: true, offer: 'none', reply: 'Photographing the Milu display' } },
  { id: 'en-sr-photo-room', group: 'photo', mode: S, focus: 'Milu', text: 'Take a photo of the room', expect: { notCmds: ['capture'], noRoom: true, offer: 'constructor', reply: 'room planner' } },
  { id: 'en-sr-catalog-01', group: 'booth', mode: S, text: 'Show me options up to 3000 BYN', expect: { tools: ['catalog_suggest'], noRoom: true, reply: 'BYN' } },
  { id: 'en-sr-catalog-02', group: 'booth', mode: S, text: 'How much is Avenu?', expect: { tools: ['catalog_lookup'], noRoom: true, reply: 'Avenu.*from' } },
  { id: 'en-sr-taps', group: 'v24', mode: S, focus: 'Urban', setup: [{ answer: 'this' }], text: 'Which taps are available?', expect: { tools: ['list_options'], noRoom: true, reply: 'Tap' } },
];
