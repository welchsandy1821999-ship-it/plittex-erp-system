import json
import io
import re

# Load DB items
with io.open(r'C:\Users\Пользователь\.gemini\antigravity\brain\104a1864-8ecc-4e2f-825c-f290b319d8b4\.system_generated\steps\8792\output.txt', 'r', encoding='utf-8') as f:
    db_items = json.load(f)

# Load Excel data
with io.open('tmp_revision.json', 'r', encoding='utf-8') as f:
    revision_data = json.load(f)

# Load current balances
# (Hardcoded from previous tool output for the script)
current_balances = {
    194: 25.6, 192: 116.36, 505: 225, 510: 908, 453: 587,
    429: 783, 189: 155.04, 393: 232.74, 154: 2900, 509: 495,
    504: 225, 506: 230, 501: 10, 508: 137500, 153: 5880,
    507: 170, 157: 16580, 156: 1400, 511: 275, 155: 26020
}

def clean_name(name):
    if not name: return ""
    name = name.lower()
    # Remove quotes, sizes, and extra spaces
    name = re.sub(r'["«»]', '', name)
    name = re.sub(r'\d+х\d+х\d+', '', name)
    return " ".join(name.split())

matches = []
unmatched = []

for row in revision_data:
    if not row or len(row) < 2: continue
    xl_name = row[0]
    xl_qty = row[1]
    
    if xl_name is None: continue
    
    xl_clean = clean_name(xl_name)
    best_match = None
    
    # Try exact match first
    for item in db_items:
        db_clean = clean_name(item['name'])
        if xl_clean in db_clean or db_clean in xl_clean:
            best_match = item
            break
    
    if best_match:
        item_id = best_match['id']
        balance = current_balances.get(item_id, 0)
        matches.append({
            'xl_name': xl_name,
            'db_name': best_match['name'],
            'id': item_id,
            'revision_qty': xl_qty,
            'current_qty': float(balance),
            'diff': float(xl_qty) - float(balance)
        })
    else:
        unmatched.append(xl_name)

result = {
    'matched_count': len(matches),
    'unmatched_count': len(unmatched),
    'matches_sample': matches[:20],
    'unmatched_sample': unmatched[:20]
}

with io.open('mapping_report.json', 'w', encoding='utf-8') as f:
    f.write(json.dumps(result, ensure_ascii=False, indent=2))
