#!/usr/bin/env python3
"""
Renor-on-ConvoMem adapter (Salesforce/ConvoMem, CC BY-NC 4.0).

Converts evidence_questions JSON into Renor session files + frozen QA artifacts.
Dataset stays in ~/bench-data/convomem/ (never git). This adapter freezes a
stratified champion sample and a disjoint holdout; it does not download the
full 75,336-pair corpus.

  <out>/corpus/<case-id>/Sessions/<session>.md
  <out>/cases.jsonl
  <out>/convomem-dataset.json     LongMemEval-shaped rows for --recency-order
  <out>/adapter-meta.json
  <out>/champion-ids.txt
  <out>/holdout-ids.txt

License: internal research only by default (CC BY-NC 4.0).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta

HF_COMMIT = 'e3e9b39115b02346824c70d349350de738f8be41'
HF_BASE = f'https://huggingface.co/datasets/Salesforce/ConvoMem/resolve/{HF_COMMIT}'

# One evidence-questions file per category (deterministic: Telemarketer persona).
CATEGORY_FILES = {
    'user_facts': 'core_benchmark/evidence_questions/user_evidence/1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
    'assistant_facts': 'core_benchmark/evidence_questions/assistant_facts_evidence/1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
    'changing_facts': 'core_benchmark/evidence_questions/changing_evidence/2_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
    'abstention': 'core_benchmark/evidence_questions/abstention_evidence/1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
    'preferences': 'core_benchmark/evidence_questions/preference_evidence/1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
    'implicit_connections': 'core_benchmark/evidence_questions/implicit_connection_evidence/1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
}

DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
EPOCH = datetime(2024, 1, 1, 12, 0, 0)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def item_key(item: dict) -> str:
    payload = json.dumps(
        {'q': item.get('question'), 'a': item.get('answer'), 'pid': item.get('personId')},
        sort_keys=True,
        ensure_ascii=False,
    )
    return sha256_bytes(payload.encode('utf-8'))


def safe_segment(value: str) -> str:
    normalized = re.sub(r'[^a-zA-Z0-9._-]+', '_', value).strip('_')
    prefix = normalized[:80] or 'session'
    digest = hashlib.sha256(value.encode('utf-8')).hexdigest()[:10]
    return f'{prefix}-{digest}'


def lme_date(dt: datetime) -> str:
    return f"{dt.year:04d}/{dt.month:02d}/{dt.day:02d} ({DOW[dt.weekday()]}) {dt.hour:02d}:{dt.minute:02d}"


def render_session(session_id: str, date_str: str, messages: list) -> str:
    body = []
    for i, msg in enumerate(messages, 1):
        speaker = msg.get('speaker') or msg.get('role') or 'User'
        text = (msg.get('text') or msg.get('content') or '').strip()
        body.append(f'### Turn {i} — {speaker}\n\n{text}')
    return (
        f'---\nkind: convomem-session\n'
        f'session_id: {json.dumps(session_id)}\n'
        f'session_date: {json.dumps(date_str)}\n'
        f'---\n# Session {session_id}\n\nTimestamp: {date_str}\n\n'
        + '\n\n'.join(body)
        + '\n'
    )


def fetch_json(rel_path: str, dest_path: str) -> dict:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    if os.path.isfile(dest_path):
        with open(dest_path, 'rb') as fh:
            return json.loads(fh.read().decode('utf-8'))
    url = f'{HF_BASE}/{rel_path}'
    req = urllib.request.Request(url, headers={'user-agent': 'renor-eval-convomem'})
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read()
    tmp = dest_path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(raw)
    os.replace(tmp, dest_path)
    return json.loads(raw.decode('utf-8'))


def unique_items(items: list[dict]) -> list[dict]:
    """Keep first occurrence of each item_key after a stable sort."""
    ranked = sorted(items, key=item_key)
    seen: set[str] = set()
    out: list[dict] = []
    for item in ranked:
        key = item_key(item)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


class InsufficientUniqueItems(ValueError):
    pass


def select_slices(items: list[dict], n_champion: int, n_holdout: int) -> tuple[list[dict], list[dict]]:
    unique = unique_items(items)
    needed = n_champion + n_holdout
    if len(unique) < needed:
        raise InsufficientUniqueItems(
            f'need {needed} unique items (champion={n_champion} + holdout={n_holdout}), '
            f'have {len(unique)} after dedupe of {len(items)} inputs'
        )
    champion = unique[:n_champion]
    holdout = unique[n_champion:n_champion + n_holdout]
    champ_keys = {item_key(x) for x in champion}
    hold_keys = {item_key(x) for x in holdout}
    if champ_keys & hold_keys:
        raise RuntimeError('champion/holdout key overlap after selection')
    return champion, holdout


def relevant_from_conversations(
    conversations: list,
    filenames: list[str],
    session_ids: list[str],
) -> list[dict]:
    """Map conversations to retrieval gold. Never invent a positive.

    - containsEvidence is True  -> positive gold for that session
    - containsEvidence is False -> skip (explicit negative / filler)
    - key absent / non-dict     -> skip and record as unannotated
    Empty gold is allowed (recall metrics skip cases with no gold).
    """
    relevant = []
    unannotated = 0
    for conv, filename, session_id in zip(conversations, filenames, session_ids):
        if not isinstance(conv, dict) or 'containsEvidence' not in conv:
            unannotated += 1
            continue
        if conv.get('containsEvidence') is True:
            relevant.append({
                'match': safe_segment(session_id),
                'notePath': f'Sessions/{filename}',
                'relevance': 1,
                'role': 'positive',
            })
    return relevant


def conv_key(conv) -> str:
    """Identity of a conversation: its id, else a hash of its messages."""
    if isinstance(conv, dict) and conv.get('id') is not None:
        return f"id:{conv['id']}"
    messages = conv.get('messages') if isinstance(conv, dict) else conv
    return 'sha:' + sha256_bytes(json.dumps(messages, sort_keys=True, ensure_ascii=False).encode('utf-8'))


def _rank(seed: int, *parts: str) -> str:
    return sha256_bytes(':'.join([str(seed), *parts]).encode('utf-8'))


def build_haystack(item: dict, items: list[dict], size: int, seed: int, case_id: str) -> tuple[list, list[bool]]:
    """Return the case's conversations (evidence + filler) in timeline order and a
    parallel is-evidence list.

    Filler is whole conversations of OTHER items of the same persona file, never one
    the question's own evidence uses (by id or by messages). It is ranked by
    sha256(seed, case, conversation), so a run is reproducible and independent of
    input order. The evidence conversations keep their relative order but land at
    hash-chosen positions, so evidence is not always the newest. When the pool is
    smaller than size - evidence, all of it is used (the caller records the shortfall).
    """
    own = item.get('conversations') or []
    own_keys = {conv_key(c) for c in own}
    own_texts = {conv_key({'messages': c.get('messages') if isinstance(c, dict) else c}) for c in own}
    pool: dict[str, object] = {}
    for other in items:
        for c in other.get('conversations') or []:
            k = conv_key(c)
            if k in own_keys or conv_key({'messages': c.get('messages') if isinstance(c, dict) else c}) in own_texts:
                continue
            pool.setdefault(k, c)
    want = max(0, size - len(own))
    filler = [pool[k] for k in sorted(pool, key=lambda k: _rank(seed, case_id, 'f', k))[:want]]
    total = len(filler) + len(own)
    slots = sorted(sorted(range(total), key=lambda i: _rank(seed, case_id, 's', str(i)))[:len(own)])
    timeline: list = []
    is_evidence: list[bool] = []
    f_iter = iter(filler)
    o_iter = iter(own)
    slot_set = set(slots)
    for pos in range(total):
        if pos in slot_set:
            timeline.append(next(o_iter))
            is_evidence.append(True)
        else:
            timeline.append(next(f_iter))
            is_evidence.append(False)
    return timeline, is_evidence


def write_case(out_dir: str, split: str, category: str, item: dict, index: int,
               haystack: int = 0, haystack_seed: int = 0, pool_items: list[dict] | None = None) -> tuple[dict, dict]:
    case_id = f'convomem-{split}-{category}-{index:02d}-{item_key(item)[:12]}'
    conv_dir = os.path.join(out_dir, 'corpus', case_id, 'Sessions')
    os.makedirs(conv_dir, exist_ok=True)

    conversations = item.get('conversations') or []
    is_evidence = [True] * len(conversations)
    if haystack:
        conversations, is_evidence = build_haystack(item, pool_items or [], haystack, haystack_seed, case_id)
    haystack_ids = []
    haystack_dates = []
    filenames = []
    for c_i, conv in enumerate(conversations):
        messages = conv.get('messages') if isinstance(conv, dict) else conv
        if not isinstance(messages, list):
            messages = []
        dt = EPOCH + timedelta(days=c_i)
        date_str = lme_date(dt)
        sid = conv.get('id') if isinstance(conv, dict) else f'{case_id}-s{c_i}'
        sid = str(sid or f'{case_id}-s{c_i}')
        # filler carries no case id, so its chunks are the same text in every vault and the
        # content-addressed embedding cache embeds each conversation once
        session_id = f'{case_id}-{sid}' if is_evidence[c_i] else f'convomem-filler-{sid}'
        filename = f'{safe_segment(session_id)}.md'
        path = os.path.join(conv_dir, filename)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(render_session(session_id, date_str, messages))
        os.utime(path, (dt.timestamp(), dt.timestamp()))
        haystack_ids.append(session_id)
        haystack_dates.append(date_str)
        filenames.append(filename)
    if haystack:
        # gold stays the question's own evidence conversations; filler is never gold
        ev = [i for i, flag in enumerate(is_evidence) if flag]
        relevant = relevant_from_conversations([conversations[i] for i in ev], [filenames[i] for i in ev], [haystack_ids[i] for i in ev])
    else:
        relevant = relevant_from_conversations(conversations, filenames, haystack_ids)

    question = (item.get('question') or '').strip()
    expected = '' if item.get('answer') is None else str(item.get('answer'))
    last_date = haystack_dates[-1] if haystack_dates else lme_date(EPOCH)
    case = {
        'id': case_id,
        'category': category,
        'query': f'Question date: {last_date}\n{question}',
        'question': question,
        'questionDate': last_date,
        'expectedAnswer': expected,
        'shouldAbstain': category == 'abstention',
        'split': split,
        'corpusDir': os.path.join(out_dir, 'corpus', case_id),
        'relevant': relevant,
        'personId': item.get('personId'),
        'itemKey': item_key(item),
    }
    if haystack:
        case['haystackConversations'] = len(conversations)
    dataset_row = {
        'question_id': case_id,
        'question_date': last_date,
        'question': question,
        'haystack_session_ids': haystack_ids,
        'haystack_dates': haystack_dates,
        'answer': expected,
        'category': category,
    }
    return case, dataset_row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--output', required=True)
    ap.add_argument('--raw-dir', default=os.path.expanduser('~/bench-data/convomem/raw'))
    ap.add_argument('--n-champion', type=int, default=8)
    ap.add_argument('--n-holdout', type=int, default=8)
    ap.add_argument('--haystack', type=int, default=0,
                    help='conversations per case vault (evidence + filler from other items of the same file); 0 = evidence only')
    ap.add_argument('--haystack-seed', type=int, default=1)
    ap.add_argument('--local-files', nargs='*', help='skip download; pass category=path pairs')
    args = ap.parse_args()

    out_dir = os.path.abspath(args.output)
    os.makedirs(out_dir, exist_ok=True)

    local_map = {}
    for pair in args.local_files or []:
        cat, path = pair.split('=', 1)
        local_map[cat] = path

    cases = []
    dataset_rows = []
    file_hashes = {}
    counts = {}

    for category, rel in CATEGORY_FILES.items():
        if category in local_map:
            path = local_map[category]
            with open(path, 'rb') as fh:
                raw = fh.read()
            data = json.loads(raw.decode('utf-8'))
            file_hashes[category] = sha256_bytes(raw)
        else:
            dest = os.path.join(args.raw_dir, rel)
            data = fetch_json(rel, dest)
            with open(dest, 'rb') as fh:
                file_hashes[category] = sha256_bytes(fh.read())
        items = data.get('evidence_items') or []
        champion, holdout = select_slices(items, args.n_champion, args.n_holdout)
        pool_items = unique_items(items)
        counts[category] = {'sourceItems': len(items), 'champion': len(champion), 'holdout': len(holdout)}
        for split, slice_items in (('champion', champion), ('holdout', holdout)):
            for i, item in enumerate(slice_items):
                case, ds = write_case(out_dir, split, category, item, i, args.haystack, args.haystack_seed, pool_items)
                cases.append(case)
                dataset_rows.append(ds)

    with open(os.path.join(out_dir, 'cases.jsonl'), 'w', encoding='utf-8') as fh:
        for row in cases:
            fh.write(json.dumps(row, ensure_ascii=False) + '\n')
    with open(os.path.join(out_dir, 'convomem-dataset.json'), 'w', encoding='utf-8') as fh:
        json.dump(dataset_rows, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

    champion_ids = [c['id'] for c in cases if c['split'] == 'champion']
    holdout_ids = [c['id'] for c in cases if c['split'] == 'holdout']
    with open(os.path.join(out_dir, 'champion-ids.txt'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(champion_ids) + '\n')
    with open(os.path.join(out_dir, 'holdout-ids.txt'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(holdout_ids) + '\n')

    meta = {
        'benchmark': 'convomem',
        'license': 'CC BY-NC 4.0',
        'source': 'huggingface.co/datasets/Salesforce/ConvoMem',
        'hfCommit': HF_COMMIT,
        'personaFile': '0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
        'nChampionPerCategory': args.n_champion,
        'nHoldoutPerCategory': args.n_holdout,
        'selection': 'dedupe by sha256(question,answer,personId), sort, first N champion, next M holdout; fail if unique items < N+M',
        'goldRule': 'containsEvidence is True -> positive; False or missing annotation -> not gold (never invent first-session gold)',
        'dateConvention': 'synthetic sequential dates from 2024-01-01 (dataset has no timestamps)',
        'counts': counts,
        'fileSha256': file_hashes,
        'casesTotal': len(cases),
        'champion': len(champion_ids),
        'holdout': len(holdout_ids),
        'adapterOutput': out_dir,
    }
    if args.haystack:
        meta['haystack'] = {
            'conversationsPerCase': args.haystack,
            'seed': args.haystack_seed,
            'filler': 'whole conversations of other unique items of the same persona file, ranked by sha256(seed, case, conversation); never the question\'s own evidence; never gold',
            'datePosition': 'evidence at hash-chosen timeline slots (relative order kept); question date = last conversation',
            'actualByCategory': {
                cat: {'min': min(sizes), 'max': max(sizes), 'cappedByPool': min(sizes) < args.haystack}
                for cat, sizes in ((cat, [c['haystackConversations'] for c in cases if c['category'] == cat]) for cat in counts)
                if sizes
            },
        }
    with open(os.path.join(out_dir, 'adapter-meta.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, indent=2)
        fh.write('\n')
    print(json.dumps({k: meta[k] for k in ('casesTotal', 'champion', 'holdout', 'hfCommit', 'counts')}, indent=2))


if __name__ == '__main__':
    main()
