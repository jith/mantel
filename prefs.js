// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildFloatAppsGroup} from './prefs/floatApps.js';
import {buildShortcutsPage} from './prefs/shortcutsPage.js';

export default class MantelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
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
            ['auto-tile', _('Tile windows as they open'),
                _('The first window on a workspace takes all of it, and each one after that splits the focused window. Maximizing a tiled window floats it until it is restored')],
        ];

        for (const [key, title, subtitle] of rows) {
            const row = new Adw.SwitchRow({title, subtitle});
            group.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        const layout = new Adw.PreferencesGroup({
            title: _('Layout'),
            description: _('Only used while windows are being tiled.'),
        });
        page.add(layout);
        settings.bind('auto-tile', layout, 'sensitive', Gio.SettingsBindFlags.GET);

        const hover = new Adw.SwitchRow({
            title: _('Focus follows the mouse'),
            subtitle: _('Focus the window under the pointer, without raising it'),
        });
        layout.add(hover);
        settings.bind('focus-follows-mouse', hover, 'active', Gio.SettingsBindFlags.DEFAULT);

        // The setting key, its title and subtitle, and the largest value.
        const lengths = [
            ['gap', _('Gap between windows'),
                _('Space left between neighbouring windows, growing with the display scale. The layout itself stays flush with the screen'), 64],
            ['border', _('Focused window outline'),
                _('Thickness of the outline around the focused window. The screen edge keeps this much back, because the outline is drawn outside the window. Zero draws none'), 32],
        ];

        for (const [key, title, subtitle, upper] of lengths) {
            const row = new Adw.SpinRow({
                title, subtitle,
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper, stepIncrement: 1, pageIncrement: 4,
                }),
            });
            layout.add(row);
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        }

        const floating = buildFloatAppsGroup(settings, window);
        page.add(floating);
        settings.bind('auto-tile', floating, 'sensitive', Gio.SettingsBindFlags.GET);

        window.add(page);
        window.add(buildShortcutsPage(settings, window));
    }
}
