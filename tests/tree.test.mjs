import {AutoTile} from './.tree-under-test.mjs';
import {tileable} from './.rules-under-test.mjs';
import {readFileSync} from 'node:fs';
import {BORROWED_SHORTCUTS, SHORTCUT_GROUPS} from '../shortcuts.js';
import {FocusOutline, GDesktopEnums, Main, Meta, Settings, apps, bound, chords as press, clockStep, global,
    hold, limit, pump, queued, rect, release, schemas, setFocus, setFocusMode, setMru, setPointer,
    setWorkspaceIndex, tick, win} from './stubs.mjs';

let failures = 0;
const expect = (label, ok, detail = '') => {
    if (!ok)
        failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`);
};
const check = (label, window, want) => {
    const got = `${window.frame}`;
    expect(label, got === want, got === want ? got : `${got}   expected ${want}`);
};
const section = title => console.log(`\n${title}`);

const schemaText = readFileSync(new URL(
    '../schemas/org.gnome.shell.extensions.mantel.gschema.xml', import.meta.url), 'utf8');
const floatApps = JSON.parse(schemaText
    .match(/<key name="float-apps" type="as">\s*<default>(\[.*?\])<\/default>/)[1]
    .replace(/'/g, '"'));

const newTiler = () => {
    const tiler = new AutoTile(new Settings({gap: 0, border: 0, debug: false, 'float-apps': floatApps,
        'focus-follows-mouse': true}));
    tiler._outline = new FocusOutline();
    return tiler;
};
const open = (tiler, window, order, preferred = null) => {
    setMru(order);
    tiler._apply(tiler._insert(window, preferred));
};
const close = (tiler, window, order) => {
    setMru(order);
    tiler._apply(tiler._detach(window));
};
const shape = (tiler, key = '0:0') =>
    tiler._leaves(tiler._trees.get(key)).map(leaf => leaf.window.title).join(',');

let t = newTiler();
const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(name => win(name));

section('open A, B, C, D  (each splits the window focused before it)');
open(t, A, []);
expect('A alone is maximized', A.is_maximized(), `${A.frame}`);
open(t, B, [A]);
open(t, C, [B, A]);
open(t, D, [C, B, A]);
check('A left half', A, '768x960+0+0');
expect('and no longer maximized', !A.get_maximize_flags());
check('B top of the right half', B, '768x480+768+0');
check('C under B', C, '384x480+768+480');
check('D beside C', D, '384x480+1152+480');

section('neighbours  (sharing an edge; of several, the most recent)');
const answers = {
    A: [null, 'B', null, null], B: ['A', null, null, 'C'],
    C: ['A', 'D', 'B', null], D: ['C', null, 'B', null],
};
setMru([B, C, D, A]);
for (const window of [A, B, C, D]) {
    ['left', 'right', 'up', 'down'].forEach((direction, i) => {
        const got = t._neighbour(t._findLeaf(window), direction)?.title ?? null;
        expect(`${window.title} ${direction}`, got === answers[window.title][i], `${got}`);
    });
}
setMru([C, B, D, A]);
expect('A right, with C used more recently', t._neighbour(t._findLeaf(A), 'right') === C);

section('focus  (past the edge, the monitor that way)');
const Other = win('Other', {monitor: 1});
setMru([B, Other, C, D, A]);
setFocus(A);
t._focus('right');
expect('A right is B', global.display.focus_window === B);
t._focus('right');
expect('past the edge, the other monitor', global.display.focus_window === Other);
setFocus(A);
t._focus('left');
expect('nothing that way, nothing happens', global.display.focus_window === A);

section('swap  (the windows exchange tiles, focus follows)');
setMru([B, C, D, A]);
t._swap('right');
check('A takes B tile', A, '768x480+768+0');
check('B takes A tile', B, '768x960+0+0');
expect('focus follows A', global.display.focus_window === A);
t._swap('left');
check('and back', A, '768x960+0+0');

section('the pointer  (kept on the focused window while focus follows it)');
const pointerAt = () => global.get_pointer().slice(0, 2).join();
setPointer(100, 100);
t._bindKeys(true);
press.get('swap-right')();
expect('it goes with a swapped window', pointerAt() === '1152,240', pointerAt());
press.get('focus-left')();
expect('and to the window focused', pointerAt() === '384,480', pointerAt());
setPointer(100, 100);
press.get('toggle-split')();
expect('but stays put while it is on it', pointerAt() === '100,100', pointerAt());
press.get('toggle-split')();
setFocusMode(GDesktopEnums.FocusMode.CLICK);
press.get('focus-right')();
expect('focus by click leaves it alone', pointerAt() === '100,100', pointerAt());
setFocus(A);
press.get('swap-left')();
setFocusMode(GDesktopEnums.FocusMode.SLOPPY);
t._bindKeys(false);
check('the layout is as it was', A, '768x960+0+0');

section('close D, B, A  (the sibling takes the space)');
close(t, D, [C, B, A]);
check('C takes D space', C, '768x480+768+480');
close(t, B, [C, A]);
check('C takes the right half', C, '768x960+768+0');
check('A untouched', A, '768x960+0+0');
close(t, A, [C]);
expect('C alone is maximized', C.is_maximized() && `${C.frame}` === '1536x960+0+0', `${C.frame}`);

section('minimize and restore  (out of the layout and back)');
open(t, A, [C]);
A.minimized = true;
t._apply(t._detach(A));
expect('C fills it meanwhile', C.is_maximized());
A.minimized = false;
open(t, A, [A, C]);
check('C gives up half again', C, '768x960+0+0');
check('A takes the other half', A, '768x960+768+0');
const before = shape(t);
t._apply(t._insert(A));
expect('a second insert is refused', shape(t) === before, shape(t));

section('split and resize');
setFocus(C);
t._toggleSplit();
check('stacked, C on top', C, '1536x480+0+0');
check('A below', A, '1536x480+0+480');
t._toggleSplit();
t._resize(true, 100);
check('the division moves right', C, '868x960+0+0');
check('A gives way', A, '668x960+868+0');
setFocus(A);
t._resize(true, -100);
check('and back, from the other side', C, '768x960+0+0');
t._resize(false, 100);
check('no division that way, nothing moves', A, '768x960+768+0');
for (let i = 0; i < 20; i++)
    t._resize(true, 300);
check('held back from the edge', C, `${Math.round(1536 * 0.9)}x960+0+0`);
t._trees.get('0:0').ratio = 0.5;
t._apply('0:0');

section('gaps and the outline  (flush with the screen, one gap between)');
t._settings.set_int('gap', 6);
t._apply('0:0');
check('C half a gap in on its shared edge', C, '765x960+0+0');
check('A the same', A, '765x960+771+0');
t._settings.set_int('border', 2);
t._apply('0:0');
check('screen edges keep room for the outline', C, '763x956+2+2');
check('A too', A, '763x956+771+2');
// This machine: 1536x960 logical is a 1920x1200 panel at 125%.
t._settings.set_int('gap', 8);
t._settings.set_int('border', 4);
t._apply('0:0');
const edges = [C, A].flatMap(({frame: {x, y, width, height}}) =>
    [x, y, x + width, y + height, x - 4, y - 4, x + width + 4, y + height + 4]);
const offGrid = edges.filter(v => Math.abs(v * 1.25 - Math.round(v * 1.25)) > 0.001);
expect('every edge on a whole pixel', !offGrid.length, offGrid.join(',') || `${edges.length} edges`);
close(t, A, [C]);
expect('alone, flush and maximized all the same', C.is_maximized());
open(t, A, [C]);
t._settings.set_int('border', 0);
t._settings.set_int('gap', 6);
t._apply('0:0');

section('settle  (a window not in its tile is asked again)');
const R = win('R');
let refusals = 1;
R.move_resize_frame = function (_userOp, x, y, width, height) {
    this.placements++;
    this.frame = refusals-- > 0 ? rect(400, 0, 768, 960) : rect(x, y, width, height);
};
const placed = () => [A, C, R].map(w => w.placements);
const [a0, c0] = placed();
open(t, R, [A, C]);
expect('the refusing window is asked twice', R.placements === 2, `${R.placements}`);
expect('the one it split, once', A.placements - a0 === 1, `${A.placements - a0}`);
expect('the rest, not at all', C.placements === c0, `${C.placements - c0}`);
t._track(R);
R.frame = rect(10, 10, 300, 300);
R.emit('position-changed');
check('an app moving it itself is put back', R, '765x477+771+483');
close(t, R, [A, C]);
t._settle('0:0');
expect('a settled tree asks nothing', A.placements - a0 === 2, `${A.placements - a0}`);

section('drag a shared edge  (the division follows)');
t._onGrabBegin(C, Meta.GrabOp.RESIZING_E | 1024);
C.frame = rect(0, 0, 997, 960);
C.emit('size-changed');
expect('the division moved', Math.abs(t._trees.get('0:0').ratio - 1000 / 1536) < 0.001,
    t._trees.get('0:0').ratio.toFixed(4));
check('A follows as it is dragged', A, '533x960+1003+0');
t._settle('0:0');
check('C is left to the user meanwhile', C, '997x960+0+0');
t._onGrabEnd(C, Meta.GrabOp.RESIZING_E | 1024);
check('C keeps the dragged width', C, '997x960+0+0');
expect('the grab lets go of it', !t._grabbed && !C.connected.size);

section('drop  (on another window the two swap, elsewhere it goes back)');
setPointer(1200, 400);
t._onGrabBegin(C, Meta.GrabOp.MOVING);
C.frame = rect(900, 100, 997, 960);
t._onGrabEnd(C, Meta.GrabOp.MOVING | 1024);
check('C took A tile', C, '533x960+1003+0');
check('A took C tile', A, '997x960+0+0');
t._onGrabBegin(C, Meta.GrabOp.KEYBOARD_MOVING);
C.frame = rect(50, 50, 533, 960);
t._onGrabEnd(C, Meta.GrabOp.KEYBOARD_MOVING);
check('dropped on itself, back in its tile', C, '533x960+1003+0');
t._trees.get('0:0').ratio = 0.5;
t._settings.set_int('gap', 0);
t._apply('0:0');

section('float  (out of the layout, above it, at its own size)');
setFocus(C);
t._toggleFloat();
expect('A has it to itself', A.is_maximized());
check('C back at its own size', C, '600x400+100+100');
expect('C above the layout', C.above);
t._resize(true, 100);
check('a resize key widens it', C, '700x400+100+100');
t._resize(false, -25);
check('or makes it shorter', C, '700x375+100+100');
setMru([C, A]);
t._toggleFloat();
check('again, C rejoins', C, '768x960+768+0');
expect('and is no longer above', !C.above);

section('pseudo-tile  (its own size, centred in its tile)');
t._untiled.set(A, rect(0, 0, 400, 300));
setFocus(A);
t._togglePseudo();
check('A at its own size, centred', A, '400x300+184+330');
t._settle('0:0');
check('which is not taken for drift', A, '400x300+184+330');
t._untiled.set(A, rect(0, 0, 1000, 600));
t._apply('0:0');
check('too big, scaled to fit', A, '768x461+0+250');
t._untiled.set(A, rect(0, 0, 400, 300));
setMru([C, A]);
t._swap('right');
check('it travels with A through a swap', A, '400x300+952+330');
check('C fills the tile A left', C, '768x960+0+0');
t._swap('left');
t._togglePseudo();
check('again gives the tile back', A, '768x960+0+0');

section('pop out  (centred, in front, on every workspace)');
setFocus(C);
setMru([C, A]);
t._togglePop();
expect('A alone', A.is_maximized());
check('C centred at 1300x900', C, '1300x900+118+30');
expect('in front, on every workspace', C.above && C.stuck);
t._togglePop();
check('again, C rejoins', C, '768x960+768+0');
expect('neither above nor pinned now', !C.above && !C.stuck);

section('scratchpad  (put away minimized, shown over the workspace)');
t._toggleScratchpad();
expect('empty, nothing happens', !t._scratch.size);
setFocus(C);
t._toScratchpad();
expect('A alone', A.is_maximized());
expect('C put away', C.minimized && t._scratch.has(C));
t._toggleScratchpad();
expect('shown', !C.minimized);
t._toggleScratchpad();
expect('put away again', C.minimized);
t._toggleScratchpad();
t._hideScratchpad();
expect('a workspace switch puts it away', C.minimized);
t._toggleScratchpad();
setFocus(C);
setMru([C, A]);
t._toggleFloat();
check('the float chord brings it into the layout', C, '768x960+768+0');
expect('and out of the scratchpad', !t._scratch.has(C) && !C.above);

section('maximized  (floats over the tile it keeps)');
for (const window of [A, C])
    t._track(window);
A.maximize();
expect('beside C, it floats over its tile', t._maximized.has(A) && A.is_maximized() &&
    !!t._findLeaf(A));
C.raise();
t._keepFloatsOnTop();
expect('a tiled window raised over it is answered', A.stacked > C.stacked);
const raisedAt = A.stacked;
t._keepFloatsOnTop();
expect('and on top, it is left there', A.stacked === raisedAt);
t._settle('0:0');
t._apply('0:0');
expect('nothing puts it back meanwhile', A.is_maximized());
A.unmaximize();
check('unmaximized, it takes its tile back', A, '768x960+0+0');
C.raise();
t._keepFloatsOnTop();
expect('and may be covered again', A.stacked < C.stacked);
setFocus(A);
t._toggleMaximize();
expect('the maximize chord floats it the same way', t._maximized.has(A));
t._toggleMaximize();
check('and again puts it back', A, '768x960+0+0');
A.maximize();
t._toggleFloat();
check('so does the float chord', A, '768x960+0+0');
A.maximize();
setPointer(1200, 400);
t._onGrabBegin(A, Meta.GrabOp.MOVING);
t._onGrabEnd(A, Meta.GrabOp.MOVING);
expect('a grab that left it maximized swaps nothing', t._maximized.has(A) &&
    t._findLeaf(C).leaf.rect.x === 768);
setMru([A, C]);
t._togglePop();
expect('popped, it is maximized no longer', !t._maximized.has(A) && t._popped.has(A) &&
    !A.get_maximize_flags() && A.above);
t._togglePop();
t._swap('left');
check('and rejoins where it was', A, '768x960+0+0');
t._toggleFloat();
A.maximize();
C.raise();
t._keepFloatsOnTop();
expect('floating, then maximized, it stays on top', A.stacked > C.stacked);
A.unmaximize();
setMru([A, C]);
t._toggleFloat();
t._swap('left');
check('back in the layout', A, '768x960+0+0');
for (const window of [A, C])
    window.disconnectObject();

section('focus under a maximized window  (it takes over)');
for (const window of [A, C])
    t._track(window);
A.maximize();
setFocus(C);
t._enforce(C);
expect('C is maximized in its place', t._maximized.has(C) && C.is_maximized());
expect('and A is back in its tile', !t._maximized.has(A) && !A.get_maximize_flags() &&
    `${A.frame}` === '768x960+0+0', `${A.frame}`);
t._enforce(C);
expect('focused again, nothing changes', t._maximized.has(C) && t._maximized.size === 1);
C.unmaximize();
setFocus(A);
t._enforce(A);
expect('with nothing maximized, focus changes nothing', !A.get_maximize_flags() && !C.get_maximize_flags());
check('C in its tile', C, '768x960+768+0');
for (const window of [A, C])
    window.disconnectObject();

const Only = win('Only');
setWorkspaceIndex(3);
t._track(Only);
open(t, Only, []);
expect('the layout\'s own maximize is not the app\'s', Only.is_maximized() && !t._maximized.has(Only));
setFocus(Only);
t._toggleMaximize();
expect('and the chord leaves it alone', Only.is_maximized());
close(t, Only, []);
setWorkspaceIndex(0);

section('fullscreen  (keeps its tile)');
A.fullscreen = true;
t._trees.get('0:0').ratio = 0.6;
t._apply('0:0');
check('it is not placed meanwhile', A, '768x960+0+0');
check('while C takes its new share', C, '614x960+922+0');
A.fullscreen = false;
t._apply('0:0');
check('out of fullscreen, it takes its share', A, '922x960+0+0');
t._trees.get('0:0').ratio = 0.5;
t._apply('0:0');

section('monitors and workspaces');
A.monitor = 1;
t._rehome(A);
expect('A moves to monitor 1', t._findLeaf(A)?.key === '0:1', t._findLeaf(A)?.key);
expect('C has monitor 0 to itself', C.is_maximized());
const trees = t._trees.size;
t._rehome(A);
expect('the same move twice is one move', t._trees.size === trees);
A.monitor = 0;
setMru([A, C]);
t._rehome(A);
expect('and back', t._findLeaf(A)?.key === '0:0' && t._trees.size === 1);
setWorkspaceIndex(1);
t._rekey();
expect('renumbered, the tree follows its windows', [...t._trees.keys()].join() === '1:0');
setWorkspaceIndex(0);
t._rekey();
const Moved = win('Moved', {monitor: 1});
open(t, Moved, [A, C]);
Moved.monitor = 0;
t._rekey();
expect('two trees on one key are merged', t._trees.size === 1 && shape(t).includes('Moved'), shape(t));
close(t, Moved, [A, C]);
t._trees.set('0:5', {window: Moved, parent: null, rect: null});
const movedBefore = Moved.placements;
t._apply('0:5');
expect('a missing monitor is not laid out', Moved.placements === movedBefore);
t._trees.delete('0:5');
expect('pinned on the primary, not tiled', !tileable(win('Pinned', {onAll: true})));
const Second = win('Second', {onAll: true, primary: false, monitor: 1});
expect('on a secondary monitor, tiled there', tileable(Second) && t._key(Second) === 'all:1');

section('across monitors  (swap carries on past the edge of the layout)');
const [west, east] = [A, C].sort((a, b) => t._findLeaf(a).leaf.rect.x - t._findLeaf(b).leaf.rect.x);
const Far = win('Far', {monitor: 1});
open(t, Far, [west, east]);
setFocus(east);
setMru([east, Far, west]);
t._swap('right');
expect('it trades places with the tiled window there', t._findLeaf(east)?.key === '0:1' &&
    east.monitor === 1 && t._findLeaf(Far)?.key === '0:0' && Far.monitor === 0);
check('which takes its tile', Far, '768x960+768+0');
expect('and focus stays with it', global.display.focus_window === east && east.is_maximized());
t._swap('left');
expect('and back', t._findLeaf(east)?.key === '0:0' && t._findLeaf(Far)?.key === '0:1');
close(t, Far, [east, west]);
setFocus(east);
t._swap('right');
t._rehome(east);
expect('with no tiled window there, it joins that layout', east.monitor === 1 &&
    t._findLeaf(east)?.key === '0:1' && west.is_maximized());
east.monitor = 0;
setMru([east, west]);
t._rehome(east);

section('rules  (what is laid out, and what floats)');
const admitted = (label, window, tiles) => {
    const leaves = t._leaves(t._trees.get('0:0')).length;
    setMru([A, C]);
    t._apply(t._admit(window));
    const laidOut = t._leaves(t._trees.get('0:0')).length > leaves;
    expect(label, tiles ? laidOut : !laidOut && t._floating.has(window) && window.above,
        laidOut ? 'laid out' : 'floats');
    if (laidOut)
        close(t, window, [A, C]);
    t._floating.delete(window);
    t._popped.delete(window);
};
admitted('a terminal is laid out', win('T'), true);
admitted('so is one with a minimum and no maximum', win('P', {get_min_size: limit(360, 294)}), true);
admitted('Calculator floats', win('Calc', {get_wm_class: () => 'org.gnome.Calculator'}), false);
admitted('the wl-copy helper floats',
    win('wl', {get_wm_class: () => 'io.github.bugaevc.wl-clipboard'}), false);
admitted('a fixed height floats', win('Fixed', {
    get_min_size: limit(300, 200), get_max_size: limit(2147483647, 200)}), false);
admitted('capped below the screen floats', win('Capped', {get_max_size: limit(800, 600)}), false);
admitted('an X11 pop-up role floats', win('Popup', {get_role: () => 'pop-up'}), false);
admitted('Nautilus saving a file floats', win('Save As', {get_wm_class: () => 'org.gnome.Nautilus'}), false);
admitted('a Nautilus folder is laid out', win('Home', {get_wm_class: () => 'org.gnome.Nautilus'}), true);
apps.set('Snap', 'org.gnome.Calculator.desktop');
admitted('listed by its desktop file', win('Snap', {get_wm_class: () => 'calc_app'}), false);
admitted('LocalSend by prefix', win('LocalSend', {get_wm_class: () => 'localsend_app'}), false);
apps.clear();
const Pip = win('Picture-in-Picture');
t._admit(Pip);
expect('picture-in-picture floats on every workspace', t._floating.has(Pip) && Pip.stuck);
check('in the top right corner', Pip, '600x338+896+38');
const Dialog = win('Preferences', {get_transient_for: () => A});
admitted('a dialog floats', Dialog, false);
const Updater = win('Software Updater', {allows_resize: () => false});
t._admit(Updater);
setFocus(Updater);
t._toggleFloat();
expect('one that cannot be resized floats for good', t._floating.has(Updater) && !t._findLeaf(Updater));
for (const [label, extra] of [
    ['a skip-taskbar window', {is_skip_taskbar: () => true}],
    ['a dialog attached to its parent', {is_attached_dialog: () => true}],
    ['a dock', {get_window_type: () => Meta.WindowType.DOCK}],
]) {
    const Else = win(label, {allows_resize: () => false, ...extra});
    t._admit(Else);
    expect(`${label} is left alone`, !t._floating.has(Else) && !Else.above);
}
const Calc = win('Calc', {get_wm_class: () => 'org.gnome.Calculator'});
t._admit(Calc);
setFocus(Calc);
setMru([Calc, A, C]);
t._toggleFloat();
expect('the float chord lays out a rule-floated window', !!t._findLeaf(Calc) && !Calc.above);
close(t, Calc, [A, C]);
t._floating.clear();

section('the strict rule  (a tileable window is laid out unless floated)');
const Stray = win('Stray');
t._pending.add(Stray);
t._enforce(Stray);
expect('not before it has drawn', !t._findLeaf(Stray));
t._pending.delete(Stray);
setMru([A, C]);
t._enforce(Stray);
expect('once it has', !!t._findLeaf(Stray));
close(t, Stray, [A, C]);
const StrayCalc = win('Calc', {get_wm_class: () => 'org.gnome.Calculator'});
t._enforce(StrayCalc);
expect('with its float rules', t._floating.has(StrayCalc));
t._floating.delete(StrayCalc);
const Hidden = win('Hidden');
Hidden.minimized = true;
t._enforce(Hidden);
expect('a minimized one stays out', !t._findLeaf(Hidden));

section('minimum sizes  (no window gets less than it will take)');
close(t, C, [A]);
const Wide = win('Wide', {get_min_size: limit(800, 400)});
open(t, Wide, [A]);
check('the division moves to give it 800', Wide, '800x960+736+0');
check('the neighbour gets the rest', A, '736x960+0+0');
const Wider = win('Wider', {get_min_size: limit(852, 400)});
open(t, Wider, [Wide, A]);
check('a second wide one stacks under it', Wider, '852x480+684+480');
close(t, Wider, [Wide, A]);
const Tall = win('Tall', {get_min_size: limit(852, 600)});
open(t, Tall, [Wide, A]);
expect('one that fits neither way floats', !t._findLeaf(Tall) && t._floating.has(Tall) && Tall.above);
check('leaving the layout as it was', Wide, '800x960+736+0');
t._floating.delete(Tall);
close(t, Wide, [A]);
open(t, C, [A]);

section('split target  (the window focused when the new one opened)');
const Opened = win('Opened');
open(t, Opened, [Opened, A, C], C);
expect('C is split, not the most recent', t._findLeaf(Opened).leaf.parent.children[0].window === C);
close(t, Opened, [A, C]);

section('windows closing together  (logout, or an app closing several)');
hold();
const P = win('P'), Q = win('Q');
open(t, P, [A, C]);
open(t, Q, [P, A, C]);
pump();
for (const window of [A, C, P, Q])
    t._track(window);
const counts = () => [A, C, P, Q].map(w => w.placements).join();
const sent = counts();
for (const window of [P, Q]) {
    window.emit('unmanaging');
    window.monitor = -1;
}
expect('each leaves the tree at once', !t._findLeaf(P) && !t._findLeaf(Q), shape(t));
C.monitor = -1;
pump();
expect('no unmanaged window is placed', counts().split(',').slice(1).join() ===
    sent.split(',').slice(1).join(), `${sent} -> ${counts()}`);
C.monitor = 0;
release();
for (const window of [A, C])
    window.disconnectObject();
t._apply('0:0');

section('a lone window  (maximized once, not answered for ever)');
hold();
const Lone = win('Lone');
setWorkspaceIndex(7);
t._track(Lone);
open(t, Lone, []);
let ran = pump();
expect('it is maximized once', Lone.placements === 1 && Lone.is_maximized(),
    `${Lone.placements} placements, ${ran} callbacks`);
expect('and nothing is left queued', !queued());
Lone.unmaximize();
pump();
expect('the app unmaximizing it, it fills it again', Lone.placements === 2 && Lone.is_maximized());
const Beside = win('Beside');
t._track(Beside);
open(t, Beside, [Lone], Lone);
ran = pump();
check('a second window splits it', Lone, '768x960+0+0');
expect('and then all is quiet', !queued() && Lone.placements === 3 && Beside.placements === 1,
    `${Lone.placements}, ${Beside.placements}, ${ran} callbacks`);
release();
close(t, Beside, [Lone]);
close(t, Lone, []);
setWorkspaceIndex(0);

clockStep(0);
const warnings = [];
const warn = console.warn;
console.warn = message => warnings.push(message);
const Busy = win('Busy');
for (let i = 0; i < 20; i++)
    t._place(Busy, rect(0, 0, 100, 100), rect(0, 0, 1536, 960));
expect('a window placed over and over is left alone', Busy.placements === 8 && warnings.length === 1,
    `${Busy.placements} placements`);
tick(1001);
t._place(Busy, rect(0, 0, 100, 100), rect(0, 0, 1536, 960));
expect('and placed again after a quiet second', Busy.placements === 9);
console.warn = warn;
clockStep(250);

section('keys and schema');
const chords = new Set([...schemaText.matchAll(/<key name="([^"]+)" type="as">/g)]
    .map(match => match[1])
    .filter(name => !['grow', 'shrink', 'float-apps'].includes(name) && !name.startsWith('borrowed-')));
t._bindKeys(true);
expect('every chord bound has a key', bound.every(name => chords.has(name)), `${bound.length} bound`);
expect('every key is bound', [...chords].every(name => bound.includes(name)));
const listed = SHORTCUT_GROUPS.flatMap(([, keys]) => keys);
expect('the Shortcuts page lists every chord', listed.length === chords.size &&
    listed.every(name => chords.has(name)));
t._bindKeys(false);
expect('and every one is released', !bound.length);
const records = new Set([...schemaText.matchAll(/<key name="borrowed-([^"]+)"/g)].map(match => match[1]));
const lent = [...Object.values(BORROWED_SHORTCUTS).flat(), ...t._borrow().map(loan => loan._key)];
expect('every loan has a record key', lent.every(key => records.has(key)),
    lent.filter(key => !records.has(key)).join() || `${new Set(lent).size} loans`);
expect('only keys a schema has are borrowed', !lent.includes('restore-window') ||
    !t._borrow().some(loan => loan._key === 'restore-window'));

section('borrowed settings  (lent while tiling, handed back after)');
const loan = key => t._borrow().find(l => l._key === key);
for (const [layout, kept] of [
    [':minimize,maximize,close', ':close'],
    ['appmenu:minimize,maximize,close', 'appmenu:close'],
    ['icon:minimize, maximize ,spacer,close', 'icon:spacer,close'],
    [':close', null],
])
    expect(`buttons "${layout}"`, loan('button-layout')._change(layout) === kept);
for (const [action, kept] of [['toggle-maximize', 'none'], ['minimize', 'none'], ['lower', null]])
    expect(`double click "${action}"`, loan('action-double-click-titlebar')._change(action) === kept);
const toMonitor = loan('move-to-monitor-left');
expect('GNOME\'s default shared with swap is lent alone',
    toMonitor._change(['<Super><Shift>Left', '<Super>KP_Left']).join() === '<Super>KP_Left');
expect('a chord the user chose is kept', toMonitor._change(['<Super><Shift><Alt>Left']) === null);
for (const loanOf of [...t._borrow()])
    loanOf.giveBack();

section('enable, lock and disable');
const wm = schemas['org.gnome.desktop.wm.preferences'];
const keys = schemas['org.gnome.desktop.wm.keybindings'];
const ta = schemas['org.gnome.shell.extensions.tiling-assistant'];
const mutter = schemas['org.gnome.mutter'];
keys.set_strv('toggle-maximized', ['<Super><Control>f']);
keys.set_strv('move-to-monitor-right', ['<Super><Shift><Alt>Right']);
const shell = schemas['org.gnome.shell.keybindings'];
const zoom = schemas['org.gnome.settings-daemon.plugins.media-keys'];
ta.set_int('focus-hint', 3);
t = newTiler();
const E1 = win('E1'), E2 = win('E2');
setMru([E1, E2]);
t.enable();
expect('open windows are adopted', shape(t) === 'E1,E2', shape(t));
expect('the title bar loses minimize and maximize', wm.get_string('button-layout') === ':close');
expect('the double click does nothing', wm.get_string('action-double-click-titlebar') === 'none');
expect('maximize and minimize keys are off', !keys.get_strv('minimize').length &&
    !keys.get_strv('toggle-maximized').length);
expect('as are the other extension\'s arrows', ta.get_strv('tile-left-half').length === 0 &&
    ta.get_strv('tile-maximize').length === 0);
expect('and its outline and drag tiling', ta.get_int('focus-hint') === 0 &&
    ta.get_int('default-move-mode') === 3);
expect('edge tiling is off and floats open centred', !mutter.get_boolean('edge-tiling') &&
    mutter.get_boolean('center-new-windows'));
expect('Super+right drag resizes', wm.get_boolean('resize-with-right-button'));
expect('focus follows the mouse', wm.get_string('focus-mode') === 'sloppy');
t._settings.set_boolean('focus-follows-mouse', false);
expect('switched off, the focus mode goes back', wm.get_string('focus-mode') === 'click' &&
    !('focus-mode' in wm.user) && !('borrowed-focus-mode' in t._settings.user));
expect('and nothing else does', wm.get_string('button-layout') === ':close');
t._settings.set_boolean('focus-follows-mouse', true);
expect('on again, it follows again', wm.get_string('focus-mode') === 'sloppy');
expect('GNOME gives up the chords it shares with Mantel', !keys.get_strv('move-to-monitor-left').length &&
    !shell.get_strv('toggle-quick-settings').length && !zoom.get_strv('magnifier-zoom-in').length);
expect('but keeps one the user chose', keys.get_strv('move-to-monitor-right').join() ===
    '<Super><Shift><Alt>Right');
expect('every chord is bound', bound.length === chords.size, `${bound.length}`);
Main.sessionMode.isLocked = true;
Main.sessionMode.updated();
expect('locked, the chords are released', !bound.length);
expect('and the layout is kept', shape(t) === 'E1,E2');
Main.sessionMode.isLocked = false;
Main.sessionMode.updated();
expect('unlocked, they are back', bound.length === chords.size);
setFocus(E2);
t._togglePop();
setFocus(E1);
t._toggleFloat();
t.disable();
expect('floating windows leave the top layer', !E1.above && !E2.above);
expect('popped ones leave every workspace', !E2.stuck);
expect('every chord is released', !bound.length);
expect('the buttons go back as they were', wm.get_string('button-layout') ===
    ':minimize,maximize,close' && !('button-layout' in wm.user));
expect('focus is by click again', !('focus-mode' in wm.user));
expect('the user\'s shortcuts as theirs', keys.get_strv('toggle-maximized').join() ===
    '<Super><Control>f' && !('minimize' in keys.user));
expect('the other extension gets its settings back', ta.get_int('focus-hint') === 3 &&
    ta.get_strv('tile-left-half').length === 2 && !('default-move-mode' in ta.user));
expect('and GNOME its own', mutter.get_boolean('edge-tiling') && !('edge-tiling' in mutter.user) &&
    !('move-to-monitor-left' in keys.user) && !('toggle-quick-settings' in shell.user) &&
    keys.get_strv('move-to-monitor-right').join() === '<Super><Shift><Alt>Right');
expect('nothing is on record', !Object.keys(t._settings.user).some(key => key.startsWith('borrowed-')),
    Object.keys(t._settings.user).join());
expect('nothing is kept', !t._trees.size && !t._floating.size && !t._timeouts.size && !t._outline);

wm.set_string('focus-mode', 'mouse');
const chosen = newTiler();
chosen.enable();
expect('a focus mode the user chose is kept', wm.get_string('focus-mode') === 'mouse');
chosen.disable();
wm.reset('focus-mode');
const clicking = newTiler();
clicking._settings.set_boolean('focus-follows-mouse', false);
clicking.enable();
expect('switched off beforehand, focus is left alone', wm.get_string('focus-mode') === 'click');
clicking.disable();

const ending = newTiler();
ending.enable();
ending._stop();
expect('the session ending releases every chord', !bound.length && !Main.sessionMode.updated);
ending.disable();
expect('and disabling after it is harmless', !ending._outline && !ending._loans.length);

console.log(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
process.exit(failures ? 1 : 0);
