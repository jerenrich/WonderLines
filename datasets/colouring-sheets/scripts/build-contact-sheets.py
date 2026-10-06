"""Create browsing thumbnails without modifying any original dataset image.

Requires Pillow. Run after generation, or while a run is in progress to include
labelled placeholders for missing samples. No review decisions are inferred.
"""
import argparse
import json
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--run', default='20261005-sunburst-r01')
args = parser.parse_args()
run_id = args.run
assert run_id and all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in run_id)
plan = [json.loads(line) for line in (ROOT / 'manifests' / f'{run_id}.jsonl').read_text().splitlines()]
catalogue = json.loads((ROOT / 'manifests' / f'{run_id}.prompts.json').read_text())['descriptions']
out = ROOT / 'previews' / run_id
out.mkdir(parents=True, exist_ok=True)

def font(size):
    try:
        return ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', size)
    except OSError:
        return ImageFont.load_default(size=size)

title_font = font(26)
label_font = font(18)
small_font = font(15)
samples = []
for planned in plan:
    record = ROOT / 'metadata' / 'samples' / f"{planned['sample_id']}.json"
    samples.append(json.loads(record.read_text()) if record.exists() else planned)

def sheet(selected, title, filename, columns, label):
    cell_w, cell_h, gap, header = 360, 300, 12, 64
    rows = (len(selected) + columns - 1) // columns
    canvas = Image.new('RGB', (gap + columns * (cell_w + gap), header + rows * (cell_h + gap)), '#eceef0')
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 12), title, fill='#17212b', font=title_font)
    draw.text((gap, 43), 'Original outputs; visual review pending. Age labels show intended complexity.', fill='#45515d', font=small_font)
    for index, sample in enumerate(selected):
        x = gap + (index % columns) * (cell_w + gap)
        y = header + (index // columns) * (cell_h + gap)
        draw.rectangle((x, y, x + cell_w, y + cell_h), fill='white')
        image_path = ROOT / sample['image']['raw_path'] if sample['image']['raw_path'] else None
        if image_path and image_path.exists():
            with Image.open(image_path) as original:
                thumb = ImageOps.contain(original.convert('RGB'), (cell_w - 8, 250), Image.Resampling.LANCZOS)
                canvas.paste(thumb, (x + (cell_w - thumb.width) // 2, y + (250 - thumb.height) // 2))
        else:
            draw.text((x + 16, y + 108), sample['status'].capitalize(), fill='#6a737b', font=title_font)
        for line_index, text in enumerate(label(sample)):
            draw.text((x + 10, y + 256 + line_index * 20), text, fill='#17212b', font=label_font)
    canvas.save(out / filename, quality=90, optimize=True)

prompt_lookup = {entry['id']: entry['description'] for entry in catalogue}
overview = [next(s for s in samples if s['description_id'] == description_id and s['age_target'] == age)
            for description_id in ['cs003', 'cs010', 'cs020', 'cs025'] for age in [3, 6, 9, 13]]
sheet(overview, 'Sunburst - four prompts across four difficulty bands', 'band-overview.jpg', 4,
      lambda s: [f"{s['description_id']} | Age {s['age_target']}", prompt_lookup[s['description_id']]])
index_lines = [
    '# Sunburst contact sheets', '',
    f'Run `{run_id}`. Thumbnails are for browsing; the original PNGs and metadata remain separate. Images are pending visual review.', '',
    f'[Four-band overview]({run_id}/band-overview.jpg)', '',
    '## By prompt', ''
]
for entry in catalogue:
    selected = sorted((s for s in samples if s['description_id'] == entry['id']), key=lambda s: s['age_target'])
    filename = f"{entry['id']}-ages.jpg"
    sheet(selected, f"{entry['id']} - {entry['description']}", filename, 4,
          lambda s: [f"Age {s['age_target']} | {s['age_band']}"])
    index_lines.append(f"- [{entry['id']} — {entry['description']}]({run_id}/{filename})")
index_lines.extend(['', '## By target age', ''])
for age in range(3, 19):
    selected = sorted((s for s in samples if s['age_target'] == age), key=lambda s: s['description_id'])
    filename = f'age-{age:02d}.jpg'
    def label(sample):
        prompt = prompt_lookup[sample['description_id']]
        # The human prompts are short; two lines fit the thumbnail label area.
        words = prompt.split()
        left, right = [], []
        for word in words:
            if len(' '.join(left + [word])) <= 36 and not right:
                left.append(word)
            else:
                right.append(word)
        return [f"{sample['description_id']} - {' '.join(left)}", ' '.join(right)]
    sheet(selected, f'Sunburst - age {age} - all 25 prompts', filename, 5, label)
    index_lines.append(f'- [Age {age}]({run_id}/{filename})')
index_lines.append('')
(ROOT / 'previews' / 'README.md').write_text('\n'.join(index_lines))
print(json.dumps({'contact_sheets': 42, 'sample_counts': dict(Counter(s['status'] for s in samples)), 'output_directory': str(out)}))
