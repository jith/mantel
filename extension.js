// SPDX-License-Identifier: GPL-3.0-or-later

// Mantel: numbered workspaces, top bar auto-hide and auto-tiling. Each
// feature is its own module, started and stopped from its own setting.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WorkspaceNumbers} from './workspaces.js';
import {PanelAutohide} from './autohide.js';
import {AutoTile} from './tiling.js';

// The setting key, the field the instance is kept in, and its constructor.
const FEATURES = [
    {key: 'workspace-numbers', field: '_workspaces', create: () => new WorkspaceNumbers()},
    {key: 'autohide', field: '_autohide', create: () => new PanelAutohide()},
    {key: 'auto-tile', field: '_autoTile', create: settings => new AutoTile(settings)},
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

        FEATURES.forEach(feature => this._sync(feature));
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;

        for (const feature of FEATURES)
            this._stop(feature);
    }

    _sync(feature) {
        if (this._settings.get_boolean(feature.key))
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
