import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bloomHasAll, buildBloom, queryTrigrams } from '../../src/shared/bloom';
import { chatgptConversation, claudeConversation, toMarkdown } from '../../src/shared/extract';
import { ingest } from '../../src/shared/ingest';
import { normalize, normalizeQuery } from '../../src/shared/normalize';
import { parseQuery } from '../../src/shared/query';
import { Engine, boundedDL, fuzzyMatch } from '../../src/offscreen/engine';

const OPTS = { includeThinking: false, includeAttachments: true };

test('normalize is length-preserving and folds what it should', () => {
  const samples = ['Hello WORLD', 'Café — “quotes” … naïve', 'emoji 🛩️ plane ✈️', '日本語のテキスト', 'Straße Łódź Ørsted', 'tab\there\nnew line nbsp', 'İstanbul ǅ ﬁ'];
  for (const s of samples) assert.equal(normalize(s).length, s.length, `length changed for ${JSON.stringify(s)}`);
  assert.equal(normalize('Café — “Quotes”'), 'cafe - "quotes"');
  assert.equal(normalize('naïve résumé'), 'naive resume');
  assert.equal(normalize('Straße'), 'strase');
  assert.equal(normalize('a\tb\nc'), 'a b c');
  assert.equal(normalizeQuery('  Fleet   WEEK '), 'fleet week');
  assert.equal(normalize('ＡＢＣ'), 'abc');
});

test('query parser', () => {
  const q = parseQuery('plane "fleet week" -boeing from:me after:2026-09 claude:');
  assert.deepEqual(
    q.terms.map((t) => [t.norm, t.phrase]),
    [
      ['plane', false],
      ['fleet week', true],
    ],
  );
  assert.deepEqual(q.neg.map((t) => t.norm), ['boeing']);
  assert.equal(q.role, 'user');
  assert.deepEqual(q.sources, ['claude']);
  assert.equal(q.since, Date.UTC(2026, 8, 1));
  assert.equal(parseQuery('in:title risotto').titleOnly, true);
  assert.deepEqual(parseQuery('url:foo').terms.map((t) => t.norm), ['url:foo']);
  assert.equal(parseQuery('is:starred').starred, true);
});

test('bloom has no false negatives and few false positives', () => {
  const words = readFileSync('/usr/share/dict/words', 'utf8').split('\n').slice(0, 50000);
  let text = '';
  for (let i = 0; i < 3000; i++) text += words[(i * 7919) % words.length] + ' ';
  const norm = normalize(text);
  const bloom = buildBloom([norm]);
  for (let i = 0; i < 500; i++) {
    const p = (i * 104729) % (norm.length - 12);
    const sub = norm.slice(p, p + 3 + (i % 9));
    assert.ok(bloomHasAll(bloom, queryTrigrams(sub)), `false negative for ${sub}`);
  }
  // false positive = bloom says "all trigrams present" while at least one trigram truly is absent
  const tri = new Set<string>();
  for (let i = 2; i < norm.length; i++) tri.add(norm.slice(i - 2, i + 1));
  let fp = 0;
  let negatives = 0;
  const other = readFileSync('/usr/share/dict/words', 'utf8').split('\n').slice(120000, 160000);
  for (let i = 0; i < other.length; i += 7) {
    const w = normalize(other[i]);
    if (w.length < 5) continue;
    const grams = Array.from({ length: w.length - 2 }, (_, k) => w.slice(k, k + 3));
    if (grams.every((g) => tri.has(g))) continue; // a true trigram-level positive
    negatives++;
    if (bloomHasAll(bloom, queryTrigrams(w))) fp++;
  }
  assert.ok(negatives > 1000);
  // design point: 8 bits per trigram, 2 hashes => ~5% per absent trigram; real queries usually miss several
  assert.ok(fp / negatives < 0.06, `fp rate ${fp / negatives}`);
});

test('fuzzy helpers', () => {
  assert.equal(boundedDL('plnae', 'plane', 2), 1);
  assert.equal(boundedDL('teh', 'the', 1), 1);
  assert.equal(boundedDL('kitten', 'sitting', 2), -1);
  assert.ok(fuzzyMatch('flt wk', 'fleet week trip'));
  assert.equal(fuzzyMatch('xyz', 'fleet week'), null);
});

// ---------------------------------------------------------------- fixtures shaped like the real APIs

function claudeFixture(uuid: string, name: string, turns: [string, string][], updated: string, extra: any = {}) {
  const msgs: any[] = [];
  let parent = '00000000-0000-4000-8000-000000000000';
  turns.forEach(([u, a], i) => {
    const hu = `${uuid.slice(0, 8)}-h${i}`;
    const au = `${uuid.slice(0, 8)}-a${i}`;
    msgs.push({ uuid: hu, sender: 'human', index: i * 2, created_at: updated, parent_message_uuid: parent, text: '', content: [{ type: 'text', text: u }], attachments: [], files: [] });
    msgs.push({ uuid: au, sender: 'assistant', index: i * 2 + 1, created_at: updated, parent_message_uuid: hu, text: '', content: [{ type: 'thinking', thinking: 'secret reasoning about ' + u }, { type: 'text', text: a }], attachments: [], files: [] });
    parent = au;
  });
  return { uuid, name, summary: '', model: 'claude-opus-5-5', created_at: updated, updated_at: updated, current_leaf_message_uuid: parent, chat_messages: msgs, ...extra };
}

function gptFixture(id: string, title: string, turns: [string, string][], updated: number) {
  const mapping: any = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  turns.forEach(([u, a], i) => {
    const un = `${id}-u${i}`;
    const an = `${id}-a${i}`;
    mapping[un] = { id: un, parent, children: [an], message: { id: un, author: { role: 'user' }, create_time: updated, content: { content_type: 'text', parts: [u] }, recipient: 'all', metadata: {} } };
    mapping[an] = { id: an, parent: un, children: [], message: { id: an, author: { role: 'assistant' }, create_time: updated, content: { content_type: 'text', parts: [a] }, recipient: 'all', metadata: {} } };
    mapping[parent].children.push(un);
    parent = an;
  });
  return { conversation_id: id, title, create_time: updated, update_time: updated, mapping, current_node: parent, default_model_slug: 'gpt-5' };
}

test('extract: claude branches, thinking, attachments; chatgpt mapping', () => {
  const c = claudeFixture('11111111-1111-4111-8111-111111111111', 'Fleet week', [['Is it too late to see planes?', 'Not too late, the Blue Angels fly Oct 9-11.']], '2026-10-10T12:00:00Z');
  c.chat_messages[0].attachments = [{ file_name: 'notes.txt', extracted_content: 'pasted itinerary text' }];
  const { meta, content } = claudeConversation(c, 'org1');
  assert.equal(meta.id, 'claude:11111111-1111-4111-8111-111111111111');
  assert.equal(meta.updatedAt, Date.parse('2026-10-10T12:00:00Z'));
  const kinds = content.messages.map((m) => `${m.role}:${m.kind}`);
  assert.deepEqual(kinds, ['user:text', 'user:attachment', 'assistant:thinking', 'assistant:text']);
  // claude.ai hides raw thinking and ships summaries instead (seen on real data 2026-10-12)
  c.chat_messages[1].content[0] = { type: 'thinking', thinking: '', summaries: [{ summary: 'Checking the air show dates' }, { summary: 'Listing viewing spots' }], hidden: false };
  const hidden = claudeConversation(c, 'org1').content.messages.find((m) => m.kind === 'thinking');
  assert.equal(hidden?.text, 'Checking the air show dates\nListing viewing spots');
  const g = gptFixture('22222222-2222-4222-8222-222222222222', 'Risotto', [['How do I make risotto?', 'Toast the rice, add stock slowly.']], 1760000000);
  const r = chatgptConversation(g);
  assert.equal(r.content.messages.length, 2);
  assert.equal(r.meta.updatedAt, 1760000000000);
  assert.ok(toMarkdown(r.meta, r.content.messages).includes('Toast the rice'));
});

// ---------------------------------------------------------------- engine

test('engine: exact, phrase, negation, role, typo, fuzzy title, snippets', async () => {
  const now = Date.now();
  const iso = (daysAgo: number) => new Date(now - daysAgo * 86400000).toISOString();
  const convs = [
    claudeFixture('aaaaaaaa-0000-4000-8000-000000000001', 'SF Fleet Week planes', [['Tell me about SF fleet week and if its too late to see planes', 'Not too late at all, the Fleet Week Air Show runs October 9-11 with the Blue Angels.']], iso(1)),
    claudeFixture('aaaaaaaa-0000-4000-8000-000000000002', 'Identifying a plane model', [['What model of plane does this appear to be?', 'It looks like a Boeing 737 based on the engines.']], iso(200)),
    claudeFixture('aaaaaaaa-0000-4000-8000-000000000003', 'Explaining airplanes to a kid', [['how do airplanes stay up', 'Wings create lift as air flows over them.']], iso(30)),
    claudeFixture('aaaaaaaa-0000-4000-8000-000000000004', 'Saffron risotto', [['risotto recipe please', 'Toast arborio rice, add warm stock slowly, finish with parmesan.']], iso(5)),
  ];
  for (const c of convs) {
    const { meta, content } = claudeConversation(c, 'org');
    await ingest(meta, content, OPTS, 'api');
  }
  const g = gptFixture('bbbbbbbb-0000-4000-8000-000000000001', 'Plane WiFi hacking toolkit', [["I'm about to go on a plane and am a huge tech nerd", 'Bring a travel router; most plane wifi is captive-portal based.']], now / 1000 - 3 * 86400);
  const r = chatgptConversation(g);
  await ingest(r.meta, r.content, OPTS, 'api');

  const e = new Engine();
  await e.load();
  assert.equal(e.state, 'ready');

  let res = (await e.search({ q: 'plane' }))!;
  const titles = res.hits.map((h) => h.title);
  assert.ok(titles.includes('SF Fleet Week planes'));
  assert.ok(titles.includes('Explaining airplanes to a kid'), 'substring inside airplanes');
  assert.ok(!titles.includes('Saffron risotto'));
  assert.ok(titles.slice(0, 2).includes('SF Fleet Week planes'), `got ${titles.join(' | ')}`);
  const fleet = res.hits.find((h) => h.title === 'SF Fleet Week planes')!;
  const snip = fleet.snippets[0];
  assert.ok(snip, 'has snippet');
  for (const [s, t] of snip.hl) assert.equal(snip.text.slice(s, t).toLowerCase(), 'plane');

  res = (await e.search({ q: '"blue angels"' }))!;
  assert.deepEqual(res.hits.map((h) => h.title), ['SF Fleet Week planes']);

  res = (await e.search({ q: 'plane -boeing' }))!;
  assert.ok(!res.hits.some((h) => h.title === 'Identifying a plane model'));

  res = (await e.search({ q: 'stock from:me' }))!;
  assert.equal(res.total, 0, 'stock only appears in assistant text');
  res = (await e.search({ q: 'stock' }))!;
  assert.equal(res.total, 1);

  res = (await e.search({ q: 'secret reasoning' }))!;
  assert.equal(res.total, 0, 'thinking excluded by default');

  res = (await e.search({ q: 'risoto' }))!; // typo
  await e.buildVocab();
  res = (await e.search({ q: 'risoto' }))!;
  assert.equal(res.corrected, 'risotto');
  assert.equal(res.hits[0]?.title, 'Saffron risotto');

  res = (await e.search({ q: 'flt wk' }))!;
  assert.ok(res.hits.some((h) => h.kind === 'title' && h.title === 'SF Fleet Week planes'), 'fuzzy title');

  res = (await e.search({ q: 'plane', filters: { sources: ['chatgpt'] } }))!;
  assert.deepEqual(res.hits.filter((h) => h.kind === 'exact').map((h) => h.title), ['Plane WiFi hacking toolkit']);

  res = (await e.search({ q: '' }))!;
  assert.equal(res.hits[0].title, 'SF Fleet Week planes', 'recent first');
  assert.equal(res.hits[0].kind, 'recent');
});
