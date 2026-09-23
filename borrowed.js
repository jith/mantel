// SPDX-License-Identifier: GPL-3.0-or-later
//
// A setting outside Mantel that a feature changes while it runs and hands
// back when it stops. The original is recorded in a key of Mantel's own, since
// a logout ends the session without disable(); an unset record means nothing
// is on loan. It is handed back only while it still holds Mantel's value, and
// a default is reset rather than copied.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class BorrowedSetting {
    // type is 'int', 'string', 'boolean' or 'strv'; change(value) is what to
    // lend in place of value, or null to leave it alone.
    constructor({mantel, record, target, key, type, change}) {
        this._mantel = mantel;
        this._record = record;
        this._target = target;
        this._key = key;
        this._type = type;
        this._change = change;
    }

    take() {
        const current = this._get(this._target, this._key);
        const lent = this._lent();

        // Still out from a session that ended without handing it back.
        if (lent !== null && same(current, this._change(lent)))
            return;

        // Anything else on record is stale: the user has changed it since.
        const replacement = this._change(current);
        if (replacement === null) {
            if (lent !== null)
                this._mantel.reset(this._record);
            return;
        }

        // Recorded first, so stopping halfway cannot lose the user's value.
        this._set(this._mantel, this._record, current);
        this._set(this._target, this._key, replacement);
    }

    giveBack() {
        const lent = this._lent();
        if (lent === null)
            return;

        if (same(this._get(this._target, this._key), this._change(lent))) {
            if (same(this._target.get_default_value(this._key)?.deepUnpack(), lent))
                this._target.reset(this._key);
            else
                this._set(this._target, this._key, lent);
        }

        this._mantel.reset(this._record);
    }

    _lent() {
        return this._mantel.get_user_value(this._record)?.deepUnpack() ?? null;
    }

    _get(settings, key) {
        return settings[`get_${this._type}`](key);
    }

    _set(settings, key, value) {
        settings[`set_${this._type}`](key, value);
    }
}
