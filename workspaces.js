// SPDX-License-Identifier: GPL-3.0-or-later

// Numbered workspace indicator, and workspace switching that can reach a
// workspace that does not exist yet.
//
// panel.js does not export its workspace indicator classes, so the numbers go
// into the live ActivitiesButton from Main.panel.statusArea, at index 0:
// PanelMenu.ButtonBox only lays out its first child. Every workspace
// keybinding goes through the one handler WindowManager installs with
// setCustomKeybindingHandler; replacing it lets a switch create the target
// workspace, and drops the switcher popup the top bar makes redundant. With a
// fixed number of workspaces, the ones a switch added go again from the end
// once they are empty and left, down to the number there was before.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INACTIVE_OPACITY = 115;
const MAX_WORKSPACES = 10;
const KEYBINDING_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

// The number of workspaces from before a switch added any; unset when none
// was added.
const RECORD = 'borrowed-num-workspaces';

const WORKSPACE_BINDINGS = ['switch', 'move'].flatMap(action =>
    ['left', 'right', 'up', 'down', 'last',
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        .map(target => `${action}-to-workspace-${target}`));

const Indicator = GObject.registerClass(
class MantelWorkspaceIndicator extends St.BoxLayout {
    constructor() {
        super({
            style_class: 'mantel-workspaces',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._workspaceManager = global.workspace_manager;
        this._workspaceManager.connectObject(
            'workspace-added', () => this._rebuild(),
            'workspace-removed', () => this._rebuild(),
            'active-workspace-changed', () => this._sync(),
            this);
        this.connect('destroy',
            () => this._workspaceManager.disconnectObject(this));

        this._rebuild();
    }

    _rebuild() {
        this.destroy_all_children();

        for (let i = 0; i < this._workspaceManager.n_workspaces; i++) {
            const pill = new St.Label({
                style_class: 'mantel-workspace',
                text: `${i + 1}`,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                track_hover: true,
            });

            // GNOME 45+ drives panel clicks through Clutter gestures rather
            // than button-press handlers, so use one here too.
            const click = new Clutter.ClickGesture();
            click.connect('recognize', () => {
                this._workspaceManager
                    .get_workspace_by_index(i)
                    ?.activate(global.get_current_time());
            });
            pill.add_action(click);

            this.add_child(pill);
        }

        this._sync();
    }

    _sync() {
        const active = this._workspaceManager.get_active_workspace_index();

        this.get_children().forEach((label, index) => {
            const isActive = index === active;
            // The top bar is light under a light theme and dark under a dark
            // one, so the digits inherit the panel's own colour and inactive
            // ones are dimmed with actor opacity rather than a fixed colour.
            label.opacity = isActive ? 255 : INACTIVE_OPACITY;
            if (isActive)
                label.add_style_pseudo_class('active');
            else
                label.remove_style_pseudo_class('active');
        });
    }
});

// Grow the workspace list until `count` workspaces exist. The bounded loop
// matters: a `while` here would spin forever if appending ever failed.
function ensureWorkspaces(count, settings) {
    const workspaceManager = global.workspace_manager;
    const time = global.get_current_time();

    if (workspaceManager.n_workspaces < count && !Meta.prefs_get_dynamic_workspaces() &&
        !settings.get_user_value(RECORD))
        settings.set_int(RECORD, workspaceManager.n_workspaces);

    for (let i = workspaceManager.n_workspaces; i < count; i++)
        workspaceManager.append_new_workspace(false, time);

    // Fallback for a build that ignores appends while workspaces are static.
    if (workspaceManager.n_workspaces < count)
        Meta.prefs_set_num_workspaces(count);
}

function switchWorkspace(settings, display, window, event, binding) {
    if (!Main.sessionMode.hasWorkspaces)
        return;

    const workspaceManager = display.get_workspace_manager();
    const [action, , , target] = binding.get_name().split('-');
    const vertical = workspaceManager.layout_rows === -1;
    const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;

    // Moving a window that is on every workspace, or is off the primary
    // monitor while workspaces are primary-only, means nothing.
    if (action === 'move' &&
        (window.is_always_on_all_workspaces() ||
         (Meta.prefs_get_workspaces_only_on_primary() &&
          window.get_monitor() !== Main.layoutManager.primaryIndex)))
        return;

    const forward = vertical
        ? Meta.MotionDirection.DOWN
        : rtl ? Meta.MotionDirection.LEFT : Meta.MotionDirection.RIGHT;
    const backward = vertical
        ? Meta.MotionDirection.UP
        : rtl ? Meta.MotionDirection.RIGHT : Meta.MotionDirection.LEFT;

    let newWs, direction;

    if (target === 'last') {
        direction = forward;
        newWs = workspaceManager.get_workspace_by_index(
            workspaceManager.n_workspaces - 1);
    } else if (isNaN(target)) {
        direction = Meta.MotionDirection[target.toUpperCase()];
        newWs = workspaceManager.get_active_workspace().get_neighbor(direction);
    } else {
        const index = Number(target) - 1;
        if (index < 0 || index >= MAX_WORKSPACES)
            return;

        ensureWorkspaces(index + 1, settings);

        newWs = workspaceManager.get_workspace_by_index(index);
        direction =
            workspaceManager.get_active_workspace_index() > index
                ? backward : forward;
    }

    if (!newWs)
        return;

    if (workspaceManager.layout_rows === -1 &&
        direction !== Meta.MotionDirection.UP &&
        direction !== Meta.MotionDirection.DOWN)
        return;

    if (workspaceManager.layout_columns === -1 &&
        direction !== Meta.MotionDirection.LEFT &&
        direction !== Meta.MotionDirection.RIGHT)
        return;

    if (action === 'switch')
        Main.wm.actionMoveWorkspace(newWs);
    else
        Main.wm.actionMoveWindow(window, newWs);
}

export class WorkspaceNumbers {
    constructor(settings) {
        this._settings = settings;
        this._trimId = 0;
    }

    enable() {
        const activities = Main.panel.statusArea.activities;
        this._dots = activities?.get_children()
            .find(child => child instanceof St.BoxLayout) ?? null;

        if (this._dots) {
            this._indicator = new Indicator();
            activities.insert_child_at_index(this._indicator, 0);
            this._dots.hide();
        }

        // The button's own ClickGesture would open the overview on top of a
        // click on a number, so it is disabled meanwhile, as PanelMenu.Button
        // does. Scrolling still changes workspace.
        this._overviewGesture = activities?._clickGesture ?? null;
        this._overviewGesture?.set_enabled(false);

        for (const name of WORKSPACE_BINDINGS) {
            Main.wm.setCustomKeybindingHandler(name, KEYBINDING_MODES,
                (...args) => switchWorkspace(this._settings, ...args));
        }

        // A workspace empties when a window leaves it, and is left when
        // another is activated; one an app is starting on is not empty.
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._queueTrim(),
            'workspace-added', () => this._watchWorkspaces(),
            'workspace-removed', () => this._watchWorkspaces(),
            this);
        Shell.WindowTracker.get_default().connectObject(
            'startup-sequence-changed', () => this._queueTrim(), this);
        this._watchWorkspaces();
        this._trim();
    }

    disable() {
        global.workspace_manager.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        this._workspaces().forEach(workspace => workspace.disconnectObject(this));
        if (this._trimId)
            GLib.source_remove(this._trimId);
        this._trimId = 0;
        this._trim();

        this._indicator?.destroy();
        this._indicator = null;

        this._dots?.show();
        this._dots = null;

        this._overviewGesture?.set_enabled(true);
        this._overviewGesture = null;

        // Hand the bindings back to the shell's own handler, popup and all.
        const stock = Main.wm._showWorkspaceSwitcher.bind(Main.wm);
        for (const name of WORKSPACE_BINDINGS)
            Main.wm.setCustomKeybindingHandler(name, KEYBINDING_MODES, stock);
    }

    _workspaces() {
        const workspaceManager = global.workspace_manager;
        return Array.from({length: workspaceManager.n_workspaces},
            (_, i) => workspaceManager.get_workspace_by_index(i));
    }

    _watchWorkspaces() {
        for (const workspace of this._workspaces()) {
            workspace.disconnectObject(this);
            workspace.connectObject('window-removed', () => this._queueTrim(), this);
        }
        this._queueTrim();
    }

    // Once the change that set it off has landed, as a window moving to
    // another workspace is removed from one before it is added to the other.
    _queueTrim() {
        if (this._trimId)
            return;

        this._trimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            this._trimId = 0;
            this._trim();
            return GLib.SOURCE_REMOVE;
        });
    }

    // From the end, the added workspaces that are empty and not active. A
    // window on every workspace leaves them empty.
    _trim() {
        const recorded = this._settings.get_user_value(RECORD);
        if (!recorded || Meta.prefs_get_dynamic_workspaces())
            return;

        const workspaceManager = global.workspace_manager;
        const before = recorded.unpack();
        const starting = Shell.WindowTracker.get_default().get_startup_sequences()
            .map(sequence => sequence.get_workspace());

        for (let i = workspaceManager.n_workspaces - 1; i >= before; i--) {
            const workspace = workspaceManager.get_workspace_by_index(i);
            if (workspace.active || starting.includes(i) ||
                workspace.list_windows().some(window => !window.is_on_all_workspaces()))
                break;
            workspaceManager.remove_workspace(workspace, global.get_current_time());
        }

        if (workspaceManager.n_workspaces <= before)
            this._settings.reset(RECORD);
    }
}
