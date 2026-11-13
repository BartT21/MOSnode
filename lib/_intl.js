// Minimal Intl polyfill (en-US-ish), used when the engine is built without
// ICU. Covers the subset real CLIs need: NumberFormat, DateTimeFormat,
// RelativeTimeFormat, Segmenter, Locale, Collator, ListFormat, PluralRules.
const g = globalThis;
if (typeof g.Intl === "undefined" || !g.Intl.Segmenter) {
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const pad = (n, w = 2) => String(n).padStart(w, "0");

  class NumberFormat {
    constructor(locale, options = {}) { this.locale = locale; this.options = options || {}; }
    resolvedOptions() { return { locale: "en-US", numberingSystem: "latn", style: this.options.style || "decimal", ...this.options }; }
    format(num) {
      num = Number(num);
      const o = this.options;
      if (o.style === "percent") num *= 100;
      let minF = o.minimumFractionDigits, maxF = o.maximumFractionDigits;
      if (o.style === "currency") { minF = minF ?? 2; maxF = maxF ?? 2; }
      if (maxF == null) maxF = Math.max(minF ?? 0, 3);
      if (minF == null) minF = 0;
      let s = Math.abs(num).toFixed(Math.min(maxF, 20));
      // trim toward minF
      if (s.indexOf(".") !== -1) {
        let [i, f] = s.split(".");
        while (f.length > minF && f.endsWith("0")) f = f.slice(0, -1);
        s = f.length ? i + "." + f : i;
      }
      // group integer part
      let [ip, fp] = s.split(".");
      if (o.useGrouping !== false) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      let out = (num < 0 ? "-" : "") + ip + (fp ? "." + fp : "");
      if (o.style === "percent") out += "%";
      if (o.style === "currency") out = (o.currencyDisplay === "code" ? (o.currency || "USD") + " " : "$") + out;
      return out;
    }
    formatToParts(num) { return [{ type: "literal", value: this.format(num) }]; }
    formatRange(a, b) { return this.format(a) + "–" + this.format(b); }
  }

  class DateTimeFormat {
    constructor(locale, options = {}) { this.locale = locale; this.options = options || {}; }
    resolvedOptions() { return { locale: "en-US", calendar: "gregory", numberingSystem: "latn", timeZone: this.options.timeZone || "UTC", ...this.options }; }
    format(date) {
      const d = date instanceof Date ? date : new Date(date ?? Date.now());
      const o = this.options;
      const parts = [];
      const has = (k) => o[k] !== undefined;
      if (!has("year") && !has("month") && !has("day") && !has("hour") && !has("minute") && !has("second") && !has("weekday")) {
        // default: short date
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
      }
      const datePieces = [];
      if (has("weekday")) datePieces.push(o.weekday === "short" ? DAYS[d.getDay()].slice(0, 3) : DAYS[d.getDay()]);
      const md = [];
      if (has("month")) md.push(o.month === "long" ? MONTHS[d.getMonth()] : o.month === "short" ? MONTHS[d.getMonth()].slice(0, 3) : pad(d.getMonth() + 1));
      if (has("day")) md.push(o.month === "numeric" || o.month === "2-digit" || !has("month") ? pad(d.getDate()) : String(d.getDate()));
      if (has("month") && (o.month === "long" || o.month === "short")) {
        if (has("day")) datePieces.push(`${md[0]} ${md[1]}`); else datePieces.push(md[0]);
        if (has("year")) datePieces.push(String(d.getFullYear()));
      } else {
        const numeric = [];
        if (has("month")) numeric.push(pad(d.getMonth() + 1));
        if (has("day")) numeric.push(pad(d.getDate()));
        if (has("year")) numeric.push(String(d.getFullYear()));
        if (numeric.length) datePieces.push(numeric.join("/"));
      }
      if (datePieces.length) parts.push(datePieces.join(", "));
      const timePieces = [];
      if (has("hour")) {
        let h = d.getHours(); let ampm = "";
        if (o.hour12 !== false && o.hourCycle !== "h23") { ampm = h >= 12 ? " PM" : " AM"; h = h % 12 || 12; }
        let t = o.hour12 !== false ? String(h) : pad(h);
        if (has("minute")) t += ":" + pad(d.getMinutes());
        if (has("second")) t += ":" + pad(d.getSeconds());
        timePieces.push(t + ampm);
      } else if (has("minute")) timePieces.push(pad(d.getHours()) + ":" + pad(d.getMinutes()) + (has("second") ? ":" + pad(d.getSeconds()) : ""));
      if (timePieces.length) parts.push(timePieces.join(" "));
      return parts.join(", ");
    }
    formatToParts(date) { return [{ type: "literal", value: this.format(date) }]; }
    formatRange(a, b) { return this.format(a) + " – " + this.format(b); }
  }

  class RelativeTimeFormat {
    constructor(locale, options = {}) { this.locale = locale; this.options = options || {}; }
    resolvedOptions() { return { locale: "en-US", style: this.options.style || "long", numeric: this.options.numeric || "always" }; }
    format(value, unit) {
      const v = Number(value);
      const u = unit.replace(/s$/, "");
      const abs = Math.abs(v);
      const plural = abs === 1 ? u : u + "s";
      if (v === 0 && this.options.numeric === "auto") return u === "day" ? "today" : "now";
      return v < 0 ? `${abs} ${plural} ago` : `in ${abs} ${plural}`;
    }
    formatToParts(value, unit) { return [{ type: "literal", value: this.format(value, unit) }]; }
  }

  class Segmenter {
    constructor(locale, options = {}) { this.granularity = (options && options.granularity) || "grapheme"; }
    resolvedOptions() { return { locale: "en-US", granularity: this.granularity }; }
    segment(input) {
      const str = String(input);
      const gran = this.granularity;
      const segs = [];
      if (gran === "word") {
        const re = /(\s+|[^\s\p{L}\p{N}]+|[\p{L}\p{N}]+)/gu;
        let m, i = 0;
        while ((m = re.exec(str)) !== null) {
          const seg = m[0];
          segs.push({ segment: seg, index: m.index, input: str, isWordLike: /[\p{L}\p{N}]/u.test(seg) });
          i = m.index + seg.length;
          if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
        }
      } else if (gran === "sentence") {
        const re = /[^.!?]*[.!?]+|\S[^.!?]*$/g;
        let m;
        while ((m = re.exec(str)) !== null) segs.push({ segment: m[0], index: m.index, input: str });
      } else {
        // grapheme: iterate by code point (covers surrogate pairs; not full clusters)
        let idx = 0;
        for (const ch of str) { segs.push({ segment: ch, index: idx, input: str }); idx += ch.length; }
      }
      return {
        [Symbol.iterator]() { let i = 0; return { next() { return i < segs.length ? { value: segs[i++], done: false } : { value: undefined, done: true }; } }; },
        containing(index) { return segs.find((s) => index >= s.index && index < s.index + s.segment.length) || segs[segs.length - 1]; },
      };
    }
  }

  class Collator {
    constructor() {}
    resolvedOptions() { return { locale: "en-US", usage: "sort", sensitivity: "variant" }; }
    compare(a, b) { return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; }
  }

  class ListFormat {
    constructor(locale, options = {}) { this.type = (options && options.type) || "conjunction"; }
    resolvedOptions() { return { locale: "en-US", type: this.type, style: "long" }; }
    format(list) {
      const arr = Array.from(list);
      if (arr.length === 0) return "";
      if (arr.length === 1) return arr[0];
      const last = arr[arr.length - 1];
      const conj = this.type === "disjunction" ? "or" : "and";
      return arr.slice(0, -1).join(", ") + (arr.length > 1 ? `, ${conj} ` : "") + last;
    }
    formatToParts(list) { return [{ type: "literal", value: this.format(list) }]; }
  }

  class PluralRules {
    constructor() {}
    resolvedOptions() { return { locale: "en-US", type: "cardinal" }; }
    select(n) { return Math.abs(Number(n)) === 1 ? "one" : "other"; }
  }

  class Locale {
    constructor(tag, options = {}) {
      tag = String(tag || "en-US");
      this.baseName = tag;
      const [lang, ...rest] = tag.split("-");
      this.language = lang;
      this.region = rest.find((p) => /^[A-Z]{2}$/.test(p));
      this.script = rest.find((p) => /^[A-Z][a-z]{3}$/.test(p));
      Object.assign(this, options);
    }
    maximize() { return this; }
    minimize() { return this; }
    toString() { return this.baseName; }
  }

  // Node's Intl constructors work with OR without `new`. ES classes require
  // `new`, so wrap each so `Intl.DateTimeFormat(...)` and `new ...` both work.
  const callable = (Cls) => {
    function F(...args) { return new Cls(...args); }
    F.prototype = Cls.prototype;
    F.supportedLocalesOf = (locales) => (Array.isArray(locales) ? locales : [locales]).map(String);
    Object.defineProperty(F, "name", { value: Cls.name });
    return F;
  };

  g.Intl = {
    NumberFormat: callable(NumberFormat), DateTimeFormat: callable(DateTimeFormat),
    RelativeTimeFormat: callable(RelativeTimeFormat), Segmenter: callable(Segmenter),
    Collator: callable(Collator), ListFormat: callable(ListFormat),
    PluralRules: callable(PluralRules), Locale: callable(Locale),
    getCanonicalLocales: (l) => (Array.isArray(l) ? l : [l]).map(String),
    supportedValuesOf: () => [],
  };
}
