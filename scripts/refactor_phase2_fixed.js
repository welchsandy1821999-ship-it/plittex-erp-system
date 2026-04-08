const fs = require('fs');

const pEjsPath = 'views/modules/production.ejs';
let pEjs = fs.readFileSync(pEjsPath, 'utf8');

const pEjsReps = [
    { from: `style="grid-template-columns: 1fr 1fr;"`, to: `class="dash-form-grid-2"` },
    { from: `class="chart-bar" style="border-color: var(--warning-text); color: var(--warning-text);"`, to: `class="chart-bar prod-chart-bar-warning"` },
    { from: `class="chart-bar" style="border-color: var(--primary);"`, to: `class="chart-bar prod-chart-bar-primary"` },
    { from: `style="width: 30%;"`, to: `class="w-30p"` },
    { from: `class="print-col-hidden" style="display: none; width: 12%;"`, to: `class="print-col-hidden prod-print-col-hidden"` },
    { from: `style="width: 13%;"`, to: `class="w-13p"` },
    { from: `style="width: 15%;"`, to: `class="w-15p"` },
    { from: `class="action-panel" style="display: none;"`, to: `class="action-panel hidden"` }
];
pEjsReps.forEach(r => pEjs = pEjs.split(r.from).join(r.to));
fs.writeFileSync(pEjsPath, pEjs);

const rEjsPath = 'views/modules/recipes.ejs';
let rEjs = fs.readFileSync(rEjsPath, 'utf8');
const rEjsReps = [
    { from: `class="btn btn-outline" style="align-items: flex-end;"`, to: `class="btn btn-outline align-end"` },
    { from: `class="btn btn-outline" style="border-color: var(--primary); color: var(--primary);"`, to: `class="btn btn-outline rec-primary-outline"` },
    { from: `style="display: flex; gap: 15px; border-bottom: 2px solid var(--border); padding-bottom: 30px; margin-bottom: 30px;"`, to: `class="rec-filter-container"` },
    { from: `class="btn btn-primary" style="font-weight: bold; border-radius: 8px; padding: 12px 24px;"`, to: `class="btn btn-primary rec-action-btn"` },
    { from: `class="btn btn-outline" style="font-weight: bold; border-radius: 8px; padding: 12px 24px; border-color: var(--primary); color: var(--primary);"`, to: `class="btn btn-outline rec-action-btn rec-primary-outline"` },
    { from: `style="font-size: 13px; margin: 0;"`, to: `class="font-13 m-0"` },
    { from: `style="grid-template-columns: 1fr 2fr; align-items: start; gap: 24px;"`, to: `class="form-grid rec-grid-header"` },
    { from: `style="border-left: 4px solid var(--primary);"`, to: `class="pl-10 rec-section-title"` },
    { from: `style="font-size: 16px;"`, to: `class="font-16"` },
    { from: `class="mb-15 pl-10" style="border-left: 4px solid var(--primary); display: none;"`, to: `class="mb-15 pl-10 rec-section-title hidden"` },
    { from: `class="form-grid mb-15" style="display: none;"`, to: `class="form-grid mb-15 hidden"` },
    { from: `style="font-size: 15px;"`, to: `class="font-15"` },
    { from: `id="cost-calc-panel" style="display: none; background: var(--surface); padding: 12px; border-radius: 8px; border: 1px dashed var(--border); margin-top: 15px;"`, to: `id="cost-calc-panel" class="rec-dash-box hidden"` },
    { from: `style="font-weight: 600;"`, to: `class="font-600"` },
    { from: `style="margin-top: 5px;"`, to: `class="mt-5"` },
    { from: `style="font-size: 15px; font-weight: bold; padding-top: 10px; border-top: 1px dashed var(--border);"`, to: `class="rec-step-header"` },
    { from: `style="font-size: 12px; margin-top: 15px; border-top: 1px dashed var(--border); padding-top: 10px;"`, to: `class="font-12 mt-15 pt-10 border-top-dashed"` },
    { from: `class="flex-between" style="align-items: center; padding-bottom: 20px; border-bottom: 1px dashed var(--border);"`, to: `class="flex-between rec-step-footer"` },
    { from: `style="display: flex; align-items: center; gap: 15px;"`, to: `class="flex-row align-center gap-15"` },
    { from: `class="fw-bold text-main" style="margin-bottom: 0; font-size: 20px;"`, to: `class="fw-bold text-main m-0 font-20"` },
    { from: `id="recipe-status-badge" style="display: none; padding: 6px 12px; font-size: 13px; font-weight: bold; border-radius: 6px;"`, to: `id="recipe-status-badge" class="rec-badge hidden"` },
    { from: `style="display: flex; gap: 10px;"`, to: `class="flex-row gap-10"` },
    { from: `style="margin-top: 15px; margin-bottom: 25px; background: var(--surface-alt); padding: 20px; border-radius: 8px;"`, to: `class="rec-cost-panel"` },
    { from: `style="display: flex; gap: 15px; align-items: flex-end; flex-wrap: wrap;"`, to: `class="rec-cost-param"` },
    { from: `style="flex: 2; min-width: 200px; margin-bottom: 0;"`, to: `class="flex-2 min-w-200 m-0"` },
    { from: `style="flex: 1; min-width: 120px; margin-bottom: 0;"`, to: `class="flex-1 min-w-120 m-0"` },
    { from: `class="btn btn-outline" style="height: 42px; padding: 0 25px;"`, to: `class="btn btn-outline h-42 px-25"` },
    { from: `style="background: var(--surface-alt);"`, to: `class="bg-surface-alt"` },
    { from: `style="padding: 12px 15px;"`, to: `class="px-15 py-12"` },
    { from: `style="text-align: right; padding: 12px 15px;"`, to: `class="text-right px-15 py-12"` },
    { from: `id="formula-guidance" style="display: none; padding: 20px; font-size: 14px; border: 1px dashed var(--border); border-radius: 6px; margin-top: 15px;"`, to: `id="formula-guidance" class="p-20 font-14 border-dashed border-rounded mt-15 hidden"` }
];
rEjsReps.forEach(r => rEjs = rEjs.split(r.from).join(r.to));
fs.writeFileSync(rEjsPath, rEjs);


function replaceJs(path, strReps, regexReps) {
    if(!fs.existsSync(path)) return;
    let content = fs.readFileSync(path, 'utf8');
    
    // JS String replacements
    strReps.forEach(r => content = content.split(r.from).join(r.to));
    
    // JS regex replacements
    regexReps.forEach(r => {
        content = content.replace(r.from, r.to);
    });
    
    fs.writeFileSync(path, content);
}

const pJsPath = 'public/js/production.js';
const pJsStrReps = [
    { from: `style="width: 140px;"`, to: `class="w-140"` },
    { from: `style="width: 60px;"`, to: `class="w-60"` },
    { from: `style="width: 120px;"`, to: `class="w-120"` },
    { from: `style="padding: 6px 12px; height: auto;"`, to: `class="p-5 h-auto"` },
    { from: `style="border-radius: 8px 0 0 8px;"`, to: `class="input-left-rounded"` },
    { from: `style="border-radius: 0 8px 8px 0;"`, to: `class="input-right-rounded"` },
    { from: `style="font-style: italic;"`, to: `class="italic"` },
    { from: `style="display: block;"`, to: `class="block"` },
    { from: `style="font-size: 16px; font-weight: bold;"`, to: `class="font-16 font-bold"` },
    { from: `style="white-space: nowrap;"`, to: `class="whitespace-nowrap"` },
    { from: `style="margin-right: 5px;"`, to: `class="mr-5"` },
    { from: `style="color: var(--warning-text); margin-right: 5px;"`, to: `class="text-warning mr-5"` },
    { from: `style="color: #b37400;"`, to: `class="text-warning"` },
    { from: `style="color: #0056b3;"`, to: `class="text-primary"` },
    { from: `style="border-bottom: 2px solid #eee;"`, to: `class="border-bottom-dashed"` },
    { from: `style="font-weight:bold;"`, to: `class="font-bold"` },
    { from: `style="text-align:right"`, to: `class="text-right"` },
    { from: `style="grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));"`, to: `class="grid-auto-fit"` },
    { from: `style="text-transform: uppercase;"`, to: `class="text-uppercase"` },
    { from: `style="border-bottom: 1px solid var(--border);"`, to: `class="border-bottom"` },
    { from: `style="text-align: center; color: var(--text-muted);"`, to: `class="text-center text-muted"` },
    { from: `style="text-align: center; color: var(--danger);"`, to: `class="text-center text-danger"` }
];
const pJsRegexReps = [
    { from: /(\w+)\.style\.display\s*=\s*'none'/g, to: `$1.classList.add('hidden')` },
    { from: /(\w+)\.style\.display\s*='none'/g, to: `$1.classList.add('hidden')` },
    { from: /(\w+)\.style\.display\s*=\s*'block'/g, to: `$1.classList.remove('hidden')` },
    { from: /(\w+)\.style\.display\s*=\s*'inline-block'/g, to: `$1.classList.remove('hidden')` },
    { from: /(\w+)\.style\.opacity\s*=\s*'0\.6'/g, to: `$1.classList.add('opacity-60')` },
    { from: /(\w+)\.style\.opacity\s*=\s*'1'/g, to: `$1.classList.remove('opacity-60', 'opacity-50')` },
    { from: /(\w+)\.style\.opacity\s*=\s*'0\.5'/g, to: `$1.classList.add('opacity-50')` },
    { from: /(\w+)\.style\.pointerEvents\s*=\s*'none'/g, to: `$1.classList.add('no-pointer')` },
    { from: /(\w+)\.style\.pointerEvents\s*=\s*'auto'/g, to: `$1.classList.remove('no-pointer')` },
    { from: /(\w+)\.style\.display\s*=\s*'table-footer-group'/g, to: `$1.classList.add('table-footer'); $1.classList.remove('hidden')` },
    { from: /(\w+)\.style\.display\s*=\s*'table-cell'/g, to: `$1.classList.add('table-cell'); $1.classList.remove('hidden')` },
    { from: /(\w+)\.style\.cssText\s*=\s*'position:absolute;width:0;height:0;border:none;'/g, to: `$1.classList.add('hidden-print-frame')` }
];
replaceJs(pJsPath, pJsStrReps, pJsRegexReps);

const rJsPath = 'public/js/recipes.js';
const rJsStrReps = [
    { from: `style="padding: 12px 15px;"`, to: `class="px-15 py-12"` },
    { from: `style="text-align: right; padding: 12px 15px;"`, to: `class="text-right px-15 py-12"` },
    { from: `class="input-modern" style="width: 80px; text-align: right; padding: 6px 10px; font-weight: bold; color: var(--primary);"`, to: `class="input-modern rec-table-input"` },
    { from: `style="text-align: center; padding: 12px 15px;"`, to: `class="text-center px-15 py-12"` },
    { from: `class="btn btn-outline" style="padding: 4px 8px; font-size: 13px; color: var(--danger); border-color: var(--danger);"`, to: `class="btn btn-outline rec-delete-btn"` },
    { from: `style="margin-bottom: 20px; font-size: 15px;"`, to: `class="mb-20 font-15"` },
    { from: `style="max-height: 480px; overflow-y: auto; padding-right: 10px;"`, to: `class="rec-modal-content"` },
    { from: `style="margin-bottom: 15px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.05);"`, to: `class="rec-acc-item"` },
    { from: `style="background: var(--surface-alt); padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;"`, to: `class="rec-acc-header"` },
    { from: `style="color: var(--primary); font-size: 14px;"`, to: `class="text-primary font-14"` },
    { from: `style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; margin: 0; cursor: pointer; color: var(--success);"`, to: `class="flex-row align-center gap-5 font-13 font-bold m-0 cursor-pointer text-success"` },
    { from: `style="width: 16px; height: 16px;"`, to: `class="w-16 h-16"` },
    { from: `style="padding: 15px; display: none; grid-template-columns: 1fr 1fr; gap: 12px; background: var(--surface);"`, to: `class="rec-acc-body hidden"` },
    { from: `style="display: flex; align-items: center; gap: 8px; cursor: pointer;"`, to: `class="flex-row align-center gap-5 cursor-pointer"` },
    { from: `style="width: 15px; height: 15px;"`, to: `class="w-16 h-16"` },
    { from: `style="font-size: 14px;"`, to: `class="font-14"` },
    { from: `style="padding: 0 20px;"`, to: `class="px-20"` },
    { from: `style="padding: 10px; font-size: 15px;"`, to: `class="p-10 font-15"` },
    { from: `class="btn btn-primary w-100" style="background: var(--danger); border-color: var(--danger);"`, to: `class="btn btn-primary w-100 rec-danger-btn"` },
    { from: `style="padding: 10px 0; font-size: 15px;"`, to: `class="py-10 font-15"` },
    { from: `style="font-size: 13px; margin-top: 15px; background: var(--surface-alt); padding: 15px 30px; border-radius: 6px; color: var(--text-main); max-height: 140px; overflow-y: auto; border: 1px dashed var(--border);"`, to: `class="rec-guidance-box"` },
    { from: `style="min-width: 140px;"`, to: `class="min-w-140"` },
    { from: `style="color: var(--danger); font-size: 13px;"`, to: `class="text-danger font-13"` },
    { from: `style="background: var(--surface-alt); padding: 15px; border-radius: 8px; margin-bottom: 20px;"`, to: `class="bg-surface-alt p-15 border-rounded mb-20"` },
    { from: `style="margin-top:0; font-weight:600; margin-bottom: 10px;"`, to: `class="m-0 font-600 mb-10"` },
    { from: `style="font-size:13px; color:var(--text-muted); margin-bottom:15px;"`, to: `class="font-13 text-muted mb-15"` },
    { from: `style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;"`, to: `class="rec-mini-grid"` },
    { from: `style="margin-bottom:0;"`, to: `class="m-0"` },
    { from: `style="font-size: 11px; font-weight: bold;"`, to: `class="font-11 font-bold"` },
    { from: `style="padding: 6px; font-size: 14px;"`, to: `class="p-5 font-14"` },
    { from: `style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;"`, to: `class="flex-between align-center mb-10"` },
    { from: `style="font-size: 15px;"`, to: `class="font-15"` },
    { from: `style="font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 5px;"`, to: `class="font-13 cursor-pointer flex-row align-center gap-5"` },
    { from: `style="max-height: 250px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--surface); display: flex; flex-direction: column; gap: 6px;"`, to: `class="rec-dropdown-list"` },
    { from: `style="font-size: 11px; color: var(--text-muted); margin-top: 10px;"`, to: `class="font-11 text-muted mt-10"` },
    { from: `style="color: var(--text-muted); padding: 10px; text-align: center;"`, to: `class="text-muted p-10 text-center"` },
    { from: `style="font-size: 13px; cursor: pointer; padding: 4px; border-bottom: 1px solid var(--border-light);"`, to: `class="font-13 cursor-pointer p-5 border-bottom"` }
];
const rJsRegexReps = [
    { from: /(\w+)\.style\.display\s*=\s*'none'/g, to: `$1.classList.add('hidden')` },
    { from: /(\w+)\.style\.display\s*=\s*'block'/g, to: `$1.classList.remove('hidden')` },
    { from: /(\w+)\.style\.display\s*=\s*'inline-block'/g, to: `$1.classList.remove('hidden')` },
    { from: /(\w+)\.style\.background\s*=\s*'var\(--border\)'/g, to: `$1.classList.add('bg-border'); $1.classList.remove('bg-warning', 'bg-success')` },
    { from: /(\w+)\.style\.color\s*=\s*'var\(--text-main\)'/g, to: `$1.classList.add('text-main'); $1.classList.remove('text-warning', 'text-success')` },
    { from: /(\w+)\.style\.background\s*=\s*'var\(--warning\)'/g, to: `$1.classList.add('bg-warning'); $1.classList.remove('bg-border', 'bg-success')` },
    { from: /(\w+)\.style\.color\s*=\s*'var\(--warning-text\)'/g, to: `$1.classList.add('text-warning'); $1.classList.remove('text-main', 'text-success')` },
    { from: /(\w+)\.style\.opacity\s*=\s*'0\.5'/g, to: `$1.classList.add('opacity-50')` },
    { from: /(\w+)\.style\.opacity\s*=\s*'1'/g, to: `$1.classList.remove('opacity-50')` }
];
replaceJs(rJsPath, rJsStrReps, rJsRegexReps);

console.log('Fixed phase 2 complete!');
