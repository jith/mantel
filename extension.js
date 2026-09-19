// SPDX-License-Identifier: GPL-3.0-or-later

// Mantel — top bar workspaces and autohide.
//
// Thin wiring only: each feature lives in its own module and is started and
// stopped independently from its setting, so a toggle takes effect at once
// rather than needing a logout. New features slot in the same way.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WorkspaceNumbers} from './workspaces.js';
import {PanelAutohide} from './autohide.js';

// Each entry: the setting key, the field it is stored in, and its constructor.
const FEATURES = [
    {key: 'workspace-numbers', field: '_workspaces', create: () => new WorkspaceNumbers()},
    {key: 'autohide', field: '_autohide', create: () => new PanelAutohide()},
];

export default class MantelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        for (const feature of FEATURES) {
            this._settings.connectObject(
                `changed::${feature.key}`, () => this._sync(feature), this);
            this._sync(feature);
        }
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._settings = null;

        for (const feature of FEATURES)
            this._stop(feature);
    }

    _sync(feature) {
        if (this._settings?.get_boolean(feature.key))
            this._start(feature);
        else
            this._stop(feature);
    }

    // A feature that throws on the way up must not take the others with it,
    // so each start and stop is isolated and reported rather than propagated.
    _start(feature) {
        if (this[feature.field])
            return;

        try {
            const instance = feature.create();
            instance.enable();
            this[feature.field] = instance;
        } catch (e) {
            this[feature.field] = null;
            console.error(`Mantel: ${feature.key} failed to start: ${e}`);
        }
    }

    _stop(feature) {
        if (!this[feature.field])
            return;

        try {
            this[feature.field].disable();
        } catch (e) {
            console.error(`Mantel: ${feature.key} failed to stop cleanly: ${e}`);
        }
        this[feature.field] = null;
    }
}
