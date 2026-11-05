import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';
import type { EvalCase } from '../../src/eval/scoring';
import { encodeTokens } from '../../src/indexer/tokenizer';
import { EVAL_NOW, jsonl } from './renorbench-common';

/**
 * RenorBench v2: the fixture and the cases, written by this script and committed (fixtures/eval/renorbench-v2/,
 * docs/evals/renorbench-v2.dev.jsonl). Nothing here reads a clock, the environment or a model: every choice is a
 * table below or a hash of a fixed key, so two runs write the same bytes (tests/eval/renorbench-v2-fixture.test.ts
 * regenerates it and compares). Every person, place and number is invented.
 *
 * Why a second fixture. v1 is 30 notes (54 chunks), so the product's window when this was written (top_k 20; the default is 50 since 2026-10-27, and the RenorBench product scripts send 20) holds nearly every
 * chunk of the vault and cannot lose anything: turning session expansion off moved the reply's size and no delivery
 * score, a stale value could not crowd out the current one, and the abstention questions sat in a mixed region that
 * moves with the verdict's bar. v1 stays exactly as it is, so its scores stay comparable; v2 is a separate vault with its
 * own baseline, built so that each product feature has cases that only it can answer:
 *
 *   session_detail   a long chat on one topic, with a few short remarks the question never echoes ("by the way, my
 *                    sister adopted a beagle called Biscuit"). The question names the topic and asks for the remark
 *                    in other words, so the 20-chunk window fills with the chat's on-topic turns and holds the remark
 *                    only if session expansion adds it: the product keeps the short statements of the best notes.
 *   knowledge_update  one fact told in three dated sessions (or thirty log entries), where the newest value must be
 *                    read first. The old statement echoes the question and the new one is terse, so only the order
 *                    the tool presents (newest first) puts the current value ahead, and only the recency boost keeps
 *                    the newest log entry in a window the older entries would fill.
 *   abstention       questions about nothing the vault says; the reply must carry the verdict "nothing on file".
 *
 * The notes are shaped like the LongMemEval sessions the product reads in earnest: front matter with the session's
 * date, one `###` section per turn ("Turn 7 - User"), so a turn is one chunk and a short turn is a statement the
 * expansion can add.
 *
 * What this is not. It is a tripwire built for the free hash embedder, not a measurement of how well the product
 * remembers. The on-topic turns are formulaic on purpose (see USER_FRAMES), and the questions, the remarks and the
 * abstention list were tuned against the stand-in's habits (it counts every word, small ones too, so a short remark and a
 * question share small words; a word repeated ten times is a magnet for accidental bucket collisions; the retrieval pool
 * is the nearest 40 by raw cosine before any boost). A real embedder ranks differently. What the cases keep is the
 * structure each feature needs: a remark the window does not hold in a chat it does, a stale statement that matches the
 * question better than the update, a log whose newest entry only the recency boost keeps in. Change a table here and the
 * tests (tests/eval/renorbench-v2.test.ts) say which of those no longer holds, on the real tool.
 */

const SEED = 'renorbench-v2';

/** The questions must ask about the present: a word of past intent flips the reply to best-match-first (hasPastIntent). */
const PAST_INTENT = /\b(previously|before|used to|former|formerly|earlier|in the past|history)\b/i;

function index(key: string, length: number): number {
  return crypto.createHash('sha256').update(`${SEED}\0${key}`).digest().readUInt32BE(0) % length;
}

function pick<T>(key: string, values: readonly T[]): T {
  return values[index(key, values.length)];
}

/** The values in an order fixed by the key: a deterministic shuffle, so one table can feed many turns without repeats. */
function shuffled<T>(key: string, values: readonly T[]): T[] {
  return values
    .map((value, i) => ({ value, order: crypto.createHash('sha256').update(`${SEED}\0${key}\0${i}`).digest().readUInt32BE(0) }))
    .sort((a, b) => a.order - b.order)
    .map(entry => entry.value);
}

function dateOf(ageDays: number): string {
  return new Date(EVAL_NOW - ageDays * 86_400_000).toISOString().slice(0, 10);
}

/** A session note, as the LongMemEval harness writes one: dated front matter, one `###` section per turn. */
function renderSession(id: string, title: string, ageDays: number, turns: Array<{ role: 'User' | 'Assistant'; text: string }>): string {
  const date = dateOf(ageDays);
  const body = turns.map((turn, i) => `### Turn ${i + 1} - ${turn.role}\n\n${turn.text}`).join('\n\n');
  return `---\nkind: chat-session\nsession_id: ${JSON.stringify(id)}\nsession_date: ${JSON.stringify(date)}\n---\n# ${title}\n\nTimestamp: ${date}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// session_detail
// ---------------------------------------------------------------------------------------------------------------

/**
 * A short remark inside a long chat. `statement` is what the user says, `question` asks for it without echoing it,
 * `needle` is the one string that identifies the answer and occurs nowhere else in the vault (the generator checks).
 */
interface Aside {
  statement: string;
  question: string;
  needle: string;
}

interface Topic {
  key: string;
  /** Two words that occur in every on-topic turn and in the question's reference to the chat. */
  phrase: string;
  title: string;
  ageDays: number;
  /** What the on-topic turns talk about: eight things, so twelve turns do not repeat each other. */
  things: string[];
  asides: Aside[];
}

const TOPICS: Topic[] = [
  {
    key: 'sourdough', phrase: 'sourdough starter', title: 'Help with my sourdough starter', ageDays: 296,
    things: ['feeding schedule', 'hydration level', 'flour blend', 'jar size', 'room temperature', 'discard routine', 'float test', 'rise time'],
    asides: [
      { statement: 'By the way, my sister Marta just adopted a beagle called Biscuit.', question: 'what did my sibling name the new puppy?', needle: 'Biscuit' },
      { statement: 'Oh, and I booked a table at Casa Verde for our anniversary dinner on Friday.', question: 'which restaurant did I reserve for the celebration?', needle: 'Casa Verde' },
      { statement: 'Side note: my dentist is Dr. Okafor, and she wants to see me every six months.', question: 'who takes care of my teeth?', needle: 'Okafor' },
      { statement: 'I almost forgot, the new neighbour in apartment 4B is called Tobias and he plays the trumpet.', question: 'who moved in next door?', needle: 'Tobias' },
      { statement: "Also, I am flying to Porto next month for my cousin's wedding.", question: 'which city am I visiting for the family celebration?', needle: 'Porto' },
    ],
  },
  {
    key: 'balcony', phrase: 'balcony garden', title: 'Planning my balcony garden', ageDays: 214,
    things: ['pot size', 'potting soil', 'afternoon sun', 'watering routine', 'drainage holes', 'trellis', 'compost', 'wind protection'],
    asides: [
      { statement: 'Quick aside: my laptop is a ThinkPad that I bought second-hand last spring.', question: 'which computer do I own?', needle: 'ThinkPad' },
      { statement: 'Oh, my coworker Ingrid is allergic to cashews, so we skip them at team lunches.', question: 'what food does my colleague avoid at work meals?', needle: 'cashews' },
      { statement: 'Funny thing, I just finished The Overstory and could not put it down.', question: 'which novel did I enjoy recently?', needle: 'Overstory' },
      { statement: 'I started pottery classes on Thursday evenings, and the teacher is very patient.', question: 'what craft course do I attend after work?', needle: 'pottery' },
      { statement: 'My car is in the garage until Friday, it is a Subaru Forester with a cracked mirror.', question: 'which vehicle am I without at the moment?', needle: 'Forester' },
    ],
  },
  {
    key: 'marathon', phrase: 'marathon training', title: 'Questions about my marathon training', ageDays: 171,
    things: ['long run', 'weekly mileage', 'pacing', 'running shoes', 'recovery days', 'fueling', 'tempo run', 'taper'],
    asides: [
      { statement: 'By the way, I switched my phone plan to Vodacom, and the data is much cheaper.', question: 'which mobile provider do I use?', needle: 'Vodacom' },
      { statement: 'Oh, my younger brother Davi graduated in astrophysics last June.', question: 'what subject did my sibling study at university?', needle: 'astrophysics' },
      { statement: 'I am thinking of adopting a grey cat called Pepper from the local shelter.', question: 'what will I name my future pet?', needle: 'Pepper' },
      { statement: 'Side note: my train to Lyon was cancelled on Sunday, so I stayed with friends.', question: 'what went wrong with my trip last weekend?', needle: 'cancelled' },
      { statement: "Also, dinner tomorrow is at my aunt Carmela's place, and she makes great lasagna.", question: 'whose home am I eating at soon?', needle: 'Carmela' },
    ],
  },
  {
    key: 'kitchen', phrase: 'kitchen renovation', title: 'Our kitchen renovation', ageDays: 133,
    things: ['cabinet layout', 'countertop material', 'plumbing', 'permits', 'tile pattern', 'lighting plan', 'ventilation', 'budget buffer'],
    asides: [
      { statement: 'I almost forgot, my password manager is Bitwarden, and I moved everything there in March.', question: 'which tool keeps my logins safe?', needle: 'Bitwarden' },
      { statement: 'Oh, and my daughter Lia has a piano recital on the 14th at the community hall.', question: 'what instrument is my child performing?', needle: 'piano recital' },
      { statement: 'Quick aside: I bought a standing desk from Fully for 540 euros.', question: 'how much did I spend on office furniture?', needle: '540 euros' },
      { statement: 'By the way, my friend Henrik is moving to Berlin in September for a new job.', question: 'which city is my pal relocating to?', needle: 'Berlin' },
      { statement: 'Also, our babysitter is called Wendell and the kids love him.', question: 'who looks after our children in the evenings?', needle: 'Wendell' },
    ],
  },
  {
    key: 'guitar', phrase: 'guitar practice', title: 'Making time for guitar practice', ageDays: 102,
    things: ['chord changes', 'metronome', 'finger strength', 'scales', 'practice routine', 'string gauge', 'tuning', 'songs to learn'],
    asides: [
      { statement: 'I have been meaning to tell you, my grandmother Odete turns ninety on Sunday.', question: 'how old will my grandparent be this weekend?', needle: 'ninety' },
      { statement: 'Quick aside: my favourite bakery is Padaria Aurora, and it opens at six.', question: 'where do I like to buy pastries?', needle: 'Aurora' },
      { statement: 'I forgot to say, my flight to Oslo leaves at 6:45 in the morning.', question: 'what time is my departure to Norway?', needle: '6:45' },
      { statement: 'Oh, my sister-in-law Renata is expecting twins in April.', question: 'how many babies are due in my family this spring?', needle: 'twins' },
      { statement: 'Also, I donated two boxes of books to the library on Saturday.', question: 'what did I give away at the weekend?', needle: 'two boxes of books' },
    ],
  },
  {
    key: 'aquarium', phrase: 'aquarium maintenance', title: 'Aquarium maintenance routine', ageDays: 77,
    things: ['water changes', 'filter media', 'nitrogen cycle', 'feeding amounts', 'algae', 'heater', 'plant growth', 'tank size'],
    asides: [
      { statement: 'Funny thing, my uncle Raimundo won a small lottery prize, about 800 euros.', question: 'who in my family had a lucky win?', needle: 'Raimundo' },
      { statement: 'By the way, I am allergic to penicillin, so the doctor wrote it on my file.', question: 'which medicine must I never take?', needle: 'penicillin' },
      { statement: 'Side note: my landlord Mr. Teixeira is raising the rent in July.', question: 'who owns the flat I live in?', needle: 'Teixeira' },
      { statement: 'I started a podcast about film scores, and we call it Second Reel.', question: 'what is my show named?', needle: 'Second Reel' },
      { statement: 'Also, the concert on Saturday is at the Teatro Alianca and tickets cost 35 euros.', question: 'where is the live music event this weekend?', needle: 'Teatro Alianca' },
    ],
  },
  {
    key: 'taxes', phrase: 'tax paperwork', title: 'Sorting out my tax paperwork', ageDays: 61,
    things: ['receipts', 'deductions', 'filing deadline', 'bank statements', 'expense categories', 'home office', 'estimated payments', 'accountant questions'],
    asides: [
      { statement: 'Oh, my best friend Yuki moved to Osaka in January for a new job.', question: 'which Japanese city does my close pal live in now?', needle: 'Osaka' },
      { statement: 'Quick aside: my phone number ends in 7731, in case you need it for the form.', question: 'what are the last digits of my mobile?', needle: '7731' },
      { statement: 'I almost forgot, the vet said our parrot Zephyr needs a checkup every spring.', question: 'what is our bird called?', needle: 'Zephyr' },
      { statement: 'By the way, my cousin Anselmo plays bass in a jazz trio on Fridays.', question: 'what instrument does my relative play in a band?', needle: 'bass in a jazz trio' },
      { statement: 'Also, I ordered a new sofa in forest green, and delivery is in three weeks.', question: 'what colour did I pick for the new couch?', needle: 'forest green' },
    ],
  },
  {
    key: 'bicycle', phrase: 'bicycle repair', title: 'Learning bicycle repair', ageDays: 38,
    things: ['brake pads', 'chain wear', 'tire pressure', 'gear indexing', 'wheel truing', 'cables', 'lubrication', 'saddle height'],
    asides: [
      { statement: 'Oh, and my manager Priscilla approved two remote days per week starting in May.', question: 'who is my boss?', needle: 'Priscilla' },
      { statement: 'Side note: my favourite tea is lapsang souchong, which I order online.', question: 'what do I like to sip in the afternoon?', needle: 'souchong' },
      { statement: 'By the way, my train card is the Navigo and I top it up on Mondays.', question: 'how do I pay for public transport?', needle: 'Navigo' },
      { statement: 'I forgot to mention, my allotment plot number is 27 and it is next to the river.', question: 'where is my little vegetable patch?', needle: 'plot number is 27' },
      { statement: 'Also, my nephew Caspian turns eight in November and wants a telescope.', question: 'what gift does my relative hope for?', needle: 'telescope' },
    ],
  },
];

/** Acknowledgements of a remark: nothing on topic and nothing of the remark, so they never carry a needle. */
const ACKS = [
  'Thanks for telling me, noted.',
  'Good to know, thanks for mentioning it.',
  'Understood, I will keep that in mind.',
  'Got it, thank you for sharing that.',
  'Noted, that is helpful context.',
  'Thanks, I appreciate you letting me know.',
  'Sounds good, thanks for the detail.',
];

/**
 * What a user asks about the topic and what the assistant answers: `{a}`, `{b}` and `{c}` are things of the topic (`{A}`,
 * `{B}` and `{C}` the same with a capital) and `{topic}` its two-word phrase. The sentences are short and mostly topic words on purpose. The hash embedder counts
 * every word, the small ones too, so a chat written in the same filler as the next chat ("it shapes", "a common slip")
 * would look like it, and a question about one would find the other: here two chats share only their small words.
 */
const USER_FRAMES = [
  'How do {a}, {b} and {c} fit together in my {topic}?',
  'Is {a} or {b} the bigger deal for my {topic}?',
  'Does {a} change {b} in my {topic}?',
  'Should {a} come before {b} in my {topic}?',
  'What do {a} and {c} tell me about my {topic}?',
  'Tell me about {a}, {b} and {c} for my {topic}.',
  'Why does {a} keep drifting in my {topic}?',
  'Can {b} wait while I sort out {a} in my {topic}?',
  'Which matters more for my {topic}: {a} or {c}?',
  'Where do {b} and {a} go wrong in a {topic}?',
  'Is {c} worth tracking for my {topic}?',
  'How often should I revisit {a} in my {topic}?',
];

const ASSISTANT_FRAMES = [
  '{A}, {b} and {c} all shape a {topic}.',
  'Check {a} first, then {b}, then {c}.',
  'In a {topic}, {a} outranks {b}.',
  '{A} and {b} belong together in a {topic}; {c} follows.',
  'Log {a}, {b} and {c} for your {topic}.',
  'A steady {topic} needs {a} and {b}.',
  '{C} matters less than {a} in a {topic}.',
  'Adjust {a} or {b}, never both, for a {topic}.',
  '{A} plus {b} tells you most about a {topic}.',
  'Revisit {a}, {b} and {c} weekly.',
  '{B} drifts when {a} changes in a {topic}.',
  'Compare {a} with {b}, then {c}.',
  'Your {topic} improves when {a} and {c} stay steady.',
  'Note {b} before you touch {a} in a {topic}.',
  '{C} and {a} explain most {topic} problems.',
  'Pair {b} with {c} when you review your {topic}.',
  'If {a} slips, {b} and {c} follow in a {topic}.',
  'Keep {a}, {b} and {c} in one list for your {topic}.',
  '{B} before {c}, and {a} last, in a {topic}.',
  'Track {c} alongside {a} for your {topic}.',
];

function fill(frame: string, topic: Topic, key: string): string {
  const [a, b, c] = shuffled(key, topic.things);
  const up = (text: string) => text[0].toUpperCase() + text.slice(1);
  return frame
    .replaceAll('{topic}', topic.phrase)
    .replaceAll('{A}', up(a)).replaceAll('{B}', up(b)).replaceAll('{C}', up(c))
    .replaceAll('{a}', a).replaceAll('{b}', b).replaceAll('{c}', c);
}

/**
 * How a question points at the chat it is about: the topic's phrase and two things the chat talked about. All are words
 * that only this chat's turns share, so a question that is otherwise all small words ("what", "my", "the") still finds its
 * chat and not another's (the hash embedder has no stop words: small words are most of what a short remark shares with a
 * question, and a question with nothing else would find any chat's short remark).
 */
const CHAT_REFERENCES = [
  'In our chat about my {topic}, {thing} and {other}',
  'While we were talking about my {topic}, {thing} and {other}',
  'During our {topic} conversation about {thing} and {other}',
  'When I asked you about my {topic}, {thing} and {other}',
];

const TOPICAL_PAIRS = 12;

interface Built {
  notes: Map<string, string>;
  ages: Map<string, number>;
  cases: EvalCase[];
}

/** Words too common to count as shared between a question and the remark it asks for. */
const SMALL_WORDS = new Set(['what', 'which', 'that', 'this', 'with', 'from', 'have', 'been', 'your', 'they', 'their', 'there', 'when', 'where', 'does', 'were', 'would', 'could', 'should', 'into', 'than', 'then', 'them', 'will', 'many', 'much']);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => word.length >= 4 && !SMALL_WORDS.has(word)));
}

/**
 * The size of a turn, in the engine's own tokens, is part of what each turn is for: a remark is a statement the expansion
 * may add (a whole section within SESSION_EXPAND_MAX_CHUNK_TOKENS), an assistant answer is not one (over it), and a
 * section over 400 would be cut into pieces. A generator that drifted across these lines would change what a case
 * measures without saying so.
 */
function checkSize(what: string, text: string, min: number, max: number): void {
  const tokens = encodeTokens(text);
  if (tokens < min || tokens > max) throw new Error(`${what} is ${tokens} tokens; it must be ${min}-${max}`);
}

function buildSessionDetail(): Built {
  const notes = new Map<string, string>();
  const ages = new Map<string, number>();
  const cases: EvalCase[] = [];
  for (const topic of TOPICS) {
    // The remarks go after some of the on-topic exchanges, in an order fixed by the topic.
    const slots = shuffled(`slots:${topic.key}`, Array.from({ length: TOPICAL_PAIRS - 1 }, (_, i) => i + 1)).slice(0, topic.asides.length).sort((a, b) => a - b);
    const turns: Array<{ role: 'User' | 'Assistant'; text: string }> = [];
    const userFrames = shuffled(`user:${topic.key}`, USER_FRAMES);
    const acks = shuffled(`acks:${topic.key}`, ACKS);
    let remark = 0;
    for (let pair = 0; pair < TOPICAL_PAIRS; pair++) {
      const question = fill(userFrames[pair % userFrames.length], topic, `u:${topic.key}:${pair}`);
      const answer = ASSISTANT_FRAMES.map((_, s) => fill(ASSISTANT_FRAMES[(pair + s) % ASSISTANT_FRAMES.length], topic, `a:${topic.key}:${pair}:${s}`)).join(' ');
      checkSize(`${topic.key} user turn ${pair}`, question, 8, 60);
      checkSize(`${topic.key} assistant turn ${pair}`, answer, 215, 380);
      turns.push({ role: 'User', text: question }, { role: 'Assistant', text: answer });
      if (remark < topic.asides.length && slots[remark] === pair) {
        const aside = topic.asides[remark];
        checkSize(`${topic.key} remark ${remark + 1}`, aside.statement, 8, 120);
        const shared = [...words(aside.question)].filter(word => words(aside.statement).has(word));
        if (shared.length > 0) throw new Error(`${topic.key} remark ${remark + 1}: the question shares ${shared.join(', ')} with the remark, so it echoes it`);
        turns.push({ role: 'User', text: aside.statement }, { role: 'Assistant', text: acks[remark] });
        remark += 1;
      }
    }
    const notePath = `Sessions/${topic.key}.md`;
    notes.set(notePath, renderSession(`${topic.key}-chat`, topic.title, topic.ageDays, turns));
    ages.set(notePath, topic.ageDays);
    topic.asides.forEach((aside, n) => {
      const [thing, other] = shuffled(`things:${topic.key}:${n}`, topic.things);
      const reference = pick(`ref:${topic.key}:${n}`, CHAT_REFERENCES).replace('{topic}', topic.phrase).replace('{thing}', thing).replace('{other}', other);
      cases.push({
        id: `detail-${topic.key}-${n + 1}`,
        category: 'session_detail',
        query: `${reference}, ${aside.question}`,
        relevant: [{ match: aside.needle, relevance: 3, notePath }],
        expectedAnswer: aside.needle,
        split: 'dev',
      });
    });
  }
  return { notes, ages, cases };
}

// ---------------------------------------------------------------------------------------------------------------
// knowledge_update
// ---------------------------------------------------------------------------------------------------------------

/** One fact in three dated sessions: the value told first, the one that replaced it, and the current one. */
interface Update {
  key: string;
  title: string[];
  /** Oldest first. The old statements echo the question's words; the newest is terse, so it matches the question least. */
  versions: Array<{ ageDays: number; statement: string; needle: string }>;
  questions: string[];
}

const UPDATES: Update[] = [
  {
    key: 'commute', title: ['Getting to the office', 'Changing my commute', 'Commute update'],
    versions: [
      { ageDays: 392, statement: 'These days I get to the office by tram, about forty minutes each way.', needle: 'tram' },
      { ageDays: 143, statement: 'I changed how I get to the office, it is a folding bike now, about half an hour.', needle: 'folding bike' },
      { ageDays: 6, statement: 'Update: the ferry is how I get to work now, it takes twenty minutes.', needle: 'ferry' },
    ],
    questions: ['How do I get to the office these days?', 'How do I get to work now?', 'Which transport do I use to reach the office now?'],
  },
  {
    key: 'editor', title: ['Choosing a code editor', 'Trying another editor', 'Editor update'],
    versions: [
      { ageDays: 410, statement: 'These days I write all my code in Sublime Text and I have no plans to change it.', needle: 'Sublime Text' },
      { ageDays: 160, statement: 'I moved my code to Neovim, and the keybindings took me a week to learn.', needle: 'Neovim' },
      { ageDays: 9, statement: 'Update: Helix is the editor I write code in now.', needle: 'Helix' },
    ],
    questions: ['Which editor do I write my code in these days?', 'What editor do I write my code in now?', 'What do I use to write code at the moment?'],
  },
  {
    key: 'morning', title: ['Morning routine', 'Changing my mornings', 'Morning update'],
    versions: [
      { ageDays: 377, statement: 'These days my first drink of the morning is a double espresso.', needle: 'espresso' },
      { ageDays: 121, statement: 'I swapped my morning coffee for matcha, which is gentler on my stomach.', needle: 'matcha' },
      { ageDays: 4, statement: 'Update: rooibos is my first drink of the morning now.', needle: 'rooibos' },
    ],
    questions: ['What is my first drink of the morning these days?', 'Which drink do I have first in the morning now?', 'What do I currently drink first thing in the morning?'],
  },
  {
    key: 'french', title: ['Studying French', 'A new way to study French', 'French study update'],
    versions: [
      { ageDays: 348, statement: 'These days I study French with Duolingo, ten minutes every evening.', needle: 'Duolingo' },
      { ageDays: 96, statement: 'I stopped that and now study French with Anki flashcards.', needle: 'Anki' },
      { ageDays: 11, statement: 'Update: the app I use to study French now is Pimsleur.', needle: 'Pimsleur' },
    ],
    questions: ['Which app do I use to study French these days?', 'How do I study French now?', 'How do I study French at the moment?'],
  },
  {
    key: 'team', title: ['Team planning', 'After the reorganisation', 'Team update'],
    versions: [
      { ageDays: 330, statement: 'These days my team at work has five people and a shared kanban board.', needle: 'five people' },
      { ageDays: 88, statement: 'My team at work grew to nine people after the reorganisation.', needle: 'nine people' },
      { ageDays: 8, statement: 'Update: my team at work is fourteen people now.', needle: 'fourteen people' },
    ],
    questions: ['How many people are on my team at work these days?', 'What is the current size of my team?', 'How big is my work team at the moment?'],
  },
  {
    key: 'sport', title: ['Training schedule', 'Switching sports', 'Training update'],
    versions: [
      { ageDays: 365, statement: 'These days I go to the climbing gym twice a week after work.', needle: 'climbing gym' },
      { ageDays: 129, statement: 'I switched to the swimming pool on weekday evenings, and the lanes are quiet.', needle: 'swimming pool' },
      { ageDays: 5, statement: 'Update: the rowing club is where I train after work now, my current sport.', needle: 'rowing club' },
    ],
    questions: ['Where do I train after work these days?', 'What is my current sport after work?', 'Where do I train after work at the moment?'],
  },
  {
    key: 'phone', title: ['Phone shopping', 'A new phone', 'Phone update'],
    versions: [
      { ageDays: 300, statement: 'These days my phone is a Pixel 6 and the battery is still great.', needle: 'Pixel 6' },
      { ageDays: 75, statement: 'I replaced my phone with a Galaxy S23 for the camera.', needle: 'Galaxy S23' },
      { ageDays: 7, statement: 'Update: the phone I use now is a Fairphone 5.', needle: 'Fairphone 5' },
    ],
    questions: ['Which phone do I use these days?', 'What phone do I use now?', 'Which phone do I use at the moment?'],
  },
  {
    key: 'saving', title: ['Saving up', 'A new savings goal', 'Savings update'],
    versions: [
      { ageDays: 410, statement: 'These days I am saving up for a camper van, about 200 euros each month.', needle: 'camper van' },
      { ageDays: 150, statement: 'My savings goal changed, it is a sailboat now.', needle: 'sailboat' },
      { ageDays: 10, statement: 'Update: I am saving for a mountain cabin now, that is my current goal.', needle: 'mountain cabin' },
    ],
    questions: ['What am I saving money for these days?', 'What is my current saving goal?', 'What am I saving for at the moment?'],
  },
];

/** What the assistant answers to an update: nothing about the value, so no needle appears in two places. */
const UPDATE_REPLIES = [
  'Thanks for the update, that gives me a clear picture.',
  'Understood, I will keep that in mind for later questions.',
  'Good to know, thank you for sharing that.',
];

function buildKnowledgeUpdate(): Built {
  const notes = new Map<string, string>();
  const ages = new Map<string, number>();
  const cases: EvalCase[] = [];
  for (const update of UPDATES) {
    const paths = update.versions.map((version, v) => {
      const notePath = `Sessions/${update.key}-${v + 1}.md`;
      notes.set(notePath, renderSession(`${update.key}-${v + 1}`, update.title[v], version.ageDays, [
        { role: 'User', text: version.statement },
        { role: 'Assistant', text: UPDATE_REPLIES[(v + update.key.length) % UPDATE_REPLIES.length] },
      ]));
      ages.set(notePath, version.ageDays);
      return notePath;
    });
    const newest = update.versions.length - 1;
    update.questions.forEach((query, n) => {
      cases.push({
        id: `update-${update.key}-${n + 1}`,
        category: 'knowledge_update',
        query,
        // The newest value is the answer; every older one is stale, and a reply that shows one of them first is wrong.
        relevant: [
          { match: update.versions[newest].needle, relevance: 3, notePath: paths[newest] },
          ...update.versions.slice(0, newest).map((version, v) => ({ match: version.needle, relevance: 1, notePath: paths[v] })),
        ],
        expectedAnswer: update.versions[newest].needle,
        split: 'dev',
      });
    });
  }
  return { notes, ages, cases };
}

// ---------------------------------------------------------------------------------------------------------------
// knowledge_update, as a log: thirty weekly entries, the newest one the answer
// ---------------------------------------------------------------------------------------------------------------

const LOG_ENTRIES = 30;
const LOG_QUESTIONS = [
  'What was my long run distance in my most recent weekly check-in?',
  'What was my long run distance in my latest weekly check-in?',
  'What is my current long run distance in my weekly check-ins?',
];
const LOG_FEELINGS = ['steady pace', 'easy effort', 'felt solid', 'a little tired', 'good rhythm', 'light legs'];

/**
 * A log restates one fact every week, so thirty chunks answer the question and the window holds twenty. The newest entry
 * is written at more length than the rest, which makes it the weakest match of the thirty; what keeps it in the window is
 * the recency boost (a note under thirty days old gets up to +0.1), and what shows it first is the newest-first layout.
 * Without the boost the newest entry is outside the window and the reply has only old distances.
 */
function buildLog(): Built {
  const notes = new Map<string, string>();
  const ages = new Map<string, number>();
  const distance = (k: number) => (22.5 - 0.5 * k).toFixed(1);
  const paths: string[] = [];
  for (let k = 0; k < LOG_ENTRIES; k++) {
    const ageDays = 2 + 7 * k;
    const date = dateOf(ageDays);
    const text = k === 0
      ? `Weekly check-in: my long run distance was ${distance(k)} km, felt strong and ran negative splits.`
      : `Weekly check-in: my long run distance was ${distance(k)} km, ${pick(`feeling:${k}`, LOG_FEELINGS)}.`;
    const notePath = `Logs/check-in-${date}.md`;
    notes.set(notePath, `---\nkind: log\nsession_date: ${JSON.stringify(date)}\n---\n# Weekly check-in ${date}\n\n${text}\n`);
    ages.set(notePath, ageDays);
    paths.push(notePath);
  }
  const cases: EvalCase[] = LOG_QUESTIONS.map((query, n) => ({
    id: `update-log-${n + 1}`,
    category: 'knowledge_update',
    query,
    relevant: [
      { match: `${distance(0)} km`, relevance: 3, notePath: paths[0] },
      { match: `${distance(1)} km`, relevance: 1, notePath: paths[1] },
      { match: `${distance(2)} km`, relevance: 1, notePath: paths[2] },
    ],
    expectedAnswer: `${distance(0)} km`,
    split: 'dev',
  }));
  return { notes, ages, cases };
}

// ---------------------------------------------------------------------------------------------------------------
// abstention
// ---------------------------------------------------------------------------------------------------------------

/**
 * Questions about things no session says: the right reply is "nothing on file". They were chosen from a longer list of
 * candidates for what the free hash embedder can do with them: each one's closest chunk in this vault is well under the
 * verdict's bar there (0.21-0.32 against 0.375), so the verdict scores say that the verdict still works. They do not say
 * how well a real embedder tells a question the vault cannot answer from one it can; a question about the person or
 * topic of a session, asking for a detail never given, is the hard case, and the hash embedder cannot separate it.
 */
const UNANSWERABLE = [
  'Which vitamins do I take daily?',
  'Which cheese goes best with quince paste?',
  'Which river runs through Vienna?',
  'Which gym instructor do I prefer?',
  'Which author wrote Pride and Prejudice?',
  'Which newspaper do I read at breakfast?',
  'Which island has the highest peak in Spain?',
  'Which supermarket do I shop at?',
  'Who designed the Sydney Opera House?',
  'Which bus line goes to the central station?',
  'Who wrote the opera La Traviata?',
  'Which shop sells replacement keys nearby?',
  'How many floors does the Burj Khalifa have?',
  'Which language do they speak in Brazil?',
  'Which nurse called me about the results?',
  'Which orchestra played at the festival?',
  'Who painted the Sistine Chapel ceiling?',
  'Which insurance company covers my flat?',
  'Which optician made my glasses?',
  'Which colour of paint covers my hallway?',
];

function buildAbstention(): Built {
  const cases: EvalCase[] = UNANSWERABLE.map((query, n) => ({
    id: `abstain-${String(n + 1).padStart(2, '0')}`,
    category: 'abstention',
    query,
    relevant: [],
    expectedAnswer: null,
    shouldAbstain: true,
    split: 'dev',
  }));
  return { notes: new Map(), ages: new Map(), cases };
}

// ---------------------------------------------------------------------------------------------------------------
// The whole benchmark
// ---------------------------------------------------------------------------------------------------------------

export interface RenorBenchV2 {
  /** Vault-relative path -> note text. */
  notes: Map<string, string>;
  /** fixture.json, as written. */
  fixtureJson: string;
  /** The cases, one JSON object a line, as written. */
  casesJsonl: string;
  cases: EvalCase[];
}

export function buildRenorBenchV2(): RenorBenchV2 {
  const parts = [buildSessionDetail(), buildKnowledgeUpdate(), buildLog(), buildAbstention()];
  const notes = new Map<string, string>();
  const ages = new Map<string, number>();
  const cases: EvalCase[] = [];
  for (const part of parts) {
    for (const [notePath, text] of part.notes) {
      if (notes.has(notePath)) throw new Error(`two notes at ${notePath}`);
      notes.set(notePath, text);
    }
    for (const [notePath, age] of part.ages) ages.set(notePath, age);
    cases.push(...part.cases);
  }

  const ids = new Set<string>();
  for (const test of cases) {
    if (ids.has(test.id)) throw new Error(`duplicate case id ${test.id}`);
    ids.add(test.id);
    if (PAST_INTENT.test(test.query)) throw new Error(`${test.id} asks with a word of past intent, which reorders the reply: ${test.query}`);
  }
  // A needle that occurs twice would let another chunk answer the case, and a chunk the case never meant would
  // deliver it: the evidence of a case is exactly one place.
  const everything = [...notes.values()].join('\n').toLowerCase();
  for (const test of cases) {
    for (const target of test.relevant) {
      const needle = target.match.toLowerCase();
      const count = everything.split(needle).length - 1;
      if (count !== 1) throw new Error(`${test.id}: the needle "${target.match}" occurs ${count} times in the vault, not once`);
    }
  }

  const relativeMtimeDays: Record<string, number> = {};
  for (const notePath of [...notes.keys()].sort()) relativeMtimeDays[notePath] = ages.get(notePath)!;
  const fixtureJson = `${JSON.stringify({
    version: 2,
    description: 'RenorBench v2 fixture. Multi-session chats and logs built to need session expansion, the newest-value rules and the relevance verdict; all identities and facts are fictional. Written by scripts/eval/generate-renorbench-v2.ts.',
    relativeMtimeDays,
  }, null, 2)}\n`;
  return { notes, fixtureJson, casesJsonl: jsonl(cases), cases };
}

// ---------------------------------------------------------------------------------------------------------------
// Command line: write the fixture and the cases where they are committed (or elsewhere, for a look)
// ---------------------------------------------------------------------------------------------------------------

export const V2_FIXTURE_DIR = 'fixtures/eval/renorbench-v2';
export const V2_CASES_PATH = 'docs/evals/renorbench-v2.dev.jsonl';

function writeBenchmark(built: RenorBenchV2, fixtureDir: string, casesPath: string): void {
  fs.rmSync(path.join(fixtureDir, 'vault'), { recursive: true, force: true });
  for (const [notePath, text] of built.notes) {
    const target = path.join(fixtureDir, 'vault', notePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
  }
  fs.writeFileSync(path.join(fixtureDir, 'fixture.json'), built.fixtureJson, 'utf8');
  fs.mkdirSync(path.dirname(casesPath), { recursive: true });
  fs.writeFileSync(casesPath, built.casesJsonl, 'utf8');
}

// Run as a script, not when a test imports `buildRenorBenchV2`.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const program = new Command()
    .name('generate-renorbench-v2')
    .description('Write the RenorBench v2 fixture and cases (deterministic: no seed, clock, environment or model)')
    .option('--write', `replace the committed ${V2_FIXTURE_DIR} and ${V2_CASES_PATH}`)
    .option('--output <dir>', 'write fixture.json, vault/ and cases.jsonl here instead (the directory must be new)')
    .parse(process.argv);
  const opts = program.opts<{ write?: boolean; output?: string }>();
  if (Boolean(opts.write) === Boolean(opts.output)) throw new Error('Specify exactly one of --write or --output <dir>');
  const built = buildRenorBenchV2();
  if (opts.write) {
    writeBenchmark(built, path.resolve(V2_FIXTURE_DIR), path.resolve(V2_CASES_PATH));
  } else {
    const output = path.resolve(opts.output!);
    fs.mkdirSync(output, { mode: 0o700 });
    writeBenchmark(built, output, path.join(output, 'cases.jsonl'));
  }
  const categories = new Map<string, number>();
  for (const test of built.cases) categories.set(test.category, (categories.get(test.category) ?? 0) + 1);
  console.log(JSON.stringify({ notes: built.notes.size, cases: built.cases.length, categories: Object.fromEntries(categories) }, null, 2));
}
