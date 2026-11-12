import { describe, it, expect } from 'vitest';
import { LocalRulesDecisionModel, classifyNote, type NoteClass } from '../../src/extraction/decision-model';

const LABELS = ['decision', 'preference', 'fact', 'result', 'request', 'noise'] as const;
type Label = (typeof LABELS)[number];

/** Synthetic notes. No person, no account, no real secret. Written as agent-chat lines, then labelled by hand. */
const EXAMPLES: Array<{ label: Label; text: string }> = [
  { label: 'decision', text: 'We decided to keep the preview on port 4177.' },
  { label: 'decision', text: 'Decision: the importer retries three times, then stops.' },
  { label: 'decision', text: 'Going with the opaque slug for new workspaces.' },
  { label: 'decision', text: 'We will ship the walkthrough before the launch post.' },
  { label: 'decision', text: 'The call is to leave session replay untouched.' },
  { label: 'decision', text: 'Agreed to store connection tokens hashed.' },
  { label: 'decision', text: 'Chose the local rules over a paid model for this pass.' },
  { label: 'decision', text: 'Ship the preview on Friday.' },
  { label: 'preference', text: 'Prefer oxlint for this repo, not a second linter.' },
  { label: 'preference', text: 'I would rather fail the save than cut a long statement.' },
  { label: 'preference', text: 'Always use the connection name as the author.' },
  { label: 'preference', text: 'Never use a public hostname derived from the email.' },
  { label: 'preference', text: "Don't use the User-Agent when the key has a name." },
  { label: 'preference', text: 'The preference is keyword search while embeddings rebuild.' },
  { label: 'preference', text: 'Use the ledger instead of a second database for facts.' },
  { label: 'preference', text: 'The importer should retry on its own.' },
  { label: 'fact', text: 'The preview port is 4177.' },
  { label: 'fact', text: 'The workspace runs on node 22.' },
  { label: 'fact', text: 'A connection with no name is unnamed.' },
  { label: 'fact', text: 'The video file is 22794916 bytes.' },
  { label: 'fact', text: 'Memory text is never sent to analytics.' },
  { label: 'fact', text: 'Old rows have a null author.' },
  { label: 'fact', text: 'The gateway overwrites a client-sent agent header.' },
  { label: 'fact', text: 'Each workspace has one owner.' },
  { label: 'result', text: 'The platform tests passed: 93 files.' },
  { label: 'result', text: 'The build failed on the missing supabase url.' },
  { label: 'result', text: 'Shipped the privacy scrub behind the existing hook.' },
  { label: 'result', text: 'The result of the quota review is not to merge.' },
  { label: 'result', text: 'Finished the sqlite migration locally.' },
  { label: 'result', text: 'Deployed the gateway without the label column.' },
  { label: 'result', text: 'The nightly importer finished with two flaky tests.' },
  { label: 'result', text: 'The tests are red.' },
  { label: 'request', text: 'Can you check the build before the post?' },
  { label: 'request', text: 'Please list the open requests for this workspace.' },
  { label: 'request', text: 'Could you rebase the privacy branch onto main?' },
  { label: 'request', text: 'Which port is the preview on?' },
  { label: 'request', text: 'Need you to confirm the two video files answer.' },
  { label: 'request', text: 'Ask the gateway to keep a blank label as unnamed.' },
  { label: 'request', text: 'Let me know when the cursor page is done.' },
  { label: 'request', text: 'Would you close the request I opened this morning?' },
  { label: 'noise', text: 'Thanks.' },
  { label: 'noise', text: 'On it.' },
  { label: 'noise', text: 'Looking now.' },
  { label: 'noise', text: 'Got it, running the suite.' },
  { label: 'noise', text: 'lol' },
  { label: 'noise', text: 'Hey, starting the task.' },
  { label: 'noise', text: 'Sure.' },
  { label: 'noise', text: 'That was great, thanks.' },
];

function score(rows: Array<{ label: Label; predicted: NoteClass }>) {
  const per: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const label of LABELS) per[label] = { tp: 0, fp: 0, fn: 0 };
  let correct = 0;
  for (const row of rows) {
    const predicted = row.predicted === 'sensitive' ? 'sensitive' : row.predicted;
    if (predicted === row.label) correct += 1;
    if (LABELS.includes(predicted as Label)) {
      if (predicted === row.label) per[predicted].tp += 1;
      else per[predicted].fp += 1;
    }
    if (predicted !== row.label) per[row.label].fn += 1;
  }
  const report: Record<string, { precision: number; recall: number }> = {};
  for (const label of LABELS) {
    const { tp, fp, fn } = per[label];
    report[label] = {
      precision: tp + fp === 0 ? 0 : tp / (tp + fp),
      recall: tp + fn === 0 ? 0 : tp / (tp + fn),
    };
  }
  return { n: rows.length, correct, accuracy: correct / rows.length, report };
}

describe('classify_capture local rules', () => {
  it('keeps the numeric capture gate, and the new task costs nothing', async () => {
    expect(LocalRulesDecisionModel.captureGate('The preview port is 4177.')).toBe('fact');
    expect(LocalRulesDecisionModel.captureGate('Thanks.')).toBe('none');
    const model = new LocalRulesDecisionModel();
    const result = await model.decide({ task: 'classify_capture', text: 'We decided to keep the preview on port 4177.' });
    expect(result).toMatchObject({ task: 'classify_capture', decision: 'decision', costUSDCents: 0 });
  });

  it('drops a secret: the local rules class it sensitive', () => {
    expect(classifyNote('password: correct-horse')).toBe('sensitive');
  });

  it('measures the 48 hand-labelled notes', () => {
    expect(EXAMPLES).toHaveLength(48);
    const rows = EXAMPLES.map((example) => ({ label: example.label, predicted: classifyNote(example.text) }));
    const measured = score(rows);
    expect(measured).toEqual({
      n: 48,
      correct: 41,
      accuracy: 41 / 48,
      report: {
        decision: { precision: 1, recall: 0.875 },
        preference: { precision: 1, recall: 0.875 },
        fact: { precision: 5 / 6, recall: 0.625 },
        result: { precision: 1, recall: 0.875 },
        request: { precision: 1, recall: 0.875 },
        noise: { precision: 8 / 14, recall: 1 },
      },
    });
  });
});
