const fs = require('fs');

const css = `
/* ==========================================================================
   PRODUCTION & RECIPES REFACTORING (AUDIT-011) 
   ========================================================================== */

/* Layout & Utils */
.w-120 { width: 120px; }
.w-140 { width: 140px; }
.w-60 { width: 60px; }
.w-80 { width: 80px; }
.h-auto { height: auto; }
.w-12p { width: 12%; }
.w-13p { width: 13%; }
.w-15p { width: 15%; }
.w-30p { width: 30%; }
.italic { font-style: italic; }
.table-footer { display: table-footer-group; }
.table-cell { display: table-cell; }

/* Production Specific */
.prod-chart-bar-warning { border-color: var(--warning-text); color: var(--warning-text); }
.prod-chart-bar-primary { border-color: var(--primary); }
.prod-status-info { font-size: 16px; font-weight: bold; white-space: nowrap; margin-right: 5px; }
.prod-total-table-row { font-weight: bold; text-align: right; }
.prod-total-table-row td { border-bottom: 2px solid var(--border); }
.prod-print-col-hidden { display: none; width: 12%; } 

/* Recipes Specific */
.rec-filter-container { display: flex; gap: 15px; border-bottom: 2px solid var(--border); padding-bottom: 30px; margin-bottom: 30px; }
.rec-primary-outline { border-color: var(--primary); color: var(--primary); }
.rec-action-btn { font-weight: bold; border-radius: 8px; padding: 12px 24px; }
.rec-grid-header { grid-template-columns: 1fr 2fr; align-items: start; gap: 24px; }
.rec-section-title { border-left: 4px solid var(--primary); font-size: 16px; }
.rec-dash-box { background: var(--surface); padding: 12px; border-radius: 8px; border: 1px dashed var(--border); margin-top: 15px; }
.rec-step-header { font-size: 15px; font-weight: bold; padding-top: 10px; border-top: 1px dashed var(--border); }
.rec-step-footer { align-items: center; padding-bottom: 20px; border-bottom: 1px dashed var(--border); }
.rec-badge { padding: 6px 12px; font-size: 13px; font-weight: bold; border-radius: 6px; }
.rec-cost-panel { margin-top: 15px; margin-bottom: 25px; background: var(--surface-alt); padding: 20px; border-radius: 8px; }
.rec-cost-param { display: flex; gap: 15px; align-items: flex-end; flex-wrap: wrap; }
.rec-table-input { width: 80px; text-align: right; padding: 6px 10px; font-weight: bold; color: var(--primary); }
.rec-delete-btn { padding: 4px 8px; font-size: 13px; color: var(--danger); border-color: var(--danger); }
.rec-modal-content { max-height: 480px; overflow-y: auto; padding-right: 10px; }
.rec-acc-item { margin-bottom: 15px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
.rec-acc-header { background: var(--surface-alt); padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
.rec-acc-body { padding: 15px; grid-template-columns: 1fr 1fr; gap: 12px; background: var(--surface); }
.rec-danger-btn { background: var(--danger); border-color: var(--danger); color: white; }
.rec-guidance-box { font-size: 13px; margin-top: 15px; background: var(--surface-alt); padding: 15px 30px; border-radius: 6px; color: var(--text-main); max-height: 140px; overflow-y: auto; border: 1px dashed var(--border); }
.rec-mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rec-dropdown-list { max-height: 250px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--surface); display: flex; flex-direction: column; gap: 6px; }

/* Forms */
.input-left-rounded { border-radius: 8px 0 0 8px; }
.input-right-rounded { border-radius: 0 8px 8px 0; }
`;

fs.appendFileSync('public/css/modules.css', css);
console.log('modules.css updated for Phase 2');
