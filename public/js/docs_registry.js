;(function() {
﻿let allRegistryDocs = [];

async function loadDocsRegistry() {
    try {
        const tbody = document.getElementById('docs-registry-body') || document.getElementById('unique-registry-tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Загрузка реестра из базы...</td></tr>';

        const clInput = document.getElementById('clientFilter');
        const dsInput = document.getElementById('dateStart');
        const deInput = document.getElementById('dateEnd');

        const clientId = clInput ? clInput.value : '';
        const startDate = dsInput ? dsInput.value : '';
        const endDate = deInput ? deInput.value : '';

        const params = new URLSearchParams();
        if (clientId) params.append('clientId', clientId);
        if (startDate) params.append('startDate', startDate);
        if (endDate) params.append('endDate', endDate);

        const queryString = params.toString();
        const url = '/api/docs/registry' + (queryString ? `?${queryString}` : '');

        allRegistryDocs = await API.get(url);
        renderRegistryTable(allRegistryDocs);
    } catch (err) {
        console.error(err);
        if (typeof UI !== 'undefined' && UI.showError) UI.showError(err.message);
    }
}

function renderRegistryTable(data) {
    console.log('=> СТАРТ ФУНКЦИИ renderRegistryTable');
    console.log('=> INCOMING DATA:', data);

    const tbody = document.getElementById('unique-registry-tbody');

    if (!tbody) {
        console.error('🚨 ОШИБКА: Таблица не найдена! Элемент id="unique-registry-tbody" отсутствует в DOM!');
        alert('КРИТИЧЕСКАЯ ОШИБКА: Не могу найти таблицу с id="unique-registry-tbody" на странице.');
        return;
    }

    console.log('=> ТАБЛИЦА НАЙДЕНА УСПЕШНО. Элемент:', tbody);

    if (!Array.isArray(data) || data.length === 0) {
        console.log('=> ДАННЫЕ ПУСТЫ ИЛИ НЕ МАССИВ');
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Счета еще не выписывались или ошибка API</td></tr>';
        return;
    }

    const showCancelled = document.getElementById('toggle-cancelled-docs')?.checked || false;
    const docsToRender = showCancelled ? data : data.filter(d => d.status !== 'cancelled');

    if (docsToRender.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Нет документов, соответствующих фильтрам</td></tr>';
        return;
    }

    console.log('=> НАЧИНАЮ РЕНДЕР (Кол-во элементов:', docsToRender.length, ')');

    try {
        const htmlRows = docsToRender.map((doc, idx) => {
            console.log(`=> Отрисовка строки ${idx + 1}, ID документа: ${doc?.id}`);

            const createdAt = doc.created_at || doc.createdAt || doc.date || new Date();
            const docNumber = doc.doc_number || doc.number || doc.docNum || 'БЕЗ НОМЕРА';
            const totalAmount = doc.total_amount || doc.amount || doc.totalAmount || 0;
            const authorName = doc.author_name || doc.author || doc.authorName || 'Автогенерация';
            const isExported = doc.is_exported_1c || doc.isExported || false;

            const d = Utils.formatDate(createdAt);

            let clientName = 'Неизвестный контрагент';
            try {
                const snap = typeof doc.client_snapshot === 'string' ? JSON.parse(doc.client_snapshot) : doc.client_snapshot;
                if (snap) clientName = snap.name || snap.clientName || snap.client_name || clientName;
            } catch (e) { }

            const sum = Utils.formatMoney(Number(totalAmount));
            const stHtml = isExported
                ? '<span class="text-success font-bold">🟢 Выгружен</span>'
                : '<span class="text-muted">⚪ Не выгружен</span>';

            // Значение режима Нотариус
            const isLocked = doc.is_locked === true;
            
            // Если документ опечатан, добавляем замок и серый фон
            const lockIcon = isLocked 
                ? '<span title="Документ защищён режимом Нотариус. Изменения невозможны" class="docs-locked-icon mr-5">🔒</span>' 
                : '';
            let rowClasses = 'docs-tbl-row';
            if (isLocked) rowClasses += ' docs-locked-row';
            if (doc.status === 'cancelled') rowClasses += ' docs-cancelled-row';

            return `
                <tr class="${rowClasses}">
                    <td class="text-center"><input type="checkbox" class="doc-check" value="${doc.id || ''}" onchange="checkExportButtonState()"></td>
                    <td class="font-13">${d}</td>
                    <td class="font-bold text-primary">${lockIcon}${docNumber}</td>
                    <td>${clientName}</td>
                    <td class="text-right font-bold">${sum}</td>
                    <td class="font-12 text-muted">${authorName}</td>
                    <td class="text-center">${stHtml}</td>
                    <td class="text-center">
                        ${doc.status !== 'cancelled' ? `
                            <button class="btn-icon docs-delete-btn text-danger" onclick="deleteRegistryInvoice(${doc.id})" title="Удалить/Аннулировать">❌</button>
                        ` : ''}
                    </td>
                </tr>
            `;
        }).join('');
        
        // Гарантированный рендеринг в современных и старых браузерах
        tbody.innerHTML = '';
        tbody.insertAdjacentHTML('beforeend', htmlRows);
        
        checkExportButtonState();
    } catch (error) {
        console.error('Render Table Error:', error);
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Ошибка загрузки: ${Utils.escapeHtml(error.message)}</td></tr>`;
    }
}

// Старая клиентская фильтрация удалена в пользу серверной

function toggleAllRegistryChecks(masterCheckbox) {
    const checks = document.querySelectorAll('.doc-check');
    checks.forEach(c => c.checked = masterCheckbox.checked);
    checkExportButtonState();
}

function checkExportButtonState() {
    const checks = document.querySelectorAll('.doc-check:checked');
    const btn = document.getElementById('btn-export-1c');
    if (btn) {
        btn.disabled = checks.length === 0;
        btn.innerText = checks.length > 0
            ? `📥 Выгрузить в 1С (Выбрано: ${checks.length})`
            : '📥 Выгрузить выбранное в 1С (XML)';
    }
}

async function exportTo1C() {
    const checks = document.querySelectorAll('.doc-check:checked');
    if (checks.length === 0) return;

    const invoiceIds = Array.from(checks).map(c => parseInt(c.value)).filter(id => !isNaN(id));
    
    if (invoiceIds.length === 0) {
        alert('Ошибка: не удалось определить ID выбранных документов.');
        return;
    }

    try {
        const btn = document.getElementById('btn-export-1c');
        const originalText = btn.innerText;
        btn.innerText = '⏳ Генерация XML...';
        btn.disabled = true;

        // Используем нативный fetch для получения Blob (API.post возвращает JSON, не Blob)
        const rawRes = await fetch('/api/docs/export-1c', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceIds })
        });

        if (!rawRes.ok) {
            const errData = await rawRes.json().catch(() => ({}));
            throw new Error(errData.error || 'Ошибка сервера при генерации файла');
        }

        // Скачивание файла (Blob)
        const blob = await rawRes.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        
        // Достаем имя файла из заголовков, если есть
        const contentDisposition = rawRes.headers.get('Content-Disposition');
        let filename = 'export_1c.xml';
        if (contentDisposition && contentDisposition.includes('filename=')) {
            filename = contentDisposition.split('filename=')[1];
        }
        
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();

        if (typeof UI !== 'undefined' && UI.showSuccess) {
            UI.showSuccess('XML файл успешно сформирован и скачан!');
        }

        // Обновляем таблицу (чтобы статусы стали зелеными)
        await loadDocsRegistry();

    } catch (err) {
        console.error('Ошибка экспорта:', err);
        if (typeof UI !== 'undefined' && UI.showError) UI.showError(err.message);
        else alert('Ошибка экспорта: ' + err.message);
        
        // Восстанавливаем кнопку при ошибке
        const btn = document.getElementById('btn-export-1c');
        if (btn) {
            btn.innerText = '📥 Выгрузить в 1С (Ошибка)';
            btn.disabled = false;
        }
    }
}

// Инициализация модуля реестра при загрузке страницы
async function initRegistry() {
    try {
        // Загружаем список контрагентов для фильтра
        const counterparties = await API.get('/api/counterparties');
        
        if (!Array.isArray(counterparties)) {
            console.warn('=> ДАННЫЕ ПУСТЫ ИЛИ НЕ МАССИВ (контрагенты)');
            return;
        }

        if (true) {
            const clientSelect = document.getElementById('clientFilter');
            
            if (clientSelect) {
                // Сбрасываем опции, оставляя только "Все контрагенты"
                clientSelect.innerHTML = '<option value="">Все контрагенты</option>';
                
                if (!Array.isArray(counterparties)) {
                    console.error('КРИТИЧЕСКАЯ ОШИБКА: /api/counterparties вернул не массив!', counterparties);
                    return; 
                }

                // Наполняем селектор реальными данными из БД
                counterparties.forEach(c => {
                    const option = document.createElement('option');
                    // Предполагается, что бэкенд отдает { id: 1, name: 'ООО Ромашка' }
                    option.value = c.id; 
                    option.textContent = c.name;
                    clientSelect.appendChild(option);
                });
            }
        } else {
            console.warn('Не удалось получить список контрагентов');
        }
    } catch (err) {
        console.error('Ошибка при обращении к API контрагентов:', err);
    }

    // Инициализируем TomSelect для фильтра
    initStaticRegistrySelects();
    
    // Слушатель для чекбокса "Показывать аннулированные"
    const toggleCancelled = document.getElementById('toggle-cancelled-docs');
    if (toggleCancelled) {
        toggleCancelled.addEventListener('change', () => {
            renderRegistryTable(allRegistryDocs);
        });
    }

    // Вызываем первичную загрузку таблицы документов
    loadDocsRegistry();
}

function initStaticRegistrySelects() {
    const el = document.getElementById('clientFilter');
    if (el) {
        if (!el.tomselect) {
            new TomSelect(el, {
                plugins: ['clear_button'],
                dropdownParent: 'body',
                onChange: function(value) {
                    loadDocsRegistry();
                }
            });
        } else {
            el.tomselect.sync();
        }
    }
}

// Ждем построения DOM и запускаем инициализацию 
document.addEventListener('DOMContentLoaded', initRegistry);

window.deleteRegistryInvoice = async function(id) {
    UI.confirm('Вы уверены? Если это последний счет, он будет удален физически с откатом номера. Если нет — он будет аннулирован.', async () => {
        try {
            const data = await API.delete(`/api/invoices/${id}`);
            if (true) {
                UI.toast(data.action === 'deleted' ? 'Счет удален, номер откатан' : 'Счет аннулирован');
                // Вызываем обновление данных реестра
                if (typeof loadDocsRegistry === 'function') loadDocsRegistry();
            } else {
                UI.toast(data.error || 'Ошибка удаления', 'error');
            }
        } catch (e) {
            
        }
    });
};



    // === ГЛОБАЛЬНЫЙ ЭКСПОРТ ===
    if (typeof loadDocsRegistry === 'function') window.loadDocsRegistry = loadDocsRegistry;
    if (typeof renderRegistryTable === 'function') window.renderRegistryTable = renderRegistryTable;
    if (typeof toggleAllRegistryChecks === 'function') window.toggleAllRegistryChecks = toggleAllRegistryChecks;
    if (typeof checkExportButtonState === 'function') window.checkExportButtonState = checkExportButtonState;
    if (typeof exportTo1C === 'function') window.exportTo1C = exportTo1C;
    if (typeof initRegistry === 'function') window.initRegistry = initRegistry;
    if (typeof initStaticRegistrySelects === 'function') window.initStaticRegistrySelects = initStaticRegistrySelects;
})();
