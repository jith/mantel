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

        let instance = null;

        try {
            instance = feature.create();
            instance.enable();
            this[feature.field] = instance;
        } catch (e) {
            console.error(`Mantel: ${feature.key} failed to start: ${e}`);

            // enable() may have got partway before throwing — released the
            // panel's strut, connected signals, armed a timer. Forgetting the
            // instance here would strand all of it for the rest of the
            // session, so unwind before giving up. Both features tolerate
            // disable() on a half-built instance.
            try {
                instance?.disable();
            } catch (cleanupError) {
                console.error(`Mantel: ${feature.key} left state behind: ${cleanupError}`);
            }

            this[feature.field] = null;
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
