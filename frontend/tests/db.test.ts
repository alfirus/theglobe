import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	clearAllConversations,
	closeDB,
	deleteConversation,
	getConversation,
	getConversations,
	saveConversation,
	type Conversation
} from '../src/lib/db';

/**
 * `db.ts` — the conversation store behind the sidebar and the chat history
 * (P1-5). fake-indexeddb gives a real IndexedDB implementation in Node, so
 * these exercise the actual transactions rather than a mock of them.
 */
function conversation(overrides: Partial<Conversation> = {}): Conversation {
	return {
		id: crypto.randomUUID(),
		title: 'New Conversation',
		messages: [],
		provider: 'hermes',
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		...overrides
	};
}

describe('db.ts — conversation persistence', () => {
	beforeEach(async () => {
		await clearAllConversations();
	});

	it('saves and reads a conversation back', async () => {
		const saved = await saveConversation(
			conversation({ title: 'First', messages: [{ role: 'user', content: 'hello' }] })
		);

		const stored = await getConversation(saved.id);
		expect(stored).not.toBeNull();
		expect(stored?.title).toBe('First');
		expect(stored?.messages).toEqual([{ role: 'user', content: 'hello' }]);
	});

	it('stamps updatedAt itself, preserves createdAt, and never mutates the input', async () => {
		const original = conversation({ createdAt: 1_600_000_000_000, updatedAt: 1_600_000_000_000 });

		const saved = await saveConversation(original);

		// The caller's object is untouched — saveConversation copies.
		expect(original.updatedAt).toBe(1_600_000_000_000);
		expect(saved.updatedAt).toBeGreaterThanOrEqual(1_700_000_000_000);
		// createdAt belongs to the creator and must survive every re-save (L10).
		expect(saved.createdAt).toBe(1_600_000_000_000);

		const again = await saveConversation({ ...saved, title: 'Renamed' });
		expect(again.createdAt).toBe(1_600_000_000_000);
		expect(again.title).toBe('Renamed');
	});

	it('deep-copies messages so later edits cannot rewrite stored history', async () => {
		const messages: Conversation['messages'] = [{ role: 'user', content: 'original' }];
		const saved = await saveConversation(conversation({ messages }));

		messages[0].content = 'mutated after save';
		messages.push({ role: 'assistant', content: 'injected' });

		const stored = await getConversation(saved.id);
		expect(stored?.messages).toEqual([{ role: 'user', content: 'original' }]);
	});

	it('returns conversations sorted by updatedAt, newest first', async () => {
		const first = await saveConversation(conversation({ title: 'Oldest' }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await saveConversation(conversation({ title: 'Middle' }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const third = await saveConversation(conversation({ title: 'Newest' }));

		const all = await getConversations();
		expect(all.map((c) => c.id)).toEqual([third.id, second.id, first.id]);
		expect(all.map((c) => c.title)).toEqual(['Newest', 'Middle', 'Oldest']);
	});

	it('returns null for an unknown id', async () => {
		expect(await getConversation('does-not-exist')).toBeNull();
	});

	it('deletes a conversation and leaves the rest alone', async () => {
		const keep = await saveConversation(conversation({ title: 'Keep' }));
		const drop = await saveConversation(conversation({ title: 'Drop' }));

		await deleteConversation(drop.id);

		expect(await getConversation(drop.id)).toBeNull();
		const remaining = await getConversations();
		expect(remaining.map((c) => c.id)).toEqual([keep.id]);
	});

	it('clears every conversation', async () => {
		await saveConversation(conversation());
		await saveConversation(conversation());
		expect(await getConversations()).toHaveLength(2);

		await clearAllConversations();

		expect(await getConversations()).toHaveLength(0);
	});

	it('re-opens cleanly after closeDB() (shared-connection teardown, L10)', async () => {
		const saved = await saveConversation(conversation({ title: 'Before close' }));
		closeDB();

		// The next call must open a fresh connection instead of reusing a closed one.
		const stored = await getConversation(saved.id);
		expect(stored?.title).toBe('Before close');

		const second = await saveConversation(conversation({ title: 'After close' }));
		expect(await getConversation(second.id)).not.toBeNull();
	});
});
