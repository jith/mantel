// SPDX-License-Identifier: GPL-3.0-or-later
//
// Top-panel autohide that mirrors the Ubuntu Dock's own autohide.
//
// ATTRIBUTION: the behaviour here is derived from dash-to-dock
// (ubuntu-dock@ubuntu.com, docking.js and intellihide.js), GPL-2.0-or-later.
// No code was copied verbatim, but the algorithm, the state machine, the
// overlap test, the barrier lifecycle and the timing constants all follow it
// closely and deliberately. dash-to-dock's "or later" clause is what
// permits this work to be distributed under GPL-3.0-or-later.
//
//
// The behaviour, the constants and the awkward details are all taken from
// ubuntu-dock@ubuntu.com (docking.js, intellihide.js) rather than invented,
// because that code already survived the cases this kind of thing trips over.
// The three that matter most, each of which was a bug here before:
//
//  * The barrier only exists while the panel is hidden, and is dropped ~100ms
//    after it opens. A live barrier under an open panel is what traps the
//    pointer at the screen edge.
//
//  * The barrier is removed entirely while a monitor is fullscreen. The dock's
//    own comment: "otherwise the mouse can get trapped on monitor." This is
//    also why reaching for a video player's controls no longer arms a reveal
//    behind the panel the shell has hidden.
//
//  * PressureBarrier keeps pressure state between 'hit' and 'left'. Since the
//    barrier is destroyed on every trigger, that state has to be reset by hand
//    before re-arming, or the next reveal never fires.
//
// Intellihide, not plain autohide: the panel stays out while nothing overlaps
// it. The panel also stops reserving screen space for the whole session, so
// windows keep full height and nothing resizes when you peek — the dock does
// the same in autohide mode. The work area is re-asserted after resume and
// unlock, a failure mode other top-bar extensions are known for: windows come
// back pushed down as though the bar still reserved its strip.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PressureBarrier} from 'resource:///org/gnome/shell/ui/layout.js';

const State = {HIDDEN: 0, SHOWING: 1, SHOWN: 2, HIDING: 3};

// Every one of these is a dash-to-dock default, so both screen edges behave
// identically where the dock is also in use.
const PRESSURE_THRESHOLD = 100;     // pressure-threshold
const SHOW_DELAY_MS = 250;          // show-delay — the PressureBarrier timeout
const HIDE_DELAY_MS = 500;          // dock uses 200, but its box is roughly twice
                                    // the panel's height, so 200 felt far too eager here
const ANIMATION_MS = 200;           // animation-time
const OVERLAP_CHECK_MS = 100;       // INTELLIHIDE_CHECK_INTERVAL
const BARRIER_RELEASE_MS = 100;     // dock's post-show barrier removal
const POINTER_WATCH_MS = 250;       // dock's _triggerTimeoutId interval
// Hysteresis. The zone that KEEPS the panel open is deliberately larger than the
// screen edge that opens it, so an overshoot while reaching for a 32px bar does
// not dismiss it. The dock never needs this because its box is far larger.
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

                // Entering: force-hide now. That branch of _updateVisibility
                // returns before reading any window geometry, so it is safe
                // mid-transition. Leaving: do nothing here — 'restacked' will
                // refresh overlap once the window has settled. Reading
                // geometry at this instant is what flickered elsewhere.
                if (this._isFullscreen())
                    this._updateVisibility();
            },
            this);

        // Deliberately NOT listening for window_manager 'switch-workspace'.
        // That fires as the switch begins, before the incoming workspace's
        // window actors are mapped, so a synchronous overlap check there sees
        // an empty workspace and shows the panel — then 'restacked' arrives
        // with the windows up and hides it again. The dock only uses
        // switch-workspace to redraw its icon list; for overlap it relies on
        // 'restacked', whose own comment notes it is "included when the
        // workspace is switched".

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

        // One signal, not four: active-changed covers lock, unlock and
        // resume-while-locked, which is every path that can leave the work
        // area stale.
        this._shieldId = Main.screenShield.connect(
            'active-changed', () => this._scheduleReassert());

        this._enabled = true;
        this._overlapping = this._windowsOverlap();
        this._updateVisibility();
    }

    disable() {
        this._enabled = false;
        this._restoreUnredirect();

        for (const name of ['_pointerWatchId', '_barrierReleaseId',
            '_reassertId', '_overlapCheckId']) {
            if (this[name]) {
                GLib.source_remove(this[name]);
                this[name] = 0;
            }
        }

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

    // --- struts ------------------------------------------------------------

    _releaseStrut() {
        if (!this._strutEntry)
            return;
        this._strutEntry.affectsStruts = false;
        Main.layoutManager._queueUpdateRegions();
    }

    _scheduleReassert() {
        if (this._reassertId)
            GLib.source_remove(this._reassertId);

        // On resume the monitor configuration is still settling, so an
        // immediate update just gets recomputed away.
        this._reassertId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REASSERT_DELAY_MS, () => {
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
                // No check here: the window is still listed at this point, and
                // closing one always restacks, which does the real work.
            },
            this);
    }

    // The dock's throttle: check now, then at most once per interval for as
    // long as changes keep arriving.
    _queueOverlapCheck() {
        if (this._overlapCheckId) {
            this._overlapPending = true;
            return;
        }

        this._checkOverlap();
        this._overlapCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OVERLAP_CHECK_MS, () => {
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
        // The overview owns the panel while it is up, so overlap is irrelevant
        // until it goes away — the dock disables intellihide outright here.
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

            // A window is only in the way once it is actually on screen.
            // mutter emits 'window-created' before the actor is mapped and
            // before placement has run, so the frame rect at that moment is
            // whatever the client asked for — frequently flush against the
            // top, which read as an overlap and hid the panel for the split
            // second until placement moved the window to its real spot. The
            // dock never sees this because its strip is a short band on the
            // left, nowhere near where an unplaced window lands.
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
        // hidden, which means a window overlaps, which means _ignoreHover is
        // false. That covers the dock's _onPressureSensed safety net — the
        // pointer can leave without ever reaching the panel.
        this._show();
    }

    _startPointerWatch() {
        if (this._pointerWatchId)
            GLib.source_remove(this._pointerWatchId);

        this._pointerWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_WATCH_MS, () => {
            if (this._ignoreHover) {
                this._pointerWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }

            // Coming back cancels a pending hide, the way the dock's
            // _box.hover does. Without this the watch removed itself the
            // moment _hide() ran, leaving ~400ms of still-visible panel
            // (hide delay + animation) that nothing was monitoring — move
            // back toward the bar in that window and it left anyway, which
            // is what the flicker was.
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

        // Strict here, like the dock's !this._box.hover: a window moving into
        // the strip must hide the panel unless the pointer is genuinely on it.
        // Using the lenient zone here meant a window dragged near the top never
        // hid the panel while the pointer sat anywhere in the top band.
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

        // Anything shown for a hover-ish reason must carry a watchdog. Without
        // this, a panel left SHOWN with _ignoreHover false and no watch running
        // can never be put away again: _updateVisibility only runs when the
        // overlap status changes, and that will not change on its own.
        // Verified live — this is what left the bar stuck open after fullscreen.
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

                if (this._barrierReleaseId) {
                    GLib.source_remove(this._barrierReleaseId);
                    this._barrierReleaseId = 0;
                }

                if (this._delayedHide) {
                    this._hide();
                    return;
                }

                // Drop the barrier a moment after opening so the pointer is
                // released, with enough of a gap that it does not slide
                // straight past and re-hide immediately.
                this._barrierReleaseId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, BARRIER_RELEASE_MS, () => {
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

                if (this._barrierReleaseId) {
                    GLib.source_remove(this._barrierReleaseId);
                    this._barrierReleaseId = 0;
                }

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

    // margin 0 is the strict test — the pointer is genuinely on the panel, the
    // equivalent of the dock's _box.hover. HOLD_MARGIN is the lenient one, used
    // only to stop a revealed panel flickering away on a small overshoot.
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
