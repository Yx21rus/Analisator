// ============================================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ============================================================
var pathsToScan = [];
var multipleDataStore = {};
var currentPathId = null;

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function formatSize(bytes) {
    if (!bytes) return '0 Б';
    if (bytes >= 1024**3) return (bytes / (1024**3)).toFixed(2) + ' ГБ';
    if (bytes >= 1024**2) return (bytes / (1024**2)).toFixed(2) + ' МБ';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' КБ';
    return bytes + ' Б';
}

function showToast(message, type) {
    type = type || 'info';
    var container = document.getElementById('toastContainer');
    var colors = { success: '#2ECC71', error: '#E74C3C', warning: '#F39C12', info: '#0d6efd' };
    var toast = document.createElement('div');
    toast.className = 'toast-custom';
    toast.style.borderLeftColor = colors[type] || colors.info;
    toast.innerHTML = `
        <div class="d-flex justify-content-between align-items-center">
            <span>${message}</span>
            <button class="btn btn-sm btn-link text-dark" onclick="this.parentElement.parentElement.remove()">
                <i class="bi bi-x-lg"></i>
            </button>
        </div>
    `;
    container.appendChild(toast);
    setTimeout(function() {
        if (toast.parentElement) {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100px)';
            setTimeout(function() { toast.remove(); }, 300);
        }
    }, 4000);
}

function normalizeUncPath(path) {
    if (!path) return path;
    path = path.trim();
    if (path.startsWith('\\') && !path.startsWith('\\\\')) {
        path = '\\' + path;
    }
    path = path.replace(/\\\\\\\\/g, '\\\\');
    path = path.replace(/\\\\\\/g, '\\\\');
    if (path.startsWith('\\\\')) {
        var parts = path.split('\\').filter(function(p) { return p !== ''; });
        if (parts.length >= 2) {
            var server = parts[0];
            var share = parts[1];
            var rest = parts.slice(2).join('\\');
            if (rest) {
                path = '\\\\' + server + '\\' + share + '\\' + rest;
            } else {
                path = '\\\\' + server + '\\' + share;
            }
        }
    }
    return path;
}

// ============================================================
// УПРАВЛЕНИЕ ПУТЯМИ
// ============================================================

function addPath() {
    var input = document.getElementById('pathInput');
    var path = input.value.trim();
    if (!path) { showToast('Введите путь', 'warning'); return; }
    path = normalizeUncPath(path);
    if (pathsToScan.indexOf(path) !== -1) { showToast('Путь уже добавлен', 'warning'); return; }
    pathsToScan.push(path);
    input.value = '';
    updatePathTags();
    showToast('Добавлен путь: ' + path, 'success');
}

function removePath(path) {
    pathsToScan = pathsToScan.filter(function(p) { return p !== path; });
    updatePathTags();
}

function updatePathTags() {
    var container = document.getElementById('pathTags');
    var btn = document.getElementById('scanBtn');
    var info = document.getElementById('pathCountInfo');
    if (pathsToScan.length === 0) {
        container.innerHTML = '<div class="empty-paths">Нет добавленных путей</div>';
        btn.disabled = true;
        info.textContent = 'Добавьте путь для сканирования';
        return;
    }
    var html = '';
    pathsToScan.forEach(function(p) {
        var escapedPath = p.replace(/\\/g, '\\\\');
        html += '<span class="path-tag">' +
            p +
            '<span class="remove-path" onclick="removePath(\'' + escapedPath + '\')">&times;</span>' +
        '</span>';
    });
    container.innerHTML = html;
    btn.disabled = false;
    info.textContent = 'Готово: ' + pathsToScan.length + ' путь(ей)';
}

document.getElementById('pathInput').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); addPath(); }
});

// ============================================================
// API ВЫЗОВЫ
// ============================================================

function loadPaths() {
    fetch('/api/paths')
        .then(function(r) { return r.json(); })
        .then(function(paths) {
            var container = document.getElementById('pathsList');
            if (paths.length === 0) {
                container.innerHTML = '<div class="text-center text-muted py-4"><i class="bi bi-inbox" style="font-size:2rem;"></i><p class="mt-2">Нет сохраненных сканирований</p></div>';
                return;
            }
            var html = '<div class="list-group">';
            paths.slice(-5).forEach(function(p) {
                var escapedPath = p.path.replace(/\\/g, '\\\\');
                html += '<div class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="openReport(\'' + escapedPath + '\')" style="cursor:pointer;">' +
                    '<div><i class="bi bi-folder"></i> <strong>' + p.path + '</strong></div>' +
                    '<span class="badge bg-primary">' + p.disk + '</span>' +
                '</div>';
            });
            html += '</div>';
            container.innerHTML = html;
        })
        .catch(function(e) { console.error('Ошибка:', e); });
}

function scanSinglePath(path) {
    var normalizedPath = normalizeUncPath(path);
    console.log('📤 Отправка пути:', normalizedPath);
    return fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function(response) {
        if (!response.ok) {
            return response.json().then(function(err) { throw new Error(err.error || 'Ошибка сервера'); });
        }
        return response.json();
    })
    .then(function(data) {
        if (data.error) throw new Error(data.error);
        return data;
    });
}

function browseFromDB(path) {
    var normalizedPath = normalizeUncPath(path);
    console.log('📤 Просмотр из БД:', normalizedPath);
    return fetch('/api/browse_from_db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function(response) {
        if (!response.ok) {
            return response.json().then(function(err) { throw new Error(err.error || 'Ошибка сервера'); });
        }
        return response.json();
    })
    .then(function(data) {
        if (data.error) throw new Error(data.error);
        return data;
    });
}

function getChartFromDB(path) {
    var normalizedPath = normalizeUncPath(path);
    console.log('📊 Запрос графика из БД для:', normalizedPath);
    return fetch('/api/parent_data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function(response) {
        if (!response.ok) {
            return response.json().then(function(err) { throw new Error(err.error || 'Ошибка сервера'); });
        }
        return response.json();
    })
    .then(function(data) {
        if (data.error) throw new Error(data.error);
        return data;
    });
}

// ============================================================
// РЕНДЕРИНГ ГРАФИКОВ
// ============================================================

function renderChart(chartData, divId, pathId) {
    var div = document.getElementById(divId);
    if (!div) return;
    
    if (!chartData) {
        div.innerHTML = `
            <div class="text-center text-muted py-3">
                <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                <p style="font-size:0.9rem;">Нет данных для графика</p>
                <small>Нужно минимум 2 сканирования</small>
            </div>
        `;
        return;
    }
    
    try {
        var data = typeof chartData === 'string' ? JSON.parse(chartData) : chartData;
        
        if (data && data.data && Array.isArray(data.data)) {
            var plotId = div.id || divId;
            Plotly.purge(plotId);
            
            var traces = data.data;
            
            // Исправляем hovertemplate для всех трейсов
            traces.forEach(function(trace, index) {
                if (trace.hovertemplate && trace.hovertemplate.indexOf('%{fullData.') !== -1) {
                    var folderName = trace.name || 'Папка ' + (index + 1);
                    trace.hovertemplate = trace.hovertemplate.replace(/%\{fullData\.[^}]+\}/g, folderName);
                }
                if (trace.hovertemplate && trace.hovertemplate.indexOf('%{fullData.fullName}') !== -1) {
                    var folderName = trace.name || 'Папка ' + (index + 1);
                    trace.hovertemplate = trace.hovertemplate.replace('%{fullData.fullName}', folderName);
                }
            });
            
            var layout = data.layout || {};
            layout.height = 350;
            layout.margin = { l: 50, r: 20, t: 40, b: 60 };
            layout.responsive = true;
            
            Plotly.newPlot(plotId, traces, layout, { 
                responsive: true,
                displaylogo: false,
                modeBarButtonsToRemove: ['toImage', 'sendDataToCloud']
            });
            return;
        }
    } catch (e) {
        console.log('📊 Ошибка парсинга графика:', e);
    }
    
    if (typeof chartData === 'string' && chartData.startsWith('iVBOR')) {
        div.innerHTML = '<img src="data:image/png;base64,' + chartData + '" class="img-fluid" style="width:100%;max-height:350px;">';
        return;
    }
    
    div.innerHTML = `
        <div class="text-center text-muted py-3">
            <i class="bi bi-exclamation-triangle" style="font-size:2rem;display:block;margin-bottom:6px;color:#f39c12;"></i>
            <p style="font-size:0.9rem;">Не удалось загрузить график</p>
        </div>
    `;
}

function scrollHistogram(scrollId, amount) {
    var wrapper = document.getElementById('scrollWrapper_' + scrollId);
    if (wrapper) {
        wrapper.scrollLeft += amount;
    }
}

// ============================================================
// ГИСТОГРАММА - ИСПРАВЛЕННАЯ ВЕРСИЯ
// ============================================================

function renderHistogram(historyData, divId, path, level, pathId) {
    var div = document.getElementById(divId);
    if (!div) {
        console.error('❌ Div для гистограммы не найден:', divId);
        return;
    }
    
    console.log('📊 renderHistogram для', pathId, 'уровень', level, 'данных:', historyData ? historyData.length : 0);
    
    if (!historyData || historyData.length === 0) {
        div.innerHTML = `
            <div class="text-center text-muted py-3">
                <i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                <p style="font-size:0.9rem;">Нет данных для гистограммы</p>
                <small>Нужно минимум 2 сканирования</small>
            </div>
        `;
        return;
    }
    
    // ================================================================
    // 1. Получаем все уникальные даты
    // ================================================================
    var allDates = [];
    historyData.forEach(function(item) {
        if (allDates.indexOf(item.date) === -1) {
            allDates.push(item.date);
        }
    });
    allDates.sort();
    
    // ================================================================
    // 2. Получаем все уникальные папки, сортируем по размеру
    // ================================================================
    var allFolderNames = [];
    historyData.forEach(function(item) {
        if (allFolderNames.indexOf(item.name) === -1) {
            allFolderNames.push(item.name);
        }
    });
    
    var folderAvgSizes = allFolderNames.map(function(name) {
        var total = 0, count = 0;
        historyData.forEach(function(item) {
            if (item.name === name) {
                total += item.size_gb;
                count++;
            }
        });
        return { name: name, avg: count > 0 ? total / count : 0 };
    });
    folderAvgSizes.sort(function(a, b) { return b.avg - a.avg; });
    var sortedFolderNames = folderAvgSizes.map(function(f) { return f.name; });
    
    // ================================================================
    // 3. Цвета для каждой папки
    // ================================================================
    var folderColors = {
        'colors': [
            '#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6', 
            '#1ABC9C', '#E67E22', '#2980B9', '#27AE60', '#C0392B',
            '#8E44AD', '#16A085', '#D35400', '#2C3E50', '#7F8C8D',
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
        ]
    };
    
    var folderColorMap = {};
    sortedFolderNames.forEach(function(name, index) {
        folderColorMap[name] = folderColors.colors[index % folderColors.colors.length];
    });
    
    // ================================================================
    // 4. Формируем данные для Plotly
    // ================================================================
    var traces = [];
    var maxHeight = 0;
    var barWidth = 0.6;
    
    var folderCount = sortedFolderNames.length;
    if (folderCount > 10) {
        barWidth = 0.5;
    }
    if (folderCount > 20) {
        barWidth = 0.4;
    }
    if (folderCount > 30) {
        barWidth = 0.3;
    }
    
    sortedFolderNames.forEach(function(folderName) {
        var values = [];
        var dates = [];
        var customData = [];
        
        allDates.forEach(function(date) {
            var found = null;
            historyData.forEach(function(item) {
                if (item.date === date && item.name === folderName) {
                    found = item;
                }
            });
            
            var dateObj = new Date(date);
            var day = String(dateObj.getDate()).padStart(2, '0');
            var month = String(dateObj.getMonth() + 1).padStart(2, '0');
            var year = dateObj.getFullYear();
            var hours = String(dateObj.getHours()).padStart(2, '0');
            var minutes = String(dateObj.getMinutes()).padStart(2, '0');
            var formattedDate = day + '.' + month + '.' + year + ' ' + hours + ':' + minutes;
            
            dates.push(formattedDate);
            var val = found ? found.size_gb : 0;
            values.push(val);
            customData.push(folderName);
            if (val > maxHeight) maxHeight = val;
        });
        
        var displayName = folderName;
        if (displayName.length > 15) {
            displayName = displayName.substring(0, 12) + '...';
        }
        
        traces.push({
            x: dates,
            y: values,
            name: displayName,
            type: 'bar',
            customdata: customData,
            marker: {
                color: folderColorMap[folderName] || '#95A5A6',
                line: {
                    color: 'rgba(255,255,255,0.8)',
                    width: 1
                }
            },
            text: values.map(function(v) {
                return v > 0 ? displayName + '\n' + v.toFixed(2) + ' ГБ' : '';
            }),
            textposition: 'outside',
            textfont: {
                size: Math.max(9, Math.min(12, 14 - folderCount * 0.15)),
                color: '#2d3436',
                weight: 'bold'
            },
            // ================================================================
            // ИСПРАВЛЕННЫЙ hovertemplate - используем %{customdata}
            // ================================================================
            hovertemplate: '<b>%{customdata}</b><br>📅 %{x}<br>📊 Размер: %{y:.2f} ГБ<extra></extra>',
            width: barWidth,
            showlegend: true
        });
    });
    
    var pathName = path.split('\\').pop() || path;
    var levelText = level === 1 ? 'Уровень 1' : 'Уровень 2';
    
    // ================================================================
    // 5. РАСЧЕТ ШИРИНЫ
    // ================================================================
    var totalWidthPerDate = sortedFolderNames.length * barWidth;
    var gapBetweenDates = totalWidthPerDate * 0.3;
    
    var minWidth = 900;
    var calculatedWidth = allDates.length * (totalWidthPerDate + gapBetweenDates) + 120;
    var plotWidth = Math.max(minWidth, calculatedWidth);
    
    var parentWidth = div.parentElement ? div.parentElement.clientWidth : 0;
    if (parentWidth > 0 && parentWidth > plotWidth) {
        plotWidth = parentWidth - 20;
    }
    
    if (sortedFolderNames.length > 15 || allDates.length > 10) {
        plotWidth = Math.max(plotWidth, 1400);
    }
    if (sortedFolderNames.length > 25 || allDates.length > 15) {
        plotWidth = Math.max(plotWidth, 1800);
    }
    
    console.log('📊 Ширина гистограммы:', plotWidth, 'px, папок:', sortedFolderNames.length, 'дат:', allDates.length);
    
    var scrollId = divId + '_' + pathId;
    
    var layout = {
        title: {
            text: '📊 Динамика размера папок по времени<br><span style="font-size:11px;font-weight:normal;">' + pathName + ' (' + levelText + ') | Папок: ' + sortedFolderNames.length + ' | Дат: ' + allDates.length + '</span>',
            font: { size: 14, weight: 'bold' }
        },
        xaxis: {
            title: 'Дата и время сканирования',
            titlefont: { size: 12 },
            tickangle: -45,
            tickfont: { size: 10 },
            gridcolor: '#f0f0f0',
            type: 'category',
            automargin: true
        },
        yaxis: {
            title: 'Размер (ГБ)',
            titlefont: { size: 12 },
            gridcolor: '#e9ecef',
            tickformat: '.2f',
            zeroline: true,
            zerolinecolor: '#dee2e6',
            zerolinewidth: 1,
            range: [0, maxHeight * 1.3 || 1]
        },
        barmode: 'group',
        bargap: 0.3,
        bargroupgap: 0.05,
        height: 450,
        width: plotWidth,
        margin: { l: 60, r: 180, t: 60, b: 120 },
        plot_bgcolor: '#f8f9fa',
        paper_bgcolor: 'white',
        responsive: false,
        hovermode: 'closest',
        legend: {
            orientation: 'v',
            x: 1.02,
            y: 1,
            xanchor: 'left',
            yanchor: 'top',
            bgcolor: 'rgba(255,255,255,0.95)',
            bordercolor: '#ddd',
            borderwidth: 1,
            font: { size: Math.max(9, Math.min(11, 14 - folderCount * 0.1)), weight: 'bold' },
            itemsizing: 'constant',
            itemwidth: 80,
            traceorder: 'normal',
            itemclick: 'toggle',
            itemdoubleclick: 'toggleothers'
        }
    };
    
    // ================================================================
    // 6. Рендерим с оберткой для скролла
    // ================================================================
    div.innerHTML = '';
    
    var wrapper = document.createElement('div');
    wrapper.className = 'histogram-scroll-wrapper';
    wrapper.id = 'scrollWrapper_' + scrollId;
    wrapper.style.cssText = `
        width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        position: relative;
        background: white;
        border-radius: 8px;
        border: 1px solid #e9ecef;
        padding: 5px 0;
    `;
    
    var inner = document.createElement('div');
    inner.className = 'histogram-inner';
    inner.id = 'histogramInner_' + scrollId;
    inner.style.cssText = `
        min-width: 100%;
        width: auto;
        padding: 5px 0;
        display: inline-block;
    `;
    
    wrapper.appendChild(inner);
    div.appendChild(wrapper);
    
    // ================================================================
    // 7. Индикатор скролла
    // ================================================================
    var indicator = document.createElement('div');
    indicator.className = 'scroll-indicator';
    indicator.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 12px;
        font-size: 0.75rem;
        color: #495057;
        background: #f8f9fa;
        border-radius: 0 0 8px 8px;
        border-top: 1px solid #e9ecef;
        flex-wrap: wrap;
        gap: 6px;
    `;
    
    var totalBars = sortedFolderNames.length * allDates.length;
    var hasManyData = totalBars > 50;
    
    indicator.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span class="scroll-arrow" onclick="scrollHistogram('${scrollId}', -400)" 
                  style="cursor:pointer;padding:2px 10px;border-radius:4px;user-select:none;background:#e9ecef;font-size:1.1rem;">
                <i class="bi bi-chevron-left"></i>
            </span>
            <span style="display:flex;align-items:center;gap:6px;">
                <i class="bi bi-arrows-expand" style="color:#6c757d;"></i>
                <span class="scroll-info">Прокрутите для просмотра</span>
                ${hasManyData ? '<span class="badge bg-warning text-dark" style="font-size:0.6rem;">Много данных</span>' : ''}
            </span>
            <span class="scroll-arrow" onclick="scrollHistogram('${scrollId}', 400)" 
                  style="cursor:pointer;padding:2px 10px;border-radius:4px;user-select:none;background:#e9ecef;font-size:1.1rem;">
                <i class="bi bi-chevron-right"></i>
            </span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;font-size:0.7rem;flex-wrap:wrap;">
            <span style="color:#6c757d;">
                <i class="bi bi-folder"></i> ${sortedFolderNames.length} папок
            </span>
            <span style="color:#6c757d;">
                <i class="bi bi-calendar"></i> ${allDates.length} дат
            </span>
            <span style="color:#6c757d;">
                <i class="bi bi-grid"></i> ${totalBars} столбцов
            </span>
            <span style="color:#6c757d;margin-left:8px;font-style:italic;">
                👆 Клик по легенде - скрыть/показать
            </span>
        </div>
    `;
    div.appendChild(indicator);
    
    // ================================================================
    // 8. Рендерим график
    // ================================================================
    try {
        var plotDiv = document.getElementById('histogramInner_' + scrollId);
        if (plotDiv) {
            Plotly.purge(plotDiv);
            Plotly.newPlot(plotDiv, traces, layout, {
                responsive: false,
                displaylogo: false,
                modeBarButtonsToRemove: ['toImage', 'sendDataToCloud']
            });
        }
    } catch(e) {
        console.error('❌ Ошибка рендеринга гистограммы:', e);
        div.innerHTML = `
            <div class="text-center text-muted py-3">
                <i class="bi bi-exclamation-triangle" style="font-size:2rem;display:block;margin-bottom:6px;color:#f39c12;"></i>
                <p style="font-size:0.9rem;">Ошибка отображения гистограммы</p>
                <small>${e.message}</small>
            </div>
        `;
    }
}

// ============================================================
// ФУНКЦИЯ ЗАГРУЗКИ ГРАФИКОВ ИЗ БД
// ============================================================

function loadChartsFromDB(pathId, path) {
    console.log('🔄 Загрузка графиков из БД для:', pathId, path);
    
    var store = multipleDataStore[pathId];
    if (!store) {
        console.error('❌ Store не найден для pathId:', pathId);
        return;
    }
    
    getChartFromDB(path)
        .then(function(data) {
            console.log('📊 Получены данные из БД для:', path);
            console.log('📊 histogram_data:', data.histogram_data ? data.histogram_data.length : 0);
            
            if (data.scans_count > 0) {
                store.scansCount = data.scans_count;
            }
            
            // ГРАФИК УРОВНЯ 1
            if (data.chart) {
                renderChart(data.chart, 'level1ChartDiv_' + pathId, pathId);
            } else {
                var chartDiv = document.getElementById('level1ChartDiv_' + pathId);
                if (chartDiv) {
                    chartDiv.innerHTML = `
                        <div class="text-center text-muted py-3">
                            <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                            <p style="font-size:0.9rem;">Нет данных для графика</p>
                            <small>Нужно минимум 2 сканирования</small>
                        </div>
                    `;
                }
            }
            
            // ГИСТОГРАММА УРОВНЯ 1
            if (data.histogram_data && data.histogram_data.length > 0) {
                renderHistogram(data.histogram_data, 'level1HistogramDiv_' + pathId, path, 1, pathId);
            } else {
                var histDiv = document.getElementById('level1HistogramDiv_' + pathId);
                if (histDiv) {
                    histDiv.innerHTML = `
                        <div class="text-center text-muted py-3">
                            <i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                            <p style="font-size:0.9rem;">Нет данных для гистограммы</p>
                            <small>Нужно минимум 2 сканирования</small>
                        </div>
                    `;
                }
            }
            
            // ГРАФИКИ УРОВНЯ 2 - если активен
            var level2Section = document.getElementById('level2Section_' + pathId);
            if (level2Section && level2Section.classList.contains('active')) {
                var currentPath = store.currentPath;
                if (currentPath && currentPath !== path) {
                    console.log('📊 Загрузка данных для уровня 2:', currentPath);
                    
                    getChartFromDB(currentPath)
                        .then(function(data2) {
                            console.log('📊 Получены данные уровня 2 для:', currentPath);
                            console.log('📊 histogram_data уровня 2:', data2.histogram_data ? data2.histogram_data.length : 0);
                            
                            if (data2.chart) {
                                renderChart(data2.chart, 'level2ChartDiv_' + pathId, pathId);
                            } else {
                                var chartDiv2 = document.getElementById('level2ChartDiv_' + pathId);
                                if (chartDiv2) {
                                    chartDiv2.innerHTML = `
                                        <div class="text-center text-muted py-3">
                                            <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                                            <p style="font-size:0.9rem;">Нет данных для графика</p>
                                            <small>Нужно минимум 2 сканирования</small>
                                        </div>
                                    `;
                                }
                            }
                            
                            if (data2.histogram_data && data2.histogram_data.length > 0) {
                                renderHistogram(data2.histogram_data, 'level2HistogramDiv_' + pathId, currentPath, 2, pathId);
                            } else {
                                var histDiv2 = document.getElementById('level2HistogramDiv_' + pathId);
                                if (histDiv2) {
                                    histDiv2.innerHTML = `
                                        <div class="text-center text-muted py-3">
                                            <i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                                            <p style="font-size:0.9rem;">Нет данных для гистограммы</p>
                                            <small>Нужно минимум 2 сканирования</small>
                                        </div>
                                    `;
                                }
                            }
                            
                            if (data2.folders && data2.folders.length > 0) {
                                store.items = data2.folders;
                            }
                        })
                        .catch(function(e) {
                            console.error('❌ Ошибка загрузки уровня 2:', e);
                            var histDiv2 = document.getElementById('level2HistogramDiv_' + pathId);
                            if (histDiv2) {
                                histDiv2.innerHTML = `
                                    <div class="text-center text-muted py-3">
                                        <i class="bi bi-exclamation-triangle" style="font-size:2rem;display:block;margin-bottom:6px;color:#f39c12;"></i>
                                        <p style="font-size:0.9rem;">Ошибка загрузки данных</p>
                                        <small>${e.message}</small>
                                    </div>
                                `;
                            }
                        });
                }
            }
            
            showToast('📊 Графики обновлены из БД', 'success');
        })
        .catch(function(e) {
            console.error('❌ Ошибка загрузки графиков:', e);
            showToast('❌ Ошибка загрузки графиков: ' + e.message, 'error');
        });
}

// ============================================================
// БОКОВАЯ ПАНЕЛЬ
// ============================================================

function buildFolderTree(pathId, folders, rootPath, currentPath, level) {
    var container = document.getElementById('folderTreeContainer_' + pathId);
    if (!container) {
        var mainContainer = document.getElementById('folderTreeContainer');
        if (!mainContainer) return;
        
        var section = document.createElement('div');
        section.id = 'folderTreeSection_' + pathId;
        section.className = 'folder-tree-section';
        
        var header = document.createElement('div');
        header.className = 'folder-tree-header';
        header.innerHTML = `
            <span><i class="bi bi-folder"></i> <span class="path-text" title="${rootPath}">${rootPath}</span></span>
            <span class="badge bg-secondary">${folders ? folders.length : 0}</span>
        `;
        section.appendChild(header);
        
        var treeContainer = document.createElement('div');
        treeContainer.id = 'folderTreeContainer_' + pathId;
        treeContainer.className = 'folder-tree-content';
        section.appendChild(treeContainer);
        
        mainContainer.appendChild(section);
        container = treeContainer;
    }
    
    if (!folders || folders.length === 0) {
        container.innerHTML = `
            <div class="empty-sidebar" style="padding:8px;font-size:0.8rem;color:#6c757d;">
                <i class="bi bi-folder" style="font-size:1.2rem;display:block;margin-bottom:4px;"></i>
                Нет папок
            </div>
        `;
        return;
    }
    
    var sortedFolders = [...folders].sort(function(a, b) {
        return (b.size || b.size_bytes || 0) - (a.size || a.size_bytes || 0);
    });
    
    var html = '<ul class="folder-tree" style="list-style:none;padding:0;margin:0;">';
    
    sortedFolders.forEach(function(f) {
        var folderPath = rootPath + '\\' + f.name;
        var isActive = (folderPath === currentPath);
        var sizeStr = f.size_str || formatSize(f.size || f.size_bytes || 0);
        var levelClass = level === 0 ? 'level1' : 'level2';
        var levelLabel = level === 0 ? 'L1' : 'L2';
        var iconColor = level === 0 ? '#fd7e14' : '#0d6efd';
        
        html += `
            <li style="padding:0;">
                <div class="folder-item ${isActive ? 'active' : ''}" 
                     onclick="browseFolderFromSidebar('${pathId}', '${encodeURIComponent(folderPath)}')"
                     title="${f.name}"
                     style="display:flex;align-items:center;padding:3px 8px;border-radius:4px;cursor:pointer;transition:background 0.15s;font-size:0.82rem;gap:6px;${isActive ? 'background:#cce5ff;font-weight:600;' : ''}">
                    <i class="bi bi-folder folder-icon" style="color:${iconColor};font-size:0.85rem;"></i>
                    <span class="folder-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
                    <span class="level-badge-sm ${levelClass}" style="font-size:0.55rem;padding:1px 6px;border-radius:10px;background:${level === 0 ? '#fd7e14' : '#0d6efd'};color:white;">${levelLabel}</span>
                    <span class="folder-size" style="font-size:0.65rem;color:#6c757d;background:#f1f3f5;padding:1px 6px;border-radius:10px;">${sizeStr}</span>
                </div>
            </li>
        `;
    });
    
    html += '</ul>';
    container.innerHTML = html;
    
    var section = document.getElementById('folderTreeSection_' + pathId);
    if (section) {
        var header = section.querySelector('.folder-tree-header');
        if (header) {
            var badge = header.querySelector('.badge');
            if (badge) {
                badge.textContent = folders.length;
            }
        }
    }
}

function updateSidebar() {
    var container = document.getElementById('folderTreeContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    var totalFolders = 0;
    var pathIds = Object.keys(multipleDataStore);
    
    if (pathIds.length === 0) {
        container.innerHTML = `
            <div class="empty-sidebar">
                <i class="bi bi-folder" style="font-size:2rem;display:block;margin-bottom:10px;"></i>
                Нет папок для отображения
            </div>
        `;
        document.getElementById('folderCountBadge').textContent = '0';
        return;
    }
    
    pathIds.sort();
    
    pathIds.forEach(function(pathId) {
        var store = multipleDataStore[pathId];
        if (!store) return;
        
        var folders = store.baseFolders || [];
        var rootPath = store.rootPath || '';
        var currentPath = store.currentPath || rootPath;
        
        var section = document.createElement('div');
        section.id = 'folderTreeSection_' + pathId;
        section.className = 'folder-tree-section';
        
        var header = document.createElement('div');
        header.className = 'folder-tree-header';
        header.innerHTML = `
            <span><i class="bi bi-folder"></i> <span class="path-text" title="${rootPath}">${rootPath}</span></span>
            <span class="badge bg-secondary">${folders ? folders.length : 0}</span>
        `;
        section.appendChild(header);
        
        var treeContainer = document.createElement('div');
        treeContainer.id = 'folderTreeContainer_' + pathId;
        treeContainer.className = 'folder-tree-content';
        section.appendChild(treeContainer);
        
        container.appendChild(section);
        
        buildFolderTree(pathId, folders, rootPath, currentPath, 0);
        
        totalFolders += folders ? folders.length : 0;
    });
    
    document.getElementById('folderCountBadge').textContent = totalFolders;
}

function browseFolderFromSidebar(pathId, encodedPath) {
    var path = decodeURIComponent(encodedPath);
    console.log('📂 Переход из сайдбара:', pathId, path);
    browseFolderMultipleDB(pathId, path);
}

// ============================================================
// РЕНДЕРИНГ СПИСКОВ ПАПОК
// ============================================================

function buildNavigationHTML(pathId, currentPathName, rootPath) {
    var store = multipleDataStore[pathId];
    if (!store) return '';
    
    var parts = currentPathName.split('\\');
    var html = '';
    
    if (store.history && store.history.length > 0) {
        html += '<button class="btn-back" onclick="goBackMultiple(\'' + pathId + '\')"><i class="bi bi-arrow-left"></i> Назад</button>';
    }
    
    if (currentPathName !== rootPath && rootPath) {
        if (html) html += '<span class="nav-separator">|</span>';
        html += '<button class="btn-home" onclick="goHomeMultiple(\'' + pathId + '\')"><i class="bi bi-house"></i> Главная</button>';
    }
    
    if (html) html += '<span class="nav-separator">|</span>';
    html += '<button class="btn btn-sm btn-outline-primary" onclick="loadChartsFromDB(\'' + pathId + '\', \'' + encodeURIComponent(currentPathName) + '\')" style="font-size:0.75rem;padding:2px 8px;">';
    html += '<i class="bi bi-arrow-repeat"></i> Обновить графики</button>';
    
    if (parts.length > 1) {
        if (html) html += '<span class="nav-separator">|</span>';
        html += '<nav aria-label="breadcrumb" style="display:inline-block;">';
        html += '<ol class="breadcrumb-nav">';
        var currentPath = '';
        parts.forEach(function(part, i) {
            if (part) {
                currentPath += (i === 0 ? part : '\\' + part);
                if (i === parts.length - 1) {
                    html += '<li class="breadcrumb-item active">' + part + '</li>';
                } else {
                    var encoded = encodeURIComponent(currentPath);
                    html += '<li class="breadcrumb-item"><a onclick="navigateMultiplePathDB(\'' + pathId + '\', decodeURIComponent(\'' + encoded + '\'))">' + part + '</a></li>';
                }
            }
        });
        html += '</ol>';
        html += '</nav>';
    }
    
    if (!html) {
        html = '<span class="nav-empty"><i class="bi bi-house"></i> Корневой уровень</span>';
    }
    
    return html;
}

function renderFolderListLevel1(pathId, folders, basePath, currentPathName, rootPath) {
    var container = document.getElementById('itemsContainerLevel1_' + pathId);
    if (!container) return;
    
    var navContainer = document.getElementById('navContainerLevel1_' + pathId);
    if (navContainer) {
        navContainer.innerHTML = buildNavigationHTML(pathId, currentPathName, rootPath);
    }
    
    if (!folders || folders.length === 0) {
        container.innerHTML = '<div class="text-center text-muted py-3"><i class="bi bi-folder" style="font-size:1.5rem;"></i><p class="mt-1" style="font-size:0.9rem;">Нет папок</p></div>';
        return;
    }
    
    var html = '<div class="list-group">';
    folders.forEach(function(f) {
        var escapedPath = encodeURIComponent(basePath + '\\' + f.name);
        html += `
            <div class="list-group-item d-flex justify-content-between align-items-center folder-clickable" 
                 onclick="browseFolderMultipleDB('${pathId}', decodeURIComponent('${escapedPath}'))">
                <div>
                    <i class="bi bi-folder" style="color:#fd7e14;margin-right:8px;"></i>
                    <strong>${f.name}</strong>
                    <i class="bi bi-chevron-right" style="font-size:0.7rem;color:#6c757d;margin-left:4px;"></i>
                </div>
                <span class="badge bg-secondary">${f.size_str || formatSize(f.size)}</span>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
    
    buildFolderTree(pathId, folders, rootPath, currentPathName, 0);
    updateSidebar();
}

function renderFolderListLevel2(pathId, folders, basePath) {
    var container = document.getElementById('itemsContainerLevel2_' + pathId);
    if (!container) return;
    
    if (!folders || folders.length === 0) {
        container.innerHTML = '<div class="text-center text-muted py-3"><i class="bi bi-folder" style="font-size:1.5rem;"></i><p class="mt-1" style="font-size:0.9rem;">Нет папок</p></div>';
        return;
    }
    
    var html = '<div class="list-group">';
    folders.forEach(function(f) {
        html += `
            <div class="list-group-item d-flex justify-content-between align-items-center">
                <div>
                    <i class="bi bi-folder" style="color:#0d6efd;margin-right:8px;"></i>
                    <strong>${f.name}</strong>
                </div>
                <span class="badge bg-secondary">${f.size_str || formatSize(f.size)}</span>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
}

// ============================================================
// НАВИГАЦИЯ - МНОЖЕСТВЕННЫЙ РЕЖИМ
// ============================================================

function goBackMultiple(pathId) {
    var store = multipleDataStore[pathId];
    if (!store || !store.history || store.history.length === 0) {
        showToast('⚠️ Нет истории для возврата', 'warning');
        return;
    }
    
    var prev = store.history.pop();
    store.currentPath = prev.path;
    store.items = prev.items;
    store.level = prev.level;
    
    updatePathDisplay(pathId);
    
    if (store.level === 0) {
        document.getElementById('level2Section_' + pathId).classList.remove('active');
        document.getElementById('level2Section_' + pathId).style.display = 'none';
        document.getElementById('levelBadge_' + pathId).textContent = 'Уровень 1';
        document.getElementById('reportTitle_' + pathId).textContent = store.rootPath;
        
        renderFolderListLevel1(pathId, store.baseFolders, store.rootPath, store.rootPath, store.rootPath);
        document.getElementById('level1ItemsCount_' + pathId).textContent = store.baseFolders ? store.baseFolders.length : 0;
        buildFolderTree(pathId, store.baseFolders, store.rootPath, store.rootPath, 0);
        
        loadChartsFromDB(pathId, store.rootPath);
    } else {
        renderFolderListLevel2(pathId, store.items, store.currentPath);
        document.getElementById('level2ItemsCount_' + pathId).textContent = store.items ? store.items.length : 0;
    }
    
    showToast('⬅️ Возврат в ' + prev.path, 'info');
}

function goHomeMultiple(pathId) {
    var store = multipleDataStore[pathId];
    if (!store) return;
    
    if (store.level === 0) {
        showToast('⚠️ Вы уже на главном уровне', 'warning');
        return;
    }
    
    store.history = [];
    store.level = 0;
    store.currentPath = store.rootPath;
    store.items = store.baseFolders;
    
    document.getElementById('level2Section_' + pathId).classList.remove('active');
    document.getElementById('level2Section_' + pathId).style.display = 'none';
    document.getElementById('levelBadge_' + pathId).textContent = 'Уровень 1';
    document.getElementById('reportTitle_' + pathId).textContent = store.rootPath;
    
    renderFolderListLevel1(pathId, store.baseFolders, store.rootPath, store.rootPath, store.rootPath);
    document.getElementById('level1ItemsCount_' + pathId).textContent = store.baseFolders ? store.baseFolders.length : 0;
    buildFolderTree(pathId, store.baseFolders, store.rootPath, store.rootPath, 0);
    
    loadChartsFromDB(pathId, store.rootPath);
    
    showToast('🏠 Возврат на главный уровень: ' + store.rootPath, 'success');
}

function navigateMultiplePathDB(pathId, path) {
    var normalizedPath = normalizeUncPath(path);
    var store = multipleDataStore[pathId];
    if (!store) return;
    
    if (normalizedPath === store.currentPath) return;
    
    var foundIndex = -1;
    if (store.history) {
        for (var i = 0; i < store.history.length; i++) {
            if (store.history[i].path === normalizedPath) {
                foundIndex = i;
                break;
            }
        }
    }
    
    if (foundIndex !== -1) {
        var saved = store.history[foundIndex];
        store.history = store.history.slice(0, foundIndex);
        store.currentPath = saved.path;
        store.items = saved.items;
        store.level = saved.level;
        
        updatePathDisplay(pathId);
        
        if (store.level === 0) {
            document.getElementById('level2Section_' + pathId).classList.remove('active');
            document.getElementById('level2Section_' + pathId).style.display = 'none';
            document.getElementById('levelBadge_' + pathId).textContent = 'Уровень 1';
            document.getElementById('reportTitle_' + pathId).textContent = store.rootPath;
            renderFolderListLevel1(pathId, store.baseFolders, store.rootPath, store.rootPath, store.rootPath);
            buildFolderTree(pathId, store.baseFolders, store.rootPath, store.rootPath, 0);
            loadChartsFromDB(pathId, store.rootPath);
        } else {
            renderFolderListLevel2(pathId, store.items, store.currentPath);
            document.getElementById('level2ItemsCount_' + pathId).textContent = store.items ? store.items.length : 0;
        }
        
        showToast('⬅️ Переход в ' + saved.path, 'info');
        return;
    }
    
    document.getElementById('loading').style.display = 'block';
    
    browseFromDB(normalizedPath)
        .then(function(data) {
            document.getElementById('loading').style.display = 'none';
            if (data.error) { showToast('Ошибка: ' + data.error, 'error'); return; }
            
            var level = store.history ? store.history.length : 0;
            store.currentPath = data.path;
            store.items = data.items || [];
            store.level = level;
            
            updatePathDisplay(pathId);
            
            if (data.chart) {
                renderChart(data.chart, 'level2ChartDiv_' + pathId, pathId);
            }
            
            if (data.histogram_data && data.histogram_data.length > 0) {
                renderHistogram(data.histogram_data, 'level2HistogramDiv_' + pathId, data.path, 2, pathId);
            }
            
            renderFolderListLevel2(pathId, data.items || [], data.path);
            document.getElementById('level2ItemsCount_' + pathId).textContent = data.items ? data.items.length : 0;
            
            if (data.items && data.items.length > 0) {
                var container = document.getElementById('folderTreeContainer_' + pathId);
                if (container) {
                    var html = '<ul class="folder-tree" style="list-style:none;padding:0;margin:0;">';
                    html += `
                        <li style="padding:0;">
                            <div class="folder-item" onclick="goHomeMultiple('${pathId}')" style="display:flex;align-items:center;padding:3px 8px;border-radius:4px;cursor:pointer;color:#007bff;font-weight:500;font-size:0.82rem;">
                                <i class="bi bi-arrow-up-circle" style="color:#007bff;margin-right:6px;"></i>
                                <span class="folder-name">.. (На уровень выше)</span>
                            </div>
                        </li>
                    `;
                    data.items.forEach(function(f) {
                        var sizeStr = f.size_str || formatSize(f.size || 0);
                        html += `
                            <li style="padding:0;">
                                <div class="folder-item" style="display:flex;align-items:center;padding:3px 8px;border-radius:4px;font-size:0.82rem;gap:6px;padding-left:20px;">
                                    <i class="bi bi-folder folder-icon" style="color:#0d6efd;font-size:0.85rem;"></i>
                                    <span class="folder-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
                                    <span class="level-badge-sm level2" style="font-size:0.55rem;padding:1px 6px;border-radius:10px;background:#0d6efd;color:white;">L2</span>
                                    <span class="folder-size" style="font-size:0.65rem;color:#6c757d;background:#f1f3f5;padding:1px 6px;border-radius:10px;">${sizeStr}</span>
                                </div>
                            </li>
                        `;
                    });
                    html += '</ul>';
                    container.innerHTML = html;
                }
            }
            
            showToast('📂 Переход в ' + normalizedPath, 'info');
        })
        .catch(function(e) {
            document.getElementById('loading').style.display = 'none';
            showToast('❌ Ошибка: ' + e.message, 'error');
        });
}

// ============================================================
// ФУНКЦИЯ ПЕРЕХОДА В ПАПКУ УРОВНЯ 2
// ============================================================

function browseFolderMultipleDB(pathId, path) {
    var normalizedPath = normalizeUncPath(path);
    var store = multipleDataStore[pathId];
    if (!store) {
        showToast('⚠️ Ошибка: данные не найдены', 'error');
        return;
    }
    
    var parts = normalizedPath.split('\\').filter(function(p) { return p !== ''; });
    var rootParts = store.rootPath.split('\\').filter(function(p) { return p !== ''; });
    if (parts.length > rootParts.length + 1) {
        showToast('⚠️ Можно просматривать только до 2 уровня вложенности', 'warning');
        return;
    }
    
    if (!store.history) store.history = [];
    store.history.push({
        path: store.currentPath,
        items: store.items,
        level: store.level
    });
    
    document.getElementById('loading').style.display = 'block';
    
    // Сначала получаем данные из БД через getChartFromDB
    getChartFromDB(normalizedPath)
        .then(function(dbData) {
            console.log('📊 Получены данные из БД для уровня 2:', normalizedPath);
            console.log('📊 histogram_data:', dbData.histogram_data ? dbData.histogram_data.length : 0);
            
            // Обновляем store
            store.currentPath = normalizedPath;
            store.items = dbData.folders || [];
            store.level = store.history.length;
            
            document.getElementById('levelBadge_' + pathId).textContent = 'Уровень 2';
            document.getElementById('reportTitle_' + pathId).textContent = normalizedPath;
            
            document.getElementById('level2Section_' + pathId).classList.add('active');
            document.getElementById('level2Section_' + pathId).style.display = 'block';
            document.getElementById('level2Path_' + pathId).textContent = normalizedPath;
            
            // ============================================================
            // ГРАФИК УРОВНЯ 2
            // ============================================================
            if (dbData.chart) {
                renderChart(dbData.chart, 'level2ChartDiv_' + pathId, pathId);
            } else {
                document.getElementById('level2ChartDiv_' + pathId).innerHTML = `
                    <div class="text-center text-muted py-3">
                        <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                        <p style="font-size:0.9rem;">Нет данных для графика</p>
                        <small>Нужно минимум 2 сканирования</small>
                    </div>
                `;
            }
            
            // ============================================================
            // ГИСТОГРАММА УРОВНЯ 2
            // ============================================================
            if (dbData.histogram_data && dbData.histogram_data.length > 0) {
                console.log('📊 Рендеринг гистограммы уровня 2:', dbData.histogram_data.length);
                renderHistogram(dbData.histogram_data, 'level2HistogramDiv_' + pathId, normalizedPath, 2, pathId);
            } else {
                document.getElementById('level2HistogramDiv_' + pathId).innerHTML = `
                    <div class="text-center text-muted py-3">
                        <i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                        <p style="font-size:0.9rem;">Нет данных для гистограммы</p>
                        <small>Нужно минимум 2 сканирования</small>
                    </div>
                `;
            }
            
            // Рендерим список папок уровня 2
            renderFolderListLevel2(pathId, dbData.folders || [], normalizedPath);
            document.getElementById('level2ItemsCount_' + pathId).textContent = dbData.folders ? dbData.folders.length : 0;
            
            // Обновляем боковую панель
            if (dbData.folders && dbData.folders.length > 0) {
                var container = document.getElementById('folderTreeContainer_' + pathId);
                if (container) {
                    var html = '<ul class="folder-tree" style="list-style:none;padding:0;margin:0;">';
                    html += `
                        <li style="padding:0;">
                            <div class="folder-item" onclick="goHomeMultiple('${pathId}')" style="display:flex;align-items:center;padding:3px 8px;border-radius:4px;cursor:pointer;color:#007bff;font-weight:500;font-size:0.82rem;">
                                <i class="bi bi-arrow-up-circle" style="color:#007bff;margin-right:6px;"></i>
                                <span class="folder-name">.. (На уровень выше)</span>
                            </div>
                        </li>
                    `;
                    dbData.folders.forEach(function(f) {
                        var sizeStr = f.size_str || formatSize(f.size || 0);
                        html += `
                            <li style="padding:0;">
                                <div class="folder-item" style="display:flex;align-items:center;padding:3px 8px;border-radius:4px;font-size:0.82rem;gap:6px;padding-left:20px;">
                                    <i class="bi bi-folder folder-icon" style="color:#0d6efd;font-size:0.85rem;"></i>
                                    <span class="folder-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
                                    <span class="level-badge-sm level2" style="font-size:0.55rem;padding:1px 6px;border-radius:10px;background:#0d6efd;color:white;">L2</span>
                                    <span class="folder-size" style="font-size:0.65rem;color:#6c757d;background:#f1f3f5;padding:1px 6px;border-radius:10px;">${sizeStr}</span>
                                </div>
                            </li>
                        `;
                    });
                    html += '</ul>';
                    container.innerHTML = html;
                }
            } else {
                var container = document.getElementById('folderTreeContainer_' + pathId);
                if (container) {
                    container.innerHTML = `
                        <div class="empty-sidebar" style="padding:8px;font-size:0.8rem;color:#6c757d;">
                            <i class="bi bi-folder" style="font-size:1.2rem;display:block;margin-bottom:4px;"></i>
                            Внутренних папок нет
                            <br>
                            <button class="btn btn-sm btn-primary mt-2" onclick="goHomeMultiple('${pathId}')">
                                <i class="bi bi-arrow-up"></i> На уровень выше
                            </button>
                        </div>
                    `;
                }
            }
            
            renderFolderListLevel1(pathId, store.baseFolders, store.rootPath, store.rootPath, store.rootPath);
            
            document.getElementById('loading').style.display = 'none';
            showToast('📁 ' + normalizedPath + ' - ' + (dbData.folders_count || 0) + ' элементов', 'info');
        })
        .catch(function(e) {
            document.getElementById('loading').style.display = 'none';
            console.error('❌ Ошибка загрузки уровня 2:', e);
            showToast('❌ Ошибка: ' + e.message, 'error');
            
            document.getElementById('level2HistogramDiv_' + pathId).innerHTML = `
                <div class="text-center text-muted py-3">
                    <i class="bi bi-exclamation-triangle" style="font-size:2rem;display:block;margin-bottom:6px;color:#f39c12;"></i>
                    <p style="font-size:0.9rem;">Ошибка загрузки данных</p>
                    <small>${e.message}</small>
                </div>
            `;
        });
}

function updatePathDisplay(pathId) {
    var store = multipleDataStore[pathId];
    if (!store) return;
    
    var levelBadge = document.getElementById('levelBadge_' + pathId);
    var reportTitle = document.getElementById('reportTitle_' + pathId);
    var statItems = document.getElementById('statItems_' + pathId);
    var statSize = document.getElementById('statSize_' + pathId);
    var statScans = document.getElementById('statScans_' + pathId);
    
    if (levelBadge) levelBadge.textContent = store.level === 0 ? 'Уровень 1' : 'Уровень 2';
    if (reportTitle) reportTitle.textContent = store.currentPath;
    if (statItems) statItems.textContent = store.items ? store.items.length : 0;
    if (statSize) statSize.textContent = store.totalSizeStr || '0';
    if (statScans) statScans.textContent = store.scansCount || 0;
    
    var navContainer = document.getElementById('navContainerLevel1_' + pathId);
    if (navContainer) {
        navContainer.innerHTML = buildNavigationHTML(pathId, store.currentPath, store.rootPath);
    }
}

// ============================================================
// ОСНОВНАЯ ФУНКЦИЯ ОТОБРАЖЕНИЯ ОТЧЕТОВ
// ============================================================

function showMultipleReports(results) {
    var container = document.getElementById('mainContent');
    
    document.getElementById('reportSection').style.display = 'block';
    container.innerHTML = '';
    
    results.forEach(function(data, index) {
        var pathId = 'path_' + (index + 1);
        var level = data.level || 1;
        
        console.log('📊 showMultipleReports для pathId:', pathId);
        console.log('📊 histogram_data:', data.histogram_data ? data.histogram_data.length : 0);
        
        multipleDataStore[pathId] = {
            rootPath: data.path,
            currentPath: data.path,
            items: data.folders || [],
            baseFolders: data.folders || [],
            level: 0,
            history: [],
            scansCount: data.scans_count || 0,
            totalSizeStr: data.total_size_str || '0',
            chart: data.chart,
            histogramData: data.histogram_data || [],
            folderHistory: data.folder_history || []
        };
        
        var cardHtml = `
            <div class="card report-card" id="report-card-${pathId}">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <span><i class="bi bi-folder"></i> <strong id="reportTitle_${pathId}">${data.path}</strong></span>
                    <div>
                        <span class="badge bg-secondary level-badge" id="levelBadge_${pathId}">Уровень ${level}</span>
                        <button class="btn btn-sm btn-danger ms-2" onclick="closeReport()"><i class="bi bi-x-lg"></i></button>
                    </div>
                </div>
                <div class="card-body">
                    <div class="stat-row">
                        <div class="stat-item"><div class="value" id="statItems_${pathId}">${data.folders ? data.folders.length : 0}</div><div class="label">Папок</div></div>
                        <div class="stat-item"><div class="value" id="statSize_${pathId}">${data.total_size_str || '0'}</div><div class="label">Размер</div></div>
                        <div class="stat-item"><div class="value" id="statScans_${pathId}">${data.scans_count || 0}</div><div class="label">Сканирований</div></div>
                        <div class="stat-item"><div class="value" style="font-size:0.7rem;">${new Date().toLocaleString()}</div><div class="label">Последнее</div></div>
                    </div>

                    <div class="chart-section level-1">
                        <div class="section-title">
                            <i class="bi bi-arrow-up-circle"></i>
                            📌 УРОВЕНЬ 1 - СКАНИРУЕМЫЙ КАТАЛОГ
                            <span class="badge">Уровень 1</span>
                            <span class="path-text">${data.path}</span>
                        </div>
                        <div class="chart-card">
                            <h6><i class="bi bi-graph-up"></i> График динамики</h6>
                            <div class="chart-wrapper">
                                <div id="level1ChartDiv_${pathId}">
                                    <div class="text-center text-muted py-3">
                                        <i class="bi bi-hourglass-split" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                                        <p style="font-size:0.9rem;">Загрузка графика...</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="chart-card">
                            <h6><i class="bi bi-bar-chart-fill"></i> Гистограмма</h6>
                            <div class="chart-wrapper">
                                <div id="level1HistogramDiv_${pathId}">
                                    <div class="text-center text-muted py-3"><i class="bi bi-clock-history" style="font-size:2rem;display:block;margin-bottom:6px;"></i><p style="font-size:0.9rem;">Загрузка...</p></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="folders-section" id="foldersSectionLevel1_${pathId}">
                        <div class="folders-header">
                            <h6><i class="bi bi-folder2-open"></i> Содержимое (Уровень 1) - <span id="level1ItemsCount_${pathId}">${data.folders ? data.folders.length : 0}</span> папок</h6>
                            <div class="folders-nav" id="navContainerLevel1_${pathId}"></div>
                        </div>
                        <div id="itemsContainerLevel1_${pathId}" class="list-group"></div>
                    </div>

                    <div class="level-2-section" id="level2Section_${pathId}">
                        <hr class="level-divider">
                        <div class="chart-section level-2">
                            <div class="section-title">
                                <i class="bi bi-folder"></i>
                                📌 УРОВЕНЬ 2 - ОТКРЫТЫЙ КАТАЛОГ
                                <span class="badge">Уровень 2</span>
                                <span class="path-text" id="level2Path_${pathId}">${data.path}</span>
                            </div>
                            <div class="chart-card">
                                <h6><i class="bi bi-graph-up"></i> График динамики</h6>
                                <div class="chart-wrapper">
                                    <div id="level2ChartDiv_${pathId}">
                                        <div class="text-center text-muted py-3">
                                            <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                                            <p style="font-size:0.9rem;">Нет данных</p>
                                            <small>Откройте папку уровня 2</small>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="chart-card">
                                <h6><i class="bi bi-bar-chart-fill"></i> Гистограмма</h6>
                                <div class="chart-wrapper">
                                    <div id="level2HistogramDiv_${pathId}">
                                        <div class="text-center text-muted py-3"><i class="bi bi-clock-history" style="font-size:2rem;display:block;margin-bottom:6px;"></i><p style="font-size:0.9rem;">Нет данных</p></div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="folders-section level-2">
                            <div class="folders-header">
                                <h6><i class="bi bi-folder2-open"></i> Содержимое (Уровень 2) - <span id="level2ItemsCount_${pathId}">0</span> папок</h6>
                            </div>
                            <div id="itemsContainerLevel2_${pathId}" class="list-group"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        container.innerHTML += cardHtml;
        
        renderFolderListLevel1(pathId, data.folders || [], data.path, data.path, data.path);
    });
    
    updateSidebar();
    
    results.forEach(function(data, index) {
        var pathId = 'path_' + (index + 1);
        setTimeout(function() {
            loadChartsFromDB(pathId, data.path);
        }, 500 + index * 200);
    });
    
    showToast('✅ Загружено ' + results.length + ' отчетов', 'success');
}

// ============================================================
// ОТКРЫТИЕ / ЗАКРЫТИЕ ОТЧЕТА
// ============================================================

function openReport(path) {
    var normalizedPath = normalizeUncPath(path);
    
    document.getElementById('loading').style.display = 'block';
    fetch('/api/report', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
        document.getElementById('loading').style.display = 'none';
        if (data.error) { showToast('Ошибка: ' + data.error, 'error'); return; }
        showMultipleReports([data]);
    })
    .catch(function(e) {
        document.getElementById('loading').style.display = 'none';
        showToast('❌ Ошибка: ' + e.message, 'error');
    });
}

function closeReport() {
    document.getElementById('reportSection').style.display = 'none';
    document.getElementById('mainContent').innerHTML = '';
    document.getElementById('folderTreeContainer').innerHTML = `
        <div class="empty-sidebar">
            <i class="bi bi-folder" style="font-size:2rem;display:block;margin-bottom:10px;"></i>
            Нет папок для отображения
        </div>
    `;
    document.getElementById('folderCountBadge').textContent = '0';
    multipleDataStore = {};
    currentPathId = null;
}

// ============================================================
// ПАСХАЛКА - ЭПИЧНЫЙ "ЖАХ!" (F2)
// ============================================================

(function() {
    var isExploding = false;
    
    function createExplosion() {
        if (isExploding) return;
        isExploding = true;
        
        var flash = document.createElement('div');
        flash.className = 'flash-overlay';
        document.body.appendChild(flash);
        setTimeout(function() {
            if (flash.parentElement) flash.remove();
        }, 400);
        
        var shockwave = document.createElement('div');
        shockwave.className = 'shockwave';
        document.body.appendChild(shockwave);
        setTimeout(function() {
            if (shockwave.parentElement) shockwave.remove();
        }, 1200);
        
        document.body.classList.add('shake');
        setTimeout(function() {
            document.body.classList.remove('shake');
        }, 900);
        
        var text = document.createElement('div');
        text.className = 'explosion-text';
        text.textContent = '💥 ЖАХ! 💥';
        document.body.appendChild(text);
        
        var container = document.createElement('div');
        container.className = 'explosion-container';
        document.body.appendChild(container);
        
        var colors = ['#ff6b6b', '#ff9f43', '#feca57', '#48dbfb', '#0abde3', '#10ac84', '#ee5a24', '#5f27cd', '#ff6b6b', '#f368e0', '#ff9f43', '#54a0ff', '#ff4757', '#2ed573', '#7bed9f'];
        
        for (var i = 0; i < 120; i++) {
            var particle = document.createElement('div');
            particle.className = 'explosion-particle';
            var size = Math.random() * 25 + 8;
            var x = Math.random() * window.innerWidth;
            var y = Math.random() * window.innerHeight;
            var tx = (Math.random() - 0.5) * 1400;
            var ty = (Math.random() - 0.5) * 1000;
            var color = colors[Math.floor(Math.random() * colors.length)];
            var duration = Math.random() * 0.5 + 0.8;
            
            particle.style.cssText = `
                left: ${x}px;
                top: ${y}px;
                width: ${size}px;
                height: ${size}px;
                background: ${color};
                --tx: ${tx}px;
                --ty: ${ty}px;
                animation-duration: ${duration}s;
                border-radius: ${Math.random() > 0.5 ? '50%' : '4px'};
                box-shadow: 0 0 15px ${color};
            `;
            container.appendChild(particle);
        }
        
        var starSymbols = ['✦', '✧', '⭐', '🌟', '💫'];
        for (var i = 0; i < 30; i++) {
            var star = document.createElement('div');
            star.className = 'star-particle';
            star.textContent = starSymbols[Math.floor(Math.random() * starSymbols.length)];
            var x = Math.random() * window.innerWidth;
            var y = Math.random() * window.innerHeight;
            var tx = (Math.random() - 0.5) * 1000;
            var ty = (Math.random() - 0.5) * 800;
            var tx2 = (Math.random() - 0.5) * 1200;
            var ty2 = (Math.random() - 0.5) * 900;
            star.style.cssText = `
                left: ${x}px;
                top: ${y}px;
                font-size: ${Math.random() * 25 + 15}px;
                --tx: ${tx}px;
                --ty: ${ty}px;
                --tx2: ${tx2}px;
                --ty2: ${ty2}px;
                animation-duration: ${Math.random() * 0.5 + 1.5}s;
            `;
            container.appendChild(star);
        }
        
        for (var i = 0; i < 60; i++) {
            var spark = document.createElement('div');
            spark.className = 'spark';
            var x = window.innerWidth / 2 + (Math.random() - 0.5) * 200;
            var y = window.innerHeight / 2 + (Math.random() - 0.5) * 200;
            var sx = (Math.random() - 0.5) * 800;
            var sy = (Math.random() - 0.5) * 800 - 300;
            var size = Math.random() * 6 + 3;
            var color = ['#ffd700', '#ff6b00', '#ff4500', '#ffa500'][Math.floor(Math.random() * 4)];
            spark.style.cssText = `
                left: ${x}px;
                top: ${y}px;
                width: ${size}px;
                height: ${size}px;
                background: ${color};
                --sx: ${sx}px;
                --sy: ${sy}px;
                animation-duration: ${Math.random() * 0.3 + 0.8}s;
                box-shadow: 0 0 15px ${color};
            `;
            document.body.appendChild(spark);
            setTimeout(function(el) {
                if (el && el.parentElement) el.remove();
            }, 1500, spark);
        }
        
        var fireColors = ['#ff4500', '#ff6b00', '#ff8c00', '#ffa500', '#ffd700'];
        for (var i = 0; i < 50; i++) {
            var fire = document.createElement('div');
            fire.className = 'fire-particle';
            var x = window.innerWidth / 2 + (Math.random() - 0.5) * 100;
            var y = window.innerHeight / 2 + (Math.random() - 0.5) * 100;
            var fx = (Math.random() - 0.5) * 400;
            var fy = -Math.random() * 600 - 100;
            var size = Math.random() * 15 + 5;
            var fireColor = fireColors[Math.floor(Math.random() * fireColors.length)];
            fire.style.cssText = `
                left: ${x}px;
                top: ${y}px;
                width: ${size}px;
                height: ${size}px;
                background: ${fireColor};
                --fx: ${fx}px;
                --fy: ${fy}px;
                animation-duration: ${Math.random() * 0.4 + 0.8}s;
                border-radius: 50%;
                box-shadow: 0 0 20px rgba(255, 100, 0, 0.5);
            `;
            container.appendChild(fire);
        }
        
        var confettiColors = ['#ff6b6b', '#ff9f43', '#feca57', '#48dbfb', '#0abde3', '#10ac84', '#ee5a24', '#5f27cd', '#ff6b6b', '#f368e0', '#ff9f43', '#54a0ff', '#2ed573', '#ff4757'];
        for (var i = 0; i < 60; i++) {
            var confetti = document.createElement('div');
            confetti.className = 'confetti-piece';
            var x = Math.random() * window.innerWidth;
            var color = confettiColors[Math.floor(Math.random() * confettiColors.length)];
            var width = Math.random() * 12 + 5;
            var height = Math.random() * 22 + 10;
            var duration = Math.random() * 2 + 2;
            var delay = Math.random() * 0.8;
            var rotation = Math.random() * 360;
            
            confetti.style.cssText = `
                left: ${x}px;
                top: -30px;
                width: ${width}px;
                height: ${height}px;
                background: ${color};
                animation-duration: ${duration}s;
                animation-delay: ${delay}s;
                transform: rotate(${rotation}deg);
                border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            `;
            document.body.appendChild(confetti);
            setTimeout(function(el) {
                if (el && el.parentElement) el.remove();
            }, 4500, confetti);
        }
        
        setTimeout(function() {
            if (text.parentElement) text.remove();
            if (container.parentElement) container.remove();
            isExploding = false;
        }, 2800);
    }
    
    document.addEventListener('keydown', function(e) {
        if (e.key === 'F2') {
            e.preventDefault();
            createExplosion();
        }
    });
})();

// ============================================================
// ОБРАБОТКА ФОРМЫ СКАНИРОВАНИЯ
// ============================================================

document.getElementById('scanForm').addEventListener('submit', function(e) {
    e.preventDefault();
    if (pathsToScan.length === 0) { showToast('Добавьте путь', 'warning'); return; }
    
    var btn = document.getElementById('scanBtn');
    var progress = document.getElementById('scanProgress');
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Сканирование...';
    progress.style.display = 'block';

    var reportSection = document.getElementById('reportSection');
    if (reportSection) {
        reportSection.style.display = 'none';
    }

    var promises = pathsToScan.map(function(path) {
        return scanSinglePath(path)
            .then(function(data) { return { success: true, data: data }; })
            .catch(function(err) {
                console.error('❌ Ошибка для ' + path + ':', err);
                return { success: false, path: path, error: err.message };
            });
    });

    Promise.all(promises)
        .then(function(results) {
            var valid = results.filter(function(r) { return r.success; }).map(function(r) { return r.data; });
            var errors = results.filter(function(r) { return !r.success; });
            
            if (errors.length > 0) {
                errors.forEach(function(e) { showToast('Ошибка сканирования ' + e.path + ': ' + e.error, 'error'); });
            }
            
            if (valid.length === 0) {
                showToast('Ни один путь не был успешно отсканирован', 'error');
                return;
            }
            
            showToast('✅ Сканирование завершено! Обработано ' + valid.length + ' путей', 'success');
            loadPaths();
            
            showMultipleReports(valid);
        })
        .finally(function() {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-play-fill"></i> Сканировать все пути';
            progress.style.display = 'none';
        });
});

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================

updatePathTags();
loadPaths();
console.log('✅ Приложение загружено.');
console.log('✅ Графики загружаются из БД при открытии отчета');
console.log('✅ Каждая папка - свой цвет');
console.log('✅ Легенда ВЕРТИКАЛЬНАЯ и находится СПРАВА от графика');
console.log('✅ Клик по легенде - скрывает/показывает папку на графике');
console.log('✅ Горизонтальный скролл для просмотра');
console.log('📂 Боковая панель показывает все сканированные пути с разделителями');
console.log('📊 Во всплывающих подсказках отображаются названия папок');
console.log('💥 Пасхалка: нажми F2 для ЭПИЧНОГО взрыва "ЖАХ!"');