import re

js_path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js"
css_path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\css\modules.css"

with open(js_path, "r", encoding="utf-8") as f:
    text = f.read()

# Define patterns to replace and their corresponding CSS utility classes
replacements = [
    # Remove simple static inline styles mapping to new utility classes
    (r'style="padding: 10px 16px; background: var\(--bg-surface-alt\); border-bottom: 1px solid var\(--border-color\);"', r'class="crm-header-row"'),
    (r'style="background: var\(--bg-surface-alt\);"', r'class="bg-surface-alt"'),
    (r'style="border-bottom: 1px solid var\(--border-color\);"', r'class="border-b"'),
    
    (r'style="padding: 8px 10px; border-right: 1px solid var\(--border-color\); font-size:11px; color:var\(--text-muted\);"', r'class="th-sub header-border"'),
    
    (r'style="padding: 6px; border-right: 1px solid var\(--border-color\); font-size:11px; color:var\(--text-muted\); text-align:center;"', r'class="td-center border-r font-11 text-muted"'),
    (r'style="padding: 6px; font-size:11px; color:var\(--text-muted\); text-align:right;"', r'class="td-right font-11 text-muted"'),
    
    (r'style="border-bottom: 2px solid var\(--border-color\);"', r'class="border-b-2"'),
    
    (r'style="padding:4px 8px; font-size:10px; color:var\(--primary\); text-align:center; border-right:1px dashed var\(--border-color\);"', r'class="td-center font-10 text-primary border-r-dashed"'),
    (r'style="padding:4px 8px; font-size:10px; color:#e65100; text-align:center; border-right:1px solid var\(--border-color\);"', r'class="td-center font-10 text-orange border-r"'),
    
    (r'style="padding:7px 10px; font-weight:600; border-right:1px solid var\(--border-color\);"', r'class="font-600 border-r padding-7-10"'),
    
    (r'style="padding:7px 6px; text-align:center; color:var\(--primary\); border-right:1px dashed var\(--border-color\);"', r'class="td-center text-primary border-r-dashed padding-7-6"'),
    (r'style="padding:7px 6px; text-align:center; color:#e65100; font-weight:700; border-right:1px solid var\(--border-color\);"', r'class="td-center text-orange font-700 border-r padding-7-6"'),
    
    (r'style="padding:7px 6px; text-align:right; color:var\(--primary\); border-right:1px dashed var\(--border-color\);"', r'class="td-right text-primary border-r-dashed padding-7-6"'),
    (r'style="padding:7px 6px; text-align:right; color:#e65100; font-weight:700; border-right:1px solid var\(--border-color\);"', r'class="td-right text-orange font-700 border-r padding-7-6"'),
    
    (r'style="padding:7px 6px; text-align:right; font-weight:700; color:var\(--danger\);"', r'class="td-right font-700 text-danger padding-7-6"'),
    
    (r'style="background: var\(--bg-surface-alt\); border-top: 2px solid var\(--border-color\);"', r'class="bg-surface-alt border-t-2"'),
    
    (r'style="padding:10px; border-right:1px solid var\(--border-color\);"', r'class="border-r padding-10"'),
    (r'style="padding:10px; border-right:1px dashed var\(--border-color\);"', r'class="border-r-dashed padding-10"'),
    
    (r'style="padding:10px; text-align:right; color:var\(--primary\); border-right:1px dashed var\(--border-color\);"', r'class="td-right text-primary border-r-dashed padding-10"'),
    (r'style="padding:10px; text-align:right; color:#e65100; border-right:1px solid var\(--border-color\);"', r'class="td-right text-orange border-r padding-10"'),
    (r'style="padding:10px; text-align:right; color:var\(--danger\); font-size:13px;"', r'class="td-right text-danger font-13 padding-10"'),
    
    # Non-td elements
    (r'style="background: var\(--bg-surface-alt\); padding: 4px 8px; border-radius: 6px;"', r'class="badge-surface"'),
    (r'style="color: #e65100;"', r'class="text-orange"'),
    (r'style="color:var\(--success\); border-color:var\(--success\);"', r'class="text-success border-success"'),
    (r'style="color: var\(--info\);"', r'class="text-info"'),
    
    (r'style="border-bottom: 1px dashed var\(--border-color\); padding-bottom: 6px; margin-bottom: 8px;"', r'class="border-b-dashed pb-6 mb-8"'),
    (r'style="border-bottom: 1px solid var\(--border-color\); padding-bottom: 8px; margin-bottom: 10px;"', r'class="border-b pb-8 mb-10"'),
    
    (r'style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var\(--text-muted\);"', r'class="font-11 text-uppercase font-700 text-muted"'),
    (r'style="font-size: 22px; font-weight: 900; line-height: 1; color: var\(--success\);"', r'class="font-22 font-900 line-height-1 text-success"'),
    (r'style="font-size: 12px; font-weight: 700; color: var\(--success\); margin-top: 3px;"', r'class="font-12 font-700 text-success mt-3"'),
    
    (r'style="padding: 8px; text-align: center; color: var\(--success\); font-weight: bold;"', r'class="padding-8 td-center text-success font-bold"'),
    (r'style="padding: 8px; text-align: center; color: var\(--primary\); font-weight: bold;"', r'class="padding-8 td-center text-primary font-bold"'),
    (r'style="padding: 8px; text-align: center; color: var\(--danger\); font-weight: bold;"', r'class="padding-8 td-center text-danger font-bold"'),
    
    (r'style="width: 70px; text-align: center; border-color: var\(--primary\); font-weight: bold;"', r'class="w-70 td-center border-primary font-bold"'),
    (r'style="padding: 4px 0; color: var\(--text-muted\); font-size: 11px;"', r'class="padding-y-4 text-muted font-11"'),
    
    (r'style="margin-top: 20px; text-align: left; background: var\(--surface-hover\); padding: 10px; border-radius: 6px; border: 1px dashed var\(--border\);"', r'class="mt-20 text-left bg-surface-hover padding-10 border-radius-6 border-dashed"'),
    (r'style="font-size: 12px; color: var\(--text-muted\); font-weight: bold;"', r'class="font-12 text-muted font-bold"'),
    (r'style="font-size: 11px; color: var\(--text-muted\); display: block; margin-top: 5px;"', r'class="font-11 text-muted d-block mt-5"'),
    
    (r'style="background: #059669; border-color: #059669;"', r'class="bg-success border-success text-white"'),
    (r'style="padding: 10px; color: var\(--text-muted\);"', r'class="padding-10 text-muted"'),
    (r'style="padding: 10px; text-align: right; color: var\(--warning-text\); font-weight: bold; font-size: 16px;"', r'class="padding-10 td-right text-warning font-bold font-16"'),
    
    (r'style="background: #fffbeb; padding: 15px; border-radius: 8px; border: 1px solid #fde68a; margin-bottom: 15px; text-align: center;"', r'class="alert-warning padding-15 border-radius-8 mb-15 td-center"'),
    (r'style="color: #b45309; font-size: 14px;"', r'class="text-warning-dark font-14"'),
    (r'style="font-size: 26px; color: var\(--warning-text\);"', r'class="font-26 text-warning"'),
    (r'style="background: var\(--surface-hover\); text-align: left;"', r'class="bg-surface-hover text-left"'),
    
    (r'style="width: 80px; text-align: center; border-color: var\(--primary\);"', r'class="w-80 td-center border-primary"'),
]

new_text = text
for pattern, repl in replacements:
    new_text = re.sub(pattern, repl, new_text)

# We still have dynamic styles like: `style="color: ${palletscolor}; line-height: 1.2;"`
# Let's fix that too. We can leave dynamic variables in style but remove static properties.
new_text = re.sub(r'style="color: \$\{palletscolor\}; line-height: 1\.2;"', r'style="color: ${palletsColor};" class="line-height-1-2"', new_text)

with open(js_path, "w", encoding="utf-8") as f:
    f.write(new_text)

print("sales.js modified!")

# Now add CSS classes to modules.css
css_additions = """
/* --- Утилиты для Sales модуля (Избавление от инлайн стилей) --- */
.bg-surface-alt { background: var(--bg-surface-alt); }
.border-b { border-bottom: 1px solid var(--border-color); }
.border-b-2 { border-bottom: 2px solid var(--border-color); }
.border-t-2 { border-top: 2px solid var(--border-color); }
.border-r { border-right: 1px solid var(--border-color); }
.border-r-dashed { border-right: 1px dashed var(--border-color); }
.border-b-dashed { border-bottom: 1px dashed var(--border-color); }
.border-dashed { border: 1px dashed var(--border-color); }
.border-primary { border-color: var(--primary); }
.border-success { border-color: var(--success); }

.text-orange { color: #e65100; }
body.dark-theme .text-orange { color: #ff9800; } /* Dark mode compatibility */

.text-warning-dark { color: #b45309; }
body.dark-theme .text-warning-dark { color: #fcd34d; }

.alert-warning { background: #fffbeb; border: 1px solid #fde68a; }
body.dark-theme .alert-warning { background: rgba(217, 119, 6, 0.1); border-color: rgba(217, 119, 6, 0.3); }

.bg-success { background: #059669; }
.text-white { color: #fff; }
.text-primary { color: var(--primary); }
.text-success { color: var(--success); }
.text-danger { color: var(--danger); }
.text-info { color: var(--info); }
.text-warning { color: var(--warning-text); }
.text-muted { color: var(--text-muted); }

.font-10 { font-size: 10px; }
.font-11 { font-size: 11px; }
.font-12 { font-size: 12px; }
.font-13 { font-size: 13px; }
.font-14 { font-size: 14px; }
.font-16 { font-size: 16px; }
.font-22 { font-size: 22px; }
.font-26 { font-size: 26px; }

.font-600 { font-weight: 600; }
.font-700, .font-bold { font-weight: 700; }
.font-900 { font-weight: 900; }

.td-center { text-align: center; }
.td-right { text-align: right; }
.text-left { text-align: left; }
.text-uppercase { text-transform: uppercase; }

.line-height-1 { line-height: 1; }
.line-height-1-2 { line-height: 1.2; }

.padding-6 { padding: 6px; }
.padding-8 { padding: 8px; }
.padding-10 { padding: 10px; }
.padding-15 { padding: 15px; }
.padding-y-4 { padding: 4px 0; }
.padding-7-6 { padding: 7px 6px; }
.padding-7-10 { padding: 7px 10px; }

.mt-3 { margin-top: 3px; }
.mt-5 { margin-top: 5px; }
.mt-20 { margin-top: 20px; }
.mb-8 { margin-bottom: 8px; }
.mb-10 { margin-bottom: 10px; }
.mb-15 { margin-bottom: 15px; }
.pb-6 { padding-bottom: 6px; }
.pb-8 { padding-bottom: 8px; }

.w-70 { width: 70px; }
.w-80 { width: 80px; }

.border-radius-6 { border-radius: 6px; }
.border-radius-8 { border-radius: 8px; }

.d-block { display: block; }
.badge-surface { background: var(--bg-surface-alt); padding: 4px 8px; border-radius: 6px; }
.bg-surface-hover { background: var(--surface-hover); }

/* --- Конец утилит Sales --- */
"""

with open(css_path, "a", encoding="utf-8") as f:
    f.write(css_additions)

print("modules.css modified!")
