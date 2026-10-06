"""Verify generation coverage, image bytes and app-prompt consistency offline.

Requires Pillow. This checks dataset integrity, not visual suitability.
"""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--run', default='20261005-sunburst-r01')
parser.add_argument('--require-complete', action='store_true')
args = parser.parse_args()
run_id = args.run
assert run_id and all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in run_id)
manifest = json.loads((ROOT / 'manifests' / f'{run_id}.json').read_text())
plan_path = ROOT / 'manifests' / f'{run_id}.jsonl'
plan_bytes = plan_path.read_bytes()
assert hashlib.sha256(plan_bytes).hexdigest() == manifest['plan_sha256']
plan = [json.loads(line) for line in plan_bytes.decode().splitlines()]
guidance = json.loads((ROOT / 'manifests' / f'{run_id}.guidance.json').read_text())
schema = json.loads((ROOT / 'schemas/sample.schema.json').read_text())
assert len(plan) == 400
assert len({sample['sample_id'] for sample in plan}) == 400
assert len({sample['worker']['generation_id'] for sample in plan}) == 400
assert len({sample['worker']['batch_id'] for sample in plan}) == 400
assert len({(sample['description_id'], sample['age_target']) for sample in plan}) == 400
assert set(sample['age_target'] for sample in plan) == set(range(3, 19))

counts, by_age, by_account, hashes, errors = Counter(), Counter(), Counter(), Counter(), []
batch_descriptions = {}
results = []
estimated_usd, estimate_count, image_bytes = 0.0, 0, 0
for planned in plan:
    record_path = ROOT / 'metadata' / 'samples' / f"{planned['sample_id']}.json"
    sample = json.loads(record_path.read_text()) if record_path.exists() else planned
    results.append(sample)
    assert set(schema['required']).issubset(sample)
    assert set(sample).issubset(schema['properties'])
    assert sample['status'] in schema['properties']['status']['enum']
    for key in ['sample_id', 'description_id', 'age_target', 'composition', 'subject_prompt', 'effective_prompt', 'requested_parameters']:
        assert sample[key] == planned[key], (sample['sample_id'], key)
    assert sample['worker']['generation_id'] == planned['worker']['generation_id']
    assert sample['worker']['account_index'] == planned['worker']['account_index']
    batch_key = (sample['worker']['account_index'], sample['worker']['batch_id'])
    if batch_key in batch_descriptions:
        assert batch_descriptions[batch_key] == sample['description']
    batch_descriptions[batch_key] = sample['description']
    band = next(b for b in guidance['age_bands'] if b['minimum'] <= sample['age_target'] <= b['maximum'])
    assert sample['age_band'] == band['id']
    subject = guidance['subject_template'].format(description=sample['description'], complexity=band['complexity'], composition_view=guidance['composition_views'][sample['composition']])
    assert subject == sample['subject_prompt']
    assert len(subject.encode('utf-16-le')) // 2 <= guidance['subject_limit_utf16_units']
    assert sample['effective_prompt'] == guidance['standard_provider_prefix'] + subject
    counts[sample['status']] += 1
    if sample['status'] == 'generated':
        assert sample['model_id'] == manifest['expected_upstream_model'] == 'gpt-image-2.5-sunburst'
        metrics = sample['worker']['metrics']
        assert metrics['upstreamModel'] == metrics['requestedModel'] == sample['model_id']
        assert metrics['provider'] == sample['provider'] == 'openai'
        assert sample['image']['raw_path'] and sample['image']['sha256']
        image_path = ROOT / sample['image']['raw_path']
        assert image_path.resolve().is_relative_to(ROOT.resolve())
        data = image_path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == sample['image']['sha256']
        hashes[sample['image']['sha256']] += 1
        image_bytes += len(data)
        with Image.open(image_path) as image:
            assert image.format == 'PNG'
            assert image.size == (sample['image']['width'], sample['image']['height'])
            assert metrics['size'] == f'{image.width}x{image.height}'
            image.verify()
        with Image.open(image_path) as image:
            image.load()
        cost = metrics.get('estimatedTotalUsd')
        if cost is not None:
            estimated_usd += cost
            estimate_count += 1
        by_age[sample['age_target']] += 1
        by_account[sample['worker']['account_index']] += 1
    elif sample['status'] in ['failed', 'uncertain']:
        errors.append({'sample_id': sample['sample_id'], 'status': sample['status'], 'error_code': sample['worker']['error_code'], 'reason': sample['failure_reason']})

if args.require_complete:
    assert counts == {'generated': 400}, dict(counts)
    assert by_age == {age: 25 for age in range(3, 19)}, dict(by_age)
    assert by_account == {index: 100 for index in range(4)}, dict(by_account)
report = {
    'run_id': run_id, 'verification': 'passed', 'counts': dict(counts),
    'generated_by_age': dict(sorted(by_age.items())), 'unique_image_hashes': len(hashes),
    'generated_by_account': dict(sorted(by_account.items())),
    'duplicate_image_hashes': [key for key, count in hashes.items() if count > 1],
    'known_inference_estimate_usd': estimated_usd, 'samples_with_cost_estimates': estimate_count,
    'raw_image_bytes': image_bytes, 'errors': errors,
    'checks': ['400 unique description/age slots', 'unique generation IDs', 'consistent shared moderation batches', 'plan hash',
               'metadata structure', 'age guidance and subject length', 'provider prompt reconstruction',
               'Sunburst model provenance', 'file hashes', 'PNG decoding and dimensions'],
    'visual_review': 'pending', 'cost_note': 'Worker inference estimates, not billing receipts.'
}
(ROOT / 'reviews' / f'{run_id}-integrity.json').write_text(json.dumps(report, indent=2) + '\n')
(ROOT / 'manifests' / f'{run_id}.results.jsonl').write_text(''.join(json.dumps(sample) + '\n' for sample in results))
collection_path = ROOT / 'collection.json'
collection = json.loads(collection_path.read_text())
collection['generated_samples'] = counts.get('generated', 0)
collection['status'] = 'generated-awaiting-review' if counts == {'generated': 400} else 'generation-incomplete' if errors else 'generating'
collection_path.write_text(json.dumps(collection, indent=2) + '\n')
print(json.dumps(report))
