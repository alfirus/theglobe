/**
 * Incremental sentence splitter for streaming TTS (P1-4).
 *
 * The chat stream hands us text in whatever chunks the provider feels like
 * sending — a word, a clause, a whole paragraph. Speech needs complete
 * utterances: cut mid-word or mid-number sounds broken, and a 2 000-character
 * paragraph would stall the first audible chunk for seconds.
 *
 * So: buffer the raw reply, and emit an utterance only at a *safe* boundary —
 * a sentence end (with a real separator after it), a structural markdown break
 * (new bullet / heading / blank line), or — only under pressure — the last
 * clause boundary before `MAX_UTTERANCE`. Nothing is ever cut inside a word.
 *
 * Markdown is stripped at emit time rather than ingest time: boundary detection
 * runs on raw punctuation (markers don't change where sentences end), and by
 * the time a slice is emitted we have its whole `[label](url)` / `**bold**`
 * construct available to clean in one piece — a link arriving across three
 * network chunks would be mangled if cleaned incrementally.
 *
 * Fenced code blocks are dropped outright: reading `const x = await fetch()`
 * aloud is worse than not reading it at all.
 *
 * Pure and DOM-free on purpose — it is unit-testable with `node ttsSplit.ts`.
 */

/** Longest utterance we hand to synthesis before forcing a boundary. */
export const MAX_UTTERANCE = 400;

/** Below this, a "boundary" cut would make a stubby fragment — wait instead. */
const MIN_CUT = 60;

export interface TtsSplitter {
	/** Feed a chat delta; returns the utterances it completed. */
	push(text: string): string[];
	/** The reply ended: emit everything still pending. */
	flush(): string[];
	/** The stream went quiet: emit at a clause boundary if one is available. */
	nudge(): string | null;
	/** Characters waiting for a boundary — drives the stall timer. */
	readonly pending: number;
}

/** Words that end in a period but do not end a sentence. */
const ABBREVIATIONS = new Set([
	'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'ave', 'rd', 'blvd',
	'vs', 'etc', 'eg', 'ie', 'no', 'fig', 'approx', 'inc', 'ltd', 'co', 'corp', 'dept',
	'est', 'ca', 'cf', 'al', 'vol', 'pp', 'ref', 'min', 'max', 'sec', 'hr', 'yr', 'us',
	'uk', 'eu', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
	'nov', 'dec', 'govt', 'intl', 'tech', 'misc', 'url', 'http', 'iee', 'dept'
]);

const ENDERS = '.!?…。！？';
const CLOSERS = '"\'”’»)］】〕〉》';
const CLAUSE = /[,;:—–-]/;
const STRUCTURAL = /^\s*(?:#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|>\s|[-_*]{3,}\s*$)/;

function isEnder(ch: string): boolean {
	return ENDERS.includes(ch);
}

function isCjkEnder(ch: string): boolean {
	return ch === '。' || ch === '！' || ch === '？';
}

/**
 * `true` when a `.` at `i` really closes a sentence: not a decimal (`3.14`),
 * not an initial (`J. R. R.`), not an abbreviation (`e.g.`).
 */
function periodIsBoundary(text: string, i: number): boolean {
	const prev = text[i - 1] ?? '';
	const next = text[i + 1] ?? '';
	if (/[0-9]/.test(prev) && /[0-9]/.test(next)) return false;

	// A run of digits right at the start of the utterance is a list marker
	// ("1. First step"), not a sentence that ends in a number.
	if (/^\s*\d{1,3}\s*$/.test(text.slice(0, i))) return false;

	// Every dot counts: `e.g.` and `U.S.A` must reduce to `eg` / `usa`.
	const head = /[A-Za-z.]+$/.exec(text.slice(0, i))?.[0] ?? '';
	const word = head.replace(/\./g, '').toLowerCase();
	if (word.length === 1 && /^[a-z]$/.test(word)) return false; // initial
	if (ABBREVIATIONS.has(word)) return false;
	return true;
}

/**
 * Index at which `text` can be cut as a finished utterance, or `null`.
 *
 * `allowEnd` accepts a boundary at the very end of the buffer (used when a
 * line ended or the reply did) — mid-stream we require a separator after the
 * ender, because `3.` may still become `3.14`.
 */
function findSentenceEnd(text: string, allowEnd: boolean): number | null {
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (!isEnder(ch)) {
			i += 1;
			continue;
		}
		// Swallow ellipses (`...`, `…`) and trailing closers (`."`, `.)`).
		let j = i + 1;
		while (j < text.length && (isEnder(text[j]) || CLOSERS.includes(text[j]))) j += 1;

		const rest = text.slice(j);
		const atEnd = rest.length === 0;
		const separated = rest.length > 0 && /^\s/.test(rest);
		// CJK stops carry no trailing space in normal prose.
		if (!separated && !(atEnd && allowEnd) && !isCjkEnder(ch)) {
			i = j;
			continue;
		}
		if (ch === '.' && !periodIsBoundary(text, i)) {
			i += 1;
			continue;
		}
		return j;
	}
	return null;
}

/**
 * Pressure cut for a run-on that never punctuates: prefer the last clause
 * boundary, then the last space, both past the halfway mark so the utterance
 * stays useful. Only a >4× overrun with no whitespace at all cuts inside a
 * token, and even then at a word edge — never mid-word on ordinary text.
 */
function findPressureCut(text: string, max: number): number | null {
	const floor = Math.max(MIN_CUT, Math.floor(max / 2));
	if (text.length < max) return null;

	const window = text.slice(0, max);
	let clause = -1;
	for (let i = window.length - 1; i >= floor; i -= 1) {
		if (CLAUSE.test(window[i])) {
			clause = i;
			break;
		}
	}
	if (clause > 0) return clause + 1;

	const space = window.lastIndexOf(' ');
	if (space >= floor) return space;

	if (text.length > max * 4) return max; // pathological unbroken token
	return null;
}

/**
 * Strip markdown from an utterance so it can be spoken. Only what changes how
 * the sentence *sounds* — structure markers, emphasis, links, URLs, tags.
 */
export function cleanForSpeech(text: string): string {
	let s = text.replace(/\s+/g, ' ').trim();
	if (!s) return '';

	// Structure markers at the head of the utterance.
	s = s.replace(/^\s{0,3}#{1,6}\s+/, '');
	s = s.replace(/^\s*>\s?/, '');
	s = s.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '');
	if (/^\s*(?:[-_*]\s*){3,}$/.test(s)) return '';

	// Links and images → their label; bare URLs → gone (a URL read aloud is
	// never what the reply meant).
	s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	s = s.replace(/https?:\/\/\S+/g, '');
	s = s.replace(/\bwww\.[^\s)]+/g, '');

	// Inline code → its content, then emphasis markers around words.
	s = s.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
	s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
	s = s.replace(/\*([^*\n]+)\*/g, '$1');
	s = s.replace(/__([^_]+)__/g, '$1');
	s = s.replace(/~~([^~]+)~~/g, '$1');

	// HTML/JSX the model wrapped around content.
	s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

	return s.replace(/\s+/g, ' ').trim();
}

export function createSplitter(maxUtterance: number = MAX_UTTERANCE): TtsSplitter {
	let pending = ''; // raw text of the utterance being built
	let partial = ''; // current line, not yet terminated
	let inCode = false;
	// `true` when the last move into `pending` was a line break, i.e. the next
	// append starts a new line and needs a separator. Without this, text split
	// across two network chunks ("Hel" + "lo") would be joined with a space and
	// spoken as "hel lo".
	let atLineStart = true;

	const emit = (raw: string, out: string[]): void => {
		const cleaned = cleanForSpeech(raw);
		if (cleaned) out.push(cleaned);
	};

	/** Take everything up to `cut` out of `pending` and emit it. */
	const cutAt = (cut: number, out: string[]): void => {
		const slice = pending.slice(0, cut);
		pending = pending.slice(cut).replace(/^\s+/, '');
		atLineStart = false; // the remainder continues mid-line
		emit(slice, out);
	};

	/** Emit every complete sentence currently in `pending`. */
	const drain = (allowEnd: boolean, out: string[]): void => {
		for (;;) {
			const cut = findSentenceEnd(pending, allowEnd);
			if (cut !== null) {
				cutAt(cut, out);
				continue;
			}
			const pressure = findPressureCut(pending, maxUtterance);
			if (pressure !== null) {
				cutAt(pressure, out);
				continue;
			}
			return;
		}
	};

	const flushPending = (out: string[]): void => {
		if (!pending) return;
		const raw = pending;
		pending = '';
		atLineStart = true;
		emit(raw, out);
	};

	/** Append `text` (already whitespace-correct) to the utterance in progress. */
	const absorb = (text: string): void => {
		pending += pending && atLineStart ? ` ${text}` : text;
	};

	/**
	 * A finished line: it may open/close a fenced code block, break a
	 * paragraph, start a new markdown block, or simply continue the sentence.
	 * A line end counts as a separator, so `…done.\nNext` emits here.
	 */
	const finishLine = (line: string, out: string[]): void => {
		const trimmed = line.trim();

		if (inCode) {
			if (trimmed.startsWith('```')) {
				inCode = false;
				flushPending(out);
			}
			return; // code content is never spoken
		}

		if (trimmed.startsWith('```')) {
			// Text before the fence on the same line still belongs to the reply.
			absorb(line.slice(0, line.indexOf('```')));
			inCode = true;
			flushPending(out);
			return;
		}

		if (trimmed === '' || /^\s*(?:[-_*]\s*){3,}$/.test(trimmed)) {
			// Blank line / horizontal rule = paragraph break.
			flushPending(out);
			return;
		}
		if (trimmed.startsWith('|')) {
			// Tables are data, not prose — drop rows instead of reading pipes.
			flushPending(out);
			return;
		}

		// A new bullet/heading/quote closes whatever was pending.
		if (STRUCTURAL.test(line) && pending) flushPending(out);

		// Absorb with the current flag first: this line may be the continuation
		// of a tail `push` already moved, and only then must no space be added.
		const isHeading = /^\s{0,3}#{1,6}\s/.test(line);
		absorb(line.trimEnd());
		atLineStart = true;
		drain(true, out);
		// A heading is a unit of its own — never merge it into the paragraph
		// that follows it (`## Results` / `**Bold** wins` would otherwise read
		// as one run-on sentence).
		if (isHeading) flushPending(out);
	};

	return {
		push(text: string): string[] {
			const out: string[] = [];
			partial += text.replace(/\r/g, '');

			for (;;) {
				const nl = partial.indexOf('\n');
				if (nl < 0) break;
				const line = partial.slice(0, nl);
				partial = partial.slice(nl + 1);
				finishLine(line, out);
				atLineStart = true;
			}

			// Mid-line: move the tail across and keep only unfinished sentences.
			if (!inCode && partial) {
				absorb(partial);
				partial = '';
				atLineStart = false;
				drain(false, out);
			}
			return out;
		},

		flush(): string[] {
			const out: string[] = [];
			const rest = partial;
			partial = '';
			if (rest) finishLine(rest, out);
			if (!inCode) drain(true, out);
			flushPending(out);
			return out;
		},

		nudge(): string | null {
			if (!pending) return null;
			const out: string[] = [];
			drain(true, out);
			if (out.length > 0) return out[0];

			// No sentence end, but a clause boundary beats stalling playback.
			let cut = -1;
			for (let i = pending.length - 1; i >= MIN_CUT; i -= 1) {
				if (CLAUSE.test(pending[i])) {
					cut = i + 1;
					break;
				}
			}
			if (cut > 0) {
				const slice = pending.slice(0, cut);
				pending = pending.slice(cut).replace(/^\s+/, '');
				const cleaned = cleanForSpeech(slice);
				if (cleaned) return cleaned;
			}
			return null;
		},

		get pending(): number {
			return pending.length + partial.length;
		}
	};
}
