import json
import io
import re

# Load DB items
with io.open(r'C:\Users\Пользователь\.gemini\antigravity\brain\104a1864-8ecc-4e2f-825c-f290b319d8b4\.system_generated\steps\8792\output.txt', 'r', encoding='utf-8') as f:
    db_items = json.load(f)

# Load Excel data
with io.open('tmp_revision.json', 'r', encoding='utf-8') as f:
    revision_data = json.load(f)

def clean_for_match(name):
    if not name: return []
    name = name.lower()
    # Remove metadata
    name = re.sub(r'["«»]', '', name)
    name = re.sub(r'2 сорт|сорт 2|2сорт|уценка|экспериментальная', '', name)
    name = re.sub(r'\d+х\d+х\d+', '', name)
    # Split into words and keep only meaningful ones
    words = re.findall(r'[а-яё]+', name)
    return [w for w in words if len(w) > 2]

def get_grade(name):
    name = name.lower()
    if '2 сорт' in name or '2сорт' in name:
        return '2 сорт'
    if 'экспериментальная' in name:
        return 'Экспериментальная'
    return '1 сорт'

final_table = []

for row in revision_data:
    if not row or len(row) < 2: continue
    xl_name = row[0]
    xl_qty = row[1]
    if xl_name is None: continue
    
    grade = get_grade(xl_name)
    xl_keywords = set(clean_for_match(xl_name))
    
    best_match = None
    max_matches = 0
    
    for item in db_items:
        db_keywords = set(clean_for_match(item['name']))
        # Special case: check if all xl_keywords are in db_keywords
        intersection = xl_keywords.intersection(db_keywords)
        if len(intersection) > max_matches:
            # Additional check: category match
            if len(intersection) >= min(len(xl_keywords), 3):
                max_matches = len(intersection)
                best_match = item

    entry = {
        'xl_name': xl_name,
        'grade': grade,
        'matched_id': best_match['id'] if best_match else None,
        'matched_name': best_match['name'] if best_match else "НЕ НАЙДЕНО",
        'revision_qty': xl_qty
    }
    final_table.append(entry)

with io.open('matching_final.json', 'w', encoding='utf-8') as f:
    f.write(json.dumps(final_table, ensure_ascii=False, indent=2))
