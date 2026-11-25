// SPDX-License-Identifier: GPL-3.0-or-later
//
// Logging out, powering off and restarting first ask every app window to
// close, as closing it by hand would. GNOME would otherwise end the apps
// without a word, and whatever they would have asked about, unsaved changes
// or a window of tabs, goes with them. An app that answers with a prompt, or
// does not close, holds the session open: GNOME is told to cancel, the app
// is brought forward, and a warning says which apps are waiting.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// How long the apps get to close, and how long a window one of them opens
// meanwhile has to stay before it counts as a prompt.
const CLOSE_MS = 8000;
const PROMPT_MS = 400;

const ACTIONS = {
    ConfirmedLogout: 'log out',
    ConfirmedShutdown: 'power off',
    ConfirmedReboot: 'restart',
};

const capitalized = text => text[0].toUpperCase() + text.slice(1);

// "A", "A and B", "A, B and C".
function listed(names) {
    return names.length < 2 ? names.join('')
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// An app's own window, as against its dialogs, which close with it, and
// the desktop, docks and windows kept off the taskbar.
export function closable(window) {
    return !window.is_override_redirect() &&
        window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.is_skip_taskbar() &&
        window.get_transient_for() === null &&
        window.can_close();
}

// What the warning says, from what kept each app open.
export function warning(signal, blocked) {
    const action = ACTIONS[signal] ?? 'log out';
    const asking = blocked.filter(entry => entry.asked).map(entry => entry.name);
    const open = blocked.filter(entry => !entry.asked).map(entry => entry.name);

    const lines = [];
    if (asking.length) {
        lines.push(`${listed(asking)} ${asking.length > 1 ? 'are' : 'is'} asking before ` +
            `${asking.length > 1 ? 'they close' : 'it closes'}.`);
    }
    if (open.length) {
        lines.push(`${listed(open)} did not close, and may have unsaved work.`);
    }
    lines.push(`Deal with ${blocked.length > 1 ? 'them' : 'it'}, then ${action} again.`);

    return {title: `${capitalized(action)} cancelled`, body: lines.join(' ')};
}

export class LogoutGuard {
    constructor() {
        this._dialog = null;
        this._original = null;
        this._wrapper = null;
        this._busy = false;
        this._timeouts = new Set();
        this._source = null;
    }

    enable() {
        const dialog = Main.endSessionDialog;
        if (!dialog)
            return;

        this._dialog = dialog;
        this._original = Object.hasOwn(dialog, '_confirm') ? dialog._confirm : null;
        this._wrapper = signal => this._guard(dialog, signal);
        dialog._confirm = this._wrapper;
    }

    disable() {
        const dialog = this._dialog;
        if (dialog && dialog._confirm === this._wrapper) {
            if (this._original)
                dialog._confirm = this._original;
            else
                delete dialog._confirm;
        }
        this._dialog = null;
        this._original = this._wrapper = null;

        this._clear();
        this._source?.destroy();
        this._source = null;
    }

    // What the dialog does once a button is pressed, or its countdown ends.
    async _guard(dialog, signal) {
        const confirm = this._original ?? Object.getPrototypeOf(dialog)._confirm;
        const proceed = () => confirm.call(dialog, signal);

        const windows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(closable);
        if (this._busy || !(signal in ACTIONS) || !windows.length)
            return proceed();

        // From the countdown the dialog is still up, and its grab would keep
        // the apps' prompts from any input.
        this._busy = true;
        dialog._stopTimer();
        dialog.close(true);

        let blocked;
        try {
            blocked = await this._closeAll(windows);
        } finally {
            this._busy = false;
        }

        if (!blocked.length)
            return proceed();

        dialog.cancel();
        Main.activateWindow(blocked[0].window);
        this._warn(signal, blocked);
        return undefined;
    }

    // Resolves to what is still open, by app, once every window has closed,
    // an app has opened a prompt, or the apps have had long enough.
    _closeAll(windows) {
        return new Promise(resolve => {
            const open = new Set(windows);
            const pids = new Set(windows.map(window => window.get_pid()).filter(pid => pid > 0));
            const prompts = new Set();
            let done = false;

            const finish = () => {
                if (done)
                    return;
                done = true;
                this._clear();
                for (const window of [...windows, ...prompts])
                    window.disconnectObject(this);

                const tracker = Shell.WindowTracker.get_default();
                const byApp = new Map();
                for (const [window, asked] of [...[...prompts].map(w => [w, true]),
                    ...[...open].map(w => [w, false])]) {
                    const name = tracker.get_window_app(window)?.get_name() ??
                        window.get_wm_class() ?? window.get_title();
                    const entry = byApp.get(name);
                    if (!entry)
                        byApp.set(name, {name, window, asked});
                    else if (asked && !entry.asked)
                        Object.assign(entry, {window, asked});
                }
                resolve([...byApp.values()]);
            };

            const check = () => {
                if (!open.size && !prompts.size)
                    finish();
            };

            for (const window of windows) {
                window.connectObject('unmanaging', () => {
                    open.delete(window);
                    check();
                }, this);
            }

            // A window from an app being closed is it asking something.
            global.display.connectObject('window-created', (_display, window) => {
                const parent = window.get_transient_for();
                if (!open.has(parent) && !pids.has(window.get_pid()))
                    return;

                prompts.add(window);
                window.connectObject('unmanaging', () => {
                    prompts.delete(window);
                    window.disconnectObject(this);
                    check();
                }, this);
                this._timeout(PROMPT_MS, () => prompts.has(window) && finish());
            }, this);

            this._timeout(CLOSE_MS, finish);

            const time = global.get_current_time();
            for (const window of windows)
                window.delete(time);
        });
    }

    _warn(signal, blocked) {
        const {title, body} = warning(signal, blocked);

        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'Mantel',
                iconName: 'dialog-warning-symbolic',
            });
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }

        const notification = new MessageTray.Notification({
            source: this._source,
            title,
            body,
            iconName: 'dialog-warning-symbolic',
            urgency: MessageTray.Urgency.CRITICAL,
        });
        const window = blocked[0].window;
        notification.connect('activated', () => {
            if (window.get_compositor_private())
                Main.activateWindow(window);
        });
        this._source.addNotification(notification);
    }

    _timeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _clear() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        global.display.disconnectObject(this);
    }
}
