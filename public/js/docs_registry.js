let allRegistryDocs = [];

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

        const res = await fetch(url);
        if (!res.ok) throw new Error('Ошибка загрузки реестра документов');

        allRegistryDocs = await res.json();
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

            const d = new Date(createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

            let clientName = 'Неизвестный контрагент';
            try {
                const snap = typeof doc.client_snapshot === 'string' ? JSON.parse(doc.client_snapshot) : doc.client_snapshot;
                if (snap) clientName = snap.name || snap.clientName || snap.client_name || clientName;
            } catch (e) { }

            const sum = Number(totalAmount).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
            const stHtml = isExported
                ? '<span style="color: var(--success); font-weight: bold;">🟢 Выгружен</span>'
                : '<span style="color: var(--text-muted);">⚪ Не выгружен</span>';

            // Значение режима Нотариус
            const isLocked = doc.is_locked === true;
            
            // Если документ опечатан, добавляем замок и серый фон
            const lockIcon = isLocked 
                ? '<span title="Документ защищён режимом Нотариус. Изменения невозможны" style="cursor: help; margin-right: 5px;">🔒</span>' 
                : '';
            let rowStyle = isLocked ? 'background-color: #f7f7f7; color: #555;' : '';
            if (doc.status === 'cancelled') {
                rowStyle += ' color: #94a3b8; text-decoration: line-through; opacity: 0.7;';
            }

            return `
                <tr style="${rowStyle}">
                    <td class="text-center"><input type="checkbox" class="doc-check" value="${doc.id || ''}" onchange="checkExportButtonState()"></td>
                    <td style="font-size: 13px;">${d}</td>
                    <td style="font-weight: bold; color: var(--primary);">${lockIcon}${docNumber}</td>
                    <td>${clientName}</td>
                    <td class="text-right" style="font-weight: bold;">${sum}</td>
                    <td style="font-size: 12px; color: var(--text-muted);">${authorName}</td>
                    <td class="text-center">${stHtml}</td>
                    <td style="text-align: center;">
                        ${doc.status !== 'cancelled' ? `
                            <button class="btn-icon" onclick="deleteRegistryInvoice(${doc.id})" title="Удалить/Аннулировать" style="color: var(--danger); cursor: pointer; background: none; border: none; font-size: 14px;">❌</button>
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
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Ошибка отрисовки: ${error.message}</td></tr>`;
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

        const res = await fetch('/api/docs/export-1c', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceIds })
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Ошибка сервера при генерации файла');
        }

        // Скачивание файла (Blob)
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        
        // Достаем имя файла из заголовков, если есть
        const contentDisposition = res.headers.get('Content-Disposition');
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
        const res = await fetch('/api/counterparties');
        
        if (res.ok) {
            const counterparties = await res.json();
            const clientSelect = document.getElementById('clientFilter');
            
            if (clientSelect) {
                // Сбрасываем опции, оставляя только "Все контрагенты"
                clientSelect.innerHTML = '<option value="">Все контрагенты</option>';
                
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
            const res = await fetch(`/api/invoices/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) {
                UI.toast(data.action === 'deleted' ? 'Счет удален, номер откатан' : 'Счет аннулирован');
                // Вызываем обновление данных реестра
                if (typeof loadDocsRegistry === 'function') loadDocsRegistry();
            } else {
                UI.toast(data.error || 'Ошибка удаления', 'error');
            }
        } catch (e) {
            UI.toast('Ошибка сети', 'error');
        }
    });
};
