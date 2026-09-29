/**
 * Sentence-splitter tests for streaming TTS (P1-4).
 *
 * Run:  node frontend/scripts/tts-split.test.mjs
 * (needs Node >= 22.6, which strips types natively — no test runner, no deps,
 * because this repo's package.json carries no test script yet)
 *
 * What it protects: the acceptance criterion "multi-line replies sound natural
 * (no mid-word cuts at chunk boundaries)" — the splitter must only ever cut on
 * sentence, clause or whitespace boundaries, even when the network hands us a
 * word half-written.
 */
import { createSplitter, cleanForSpeech, MAX_UTTERANCE } from '../src/lib/ttsSplit.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass += 1;
		console.log(`  ok   ${name}`);
	} else {
		fail += 1;
		console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
	}
}

/** Feed text one character at a time — the worst case for a splitter. */
function drip(text) {
	const s = createSplitter();
	const out = [];
	for (const ch of text) out.push(...s.push(ch));
	out.push(...s.flush());
	return out;
}

function feed(text) {
	const s = createSplitter();
	const out = s.push(text);
	out.push(...s.flush());
	return out;
}

console.log('1. plain sentences, whole text');
check('two sentences', feed('Hello there. How are you today?'), ['Hello there.', 'How are you today?']);

console.log('2. character-by-character drip (no mid-word cuts)');
check('drip', drip('First sentence here. Second one follows.'), [
	'First sentence here.',
	'Second one follows.'
]);

console.log('3. word split across two network chunks');
{
	const s = createSplitter();
	const a = s.push('The quick brown fo');
	const b = s.push('x jumps.');
	const rest = s.flush();
	check('no space inside "fox"', [...a, ...b, ...rest], ['The quick brown fox jumps.']);
}

console.log('4. numbers and abbreviations are not sentence ends');
check('decimal', feed('Pi is 3.14 exactly.'), ['Pi is 3.14 exactly.']);
check('abbrev', feed('Use e.g. the chat route.'), ['Use e.g. the chat route.']);
check('title', feed('Dr. Smith arrived. We waited.'), ['Dr. Smith arrived.', 'We waited.']);
check('initials', feed('J. R. R. Tolkien wrote it. It is long.'), [
	'J. R. R. Tolkien wrote it.',
	'It is long.'
]);

console.log('5. line and markdown structure');
check(
	'bullets become their own utterances',
	feed('Plan:\n1. First step.\n2. Second step.\n\nDone for now.'),
	['Plan:', 'First step.', 'Second step.', 'Done for now.']
);
check('heading and bold stripped', feed('## Results\n**Bold** text wins.'), ['Results', 'Bold text wins.']);
check(
	'links keep their label, bare URLs vanish',
	feed('See [the docs](https://example.com/x) or https://foo.bar/baz today.'),
	['See the docs or today.']
);
check('code fence dropped', feed('Run it:\n```ts\nconst x = 1;\n```\nThen stop.'), ['Run it:', 'Then stop.']);
check('table rows dropped', feed('A note.\n| a | b |\n|---|---|\nAfter.'), ['A note.', 'After.']);

console.log('6. pressure cut on a run-on (no mid-word split)');
{
	const long =
		'This sentence keeps going and going without a single full stop so the splitter has to cut it somewhere sensible ' +
		'reading the whole paragraph out loud in one breath would be far too long to buffer before the first chunk of audio ' +
		'is produced and played back for the listener who is still waiting to hear anything at all, and that is exactly why ' +
		'the pressure cut exists: it fires only once the pending text is over the utterance cap and only on a word boundary';
	check('longer than one utterance', long.length > MAX_UTTERANCE, true);
	const out = feed(long);
	check('multiple chunks', out.length > 1, true);
	check('first chunk under cap', out[0].length <= MAX_UTTERANCE, true);
	check('no word broken', out.every((chunk) => long.includes(chunk)), true);
	check('rejoins', out.join(' '), long);
}

console.log('7. flush emits the trailing sentence');
check('tail', feed('One. Two'), ['One.', 'Two']);
check('no punctuation tail', feed('no punctuation here'), ['no punctuation here']);
check('empty', feed('   '), []);

console.log('8. stall nudge cuts at a clause boundary');
{
	const s = createSplitter();
	const got = s.push('Well, that depends on the budget we have available right now, the timeline and the team');
	check('nothing complete yet', got, []);
	const nudged = s.nudge();
	check(
		'nudge returns a clause',
		nudged,
		'Well, that depends on the budget we have available right now,'
	);
	check('remainder kept', s.flush(), ['the timeline and the team']);
}

console.log('9. CRLF and blank input');
check('crlf', feed('Line one.\r\nLine two.\r\n'), ['Line one.', 'Line two.']);
check('no-op push', feed(''), []);

console.log('10. cleanForSpeech');
check('emphasis', cleanForSpeech('**bold** and *italic*'), 'bold and italic');
check('inline code', cleanForSpeech('run `npm run build` now'), 'run npm run build now');
check('hr', cleanForSpeech('---'), '');
check('whitespace', cleanForSpeech('  a\n\nb  '), 'a b');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
