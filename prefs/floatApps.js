// SPDX-License-Identifier: GPL-3.0-or-later
//
// The apps that open floating while windows are tiled (the float-apps key),
// added by picking an installed app or by typing an app ID.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const KEY = 'float-apps';
const FALLBACK_ICON = 'application-x-executable-symbolic';

const idOf = info => info.get_id().replace(/\.desktop$/, '');

function appRow(title, subtitle, icon) {
    const row = new Adw.ActionRow({title, subtitle, use_markup: false});
    row.add_prefix(new Gtk.Image({
        gicon: icon ?? new Gio.ThemedIcon({name: FALLBACK_ICON}),
        icon_size: Gtk.IconSize.LARGE,
    }));
    return row;
}

function chooseApp(window, listed, add) {
    const taken = new Set(listed.map(id => id.toLowerCase()));
    const apps = Gio.AppInfo.get_all()
        .filter(info => info.should_show() && !taken.has(idOf(info).toLowerCase()))
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

    const dialog = new Adw.Dialog({
        title: _('Add App'),
        content_width: 420,
        content_height: 560,
    });

    const search = new Gtk.SearchEntry({
        placeholder_text: _('Search apps'),
        hexpand: true,
    });
    const list = new Gtk.ListBox({
        css_classes: ['boxed-list'],
        selection_mode: Gtk.SelectionMode.NONE,
        margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
        valign: Gtk.Align.START,
    });

    for (const info of apps) {
        const row = appRow(info.get_display_name(), idOf(info), info.get_icon());
        row.activatable = true;
        row.connect('activated', () => {
            add(idOf(info));
            dialog.close();
        });
        list.append(row);
    }

    list.set_filter_func(row => {
        const text = search.text.toLowerCase();
        return !text || row.title.toLowerCase().includes(text) ||
            row.subtitle.toLowerCase().includes(text);
    });
    search.connect('search-changed', () => list.invalidate_filter());

    const header = new Adw.HeaderBar({title_widget: search});
    const view = new Adw.ToolbarView({
        content: new Gtk.ScrolledWindow({
            child: list,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }),
    });
    view.add_top_bar(header);
    dialog.child = view;

    dialog.present(window);
}

export function buildFloatAppsGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: _('Floating Apps'),
        description: _('These open floating, in front of the layout, instead of tiled. The float shortcut still moves any window in or out of the layout.'),
    });

    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: _('Reset to Defaults'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset(KEY));
    group.set_header_suffix(reset);

    const listed = () => settings.get_strv(KEY);
    const add = id => {
        id = id.trim();
        if (id && !listed().some(entry => entry.toLowerCase() === id.toLowerCase()))
            settings.set_strv(KEY, [...listed(), id]);
    };
    const remove = id => settings.set_strv(KEY, listed().filter(entry => entry !== id));

    const choose = new Adw.ButtonRow({
        title: _('Add App…'),
        start_icon_name: 'list-add-symbolic',
    });
    choose.connect('activated', () => chooseApp(window, listed(), add));

    const byId = new Adw.EntryRow({
        title: _('Add by App ID'),
        show_apply_button: true,
    });
    byId.connect('apply', () => {
        add(byId.text);
        byId.text = '';
    });

    const entryRow = id => {
        const info = id.endsWith('*') ? null : GioUnix.DesktopAppInfo.new(`${id}.desktop`);
        const row = appRow(info?.get_display_name() ?? id, info ? id : '', info?.get_icon());

        const button = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Remove'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        button.connect('clicked', () => remove(id));
        row.add_suffix(button);
        return row;
    };

    // A group cannot insert, so the add rows are moved after the list.
    let rows = [];
    group.add(choose);
    group.add(byId);
    const sync = () => {
        for (const row of [...rows, choose, byId])
            group.remove(row);

        rows = listed().map(entryRow);
        for (const row of [...rows, choose, byId])
            group.add(row);

        reset.sensitive = settings.get_user_value(KEY) !== null;
    };

    // Dropped with the window, which the preferences process outlives.
    const changed = settings.connect(`changed::${KEY}`, sync);
    window.connect('close-request', () => {
        settings.disconnect(changed);
        return false;
    });

    sync();
    return group;
}
