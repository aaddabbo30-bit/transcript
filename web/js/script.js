// The script of a call: every suggestion Claude sent during it, kept in the
// order it arrived, so nothing disappears when the next one comes. The latest
// set is shown big ("now"); the script lists all the others, newest first,
// grouped by when they arrived, with a filter by kind and pins.

export const KINDS = ["answer", "question", "point", "warning"];

const keyOf = (item) => `${item.kind}|${String(item.say || item.text || "").trim().toLowerCase()}`;

export class SuggestionScript {
  constructor(items = []) {
    this.items = []; // {key, kind, say, why, topic, at}
    this.pinned = new Set();
    this.latest = null; // keys of the latest set
    for (const item of items) this.addItem(item, item.at, item.topic);
  }

  addItem(item, at, topic = "") {
    const say = String(item.say || item.text || "").trim();
    if (!say) return null;
    const kind = KINDS.includes(item.kind) ? item.kind : "point";
    const key = keyOf({ kind, say });
    const known = this.items.find((x) => x.key === key);
    if (known) return null; // said again: it keeps its place
    const entry = { key, kind, say, why: String(item.why || ""), topic: topic || "", at };
    this.items.push(entry);
    return entry;
  }

  /** A set from show_suggestions; returns true when it brought something new. */
  add(set) {
    if (!set) return false;
    // A page opened mid-call: the bridge's earlier suggestions go in first, as older.
    for (const old of set.previous || []) this.addItem(old, set.updatedAt - 1, "");
    let added = false;
    for (const item of set.suggestions || []) if (this.addItem(item, set.updatedAt, set.topic)) added = true;
    this.latest = new Set((set.suggestions || []).map((item) => keyOf({ kind: KINDS.includes(item.kind) ? item.kind : "point", say: String(item.say || item.text || "").trim() })));
    return added;
  }

  togglePin(key) {
    if (this.pinned.has(key)) this.pinned.delete(key);
    else this.pinned.add(key);
  }

  counts() {
    const counts = { all: this.items.length };
    for (const kind of KINDS) counts[kind] = this.items.filter((x) => x.kind === kind).length;
    return counts;
  }

  /** The script below "now": the earlier suggestions (all of them with a filter), newest first, grouped by arrival. */
  groups(filter = "all") {
    const shown = this.items.filter((x) => (filter === "all" ? !(this.latest && this.latest.has(x.key)) : x.kind === filter));
    const groups = [];
    for (const item of [...shown].sort((a, b) => b.at - a.at)) {
      const last = groups[groups.length - 1];
      if (last && last.at === item.at) last.items.push(item);
      else groups.push({ at: item.at, topic: item.topic, items: [item] });
    }
    return groups;
  }

  pinnedItems() {
    return this.items.filter((x) => this.pinned.has(x.key));
  }

  /** What the history keeps of the call. */
  toJSON() {
    return this.items.map(({ kind, say, why, topic, at }) => ({ kind, say, why, topic, at }));
  }
}
