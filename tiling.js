// SPDX-License-Identifier: GPL-3.0-or-later
//
// Auto-tiling in the style of Hyprland's dwindle layout. Each workspace and
// monitor has a binary tree: a leaf holds a window, a split holds two
// children, an orientation and a ratio. A new window splits the focused leaf
// along its longer side, and a closed one gives its space to its sibling.

import GDesktopEnums from 'gi://GDesktopEnums';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BorrowedSetting} from './borrowed.js';
import {FocusOutline} from './outline.js';
import {floatRule, followsWorkspaces, minSize, tileable} from './rules.js';
import {BORROWED_SHORTCUTS, unbind} from './shortcuts.js';

const TILING_ASSISTANT = 'org.gnome.shell.extensions.tiling-assistant';
const OUTLINE_HINTS = [1, 3];
const IGNORE_DRAGS = 3;

function withoutMinMax(layout) {
    const kept = layout.split(':')
        .map(side => side.split(',')
            .filter(button => !['minimize', 'maximize'].includes(button.trim()))
            .join(','))
        .join(':');
    return kept === layout ? null : kept;
}

// Settings outside Mantel that tiling changes while it runs, handed back when
// it stops (borrowed.js): [schema, key, type, change, gate], where change(value)
// is the value to lend, or null to leave it alone, and gate a Mantel setting
// that has to be on as well.
const LOANS = [
    ['org.gnome.desktop.wm.preferences', 'focus-mode', 'string',
        mode => mode === 'click' ? 'sloppy' : null, 'focus-follows-mouse'],
    ['org.gnome.desktop.wm.preferences', 'button-layout', 'string', withoutMinMax],
    ['org.gnome.desktop.wm.preferences', 'action-double-click-titlebar', 'string',
        action => /maximize|minimize/.test(action) ? 'none' : null],
    ['org.gnome.desktop.wm.preferences', 'resize-with-right-button', 'boolean', on => on ? null : true],
    ['org.gnome.mutter', 'edge-tiling', 'boolean', on => on ? false : null],
    ['org.gnome.mutter', 'center-new-windows', 'boolean', on => on ? null : true],
    [TILING_ASSISTANT, 'focus-hint', 'int', hint => OUTLINE_HINTS.includes(hint) ? 0 : null],
    [TILING_ASSISTANT, 'default-move-mode', 'int', mode => mode === IGNORE_DRAGS ? null : IGNORE_DRAGS],
    ...Object.entries(BORROWED_SHORTCUTS).flatMap(([schema, keys]) =>
        keys.map(key => [schema, key, 'strv', unbind(key)])),
];

const SETTLE_MS = 250;
const DIRECTIONS = ['left', 'right', 'up', 'down'];
const RESIZE_STEPS = {'': 100, '-little': 25, '-lot': 300};
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
const POP_WIDTH = 1300;
const POP_HEIGHT = 900;
const PIP_WIDTH = 600;
const PIP_HEIGHT = 338;
const PIP_MARGIN = 40;

// A client that answers every placement with a change of its own would be
// chased for ever; past this many placements in a second it is left alone.
const MAX_PLACEMENTS = 8;

const GRAB_UNCONSTRAINED = 1024;
const MOVE_OPS = new Set([Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING]);
const RESIZE_OPS = new Set(Object.entries(Meta.GrabOp)
    .filter(([name]) => name.includes('RESIZING'))
    .map(([, op]) => op));

const rectangle = (x, y, width, height) => new Mtk.Rectangle({x, y, width, height});

// Held back from the edges so that a division can always be moved back.
const clampRatio = ratio => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

export class AutoTile {
    constructor(settings) {
        this._settings = settings;
        this._debug = false;
        this._outline = null;
        this._loans = [];
        this._keybindings = [];
        this._timeouts = new Set();
        this._settling = new Map();
        this._relayoutId = 0;

        // 'workspace:monitor', or 'all:monitor' for windows on every
        // workspace, to a root. A leaf is {window, parent, rect} and a split
        // {children, horizontal, ratio, parent, rect}; rect is the space the
        // node was last given, before gaps.
        this._trees = new Map();

        this._floating = new Set();
        this._popped = new Set();
        this._scratch = new Set();
        this._pseudo = new Set();
        // Maximized by their app: floating over a tile they keep.
        this._maximized = new Set();
        // Opened, not yet drawn.
        this._pending = new Set();
        this._queued = new Set();

        // Per window: the rectangle last asked for, its frame from before it
        // was first placed, and its recent placements.
        this._sent = new Map();
        this._untiled = new Map();
        this._placements = new Map();

        this._grabbed = null;
        this._grabFrame = null;
        this._grabResize = 0;
    }

    enable() {
        this._loans = this._borrow();
        this._lend(this._loans);
        this._outline = new FocusOutline();
        this._outline.width = this._settings.get_int('border');
        this._debug = this._settings.get_boolean('debug');
        this._settings.connectObject(
            'changed::focus-follows-mouse', () => this._lend(this._loans.filter(loan => loan.gate)),
            'changed::gap', () => this._relayout(),
            'changed::border', () => {
                this._outline.width = this._settings.get_int('border');
                this._relayout();
            },
            'changed::debug', () => (this._debug = this._settings.get_boolean('debug')),
            this);

        Main.sessionMode.connectObject('updated',
            () => this._bindKeys(!Main.sessionMode.isLocked), this);
        this._bindKeys(!Main.sessionMode.isLocked);

        // Trees are keyed by workspace index, which GNOME renumbers.
        global.workspace_manager.connectObject(
            'workspace-added', () => this._rekey(),
            'workspace-removed', () => this._rekey(),
            'workspaces-reordered', () => this._rekey(),
            'active-workspace-changed', () => this._hideScratchpad(),
            this);

        global.display.connectObject(
            'window-created', (_display, window) => this._onWindowCreated(window),
            'grab-op-begin', (_display, window, op) => this._onGrabBegin(window, op),
            'grab-op-end', (_display, window, op) => this._onGrabEnd(window, op),
            'window-entered-monitor', (_display, _monitor, window) =>
                this._defer(() => this._rehome(window)),
            'workareas-changed', () => this._queueRelayout(),
            'restacked', () => this._keepFloatsOnTop(),
            'notify::focus-window', () =>
                this._defer(() => this._enforce(global.display.focus_window)),
            'closing', () => this._stop(),
            this);

        for (const window of this._windows()) {
            this._track(window);
            this._admit(window);
        }
        this._relayout();
    }

    disable() {
        for (const window of this._floating)
            window.unmake_above();
        for (const window of this._popped)
            window.unstick();

        this._stop();
        for (const loan of this._loans)
            loan.giveBack();
        this._loans = [];
    }

    // Also run as the session ends, since placing a window that is being
    // unmanaged crashes the shell.
    _stop() {
        this._bindKeys(false);
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);

        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._settling.clear();
        this._relayoutId = 0;

        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const actor of global.get_window_actors()) {
            actor.disconnectObject(this);
            actor.meta_window.disconnectObject(this);
        }
        this._endGrab();

        this._outline?.destroy();
        this._outline = null;

        for (const collection of [this._trees, this._floating, this._popped, this._scratch,
            this._pseudo, this._maximized, this._pending, this._queued, this._sent,
            this._untiled, this._placements])
            collection.clear();
    }

    // Only keys that are installed: GSettings aborts the shell on a key its
    // schema lacks, and Tiling Assistant's vary by version.
    _borrow() {
        const source = Gio.SettingsSchemaSource.get_default();
        const targets = new Map();

        return LOANS
            .filter(([schema, key]) => source.lookup(schema, true)?.has_key(key))
            .map(([schema, key, type, change, gate]) => {
                if (!targets.has(schema))
                    targets.set(schema, new Gio.Settings({schema_id: schema}));

                const loan = new BorrowedSetting({
                    mantel: this._settings, record: `borrowed-${key}`,
                    target: targets.get(schema), key, type, change,
                });
                loan.gate = gate;
                return loan;
            });
    }

    _lend(loans) {
        for (const loan of loans) {
            if (!loan.gate || this._settings.get_boolean(loan.gate))
                loan.take();
            else
                loan.giveBack();
        }
    }

    // --- chords -------------------------------------------------------------

    // Unbound on the lock screen.
    _bindKeys(bind) {
        for (const name of this._keybindings)
            Main.wm.removeKeybinding(name);
        this._keybindings = [];

        for (const [name, action] of bind ? Object.entries(this._actions()) : []) {
            const bound = Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL, () => {
                    action();
                    this._keepPointer();
                });
            if (bound === Meta.KeyBindingAction.NONE)
                console.warn(`Mantel: could not bind ${name}`);
            this._keybindings.push(name);
        }
    }

    _actions() {
        const actions = {
            'toggle-float': () => this._toggleFloat(),
            'toggle-maximize': () => this._toggleMaximize(),
            'toggle-split': () => this._toggleSplit(),
            'toggle-pseudo': () => this._togglePseudo(),
            'toggle-pop': () => this._togglePop(),
            'scratchpad': () => this._toggleScratchpad(),
            'to-scratchpad': () => this._toScratchpad(),
        };

        for (const direction of DIRECTIONS) {
            actions[`focus-${direction}`] = () => this._focus(direction);
            actions[`swap-${direction}`] = () => this._swap(direction);
        }

        for (const [suffix, step] of Object.entries(RESIZE_STEPS)) {
            actions[`resize-left${suffix}`] = () => this._resize(true, -step);
            actions[`resize-right${suffix}`] = () => this._resize(true, step);
            actions[`resize-up${suffix}`] = () => this._resize(false, -step);
            actions[`resize-down${suffix}`] = () => this._resize(false, step);
        }

        return actions;
    }

    // While focus follows the pointer, the pointer is moved onto the focused
    // window after a chord, or whatever the chord moved under it takes focus.
    _keepPointer() {
        const window = global.display.focus_window;
        if (!window || Meta.prefs_get_focus_mode() === GDesktopEnums.FocusMode.CLICK)
            return;

        const {x, y, width, height} = this._findLeaf(window)?.leaf.rect ?? window.get_frame_rect();
        const [px, py] = global.get_pointer();
        if (px < x || py < y || px >= x + width || py >= y + height) {
            global.stage.get_context().get_backend().get_default_seat()
                .warp_pointer(x + Math.round(width / 2), y + Math.round(height / 2));
        }
    }

    _focusedLeaf() {
        const window = global.display.focus_window;
        const found = window && this._findLeaf(window);
        return found?.leaf.rect ? found : null;
    }

    // The window sharing an edge with this one that way, the most recently
    // used of several.
    _neighbour(here, direction) {
        const a = here.leaf.rect;
        const beside = {
            left: b => b.x + b.width === a.x && a.vert_overlap(b),
            right: b => a.x + a.width === b.x && a.vert_overlap(b),
            up: b => b.y + b.height === a.y && a.horiz_overlap(b),
            down: b => a.y + a.height === b.y && a.horiz_overlap(b),
        }[direction];

        const windows = this._leaves(this._trees.get(here.key))
            .filter(leaf => leaf.rect && beside(leaf.rect))
            .map(leaf => leaf.window);
        return this._windows().find(window => windows.includes(window)) ?? windows[0] ?? null;
    }

    _monitorBeyond(window, direction) {
        return global.display.get_monitor_neighbor_index(window.get_monitor(),
            Meta.DisplayDirection[direction.toUpperCase()]);
    }

    // The most recently used window on a monitor, on this workspace.
    _onMonitor(monitor, accept) {
        return this._windows(global.workspace_manager.get_active_workspace())
            .find(window => window.get_monitor() === monitor && accept(window));
    }

    // Past the edge of the layout, focus goes to the monitor that way.
    _focus(direction) {
        const here = this._focusedLeaf();
        if (!here)
            return;

        const next = this._neighbour(here, direction) ?? this._onMonitor(
            this._monitorBeyond(here.leaf.window, direction), window => !window.minimized);
        next?.activate(global.get_current_time());
    }

    // Past the edge of the layout, the window changes places with the tiled
    // window on the monitor that way, or joins that monitor's layout.
    _swap(direction) {
        const here = this._focusedLeaf();
        if (!here)
            return;

        const window = here.leaf.window;
        const monitor = window.get_monitor();
        const beyond = this._monitorBeyond(window, direction);
        const other = this._neighbour(here, direction) ??
            this._onMonitor(beyond, candidate => !!this._findLeaf(candidate));
        if (!other) {
            if (beyond >= 0)
                window.move_to_monitor(beyond);
            return;
        }

        const there = this._findLeaf(other);
        here.leaf.window = other;
        there.leaf.window = window;
        if (there.key !== here.key) {
            window.move_to_monitor(other.get_monitor());
            other.move_to_monitor(monitor);
            this._apply(there.key);
        }
        this._apply(here.key);
        window.activate(global.get_current_time());
    }

    _toggleSplit() {
        const here = this._focusedLeaf();
        const parent = here?.leaf.parent;
        if (!parent)
            return;

        parent.horizontal = !parent.horizontal;
        this._apply(here.key);
    }

    // Move the nearest division across that axis by pixels, right or down
    // for a positive step, whichever side of it the window is on. A floating
    // window grows or shrinks by as much.
    _resize(horizontal, pixels) {
        const here = this._focusedLeaf();
        const window = global.display.focus_window;
        if (!here && this._floating.has(window) && !window.get_maximize_flags()) {
            const {x, y, width, height} = window.get_frame_rect();
            window.move_resize_frame(true, x, y,
                width + (horizontal ? pixels : 0), height + (horizontal ? 0 : pixels));
            return;
        }

        let node = here?.leaf;
        while (node?.parent && node.parent.horizontal !== horizontal)
            node = node.parent;

        const split = node?.parent;
        if (!split?.rect)
            return;

        const length = horizontal ? split.rect.width : split.rect.height;
        split.ratio = clampRatio(split.ratio + pixels / length);
        this._apply(here.key);
    }

    _togglePseudo() {
        const here = this._focusedLeaf();
        if (!here)
            return;

        const window = here.leaf.window;
        if (!this._pseudo.delete(window))
            this._pseudo.add(window);
        this._apply(here.key);
    }

    // The focused window, when it is tiled or floating; dialogs and the like
    // are left alone.
    _chordWindow() {
        const window = global.display.focus_window;
        return window && (this._floating.has(window) || this._findLeaf(window)) ? window : null;
    }

    _toggleFloat() {
        const window = this._chordWindow();
        if (!window)
            return;

        if (this._floating.has(window))
            this._rejoin(window);
        else if (this._maximized.has(window))
            window.unmaximize();
        else
            this._apply(this._float(window));
    }

    // Maximized, a tiled window floats over its tile until it is
    // unmaximized. Alone in its tree it fills the workspace already.
    _toggleMaximize() {
        const window = this._chordWindow();
        const found = window && this._findLeaf(window);
        if (!window || (found && !found.leaf.parent))
            return;

        if (window.is_maximized())
            window.unmaximize();
        else
            window.maximize();
    }

    // Out of the layout at a set size, centred, in front and on every
    // workspace. Again puts it back.
    _togglePop() {
        const window = this._chordWindow();
        if (!window)
            return;

        if (this._popped.has(window)) {
            this._rejoin(window);
            return;
        }

        const key = this._float(window);
        this._scratch.delete(window);
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (window.get_maximize_flags())
            window.unmaximize();

        const area = window.get_work_area_current_monitor();
        const width = Math.min(POP_WIDTH, area.width);
        const height = Math.min(POP_HEIGHT, area.height);
        window.move_resize_frame(true,
            area.x + Math.round((area.width - width) / 2),
            area.y + Math.round((area.height - height) / 2),
            width, height);

        window.stick();
        this._popped.add(window);
        this._apply(key);
    }

    // The scratchpad is a set of floating windows kept minimized, shown over
    // the current workspace, and put away again on a workspace switch.
    _toScratchpad() {
        const window = this._chordWindow();
        if (!window)
            return;

        const key = this._float(window);
        if (this._popped.delete(window))
            window.unstick();

        this._scratch.add(window);
        window.minimize();
        this._apply(key);
    }

    _toggleScratchpad() {
        const windows = [...this._scratch];
        if (!windows.length)
            return;

        const workspace = global.workspace_manager.get_active_workspace();
        if (windows.some(window => !window.minimized && window.located_on_workspace(workspace))) {
            this._hideScratchpad();
            return;
        }

        for (const window of windows) {
            if (!window.is_on_all_workspaces())
                window.change_workspace(workspace);
            window.unminimize();
        }
        windows.at(-1).activate(global.get_current_time());
    }

    _hideScratchpad() {
        for (const window of this._scratch)
            window.minimize();
    }

    // Out of the layout and above it, at the size it had before it was
    // tiled. Returns the tree it left.
    _float(window) {
        this._maximized.delete(window);
        const key = this._detach(window);
        const rect = this._untiled.get(window);
        this._untiled.delete(window);

        if (key && rect) {
            if (window.get_maximize_flags())
                window.unmaximize();
            window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        }

        this._floating.add(window);
        window.make_above();
        return key;
    }

    _rejoin(window) {
        this._scratch.delete(window);
        if (this._popped.delete(window))
            window.unstick();

        if (!tileable(window))
            return;

        this._floating.delete(window);
        window.unmake_above();
        this._apply(this._insert(window));
    }

    // --- mouse --------------------------------------------------------------

    _onGrabBegin(window, op) {
        const kind = op & ~GRAB_UNCONSTRAINED;
        if (!window || !this._findLeaf(window) || !(MOVE_OPS.has(kind) || RESIZE_OPS.has(kind)))
            return;

        this._grabbed = window;
        if (RESIZE_OPS.has(kind)) {
            this._grabFrame = window.get_frame_rect();
            this._grabResize = window.connect('size-changed', () => this._follow(window));
        }
    }

    // A resize is kept, a move exchanges the window with the one it was
    // dropped on, and anything else goes back to its tile.
    _onGrabEnd(window, op) {
        const grabbed = this._grabbed;
        this._endGrab();

        const here = grabbed === window && this._findLeaf(window);
        if (!here || this._floatsOverTile(window))
            return;

        if (RESIZE_OPS.has(op & ~GRAB_UNCONSTRAINED))
            this._apply(here.key);
        else
            this._dropped(window, here);
    }

    _endGrab() {
        if (this._grabResize)
            this._grabbed.disconnect(this._grabResize);
        this._grabResize = 0;
        this._grabFrame = null;
        this._grabbed = null;
    }

    // The divisions on the edges being dragged follow them, and the rest of
    // the tree with them.
    _follow(window) {
        const found = this._findLeaf(window);
        const space = found && this._space(found.key);
        if (!space)
            return;

        const half = Math.round(space.gap / 2);
        const before = this._grabFrame;
        const frame = window.get_frame_rect();
        this._grabFrame = frame;

        // Only the nearest division on each side lies on the window's edge.
        const seen = new Set();
        for (let node = found.leaf; node.parent; node = node.parent) {
            const split = node.parent;
            const first = split.children[0] === node;
            const side = `${split.horizontal}${first}`;
            if (seen.has(side) || !split.rect)
                continue;
            seen.add(side);

            const division = ({x, y, width, height}) => split.horizontal
                ? first ? x + width + half : x - half
                : first ? y + height + half : y - half;
            if (division(frame) === division(before))
                continue;

            const [start, length] = split.horizontal
                ? [split.rect.x, split.rect.width]
                : [split.rect.y, split.rect.height];
            split.ratio = clampRatio((division(frame) - start) / length);
        }

        this._apply(found.key);
    }

    // Leaf rectangles cover the work area, so the pointer is over one.
    _dropped(window, here) {
        const now = this._key(window);
        if (now && now !== here.key) {
            this._apply(this._detach(window));
            this._apply(this._insert(window));
            return;
        }

        const [x, y] = global.get_pointer();
        const target = this._leaves(this._trees.get(here.key)).find(leaf =>
            leaf !== here.leaf && leaf.rect?.contains_point(x, y));
        if (target) {
            here.leaf.window = target.window;
            target.window = window;
        }

        this._apply(here.key);
        window.activate(global.get_current_time());
    }

    // --- windows ------------------------------------------------------------

    _onWindowCreated(window) {
        if (window.is_override_redirect())
            return;

        this._track(window);

        // The window focused as this one opens is the one it splits.
        const focused = global.display.focus_window;
        const actor = window.get_compositor_private();
        if (!actor)
            return;

        // Admitted once drawn, when its size is final.
        this._pending.add(window);
        actor.connectObject('first-frame', () => {
            actor.disconnectObject(this);
            this._pending.delete(window);
            this._apply(this._admit(window, focused));
            // Focused while still pending, it was passed over then.
            if (window.has_focus())
                this._enforce(window);
        }, this);
    }

    // A window that can be laid out is in the layout, or floating because a
    // rule or a chord said so.
    _enforce(window) {
        if (!window || this._pending.has(window) || this._floating.has(window) || window.minimized)
            return;

        const found = this._findLeaf(window);
        if (found) {
            this._takeOver(window, found.key);
        } else if (tileable(window)) {
            this._log(`"${window.get_title()}" was outside the layout`);
            this._apply(this._admit(window));
        }
    }

    // Focused under windows maximized over its tree, a tiled window is
    // maximized in their place and they go back to their tiles.
    _takeOver(window, key) {
        if (this._maximized.has(window))
            return;

        const covering = this._leaves(this._trees.get(key))
            .map(leaf => leaf.window)
            .filter(other => this._maximized.has(other));
        if (!covering.length)
            return;

        this._log(`"${window.get_title()}" takes over from a maximized window`);
        covering.forEach(other => other.unmaximize());
        window.maximize();
    }

    // Floated by rule the way the float chord floats a window, so the chord
    // brings it in. Picture-in-picture goes to the top right corner and
    // follows across workspaces.
    _admit(window, preferred = null) {
        const rule = floatRule(window, this._settings.get_strv('float-apps'));
        if (!rule)
            return this._insert(window, preferred);

        this._float(window);
        if (followsWorkspaces(window)) {
            const area = window.get_work_area_current_monitor();
            window.move_resize_frame(true, area.x + area.width - PIP_WIDTH - PIP_MARGIN,
                area.y + Math.round(area.height * 0.04), PIP_WIDTH, PIP_HEIGHT);
            this._popped.add(window);
            window.stick();
        }
        this._log(`"${window.get_title()}" floats: ${rule}`);
        return null;
    }

    _track(window) {
        window.connectObject(
            'unmanaging', () => this._forget(window),
            'workspace-changed', () => this._defer(() => this._rehome(window)),
            'notify::fullscreen', () => this._defer(() => {
                if (window.is_fullscreen() || this._floating.has(window))
                    return;
                const found = this._findLeaf(window);
                this._apply(found ? found.key : this._admit(window));
            }),
            'notify::minimized', () => this._defer(() =>
                this._apply(window.minimized ? this._detach(window) : this._insert(window))),
            'notify::maximized-horizontally', () => this._onMaximizeChanged(window),
            'notify::maximized-vertically', () => this._onMaximizeChanged(window),
            // Apps can move their own windows after they open.
            'position-changed', () => this._queueSettle(this._findLeaf(window)?.key),
            'size-changed', () => this._queueSettle(this._findLeaf(window)?.key),
            this);
    }

    // Out of every tree at once: several windows can be unmanaged in one turn,
    // and the deferred pass must not find any of them.
    _forget(window) {
        window.disconnectObject(this);
        if (window === this._grabbed)
            this._endGrab();

        for (const collection of [this._floating, this._popped, this._scratch, this._pseudo,
            this._maximized, this._pending, this._untiled, this._placements])
            collection.delete(window);

        const key = this._detach(window);
        this._defer(() => this._apply(key));
    }

    // The two axes notify separately, and a placement sets off more, so the
    // burst is answered with one pass per tree.
    _onMaximizeChanged(window) {
        const found = this._findLeaf(window);
        if (!found || window === this._grabbed || this._queued.has(found.key))
            return;

        const key = found.key;
        this._queued.add(key);
        this._defer(() => {
            this._queued.delete(key);

            const root = this._trees.get(key);
            for (const leaf of root ? this._leaves(root) : []) {
                if (!this._maximized.has(leaf.window) && this._appMaximized(leaf)) {
                    this._log(`"${leaf.window.get_title()}" floats over its tile`);
                    this._maximized.add(leaf.window);
                }
            }

            this._apply(key);
        });
    }

    // The layout maximizes only a window alone in its tree.
    _appMaximized(leaf) {
        const window = leaf.window;
        return window !== this._grabbed && window.is_maximized() &&
            (leaf.parent !== null || this._pseudo.has(window));
    }

    // Unmaximized, it is let go, to be placed in its tile again.
    _floatsOverTile(window) {
        if (!this._maximized.has(window))
            return false;

        if (window === this._grabbed || window.is_maximized())
            return true;

        this._maximized.delete(window);
        this._sent.delete(window);
        return false;
    }

    // mutter keeps a maximized window out of the above layer, so a maximized
    // floating window is raised back over the tiled ones.
    _keepFloatsOnTop() {
        const raised = [...this._floating, ...this._maximized]
            .filter(window => !window.minimized && window.is_maximized());
        if (!raised.length)
            return;

        const tiled = [...this._trees.values()]
            .flatMap(root => this._leaves(root))
            .map(leaf => leaf.window)
            .filter(window => !this._maximized.has(window));

        for (const window of raised) {
            const below = tiled.filter(other => other.get_monitor() === window.get_monitor());
            if (below.length &&
                global.display.sort_windows_by_stacking([window, ...below]).at(-1) !== window)
                window.raise();
        }
    }

    // --- the tree -----------------------------------------------------------

    _key(window) {
        const monitor = window.get_monitor();
        if (monitor < 0)
            return null;

        if (window.is_on_all_workspaces())
            return `all:${monitor}`;

        const workspace = window.get_workspace();
        return workspace ? `${workspace.index()}:${monitor}` : null;
    }

    // What a tree is laid out in, or null once its workspace or monitor has
    // gone. A window alone keeps no room for the outline.
    _space(key) {
        const root = this._trees.get(key);
        const [index, monitor] = key.split(':').map(Number);
        const workspace = Number.isNaN(index)
            ? global.workspace_manager.get_active_workspace()
            : global.workspace_manager.get_workspace_by_index(index);
        if (!root || !workspace || monitor >= global.display.get_n_monitors())
            return null;

        return {
            root,
            workArea: workspace.get_work_area_for_monitor(monitor),
            gap: Math.round(this._settings.get_int('gap') * global.display.get_monitor_scale(monitor)),
            edge: root.window ? 0 : this._settings.get_int('border'),
        };
    }

    // Split the leaf of the window this one opened over. Returns the tree
    // that changed. A window that fits beside the others neither way floats.
    _insert(window, preferred = null) {
        const key = !this._floating.has(window) && !window.minimized &&
            tileable(window) && this._key(window);
        if (!key || this._findLeaf(window))
            return null;

        const leaf = {window, parent: null, rect: null};
        const root = this._trees.get(key);
        if (!root) {
            this._trees.set(key, leaf);
            return key;
        }

        const target = this._targetLeaf(root, window, preferred);
        const split = {
            children: [target, leaf],
            horizontal: !target.rect || target.rect.width >= target.rect.height,
            ratio: 0.5,
            parent: target.parent,
            rect: target.rect,
        };
        this._replace(key, target, split);
        target.parent = split;
        leaf.parent = split;

        if (!this._fits(key)) {
            split.horizontal = !split.horizontal;
            if (!this._fits(key)) {
                this._replace(key, split, target);
                this._log(`"${window.get_title()}" does not fit; it floats`);
                this._float(window);
                return null;
            }
        }

        return key;
    }

    // The sibling takes the parent's place, and so the space the pair held.
    _detach(window) {
        const found = this._findLeaf(window);
        if (!found)
            return null;

        const {key, leaf} = found;
        this._sent.delete(window);
        if (leaf.parent)
            this._replace(key, leaf.parent, leaf.parent.children.find(child => child !== leaf));
        else
            this._trees.delete(key);
        return key;
    }

    _replace(key, node, replacement) {
        const parent = node.parent;
        replacement.parent = parent;
        if (parent)
            parent.children[parent.children.indexOf(node)] = replacement;
        else
            this._trees.set(key, replacement);
    }

    // The window focused when this one opened, or the most recently used.
    _targetLeaf(root, window, preferred) {
        const leaves = this._leaves(root);
        for (const candidate of [preferred, ...this._windows(window.get_workspace())]) {
            const leaf = candidate !== window && leaves.find(l => l.window === candidate);
            if (leaf)
                return leaf;
        }
        return leaves.at(-1);
    }

    _leaves(node, collected = []) {
        if (node.window)
            collected.push(node);
        else
            node.children.forEach(child => this._leaves(child, collected));
        return collected;
    }

    _findLeaf(window) {
        for (const [key, root] of this._trees) {
            const leaf = this._leaves(root).find(candidate => candidate.window === window);
            if (leaf)
                return {key, leaf};
        }
        return null;
    }

    // --- layout -------------------------------------------------------------

    _apply(key) {
        const space = key && this._space(key);
        if (!space)
            return;

        this._layout(space.root, space.workArea, space);
        this._outline.sync();
        this._queueSettle(key);
    }

    _layout(node, rect, space) {
        node.rect = rect;

        if (node.window) {
            const window = node.window;
            if (window.is_fullscreen() || window === this._grabbed || this._floatsOverTile(window))
                return;

            const want = this._want(node, space);
            if (!this._placed(window, want, space.workArea))
                this._place(window, want, space.workArea);
            return;
        }

        // The division moves as far as it takes to give each side its
        // minimum size, when both can have it.
        const [first, second] = node.children;
        const axis = node.horizontal ? 0 : 1;
        const length = node.horizontal ? rect.width : rect.height;
        const pad = this._pad(space);
        const least = this._minSize(first, pad)[axis];
        const most = length - this._minSize(second, pad)[axis];
        let size = Math.round(length * node.ratio);
        if (least <= most)
            size = Math.min(Math.max(size, least), most);

        if (node.horizontal) {
            this._layout(first, rectangle(rect.x, rect.y, size, rect.height), space);
            this._layout(second, rectangle(rect.x + size, rect.y, rect.width - size, rect.height), space);
        } else {
            this._layout(first, rectangle(rect.x, rect.y, rect.width, size), space);
            this._layout(second, rectangle(rect.x, rect.y + size, rect.width, rect.height - size), space);
        }
    }

    // The tile inset by half a gap on a shared edge and by the outline's
    // width on a screen edge, since the outline is drawn outside the window;
    // for a pseudo-tiled window, its own size centred in that.
    _want(leaf, {workArea, gap, edge}) {
        const {x, y, width, height} = leaf.rect;
        const half = Math.round(gap / 2);
        const left = x === workArea.x ? edge : half;
        const top = y === workArea.y ? edge : half;
        const right = x + width === workArea.x + workArea.width ? edge : half;
        const bottom = y + height === workArea.y + workArea.height ? edge : half;
        const tile = rectangle(x + left, y + top, width - left - right, height - top - bottom);

        const own = this._pseudo.has(leaf.window) && this._untiled.get(leaf.window);
        if (!own)
            return tile;

        const scale = Math.min(1, tile.width / own.width, tile.height / own.height);
        const w = Math.round(own.width * scale);
        const h = Math.round(own.height * scale);
        return rectangle(tile.x + Math.round((tile.width - w) / 2),
            tile.y + Math.round((tile.height - h) / 2), w, h);
    }

    // The most an edge can be inset, on both sides of an axis.
    _pad({gap, edge}) {
        return 2 * Math.max(Math.round(gap / 2), edge);
    }

    // The smallest [width, height] a subtree takes before gaps.
    _minSize(node, pad) {
        if (node.window) {
            const [width, height] = minSize(node.window);
            return [width + pad, height + pad];
        }

        const [a, b] = node.children.map(child => this._minSize(child, pad));
        return node.horizontal
            ? [a[0] + b[0], Math.max(a[1], b[1])]
            : [Math.max(a[0], b[0]), a[1] + b[1]];
    }

    _fits(key) {
        const space = this._space(key);
        if (!space)
            return true;

        const [width, height] = this._minSize(space.root, this._pad(space));
        return width <= space.workArea.width && height <= space.workArea.height;
    }

    // Asked of what was sent rather than of the frame, which on Wayland
    // reaches the new size only once the client has drawn it.
    _placed(window, rect, workArea) {
        if (rect.equal(workArea))
            return window.is_maximized();
        return !window.get_maximize_flags() && !!this._sent.get(window)?.equal(rect);
    }

    // A window alone in its tree is maximized, which also squares its
    // corners. Moved before it is resized, since some terminals take only
    // the size otherwise.
    _place(window, rect, workArea) {
        if (window.get_monitor() < 0 || !window.get_compositor_private() || this._looping(window))
            return;

        if (!this._untiled.has(window))
            this._untiled.set(window, window.get_frame_rect());
        this._sent.set(window, rect);

        if (rect.equal(workArea)) {
            window.maximize();
            return;
        }

        if (window.get_maximize_flags())
            window.unmaximize();
        window.move_frame(true, rect.x, rect.y);
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
    }

    // Not while a window is being dragged, when its neighbours follow it on
    // every frame.
    _looping(window) {
        if (this._grabbed)
            return false;

        const now = GLib.get_monotonic_time();
        const recent = (this._placements.get(window) ?? []).filter(time => now - time < 1000000);
        recent.push(now);
        this._placements.set(window, recent);

        if (recent.length === MAX_PLACEMENTS + 1)
            console.warn(`Mantel: stopped placing "${window.get_title()}", which keeps moving`);
        return recent.length > MAX_PLACEMENTS;
    }

    _queueSettle(key) {
        if (!key)
            return;

        this._removeTimeout(this._settling.get(key));
        this._settling.set(key, this._addTimeout(SETTLE_MS, () => {
            this._settling.delete(key);
            this._settle(key);
        }));
    }

    // Once the placements have landed, ask again for any tile a window is
    // not in: a client need not take the size it is given, and some apps
    // move their own windows once they are open. Never mid-drag.
    _settle(key) {
        const space = !this._grabbed && this._space(key);
        if (!space)
            return;

        for (const leaf of this._leaves(space.root)) {
            const window = leaf.window;
            if (!leaf.rect || window.is_fullscreen() || this._maximized.has(window))
                continue;

            const want = this._want(leaf, space);
            const rested = want.equal(space.workArea)
                ? window.is_maximized()
                : want.equal(window.get_frame_rect());
            if (!rested) {
                this._log(`"${window.get_title()}" left its tile; placing it again`);
                this._place(window, want, space.workArea);
            }
        }
    }

    _relayout() {
        for (const key of [...this._trees.keys()])
            this._apply(key);
    }

    // Work areas change together, so lay out once after the burst.
    _queueRelayout() {
        this._removeTimeout(this._relayoutId);
        this._relayoutId = this._addTimeout(0, () => this._relayout());
    }

    // Move a window to the tree it now belongs in. Several signals report the
    // same move, so a second call does nothing.
    _rehome(window) {
        const found = this._findLeaf(window);
        if (!found || window === this._grabbed || found.key === this._key(window))
            return;

        this._apply(this._detach(window));
        this._apply(this._insert(window));
    }

    // Read every tree's key back off its windows. Two trees that land on one
    // key are merged rather than one replacing the other.
    _rekey() {
        const roots = [...this._trees.values()];
        this._trees.clear();

        const strays = [];
        for (const root of roots) {
            const windows = this._leaves(root).map(leaf => leaf.window);
            const key = this._key(windows[0]);
            if (key && !this._trees.has(key))
                this._trees.set(key, root);
            else
                strays.push(...windows);
        }

        for (const window of strays)
            this._insert(window);
        this._relayout();
    }

    // --- helpers ------------------------------------------------------------

    _windows(workspace = null) {
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
    }

    // Signals like 'unmanaging' fire mid-change, too early to lay out from.
    _defer(callback) {
        this._addTimeout(0, callback);
    }

    _log(message) {
        if (this._debug)
            console.log(`Mantel auto-tile: ${message}`);
    }

    // One-shot; the id is dropped before the callback runs, even if it throws.
    _addTimeout(interval, callback) {
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _removeTimeout(id) {
        if (this._timeouts.delete(id))
            GLib.source_remove(id);
    }
}
