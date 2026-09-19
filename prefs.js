// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MantelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Features'),
            description: _('Each can be turned off on its own.'),
        });
        page.add(group);

        const rows = [
            ['workspace-numbers', _('Workspace numbers'),
                _('Number the top bar indicator, click a number to switch, and reach a workspace that does not exist yet with Super+1…0')],
            ['autohide', _('Auto-hide the top bar'),
                _('Hide the bar when a window needs the space; push the pointer at the top edge to bring it back')],
        ];

        for (const [key, title, subtitle] of rows) {
            const row = new Adw.SwitchRow({title, subtitle});
            group.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        window.add(page);
    }
}
