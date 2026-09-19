// SPDX-License-Identifier: GPL-3.0-or-later
//
// Auto-hide for the top panel, using intellihide: the bar stays visible while
// nothing overlaps it, and leaves only when a window needs the space.
//
// While enabled the panel stops reserving screen space for the whole session,
// so windows keep full height and the bar floats over them — nothing resizes
// on a reveal. The work area is re-asserted after resume and unlock, or
// windows come back pushed down as though the bar still held its strip.
//
// ATTRIBUTION: derived from dash-to-dock (ubuntu-dock@ubuntu.com, docking.js
// and intellihide.js), GPL-2.0-or-later. No code was copied verbatim, but the
// algorithm, state machine, overlap test, barrier lifecycle and timing
// constants follow it closely. Its "or later" clause is what permits
// redistribution here under GPL-3.0-or-later.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PressureBarrier} from 'resource:///org/gnome/shell/ui/layout.js';

const State = {HIDDEN: 0, SHOWING: 1, SHOWN: 2, HIDING: 3};

// dash-to-dock defaults, so both screen edges behave alike where it is in use.
const PRESSURE_THRESHOLD = 100;
const SHOW_DELAY_MS = 250;          // also the PressureBarrier timeout
const HIDE_DELAY_MS = 500;          // dock uses 200; its box is twice this tall
const ANIMATION_MS = 200;
const OVERLAP_CHECK_MS = 100;
const BARRIER_RELEASE_MS = 100;
const POINTER_WATCH_MS = 250;
// Hysteresis: the zone that keeps the panel open is larger than the edge that
// opens it, so an overshoot toward a 32px bar does not dismiss it.
const HOLD_MARGIN = 32;
const REASSERT_DELAY_MS = 600;

const HANDLED_WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DOCK,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.TOOLBAR,
    Meta.WindowType.MENU,
    Meta.WindowType.UTILITY,
    Meta.WindowType.SPLASHSCREEN,
    Meta.WindowType.DROPDOWN_MENU,
];

// The desktop-icons window covers the screen and must not count as overlap.
const IGNORED_APP_IDS = ['com.rastersoft.ding', 'com.desktop.ding'];

export class PanelAutohide {
    constructor() {
        this._panelBox = Main.layoutManager.panelBox;
        this._strutEntry = null;

        this._pressureBarrier = null;
        this._barrier = null;

        this._trackedWindows = new Set();
        this._overlapping = false;
        this._overlapCheckId = 0;
        this._overlapPending = false;

        this._state = State.SHOWN;
        this._unredirectDisabled = false;
        this._ignoreHover = true;
        this._delayedHide = false;
        this._oldIgnoreHover = null;

        // Every timeout id is mirrored here so disable() can drop them all.
        this._timeouts = [];
        this._pointerWatchId = 0;
        this._barrierReleaseId = 0;
        this._enabled = false;
        this._reassertId = 0;
        this._shieldId = 0;
    }

    enable() {
        this._strutEntry = Main.layoutManager._trackedActors
            .find(entry => entry.actor === this._panelBox) ?? null;
        this._releaseStrut();

        this._createPressureBarrier();

        Main.layoutManager.connectObject('monitors-changed', () => {
            this._releaseStrut();
            this._updateBarrier();
            this._queueOverlapCheck();
        }, this);

        this._panelBox.connectObject('notify::height', () => {
            if (this._state === State.HIDDEN)
                this._panelBox.translation_y = -this._panelHeight();
        }, this);

        global.display.connectObject(
            'window-created', (_d, win) => {
                this._trackWindow(win);
                this._queueOverlapCheck();
            },
            'restacked', () => this._queueOverlapCheck(),
            'in-fullscreen-changed', () => {
                this._updateBarrier();

                // Entering: force-hide. That branch returns before reading
                // any window geometry, so it is safe mid-transition. Leaving:
                // 'restacked' refreshes overlap once the window has settled.
                if (this._isFullscreen())
                    this._updateVisibility();
            },
            this);

        // Deliberately not listening for 'switch-workspace': it fires before
        // the incoming workspace's actors are mapped, so a check there sees an
        // empty workspace and shows the panel, then hides it again. 'restacked'
        // covers workspace switches at a settled moment.

        // Focus can change without a restack when a window is always-on-top.
        Shell.WindowTracker.get_default().connectObject(
            'notify::focus-app', () => this._queueOverlapCheck(), this);

        Main.overview.connectObject(
            'showing', () => {
                this._ignoreHover = true;
                this._showNow();
            },
            'hiding', () => {
                this._queueOverlapCheck();   // skipped while the overview was up
                this._updateVisibility();
            },
            'hidden', () => this._updateVisibility(),
            'item-drag-begin', () => this._onDragStart(),
            'item-drag-end', () => this._onDragEnd(),
            'item-drag-cancelled', () => this._onDragEnd(),
            this);

        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (win)
                this._trackWindow(win);
        }

        // active-changed covers lock, unlock and resume-while-locked — every
        // path that can leave the work area stale.
        this._shieldId = Main.screenShield.connect(
            'active-changed', () => this._scheduleReassert());

        this._enabled = true;
        this._overlapping = this._windowsOverlap();
        this._updateVisibility();
    }

    disable() {
        this._enabled = false;
        this._restoreUnredirect();

        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.length = 0;
        this._overlapCheckId = this._pointerWatchId = 0;
        this._barrierReleaseId = this._reassertId = 0;

        if (this._shieldId) {
            Main.screenShield.disconnect(this._shieldId);
            this._shieldId = 0;
        }

        for (const win of this._trackedWindows)
            win.disconnectObject(this);
        this._trackedWindows.clear();

        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        this._panelBox.disconnectObject(this);

        this._removeBarrier();
        this._pressureBarrier?.destroy();
        this._pressureBarrier = null;

        this._panelBox.remove_all_transitions();
        this._panelBox.translation_y = 0;
        this._state = State.SHOWN;

        if (this._strutEntry) {
            this._strutEntry.affectsStruts = true;
            Main.layoutManager._queueUpdateRegions();
            this._strutEntry = null;
        }
    }

    // --- timeouts ----------------------------------------------------------

    // Sources are pruned as they finish, so disable() never hands a dead id
    // to source_remove.
    _addTimeout(interval, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            const result = callback();
            if (result === GLib.SOURCE_REMOVE)
                this._forgetTimeout(id);
            return result;
        });
        this._timeouts.push(id);
        return id;
    }

    _forgetTimeout(id) {
        const index = this._timeouts.indexOf(id);
        if (index !== -1)
            this._timeouts.splice(index, 1);
    }

    // Returns 0, so callers can clear their own field in the same statement.
    _removeTimeout(id) {
        if (id) {
            GLib.source_remove(id);
            this._forgetTimeout(id);
        }
        return 0;
    }

    // --- struts ------------------------------------------------------------

    _releaseStrut() {
        if (!this._strutEntry)
            return;
        this._strutEntry.affectsStruts = false;
        Main.layoutManager._queueUpdateRegions();
    }

    _scheduleReassert() {
        this._reassertId = this._removeTimeout(this._reassertId);

        // On resume the monitor configuration is still settling, so an
        // immediate update just gets recomputed away.
        this._reassertId = this._addTimeout(REASSERT_DELAY_MS, () => {
            this._reassertId = 0;
            this._releaseStrut();
            this._queueOverlapCheck();
            this._updateBarrier();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- intellihide -------------------------------------------------------

    _trackWindow(win) {
        if (this._trackedWindows.has(win) || !this._handledWindow(win))
            return;

        this._trackedWindows.add(win);
        win.connectObject(
            'position-changed', () => this._queueOverlapCheck(),
            'size-changed', () => this._queueOverlapCheck(),
            'workspace-changed', () => this._queueOverlapCheck(),
            'notify::minimized', () => this._queueOverlapCheck(),
            'unmanaged', () => {
                win.disconnectObject(this);
                this._trackedWindows.delete(win);
                // No check here: the window is still listed, and closing one
                // always restacks.
            },
            this);
    }

    // Check now, then at most once per interval while changes keep arriving.
    _queueOverlapCheck() {
        if (this._overlapCheckId) {
            this._overlapPending = true;
            return;
        }

        this._checkOverlap();
        this._overlapCheckId = this._addTimeout(OVERLAP_CHECK_MS, () => {
            this._checkOverlap();
            if (this._overlapPending) {
                this._overlapPending = false;
                return GLib.SOURCE_CONTINUE;
            }
            this._overlapCheckId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkOverlap() {
        // The overview owns the panel while it is up, so overlap is moot.
        if (!this._enabled || Main.overview.visibleTarget)
            return;

        const overlapping = this._windowsOverlap();
        if (overlapping === this._overlapping)
            return;

        this._overlapping = overlapping;
        this._updateVisibility();
    }

    _handledWindow(win) {
        if (!HANDLED_WINDOW_TYPES.includes(win.get_window_type()))
            return false;

        return !(IGNORED_APP_IDS.includes(win.get_gtk_application_id()) &&
                 win.is_skip_taskbar());
    }

    _windowsOverlap() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        const x1 = monitor.x;
        const x2 = monitor.x + monitor.width;
        const y1 = monitor.y;
        const y2 = monitor.y + this._panelHeight();
        const active = global.workspace_manager.get_active_workspace_index();

        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (!win || !this._handledWindow(win))
                continue;

            // mutter emits 'window-created' before the actor is mapped and
            // before placement runs, so the frame rect is whatever the client
            // asked for — often flush against the top. Not on screen yet means
            // not in the way.
            if (!actor.visible)
                continue;

            if (win.get_workspace()?.index() !== active)
                continue;
            if (!win.showing_on_its_workspace())
                continue;

            const rect = win.get_frame_rect();
            if (rect.width <= 0 || rect.height <= 0)
                continue;

            if (rect.x < x2 && rect.x + rect.width >= x1 &&
                rect.y < y2 && rect.y + rect.height >= y1)
                return true;
        }

        return false;
    }

    // --- barrier -----------------------------------------------------------

    _createPressureBarrier() {
        // showDelay is the barrier's timeout, exactly as the dock builds it.
        this._pressureBarrier = new PressureBarrier(
            PRESSURE_THRESHOLD,
            SHOW_DELAY_MS,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._pressureBarrier.connect('trigger', () => this._onPressureSensed());
    }

    _updateBarrier() {
        this._removeBarrier();

        if (!this._pressureBarrier)
            return;

        // "The barrier needs to be removed in fullscreen ... otherwise the
        // mouse can get trapped on monitor." — dash-to-dock, _updateBarrier.
        if (this._isFullscreen())
            return;

        // Only while hidden: a live barrier under an open panel holds the
        // pointer at the edge.
        if (this._state !== State.HIDDEN)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        // The barrier is destroyed every time it triggers, so its pressure
        // state has to be cleared by hand before re-arming.
        this._pressureBarrier._reset();
        this._pressureBarrier._isTriggered = false;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);

        // Inset a pixel at each end so this does not fight the shell's own
        // corner barriers.
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: workArea.x + 1,
            x2: workArea.x + workArea.width - 1,
            y1: monitor.y,
            y2: monitor.y,
            directions: Meta.BarrierDirection.POSITIVE_Y,
        });
        this._pressureBarrier.addBarrier(this._barrier);
    }

    _removeBarrier() {
        if (this._barrier) {
            this._pressureBarrier?.removeBarrier(this._barrier);
            this._barrier.destroy();
            this._barrier = null;
        }
    }

    _onPressureSensed() {
        if (Main.overview.visibleTarget || this._isFullscreen())
            return;

        // _show() starts the pointer watch itself: pressure only fires while
        // hidden, so _ignoreHover is false here.
        this._show();
    }

    _startPointerWatch() {
        this._pointerWatchId = this._removeTimeout(this._pointerWatchId);
        this._pointerWatchId = this._addTimeout(POINTER_WATCH_MS, () => {
            if (this._ignoreHover) {
                this._pointerWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }

            // Coming back cancels a pending hide, as the dock's _box.hover
            // does. The panel stays on screen for hide delay + animation after
            // _hide(), and that window has to stay monitored.
            if (this._pointerOverPanel(HOLD_MARGIN)) {
                if (this._state === State.HIDING || this._delayedHide)
                    this._show();
                return GLib.SOURCE_CONTINUE;
            }

            if (Main.panel.menuManager?.activeMenu)
                return GLib.SOURCE_CONTINUE;

            this._hide();

            if (this._state === State.HIDDEN) {
                this._pointerWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // --- visibility --------------------------------------------------------

    // Mirrors _updateDashVisibility: the overview owns the panel while it is
    // up; otherwise intellihide decides, and hover only matters when a window
    // is actually in the way.
    _updateVisibility() {
        if (!this._enabled || Main.overview.visibleTarget)
            return;

        // While a monitor is fullscreen the shell hides panelBox outright, so
        // the pointer being "over" the panel means nothing. Hide unconditionally
        // — left parked open, the panel reappears the instant fullscreen ends
        // and nothing is scheduled to put it away again.
        if (this._isFullscreen()) {
            this._ignoreHover = false;
            this._hideNow();
            return;
        }

        if (!this._overlapping) {
            this._ignoreHover = true;
            this._showNow();
            return;
        }

        this._ignoreHover = false;

        // Strict, like the dock's !this._box.hover: a window moving into the
        // strip hides the panel unless the pointer is genuinely on it.
        if (!this._pointerOverPanel() && !Main.panel.menuManager?.activeMenu)
            this._hideNow();
        else
            this._startPointerWatch();  // look again once the pointer clears
    }

    _onDragStart() {
        this._oldIgnoreHover = this._ignoreHover;
        this._ignoreHover = true;
        this._showNow();
    }

    _onDragEnd() {
        if (this._oldIgnoreHover !== null)
            this._ignoreHover = this._oldIgnoreHover;
        this._oldIgnoreHover = null;
        this._updateVisibility();
    }

    _show() {
        this._delayedHide = false;
        if (this._state === State.HIDDEN || this._state === State.HIDING)
            this._animateIn(0);

        // Anything shown for a hover-ish reason needs a watchdog: a panel left
        // SHOWN with _ignoreHover false and no watch can never be put away,
        // since _updateVisibility only runs when overlap changes.
        if (!this._ignoreHover)
            this._startPointerWatch();
    }

    _hide() {
        if (this._state === State.SHOWING) {
            // Let the show finish, then hide, rather than fighting it.
            this._delayedHide = true;
            return;
        }
        if (this._state === State.SHOWN)
            this._animateOut(HIDE_DELAY_MS);
    }

    _showNow() {
        if (this._state !== State.SHOWN && this._state !== State.SHOWING)
            this._animateIn(0);
    }

    _hideNow() {
        if (this._state !== State.HIDDEN && this._state !== State.HIDING)
            this._animateOut(0);
    }

    _animateIn(delay) {
        this._state = State.SHOWING;
        this._delayedHide = false;
        this._disableUnredirect();
        this._panelBox.remove_all_transitions();

        this._panelBox.ease({
            translation_y: 0,
            duration: ANIMATION_MS,
            delay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._state = State.SHOWN;

                this._barrierReleaseId = this._removeTimeout(this._barrierReleaseId);

                if (this._delayedHide) {
                    this._hide();
                    return;
                }

                // Release the barrier shortly after opening, with enough gap
                // that the pointer does not slide straight past.
                this._barrierReleaseId = this._addTimeout(BARRIER_RELEASE_MS, () => {
                    this._barrierReleaseId = 0;
                    this._removeBarrier();
                    return GLib.SOURCE_REMOVE;
                });
            },
        });
    }

    _animateOut(delay) {
        this._state = State.HIDING;
        this._panelBox.remove_all_transitions();

        this._panelBox.ease({
            translation_y: -this._panelHeight(),
            duration: ANIMATION_MS,
            delay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._state = State.HIDDEN;
                this._restoreUnredirect();

                this._barrierReleaseId = this._removeTimeout(this._barrierReleaseId);
                this._updateBarrier();
            },
        });
    }

    // --- helpers -----------------------------------------------------------

    _disableUnredirect() {
        if (this._unredirectDisabled)
            return;
        global.compositor.disable_unredirect();
        this._unredirectDisabled = true;
    }

    _restoreUnredirect() {
        if (!this._unredirectDisabled)
            return;
        global.compositor.enable_unredirect();
        this._unredirectDisabled = false;
    }

    _isFullscreen() {
        return !!Main.layoutManager.primaryMonitor?.inFullscreen;
    }

    // margin 0 is strict — genuinely on the panel, the dock's _box.hover.
    // HOLD_MARGIN is lenient, only to stop a revealed panel flickering away.
    _pointerOverPanel(margin = 0) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        const [x, y] = global.get_pointer();
        if (x < monitor.x || x > monitor.x + monitor.width)
            return false;

        return y >= monitor.y &&
               y <= monitor.y + this._panelHeight() + margin;
    }

    _panelHeight() {
        return this._panelBox.height || Main.panel.height || 32;
    }
}
