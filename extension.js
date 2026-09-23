// SPDX-License-Identifier: GPL-3.0-or-later

// Mantel: numbered workspaces, top bar auto-hide and auto-tiling. Each
// feature is its own module, started and stopped from its own setting.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WorkspaceNumbers} from './workspaces.js';
import {PanelAutohide} from './autohide.js';
import {AutoTile} from './tiling.js';

// The setting key, the field the instance is kept in, its constructor, and
// whether it keeps running on the lock screen.
const FEATURES = [
    {key: 'workspace-numbers', field: '_workspaces', create: () => new WorkspaceNumbers()},
    {key: 'autohide', field: '_autohide', create: () => new PanelAutohide()},
    {key: 'auto-tile', field: '_autoTile', create: settings => new AutoTile(settings), locked: true},
];

// A feature that throws must not take the others with it.
function attempt(feature, action, callback) {
    try {
        callback();
        return true;
    } catch (e) {
        console.error(`Mantel: ${feature.key} failed to ${action}: ${e}`);
        return false;
    }
}

export default class MantelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        for (const feature of FEATURES) {
            this._settings.connectObject(
                `changed::${feature.key}`, () => this._sync(feature), this);
        }
        Main.sessionMode.connectObject('updated',
            () => FEATURES.forEach(feature => this._sync(feature)), this);

        FEATURES.forEach(feature => this._sync(feature));
    }

    // The unlock-dialog session mode keeps auto-tiling running while the
    // screen is locked, so that the layout is still there after unlocking
    // rather than rebuilt from scratch. It drops its keybindings there, and
    // the other features stop on the lock screen as they would without it.
    disable() {
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;

        for (const feature of FEATURES)
            this._stop(feature);
    }

    _sync(feature) {
        if (this._settings.get_boolean(feature.key) && (feature.locked || !Main.sessionMode.isLocked))
            this._start(feature);
        else
            this._stop(feature);
    }

    // What a feature's enable() got through is unwound if it throws.
    _start(feature) {
        if (this[feature.field])
            return;

        const instance = feature.create(this._settings);
        if (attempt(feature, 'start', () => instance.enable()))
            this[feature.field] = instance;
        else
            attempt(feature, 'stop', () => instance.disable());
    }

    _stop(feature) {
        const instance = this[feature.field];
        this[feature.field] = null;
        if (instance)
            attempt(feature, 'stop', () => instance.disable());
    }
}
