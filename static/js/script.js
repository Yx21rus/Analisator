// ============================================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ============================================================
var pathsToScan = [];
var multipleDataStore = {};
var currentPathId = null;
var openPaths = [];
var scheduledTasks = {};
var refreshIntervals = {};

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

function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getIntervalLabel(interval) {
    var labels = {
        '1min': '1 мин',
        '30min': '30 мин',
        'hour': 'Час',
        'day': 'День',
        'week': 'Неделя',
        'month': 'Месяц',
        '3months': '3 мес',
        '6months': '6 мес',
        '12months': '12 мес'
    };
    return labels[interval] || interval;
}

function getIntervalLabelShort(interval) {
    var labels = {
        '1min': '1м',
        '30min': '30м',
        'hour': 'Час',
        'day': 'День',
        'week': 'Нед',
        'month': 'Мес',
        '3months': '3м',
        '6months': '6м',
        '12months': '12м'
    };
    return labels[interval] || interval;
}

// ============================================================
// УПРАВЛЕНИЕ СПИСКОМ ОТКРЫТЫХ КАТАЛОГОВ
// ============================================================

function findOpenPathByPath(path) {
    return openPaths.find(function(item) { 
        return item.path.toLowerCase() === path.toLowerCase(); 
    });
}

function findOpenPathById(pathId) {
    return openPaths.find(function(item) { 
        return item.pathId === pathId; 
    });
}

function addOpenPath(pathId, path, type) {
    var existing = findOpenPathByPath(path);
    if (existing) {
        existing.pathId = pathId;
        existing.type = type;
        updateOpenPathsList();
        return existing;
    }
    
    var newItem = {
        pathId: pathId,
        path: path,
        type: type || 'scan'
    };
    openPaths.push(newItem);
    updateOpenPathsList();
    return newItem;
}

function removeOpenPath(pathId) {
    var index = openPaths.findIndex(function(item) { return item.pathId === pathId; });
    if (index === -1) return;
    
    var path = openPaths[index].path;
    openPaths.splice(index, 1);
    
    var pathIndex = pathsToScan.indexOf(path);
    if (pathIndex !== -1) {
        pathsToScan.splice(pathIndex, 1);
        updatePathTags();
    }
    
    if (multipleDataStore[pathId]) {
        delete multipleDataStore[pathId];
    }
    
    var card = document.getElementById('accordion-' + pathId);
    if (card) {
        card.remove();
    }
    
    var section = document.getElementById('folderTreeSection_' + pathId);
    if (section) {
        section.remove();
    }
    
    updateOpenPathsList();
    updateSidebar();
    
    if (Object.keys(multipleDataStore).length === 0) {
        document.getElementById('reportSection').style.display = 'none';
        document.getElementById('mainContent').innerHTML = '';
    }
    
    showToast('🗑️ Закрыт каталог: ' + path, 'info');
}

function updateOpenPathsList() {
    var container = document.getElementById('openPathsContainer');
    var list = document.getElementById('openPathsList');
    var count = document.getElementById('openPathsCount');
    
    if (openPaths.length === 0) {
        if (container) container.style.display = 'none';
        return;
    }
    
    if (container) container.style.display = 'block';
    if (count) count.textContent = openPaths.length;
    
    var html = '';
    openPaths.forEach(function(item) {
        var shortPath = item.path;
        if (shortPath.length > 40) {
            shortPath = '...' + shortPath.substring(shortPath.length - 37);
        }
        var badgeClass = item.type === 'scan' ? 'scan' : (item.type === 'scheduler' ? 'scheduler' : 'db');
        var badgeText = item.type === 'scan' ? 'Скан' : (item.type === 'scheduler' ? 'План' : 'БД');
        html += `
            <div class="open-path-item">
                <span class="path-badge ${badgeClass}">${badgeText}</span>
                <span class="path-name" title="${item.path}">${shortPath}</span>
                <button class="path-close-btn" onclick="removeOpenPath('${item.pathId}')" title="Закрыть каталог">
                    <i class="bi bi-x-circle"></i>
                </button>
            </div>
        `;
    });
    if (list) list.innerHTML = html;
}

// ============================================================
// ФУНКЦИЯ ЭКСПОРТА В EXCEL
// ============================================================

function exportExcelForPath(pathId, path) {
    if (!path) {
        var store = multipleDataStore[pathId];
        if (store) {
            path = store.currentPath || store.rootPath;
        }
    }
    
    if (!path) {
        showToast('❌ Путь не найден', 'error');
        return;
    }
    
    try {
        path = decodeURIComponent(path);
    } catch (e) {}
    
    showToast('📊 Генерация Excel отчета для: ' + path, 'info');
    document.getElementById('loading').style.display = 'block';
    
    fetch('/api/export_excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path })
    })
    .then(function(response) {
        document.getElementById('loading').style.display = 'none';
        
        if (!response.ok) {
            return response.json().then(function(err) {
                throw new Error(err.error || 'Ошибка сервера');
            });
        }
        
        var filename = 'report.xlsx';
        var contentDisposition = response.headers.get('Content-Disposition');
        if (contentDisposition) {
            var match = contentDisposition.match(/filename=([^;]+)/);
            if (match) {
                filename = match[1];
            }
        }
        
        return response.blob().then(function(blob) {
            return { blob: blob, filename: filename };
        });
    })
    .then(function(result) {
        var url = URL.createObjectURL(result.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 100);
        showToast('✅ Excel отчет скачан: ' + result.filename, 'success');
    })
    .catch(function(e) {
        document.getElementById('loading').style.display = 'none';
        showToast('❌ Ошибка экспорта: ' + e.message, 'error');
    });
}

// ============================================================
// УПРАВЛЕНИЕ ПУТЯМИ ДЛЯ СКАНИРОВАНИЯ
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
    var scanBtn = document.getElementById('scanBtn');
    var loadBtn = document.getElementById('loadFromDbBtn');
    var info = document.getElementById('pathCountInfo');
    
    if (pathsToScan.length === 0) {
        if (container) container.innerHTML = '<div class="empty-paths">Нет добавленных путей</div>';
        if (scanBtn) scanBtn.disabled = true;
        if (loadBtn) loadBtn.disabled = true;
        if (info) info.textContent = 'Добавьте путь для сканирования или загрузки';
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
    if (container) container.innerHTML = html;
    if (scanBtn) scanBtn.disabled = false;
    if (loadBtn) loadBtn.disabled = false;
    if (info) info.textContent = 'Готово: ' + pathsToScan.length + ' путь(ей)';
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
                if (container) container.innerHTML = '<div class="text-center text-muted py-4"><i class="bi bi-inbox" style="font-size:2rem;"></i><p class="mt-2">Нет сохраненных сканирований</p></div>';
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
            if (container) container.innerHTML = html;
        })
        .catch(function(e) { console.error('Ошибка:', e); });
}

function scanSinglePath(path) {
    var normalizedPath = normalizeUncPath(path);
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

function loadFromDB() {
    if (pathsToScan.length === 0) {
        showToast('Добавьте путь', 'warning');
        return;
    }
    
    var btn = document.getElementById('loadFromDbBtn');
    var progress = document.getElementById('scanProgress');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Загрузка...';
    }
    if (progress) progress.style.display = 'block';
    
    fetch('/api/load_from_db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: pathsToScan })
    })
    .then(function(response) {
        if (!response.ok) {
            return response.json().then(function(err) {
                throw new Error(err.error || 'Ошибка сервера');
            });
        }
        return response.json();
    })
    .then(function(data) {
        if (data.error) {
            showToast('❌ ' + data.error, 'error');
            return;
        }
        
        if (data.errors && data.errors.length > 0) {
            data.errors.forEach(function(err) {
                showToast('⚠️ ' + err.path + ': ' + err.error, 'warning');
            });
        }
        
        if (data.results.length === 0) {
            showToast('❌ Нет данных для загрузки', 'error');
            return;
        }
        
        showToast('✅ Загружено из БД: ' + data.results.length + ' путей', 'success');
        loadPaths();
        showMultipleReports(data.results, 'db');
    })
    .catch(function(error) {
        console.error('❌ Ошибка:', error);
        showToast('❌ Ошибка загрузки: ' + error.message, 'error');
    })
    .finally(function() {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-database-fill"></i> Загрузить из БД';
        }
        if (progress) progress.style.display = 'none';
    });
}

document.getElementById('loadFromDbBtn').addEventListener('click', loadFromDB);

function browseFromDB(path) {
    var normalizedPath = normalizeUncPath(path);
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
        div.innerHTML = '';
        return;
    }
    
    try {
        var data = typeof chartData === 'string' ? JSON.parse(chartData) : chartData;
        
        if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
            var plotId = div.id || divId;
            Plotly.purge(plotId);
            
            var traces = data.data;
            
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
    
    div.innerHTML = '';
}

// ============================================================
// РЕНДЕРИНГ ГИСТОГРАММЫ С СОХРАНЕНИЕМ ГОРИЗОНТАЛЬНОГО СКРОЛЛА
// ============================================================

function renderSectionedHistogram(chartData, divId, pathId) {
    var div = document.getElementById(divId);
    if (!div) {
        console.error('❌ Div для гистограммы не найден:', divId);
        return;
    }
    
    // Проверяем, есть ли уже обертка со скроллом
    var wrapper = div.closest('.histogram-scroll-wrapper');
    var innerDiv = div;
    
    // Если обертки нет, создаем ее
    if (!wrapper) {
        var parent = div.parentElement;
        
        wrapper = document.createElement('div');
        wrapper.className = 'histogram-scroll-wrapper';
        
        var newInner = document.createElement('div');
        newInner.className = 'histogram-inner';
        newInner.id = div.id;
        
        wrapper.appendChild(newInner);
        parent.insertBefore(wrapper, div);
        parent.removeChild(div);
        
        div = newInner;
    } else {
        var inner = wrapper.querySelector('.histogram-inner');
        if (inner) {
            div = inner;
            div.id = divId;
        }
    }
    
    div.innerHTML = '';
    
    if (!chartData) {
        div.innerHTML = `
            <div class="text-center text-muted py-3">
                <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                <p style="font-size:0.9rem;">Нет данных для гистограммы</p>
                <small>Нужно минимум 2 сканирования</small>
            </div>
        `;
        return;
    }
    
    try {
        var data = typeof chartData === 'string' ? JSON.parse(chartData) : chartData;
        
        if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
            var plotId = div.id || divId;
            Plotly.purge(plotId);
            
            var traces = data.data;
            var layout = data.layout || {};
            
            traces.forEach(function(trace, index) {
                trace.orientation = 'v';
                trace.type = 'bar';
                
                if (!trace.width) {
                    trace.width = 0.95;
                }
                
                if (!trace.textposition) {
                    trace.textposition = 'outside';
                }
                if (!trace.textfont) {
                    trace.textfont = { size: 8, color: '#2c3e50' };
                }
                
                if (trace.hovertemplate) {
                    trace.hovertemplate = trace.hovertemplate.replace(/%\{fullData\.[^}]+\}/g, '%{customdata}');
                }
                
                if (!trace.customdata && trace.name) {
                    var dataLen = trace.x ? trace.x.length : 0;
                    trace.customdata = Array(dataLen).fill(trace.name);
                }
                
                if (!trace.marker) {
                    trace.marker = {};
                }
                if (!trace.marker.line) {
                    trace.marker.line = {
                        color: 'rgba(0,0,0,0.12)',
                        width: 0.5
                    };
                }
            });
            
            layout.barmode = 'group';
            layout.bargap = 0.25;
            layout.bargroupgap = 0.0;
            
            var folderCount = traces.length;
            var calculatedHeight = 100 + folderCount * 210;
            layout.height = Math.max(400, Math.min(1500, calculatedHeight));
            
            if (!layout.margin) {
                layout.margin = { l: 80, r: 30, t: 80, b: 40 };
            }
            
            if (layout.xaxis) {
                layout.xaxis.tickangle = -90;
                layout.xaxis.tickfont = layout.xaxis.tickfont || { size: 7 };
            }
            
            for (var key in layout) {
                if (key.startsWith('xaxis')) {
                    if (!layout[key].tickangle) {
                        layout[key].tickangle = -90;
                    }
                    if (!layout[key].tickfont) {
                        layout[key].tickfont = { size: 7 };
                    }
                }
            }
            
            if (!layout.legend) {
                layout.legend = {};
            }
            layout.legend.orientation = 'v';
            layout.legend.x = 1.02;
            layout.legend.y = 1;
            layout.legend.xanchor = 'left';
            layout.legend.yanchor = 'top';
            layout.legend.font = layout.legend.font || { size: 9, color: '#2c3e50' };
            layout.legend.itemwidth = 30;
            layout.legend.bgcolor = 'rgba(255,255,255,0.95)';
            layout.legend.bordercolor = '#e0e0e0';
            layout.legend.borderwidth = 1;
            
            layout.plot_bgcolor = layout.plot_bgcolor || '#ffffff';
            layout.paper_bgcolor = layout.paper_bgcolor || '#ffffff';
            layout.dragmode = false;
            
            var dateCount = 0;
            if (traces.length > 0 && traces[0].x) {
                dateCount = traces[0].x.length;
            }
            var minWidth = Math.max(800, dateCount * 70 + 200);
            layout.width = Math.min(2000, minWidth);
            
            if (wrapper) {
                wrapper.style.overflowX = 'auto';
                wrapper.style.overflowY = 'hidden';
                wrapper.style.width = '100%';
                wrapper.style.position = 'relative';
                wrapper.style.background = 'white';
                wrapper.style.borderRadius = '8px';
                wrapper.style.border = '1px solid #e9ecef';
                wrapper.style.padding = '5px 0';
            }
            
            if (div) {
                div.style.minWidth = '100%';
                div.style.width = 'auto';
                div.style.padding = '5px 10px';
                div.style.display = 'inline-block';
            }
            
            Plotly.newPlot(plotId, traces, layout, { 
                responsive: true,
                displaylogo: false,
                modeBarButtonsToRemove: ['toImage', 'sendDataToCloud', 'zoom2d', 'pan2d', 'select2d', 'lasso2d', 'zoomIn2d', 'zoomOut2d', 'autoScale2d', 'resetScale2d']
            });
            
            var indicator = wrapper.querySelector('.scroll-indicator');
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.className = 'scroll-indicator';
                indicator.innerHTML = `
                    <span class="scroll-arrow" onclick="scrollHistogram('${divId}', -200)">◀</span>
                    <span class="badge bg-secondary">Горизонтальная прокрутка</span>
                    <span class="scroll-arrow" onclick="scrollHistogram('${divId}', 200)">▶</span>
                `;
                wrapper.appendChild(indicator);
            }
            
            return;
        }
    } catch (e) {
        console.log('📊 Ошибка парсинга гистограммы:', e);
    }
    
    div.innerHTML = `
        <div class="text-center text-muted py-3">
            <i class="bi bi-exclamation-triangle" style="font-size:2rem;display:block;margin-bottom:6px;color:#f39c12;"></i>
            <p style="font-size:0.9rem;">Не удалось загрузить гистограмму</p>
        </div>
    `;
}

// ============================================================
// ФУНКЦИЯ ДЛЯ СКРОЛЛА ГИСТОГРАММЫ
// ============================================================

function scrollHistogram(divId, delta) {
    var wrapper = document.getElementById(divId);
    if (!wrapper) {
        wrapper = document.querySelector('#' + divId + ' .histogram-scroll-wrapper');
    }
    if (!wrapper) {
        var div = document.getElementById(divId);
        if (div) {
            wrapper = div.closest('.histogram-scroll-wrapper');
        }
    }
    if (wrapper) {
        wrapper.scrollLeft += delta;
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
            
            if (data.scans_count !== undefined && data.scans_count > 0) {
                store.scansCount = data.scans_count;
            }
            
            var scansEl = document.getElementById('statScans_' + pathId);
            if (scansEl && store.scansCount !== undefined) {
                scansEl.textContent = store.scansCount;
            }
            var accordionScansEl = document.getElementById('accordionStatScans_' + pathId);
            if (accordionScansEl && store.scansCount !== undefined) {
                accordionScansEl.textContent = store.scansCount;
            }
            
            var chartDiv1 = document.getElementById('level1ChartDiv_' + pathId);
            if (chartDiv1) {
                if (data.chart) {
                    renderChart(data.chart, 'level1ChartDiv_' + pathId, pathId);
                } else {
                    chartDiv1.innerHTML = `
                        <div class="text-center text-muted py-3">
                            <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                            <p style="font-size:0.9rem;">Нет данных для графика</p>
                            <small>Нужно минимум 2 сканирования</small>
                            <br>
                            <small class="text-primary">Запустите планировщик для накопления данных</small>
                        </div>
                    `;
                }
            }
            
            var histDiv1 = document.getElementById('level1HistogramDiv_' + pathId);
            if (histDiv1) {
                if (data.sectioned_histogram) {
                    renderSectionedHistogram(data.sectioned_histogram, 'level1HistogramDiv_' + pathId, pathId);
                } else {
                    histDiv1.innerHTML = `
                        <div class="text-center text-muted py-3">
                            <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                            <p style="font-size:0.9rem;">Нет данных для гистограммы</p>
                            <small>Нужно минимум 2 сканирования</small>
                            <br>
                            <small class="text-primary">Запустите планировщик для накопления данных</small>
                        </div>
                    `;
                }
            }
            
            var level2Section = document.getElementById('level2Section_' + pathId);
            if (level2Section && level2Section.classList.contains('active')) {
                var currentPath = store.currentPath;
                if (currentPath && currentPath !== path) {
                    console.log('📊 Загрузка данных для уровня 2:', currentPath);
                    
                    getChartFromDB(currentPath)
                        .then(function(data2) {
                            console.log('📊 Получены данные уровня 2 для:', currentPath);
                            
                            var chartDiv2 = document.getElementById('level2ChartDiv_' + pathId);
                            if (chartDiv2) {
                                if (data2.chart) {
                                    renderChart(data2.chart, 'level2ChartDiv_' + pathId, pathId);
                                } else {
                                    chartDiv2.innerHTML = `
                                        <div class="text-center text-muted py-3">
                                            <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                                            <p style="font-size:0.9rem;">Нет данных для графика</p>
                                            <small>Нужно минимум 2 сканирования</small>
                                        </div>
                                    `;
                                }
                            }
                            
                            var histDiv2 = document.getElementById('level2HistogramDiv_' + pathId);
                            if (histDiv2) {
                                if (data2.sectioned_histogram) {
                                    renderSectionedHistogram(data2.sectioned_histogram, 'level2HistogramDiv_' + pathId, pathId);
                                } else {
                                    histDiv2.innerHTML = `
                                        <div class="text-center text-muted py-3">
                                            <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
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
                        });
                }
            }
            
            updateAccordionHeader(pathId);
            showToast('📊 Графики обновлены', 'success');
        })
        .catch(function(e) {
            console.error('❌ Ошибка загрузки графиков:', e);
            showToast('❌ Ошибка загрузки графиков: ' + e.message, 'error');
        });
}

// ============================================================
// ПЛАНИРОВЩИК - ДОБАВЛЕНИЕ ПУТИ
// ============================================================

function addPathToScheduler() {
    var input = document.getElementById('schedulerPathInput');
    var path = input.value.trim();
    
    if (!path) {
        showToast('⚠️ Введите путь для планировщика', 'warning');
        return;
    }
    
    path = normalizeUncPath(path);
    
    var schedulerPaths = getSchedulerPaths();
    var exists = schedulerPaths.some(function(p) { 
        return p.toLowerCase() === path.toLowerCase(); 
    });
    
    if (exists) {
        showToast('⚠️ Путь уже добавлен в планировщик', 'warning');
        return;
    }
    
    addSchedulerPath(path);
    input.value = '';
    showToast('✅ Путь добавлен в планировщик: ' + path, 'success');
}

// ============================================================
// ПОЛУЧЕНИЕ СПИСКА ПУТЕЙ ИЗ ПЛАНИРОВЩИКА (localStorage)
// ============================================================

function getSchedulerPaths() {
    try {
        return JSON.parse(localStorage.getItem('schedulerPaths') || '[]');
    } catch (e) {
        return [];
    }
}

function setSchedulerPaths(paths) {
    localStorage.setItem('schedulerPaths', JSON.stringify(paths));
}

function addSchedulerPath(path) {
    var paths = getSchedulerPaths();
    if (!paths.some(function(p) { return p.toLowerCase() === path.toLowerCase(); })) {
        paths.push(path);
        setSchedulerPaths(paths);
        renderSchedulerList();
    }
}

function removeSchedulerPathFromList(path) {
    var paths = getSchedulerPaths();
    paths = paths.filter(function(p) { return p.toLowerCase() !== path.toLowerCase(); });
    setSchedulerPaths(paths);
    renderSchedulerList();
}

// ============================================================
// ОТОБРАЖЕНИЕ СПИСКА ПУТЕЙ В ПЛАНИРОВЩИКЕ
// ============================================================

function renderSchedulerList() {
    var container = document.getElementById('schedulerList');
    if (!container) return;
    
    var paths = getSchedulerPaths();
    var countBadge = document.getElementById('schedulerCountBadge');
    if (countBadge) countBadge.textContent = paths.length;
    
    if (paths.length === 0) {
        container.innerHTML = `
            <div class="empty-scheduler" id="emptySchedulerMessage">
                <i class="bi bi-clock" style="font-size:1.5rem;display:block;margin-bottom:6px;"></i>
                <span style="font-size:0.8rem;color:#6c757d;">Нет путей в планировщике</span>
                <br>
                <small style="font-size:0.65rem;color:#adb5bd;">Добавьте путь выше</small>
            </div>
        `;
        return;
    }
    
    var html = '';
    paths.forEach(function(path) {
        var shortPath = path.length > 40 ? '...' + path.substring(path.length - 37) : path;
        var pathId = 'scheduler_' + path.replace(/[\\:]/g, '_');
        
        var isActive = false;
        var activeInterval = null;
        for (var taskId in scheduledTasks) {
            if (scheduledTasks[taskId].path === path && scheduledTasks[taskId].active) {
                isActive = true;
                activeInterval = scheduledTasks[taskId].interval;
                break;
            }
        }
        
        var statusClass = isActive ? 'running' : 'stopped';
        var statusText = isActive ? '🟢 ' + getIntervalLabel(activeInterval) : '⚪ Не активен';
        var escapedPath = path.replace(/\\/g, '\\\\');
        
        var intervals = ['1min', '30min', 'hour', 'day', 'week', 'month', '3months', '6months', '12months'];
        var intervalLabels = ['1м', '30м', 'Час', 'День', 'Нед', 'Мес', '3м', '6м', '12м'];
        var intervalTitles = ['1 минута', '30 минут', 'Час', 'День', 'Неделя', 'Месяц', '3 месяца', '6 месяцев', '12 месяцев'];
        
        html += `
            <div class="scheduler-item" id="schedulerItem_${pathId}">
                <div class="scheduler-item-path">
                    <span class="status-dot ${statusClass}" id="schedulerDot_${pathId}"></span>
                    <span class="path-text" title="${path}">${shortPath}</span>
                    <span class="scheduler-status-badge" id="schedulerStatusBadge_${pathId}">
                        ${statusText}
                    </span>
                    
                    <div class="scheduler-interval-buttons">`;
        
        for (var i = 0; i < intervals.length; i++) {
            var isActiveInterval = (isActive && activeInterval === intervals[i]);
            var activeClass = isActiveInterval ? 'active' : '';
            html += `
                        <button class="btn-scheduler-interval ${activeClass}" 
                                onclick="startSchedulerForPath('${escapedPath}', '${intervals[i]}', event)" 
                                title="${intervalTitles[i]}">
                            ${intervalLabels[i]}
                        </button>`;
        }
        
        html += `
                    </div>
                    
                    <div class="scheduler-actions">
                        <button class="btn-scheduler-start ${isActive ? 'hidden' : ''}" 
                                id="startSchedulerBtn_${pathId}" 
                                onclick="startSchedulerForPath('${escapedPath}', 'hour', event)" 
                                title="Запустить планировщик">
                            ▶
                        </button>
                        <button class="btn-scheduler-stop ${!isActive ? 'hidden' : ''}" 
                                id="stopSchedulerBtn_${pathId}" 
                                onclick="stopSchedulerForPath('${escapedPath}', event)" 
                                title="Остановить планировщик">
                            ⏹
                        </button>
                        <button class="btn-open-report" 
                                onclick="openReportFromScheduler('${escapedPath}')" 
                                title="Открыть отчет в правой панели">
                            <i class="bi bi-folder-open"></i> Открыть
                        </button>
                        <button class="btn-remove-scheduler" 
                                onclick="removeSchedulerPath('${escapedPath}')" 
                                title="Удалить из планировщика">
                            <i class="bi bi-x"></i>
                        </button>
                    </div>
                    <span class="scheduler-info" id="schedulerInfo_${pathId}"></span>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

// ============================================================
// ОТКРЫТЬ ОТЧЕТ ИЗ ПЛАНИРОВЩИКА
// ============================================================

function openReportFromScheduler(path) {
    var normalizedPath = normalizeUncPath(path);
    console.log('📂 Открытие отчета из планировщика для:', normalizedPath);
    showToast('📂 Открытие отчета для: ' + normalizedPath, 'info');
    
    document.getElementById('loading').style.display = 'block';
    
    fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function(response) { return response.json(); })
    .then(function(data) {
        document.getElementById('loading').style.display = 'none';
        
        if (data.error) {
            showToast('❌ Ошибка: ' + data.error, 'error');
            return;
        }
        
        if (!data.folders || data.folders.length === 0) {
            showToast('⚠️ Нет данных для этого пути. Запустите сканирование.', 'warning');
            return;
        }
        
        console.log('📊 Получены данные для отчета:', data);
        console.log('📊 Количество папок:', data.folders.length);
        console.log('📊 Сканирований:', data.scans_count);
        
        var existing = findOpenPathByPath(normalizedPath);
        
        if (existing) {
            showToast('ℹ️ Отчет уже открыт: ' + normalizedPath, 'info');
            var accordion = document.getElementById('accordion-' + existing.pathId);
            if (accordion) {
                accordion.scrollIntoView({ behavior: 'smooth', block: 'start' });
                var body = document.getElementById('accordionBody_' + existing.pathId);
                var toggle = document.getElementById('accordionToggle_' + existing.pathId);
                if (body) body.classList.add('show');
                if (toggle) toggle.classList.remove('collapsed');
            }
            updateExistingReport(existing.pathId, data, 'scheduler');
            return;
        }
        
        showMultipleReports([data], 'scheduler');
        
        setTimeout(function() {
            var newExisting = findOpenPathByPath(normalizedPath);
            if (newExisting) {
                var accordion = document.getElementById('accordion-' + newExisting.pathId);
                if (accordion) {
                    accordion.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    var body = document.getElementById('accordionBody_' + newExisting.pathId);
                    var toggle = document.getElementById('accordionToggle_' + newExisting.pathId);
                    if (body) body.classList.add('show');
                    if (toggle) toggle.classList.remove('collapsed');
                }
            }
            updateSidebar();
        }, 500);
        
        showToast('✅ Отчет открыт: ' + normalizedPath + ' (' + data.folders.length + ' папок)', 'success');
    })
    .catch(function(e) {
        document.getElementById('loading').style.display = 'none';
        console.error('❌ Ошибка открытия отчета:', e);
        showToast('❌ Ошибка: ' + e.message, 'error');
    });
}

// ============================================================
// ЗАПУСК ПЛАНИРОВЩИКА ДЛЯ ПУТИ
// ============================================================

function startSchedulerForPath(path, interval, event) {
    if (event) event.stopPropagation();
    
    var normalizedPath = normalizeUncPath(path);
    console.log('▶️ Запуск планировщика для:', normalizedPath, 'интервал:', interval);
    showToast('⏳ Запуск планировщика для: ' + normalizedPath, 'info');
    
    var pathId = 'scheduler_' + path.replace(/[\\:]/g, '_');
    var buttons = document.querySelectorAll('#schedulerItem_' + pathId + ' .btn-scheduler-interval');
    buttons.forEach(function(b) { b.classList.remove('active'); });
    if (event) {
        var btn = event.currentTarget;
        if (btn) btn.classList.add('active');
    }
    
    document.getElementById('loading').style.display = 'block';
    
    fetch('/api/scheduler/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function() {
        if (refreshIntervals[normalizedPath]) {
            clearInterval(refreshIntervals[normalizedPath]);
            delete refreshIntervals[normalizedPath];
        }
        
        for (var taskId in scheduledTasks) {
            if (scheduledTasks[taskId].path === normalizedPath) {
                delete scheduledTasks[taskId];
                break;
            }
        }
        
        return fetch('/api/scheduler/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: normalizedPath, interval: interval })
        });
    })
    .then(function(response) { return response.json(); })
    .then(function(data) {
        document.getElementById('loading').style.display = 'none';
        if (data.error) {
            showToast('❌ ' + data.error, 'error');
            return;
        }
        
        console.log('✅ Планировщик запущен:', data);
        
        if (!scheduledTasks[data.task_id]) {
            scheduledTasks[data.task_id] = {
                path: normalizedPath,
                interval: interval,
                active: true
            };
        } else {
            scheduledTasks[data.task_id].active = true;
            scheduledTasks[data.task_id].interval = interval;
        }
        
        setTimeout(function() {
            var buttons2 = document.querySelectorAll('#schedulerItem_' + pathId + ' .btn-scheduler-interval');
            buttons2.forEach(function(b) { 
                b.classList.remove('active');
                if (b.textContent.trim() === getIntervalLabelShort(interval)) {
                    b.classList.add('active');
                }
            });
        }, 100);
        
        showToast('✅ Планировщик запущен для: ' + normalizedPath + ' (' + getIntervalLabel(interval) + ')', 'success');
        renderSchedulerList();
        
        startAutoRefresh(normalizedPath);
    })
    .catch(function(e) {
        document.getElementById('loading').style.display = 'none';
        console.error('❌ Ошибка запуска:', e);
        showToast('❌ Ошибка: ' + e.message, 'error');
    });
}

// ============================================================
// АВТОМАТИЧЕСКОЕ ОБНОВЛЕНИЕ ГРАФИКОВ
// ============================================================

function startAutoRefresh(path) {
    var normalizedPath = normalizeUncPath(path);
    console.log('🔄 Запуск автообновления для:', normalizedPath);
    
    if (refreshIntervals[normalizedPath]) {
        clearInterval(refreshIntervals[normalizedPath]);
        delete refreshIntervals[normalizedPath];
    }
    
    refreshIntervals[normalizedPath] = setInterval(function() {
        var isActive = false;
        for (var taskId in scheduledTasks) {
            if (scheduledTasks[taskId].path === normalizedPath && scheduledTasks[taskId].active) {
                isActive = true;
                break;
            }
        }
        
        if (!isActive) {
            if (refreshIntervals[normalizedPath]) {
                clearInterval(refreshIntervals[normalizedPath]);
                delete refreshIntervals[normalizedPath];
                console.log('⏹️ Автообновление остановлено для:', normalizedPath);
            }
            return;
        }
        
        fetch('/api/scheduler/path_status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: normalizedPath })
        })
        .then(function(response) { return response.json(); })
        .then(function(data) {
            if (data.active && data.task_id) {
                var pathId = 'scheduler_' + normalizedPath.replace(/[\\:]/g, '_');
                var dot = document.getElementById('schedulerDot_' + pathId);
                var badge = document.getElementById('schedulerStatusBadge_' + pathId);
                if (dot) dot.className = 'status-dot running';
                if (badge) badge.innerHTML = '🟢 ' + getIntervalLabel(data.interval);
                
                var buttons = document.querySelectorAll('#schedulerItem_' + pathId + ' .btn-scheduler-interval');
                buttons.forEach(function(b) { 
                    b.classList.remove('active');
                    if (b.textContent.trim() === getIntervalLabelShort(data.interval)) {
                        b.classList.add('active');
                    }
                });
                
                if (data.last_scan) {
                    var existing = findOpenPathByPath(normalizedPath);
                    if (existing) {
                        fetch('/api/report', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: normalizedPath })
                        })
                        .then(function(response) { return response.json(); })
                        .then(function(reportData) {
                            if (reportData.error) return;
                            if (reportData.folders && reportData.folders.length > 0) {
                                updateExistingReport(existing.pathId, reportData, 'scheduler');
                                
                                var chartDiv1 = document.getElementById('level1ChartDiv_' + existing.pathId);
                                if (chartDiv1 && reportData.chart) {
                                    renderChart(reportData.chart, 'level1ChartDiv_' + existing.pathId, existing.pathId);
                                }
                                
                                var histDiv1 = document.getElementById('level1HistogramDiv_' + existing.pathId);
                                if (histDiv1 && reportData.sectioned_histogram) {
                                    renderSectionedHistogram(reportData.sectioned_histogram, 'level1HistogramDiv_' + existing.pathId, existing.pathId);
                                }
                                
                                var statScans = document.getElementById('statScans_' + existing.pathId);
                                if (statScans) statScans.textContent = reportData.scans_count || 0;
                                
                                var accordionScans = document.getElementById('accordionStatScans_' + existing.pathId);
                                if (accordionScans) accordionScans.textContent = reportData.scans_count || 0;
                                
                                updateSidebar();
                                console.log('📊 Графики обновлены для:', normalizedPath, 'сканирований:', reportData.scans_count);
                            }
                        })
                        .catch(function(e) {
                            console.error('❌ Ошибка обновления данных:', e);
                        });
                    } else {
                        openReportFromScheduler(normalizedPath);
                    }
                }
            }
        })
        .catch(function(e) {
            console.error('❌ Ошибка проверки статуса:', e);
        });
    }, 3000);
    
    console.log('✅ Автообновление запущено для:', normalizedPath);
}

// ============================================================
// ОСТАНОВКА ПЛАНИРОВЩИКА ДЛЯ ПУТИ
// ============================================================

function stopSchedulerForPath(path, event) {
    if (event) event.stopPropagation();
    
    var normalizedPath = normalizeUncPath(path);
    console.log('⏹️ Остановка планировщика для:', normalizedPath);
    showToast('⏳ Остановка планировщика для: ' + normalizedPath, 'info');
    
    document.getElementById('loading').style.display = 'block';
    
    fetch('/api/scheduler/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function(response) { return response.json(); })
    .then(function(data) {
        document.getElementById('loading').style.display = 'none';
        if (data.error) {
            showToast('❌ ' + data.error, 'error');
            return;
        }
        
        for (var taskId in scheduledTasks) {
            if (scheduledTasks[taskId].path === normalizedPath) {
                delete scheduledTasks[taskId];
                break;
            }
        }
        
        if (refreshIntervals[normalizedPath]) {
            clearInterval(refreshIntervals[normalizedPath]);
            delete refreshIntervals[normalizedPath];
            console.log('⏹️ Автообновление остановлено для:', normalizedPath);
        }
        
        var pathId = 'scheduler_' + normalizedPath.replace(/[\\:]/g, '_');
        var buttons = document.querySelectorAll('#schedulerItem_' + pathId + ' .btn-scheduler-interval');
        buttons.forEach(function(b) { b.classList.remove('active'); });
        
        showToast('⏹️ Планировщик остановлен для: ' + normalizedPath, 'warning');
        renderSchedulerList();
    })
    .catch(function(e) {
        document.getElementById('loading').style.display = 'none';
        console.error('❌ Ошибка остановки:', e);
        showToast('❌ Ошибка: ' + e.message, 'error');
    });
}

// ============================================================
// УДАЛЕНИЕ ПУТИ ИЗ ПЛАНИРОВЩИКА
// ============================================================

function removeSchedulerPath(path) {
    var normalizedPath = normalizeUncPath(path);
    
    if (refreshIntervals[normalizedPath]) {
        clearInterval(refreshIntervals[normalizedPath]);
        delete refreshIntervals[normalizedPath];
    }
    
    fetch('/api/scheduler/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath })
    })
    .then(function() {
        removeSchedulerPathFromList(normalizedPath);
        for (var taskId in scheduledTasks) {
            if (scheduledTasks[taskId].path === normalizedPath) {
                delete scheduledTasks[taskId];
                break;
            }
        }
        showToast('🗑️ Удален из планировщика: ' + normalizedPath, 'info');
    })
    .catch(function(e) {
        console.error('Ошибка остановки:', e);
        removeSchedulerPathFromList(normalizedPath);
        showToast('🗑️ Удален из планировщика: ' + normalizedPath, 'info');
    });
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ ПЛАНИРОВЩИКА
// ============================================================

function initScheduler() {
    console.log('🔄 Инициализация планировщика...');
    renderSchedulerList();
    
    fetch('/api/scheduler/status')
        .then(function(response) { return response.json(); })
        .then(function(tasks) {
            console.log('📋 Загружены задачи с сервера:', tasks);
            tasks.forEach(function(task) {
                if (task.active) {
                    scheduledTasks[task.task_id] = {
                        path: task.path,
                        interval: task.interval,
                        active: true
                    };
                    console.log('✅ Восстановлена задача:', task.task_id, task.path);
                    
                    setTimeout(function() {
                        startAutoRefresh(task.path);
                    }, 1000);
                }
            });
            renderSchedulerList();
        })
        .catch(function(e) {
            console.error('❌ Ошибка загрузки задач планировщика:', e);
        });
}

// ============================================================
// БОКОВАЯ ПАНЕЛЬ - СОДЕРЖАНИЕ
// ============================================================

function updateSidebar() {
    var container = document.getElementById('folderTreeContainer');
    if (!container) {
        console.error('❌ folderTreeContainer не найден');
        return;
    }
    
    var schedulerBlock = document.getElementById('schedulerBlock');
    container.innerHTML = '';
    
    if (schedulerBlock) {
        container.appendChild(schedulerBlock);
    }
    
    var totalFolders = 0;
    var pathIds = Object.keys(multipleDataStore);
    
    console.log('📊 Обновление боковой панели, путей:', pathIds.length);
    
    var contentBlock = document.createElement('div');
    contentBlock.className = 'content-block';
    contentBlock.id = 'contentBlock';
    contentBlock.innerHTML = `
        <div class="content-block-header">
            <span><i class="bi bi-list-ul"></i> 📂 Содержание</span>
            <span class="badge bg-secondary" id="folderCountBadge">${pathIds.length}</span>
        </div>
        <div class="content-block-body" id="contentBlockBody">
    `;
    
    if (pathIds.length === 0) {
        contentBlock.innerHTML += `
            <div class="empty-sidebar">
                <i class="bi bi-folder" style="font-size:2rem;display:block;margin-bottom:10px;"></i>
                Нет папок для отображения
            </div>
        `;
    } else {
        pathIds.sort();
        
        pathIds.forEach(function(pathId) {
            var store = multipleDataStore[pathId];
            if (!store) {
                console.warn('⚠️ Store не найден для pathId:', pathId);
                return;
            }
            
            var rootPath = store.rootPath || '';
            var currentPath = store.currentPath || rootPath;
            var baseFolders = store.baseFolders || [];
            var level2Folders = store.items || [];
            var currentLevel = store.level || 0;
            
            console.log(`📂 Путь: ${rootPath}, уровень 1 папок: ${baseFolders.length}, уровень 2 папок: ${level2Folders.length}`);
            
            if (baseFolders && baseFolders.length > 0) {
                var section1 = document.createElement('div');
                section1.id = 'folderTreeSection_' + pathId + '_level1';
                section1.className = 'folder-tree-section';
                
                var header1 = document.createElement('div');
                header1.className = 'folder-tree-header';
                header1.innerHTML = `
                    <span><i class="bi bi-folder"></i> <span class="path-text" title="${rootPath}">${rootPath}</span></span>
                    <span class="badge bg-secondary">${baseFolders.length}</span>
                `;
                section1.appendChild(header1);
                
                var treeContainer1 = document.createElement('div');
                treeContainer1.id = 'folderTreeContainer_' + pathId + '_level1';
                treeContainer1.className = 'folder-tree-content';
                section1.appendChild(treeContainer1);
                
                var body = contentBlock.querySelector('.content-block-body');
                if (body) {
                    body.appendChild(section1);
                }
                
                var sortedFolders1 = [...baseFolders].sort(function(a, b) {
                    return (b.size || b.size_bytes || 0) - (a.size || a.size_bytes || 0);
                });
                buildFolderTreeDirect(treeContainer1, sortedFolders1, rootPath, currentPath, 0);
                totalFolders += baseFolders.length;
            }
            
            if (currentLevel > 0 && level2Folders && level2Folders.length > 0) {
                var section2 = document.createElement('div');
                section2.id = 'folderTreeSection_' + pathId + '_level2';
                section2.className = 'folder-tree-section';
                
                var header2 = document.createElement('div');
                header2.className = 'folder-tree-header';
                header2.innerHTML = `
                    <span><i class="bi bi-folder"></i> <span class="path-text" title="${currentPath}">${currentPath}</span></span>
                    <span class="badge bg-secondary">${level2Folders.length}</span>
                `;
                section2.appendChild(header2);
                
                var treeContainer2 = document.createElement('div');
                treeContainer2.id = 'folderTreeContainer_' + pathId + '_level2';
                treeContainer2.className = 'folder-tree-content';
                section2.appendChild(treeContainer2);
                
                var body = contentBlock.querySelector('.content-block-body');
                if (body) {
                    body.appendChild(section2);
                }
                
                var sortedFolders2 = [...level2Folders].sort(function(a, b) {
                    return (b.size || b.size_bytes || 0) - (a.size || a.size_bytes || 0);
                });
                buildFolderTreeDirect(treeContainer2, sortedFolders2, currentPath, currentPath, 1);
                totalFolders += level2Folders.length;
            }
        });
    }
    
    contentBlock.innerHTML += `</div>`;
    container.appendChild(contentBlock);
    
    var badge = document.getElementById('folderCountBadge');
    if (badge) badge.textContent = totalFolders;
    
    console.log('✅ Боковая панель обновлена, всего папок:', totalFolders);
}

// ============================================================
// ПОСТРОЕНИЕ ДЕРЕВА ПАПОК
// ============================================================

function buildFolderTreeDirect(container, folders, rootPath, currentPath, level) {
    if (!container) {
        console.warn('⚠️ container не передан');
        return;
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
        var levelClass = 'level' + (level + 1);
        var levelLabel = 'L' + (level + 1);
        var iconColor = level === 0 ? '#fd7e14' : '#0d6efd';
        var paddingLeft = level * 16 + 8;
        
        var escapedPath = encodeURIComponent(folderPath);
        var pathId = getPathIdByRoot(rootPath);
        
        html += `
            <li style="padding:0;">
                <div class="folder-item ${isActive ? 'active' : ''}" 
                     onclick="browseFolderFromSidebar('${pathId}', '${escapedPath}')"
                     title="${f.name}"
                     style="display:flex;align-items:center;padding:3px 8px;border-radius:4px;cursor:pointer;transition:background 0.15s;font-size:0.82rem;gap:6px;${isActive ? 'background:#cce5ff;font-weight:600;' : ''} padding-left:${paddingLeft}px;">
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
}

function getPathIdByRoot(rootPath) {
    var pathIds = Object.keys(multipleDataStore);
    for (var i = 0; i < pathIds.length; i++) {
        var store = multipleDataStore[pathIds[i]];
        if (store && store.rootPath === rootPath) {
            return pathIds[i];
        }
    }
    return null;
}

function buildFolderTree(pathId, folders, rootPath, currentPath, level) {
    var container = document.getElementById('folderTreeContainer_' + pathId);
    if (!container) {
        console.warn('⚠️ folderTreeContainer_' + pathId + ' не найден');
        return;
    }
    buildFolderTreeDirect(container, folders, rootPath, currentPath, level);
}

function browseFolderFromSidebar(pathId, encodedPath) {
    var path = decodeURIComponent(encodedPath);
    console.log('📂 Переход из сайдбара:', pathId, path);
    
    var store = multipleDataStore[pathId];
    if (!store) {
        showToast('⚠️ Ошибка: данные не найдены', 'error');
        return;
    }
    
    if (path === store.currentPath) {
        return;
    }
    
    browseFolderMultipleDB(pathId, path);
}

// ============================================================
// РЕНДЕРИНГ СПИСКОВ ПАПОК
// ============================================================

function buildNavigationHTML(pathId, currentPathName, rootPath, level) {
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
    
    html += '<span class="nav-separator">|</span>';
    var levelText = level === 0 ? 'Уровень 1' : 'Уровень 2';
    html += '<button class="btn btn-sm btn-success" onclick="exportExcelForPath(\'' + pathId + '\', \'' + encodeURIComponent(currentPathName) + '\')" style="font-size:0.75rem;padding:2px 10px;">';
    html += '<i class="bi bi-file-earmark-excel"></i> Excel (' + levelText + ')</button>';
    
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
        navContainer.innerHTML = buildNavigationHTML(pathId, currentPathName, rootPath, 0);
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
    
    updateSidebar();
}

function renderFolderListLevel2(pathId, folders, basePath, currentPathName, rootPath) {
    var container = document.getElementById('itemsContainerLevel2_' + pathId);
    if (!container) {
        console.warn('⚠️ itemsContainerLevel2_' + pathId + ' не найден');
        return;
    }
    
    var navContainer = document.getElementById('navContainerLevel2_' + pathId);
    if (navContainer) {
        navContainer.innerHTML = buildNavigationHTML(pathId, currentPathName, rootPath, 1);
    }
    
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
// ПЕРЕХОД В ПАПКУ УРОВНЯ 2
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
    
    browseFromDB(normalizedPath)
        .then(function(data) {
            document.getElementById('loading').style.display = 'none';
            if (data.error) { showToast('Ошибка: ' + data.error, 'error'); return; }
            
            store.currentPath = data.path;
            store.items = data.items || [];
            store.level = 1;
            
            var levelBadge = document.getElementById('levelBadge_' + pathId);
            if (levelBadge) levelBadge.textContent = 'Уровень 2';
            var reportTitle = document.getElementById('reportTitle_' + pathId);
            if (reportTitle) reportTitle.textContent = data.path;
            
            var level2Section = document.getElementById('level2Section_' + pathId);
            if (level2Section) {
                level2Section.classList.add('active');
                level2Section.style.display = 'block';
            }
            var level2Path = document.getElementById('level2Path_' + pathId);
            if (level2Path) level2Path.textContent = data.path;
            
            if (data.chart) {
                renderChart(data.chart, 'level2ChartDiv_' + pathId, pathId);
            } else {
                var chartDiv = document.getElementById('level2ChartDiv_' + pathId);
                if (chartDiv) chartDiv.innerHTML = '';
            }
            
            if (data.sectioned_histogram) {
                renderSectionedHistogram(data.sectioned_histogram, 'level2HistogramDiv_' + pathId, pathId);
            } else {
                var histDiv = document.getElementById('level2HistogramDiv_' + pathId);
                if (histDiv) histDiv.innerHTML = '';
            }
            
            var navContainer = document.getElementById('navContainerLevel2_' + pathId);
            if (navContainer) {
                navContainer.innerHTML = buildNavigationHTML(pathId, data.path, store.rootPath, 1);
            }
            
            renderFolderListLevel2(pathId, data.items || [], data.path, data.path, store.rootPath);
            var countEl = document.getElementById('level2ItemsCount_' + pathId);
            if (countEl) countEl.textContent = data.items ? data.items.length : 0;
            
            updateSidebar();
            
            showToast('📁 ' + normalizedPath + ' - ' + (data.items_count || 0) + ' элементов', 'info');
        })
        .catch(function(e) {
            document.getElementById('loading').style.display = 'none';
            showToast('❌ Ошибка: ' + e.message, 'error');
        });
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
        var level2Section = document.getElementById('level2Section_' + pathId);
        if (level2Section) {
            level2Section.classList.remove('active');
            level2Section.style.display = 'none';
        }
        var levelBadge = document.getElementById('levelBadge_' + pathId);
        if (levelBadge) levelBadge.textContent = 'Уровень 1';
        var reportTitle = document.getElementById('reportTitle_' + pathId);
        if (reportTitle) reportTitle.textContent = store.rootPath;
        
        renderFolderListLevel1(pathId, store.baseFolders, store.rootPath, store.rootPath, store.rootPath);
        var countEl = document.getElementById('level1ItemsCount_' + pathId);
        if (countEl) countEl.textContent = store.baseFolders ? store.baseFolders.length : 0;
        buildFolderTree(pathId, store.baseFolders, store.rootPath, store.rootPath, 0);
        
        loadChartsFromDB(pathId, store.rootPath);
    } else {
        renderFolderListLevel2(pathId, store.items, store.currentPath, store.currentPath, store.rootPath);
        var countEl = document.getElementById('level2ItemsCount_' + pathId);
        if (countEl) countEl.textContent = store.items ? store.items.length : 0;
    }
    
    updateSidebar();
    
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
    store.items = [];
    
    var level2Section = document.getElementById('level2Section_' + pathId);
    if (level2Section) {
        level2Section.classList.remove('active');
        level2Section.style.display = 'none';
    }
    var levelBadge = document.getElementById('levelBadge_' + pathId);
    if (levelBadge) levelBadge.textContent = 'Уровень 1';
    var reportTitle = document.getElementById('reportTitle_' + pathId);
    if (reportTitle) reportTitle.textContent = store.rootPath;
    
    renderFolderListLevel1(pathId, store.baseFolders, store.rootPath, store.rootPath, store.rootPath);
    var countEl = document.getElementById('level1ItemsCount_' + pathId);
    if (countEl) countEl.textContent = store.baseFolders ? store.baseFolders.length : 0;
    
    updateSidebar();
    
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
            var level2Section = document.getElementById('level2Section_' + pathId);
            if (level2Section) {
                level2Section.classList.remove('active');
                level2Section.style.display = 'none';
            }
            var levelBadge = document.getElementById('levelBadge_' + pathId);
            if (levelBadge) levelBadge.textContent = 'Уровень 1';
            var reportTitle = document.getElementById('reportTitle_' + pathId);
            if (reportTitle) reportTitle.textContent = store.rootPath;
            renderFolderListLevel1(pathId, store.baseFolders, store.rootPath, store.rootPath, store.rootPath);
            buildFolderTree(pathId, store.baseFolders, store.rootPath, store.rootPath, 0);
            loadChartsFromDB(pathId, store.rootPath);
        } else {
            renderFolderListLevel2(pathId, store.items, store.currentPath, store.currentPath, store.rootPath);
            var countEl = document.getElementById('level2ItemsCount_' + pathId);
            if (countEl) countEl.textContent = store.items ? store.items.length : 0;
        }
        
        updateSidebar();
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
            
            if (data.sectioned_histogram) {
                renderSectionedHistogram(data.sectioned_histogram, 'level2HistogramDiv_' + pathId, pathId);
            }
            
            renderFolderListLevel2(pathId, data.items || [], data.path, data.path, store.rootPath);
            var countEl = document.getElementById('level2ItemsCount_' + pathId);
            if (countEl) countEl.textContent = data.items ? data.items.length : 0;
            
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
            
            updateSidebar();
            showToast('📂 Переход в ' + normalizedPath, 'info');
        })
        .catch(function(e) {
            document.getElementById('loading').style.display = 'none';
            showToast('❌ Ошибка: ' + e.message, 'error');
        });
}

function updatePathDisplay(pathId) {
    var store = multipleDataStore[pathId];
    if (!store) return;
    
    var levelBadge = document.getElementById('levelBadge_' + pathId);
    if (levelBadge) levelBadge.textContent = store.level === 0 ? 'Уровень 1' : 'Уровень 2';
    
    var reportTitle = document.getElementById('reportTitle_' + pathId);
    if (reportTitle) reportTitle.textContent = store.currentPath;
    
    var statItems = document.getElementById('statItems_' + pathId);
    if (statItems) statItems.textContent = store.items ? store.items.length : 0;
    
    var statSize = document.getElementById('statSize_' + pathId);
    if (statSize) statSize.textContent = store.totalSizeStr || '0';
    
    var statScans = document.getElementById('statScans_' + pathId);
    if (statScans) statScans.textContent = store.scansCount || 0;
    
    var navContainer = document.getElementById('navContainerLevel1_' + pathId);
    if (navContainer) {
        navContainer.innerHTML = buildNavigationHTML(pathId, store.currentPath, store.rootPath, store.level);
    }
    
    updateAccordionHeader(pathId);
}

// ============================================================
// АККОРДЕОН - УПРАВЛЕНИЕ
// ============================================================

function toggleAccordion(pathId) {
    var body = document.getElementById('accordionBody_' + pathId);
    var toggle = document.getElementById('accordionToggle_' + pathId);
    
    if (!body || !toggle) return;
    
    if (body.classList.contains('show')) {
        body.classList.remove('show');
        toggle.classList.add('collapsed');
    } else {
        body.classList.add('show');
        toggle.classList.remove('collapsed');
    }
}

function updateAccordionHeader(pathId) {
    var store = multipleDataStore[pathId];
    if (!store) return;
    
    var pathNameEl = document.getElementById('accordionPathName_' + pathId);
    var statFoldersEl = document.getElementById('accordionStatFolders_' + pathId);
    var statSizeEl = document.getElementById('accordionStatSize_' + pathId);
    var statScansEl = document.getElementById('accordionStatScans_' + pathId);
    
    if (pathNameEl) pathNameEl.textContent = store.rootPath;
    if (statFoldersEl) statFoldersEl.textContent = store.baseFolders ? store.baseFolders.length : 0;
    if (statSizeEl) statSizeEl.textContent = store.totalSizeStr || '0';
    if (statScansEl) statScansEl.textContent = store.scansCount || 0;
}

// ============================================================
// ОСНОВНАЯ ФУНКЦИЯ ОТОБРАЖЕНИЯ ОТЧЕТОВ (АККОРДЕОН)
// ============================================================

function showMultipleReports(results, sourceType) {
    var container = document.getElementById('mainContent');
    sourceType = sourceType || 'scan';
    
    var uniqueResults = [];
    var seenPaths = [];
    
    results.forEach(function(data) {
        if (!seenPaths.includes(data.path)) {
            seenPaths.push(data.path);
            uniqueResults.push(data);
        }
    });
    
    if (uniqueResults.length < results.length) {
        showToast('⚠️ Удалены дубликаты путей', 'warning');
    }
    
    var reportSection = document.getElementById('reportSection');
    if (reportSection) reportSection.style.display = 'block';
    
    uniqueResults.sort(function(a, b) {
        return a.path.localeCompare(b.path);
    });
    
    uniqueResults.forEach(function(data) {
        var path = data.path;
        
        var existing = findOpenPathByPath(path);
        if (existing) {
            updateExistingReport(existing.pathId, data, sourceType);
            return;
        }
        
        var pathId = 'path_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        var level = data.level || 1;
        
        console.log('📊 Создание нового отчета для pathId:', pathId);
        
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
            sectionedHistogram: data.sectioned_histogram || null,
            folderHistory: data.folder_history || []
        };
        
        addOpenPath(pathId, data.path, sourceType);
        
        var cardHtml = createAccordionHTML(pathId, data, level, sourceType);
        if (container) container.innerHTML += cardHtml;
        
        var body = document.getElementById('accordionBody_' + pathId);
        var toggle = document.getElementById('accordionToggle_' + pathId);
        if (body) body.classList.add('show');
        if (toggle) toggle.classList.remove('collapsed');
        
        updateAccordionHeader(pathId);
        
        renderFolderListLevel1(pathId, data.folders || [], data.path, data.path, data.path);
        
        setTimeout(function() {
            loadChartsFromDB(pathId, data.path);
        }, 300);
    });
    
    setTimeout(function() {
        updateSidebar();
    }, 100);
    
    showToast('✅ Загружено ' + uniqueResults.length + ' отчетов', 'success');
}

function createAccordionHTML(pathId, data, level, sourceType) {
    var encodedPath = encodeURIComponent(data.path);
    var badgeClass = sourceType === 'scan' ? 'scan' : (sourceType === 'scheduler' ? 'scheduler' : 'db');
    var badgeText = sourceType === 'scan' ? 'Скан' : (sourceType === 'scheduler' ? 'План' : 'БД');
    
    return `
        <div class="accordion-report" id="accordion-${pathId}">
            <div class="accordion-header" onclick="toggleAccordion('${pathId}')">
                <div class="header-left">
                    <span class="path-badge ${badgeClass}">${badgeText}</span>
                    <span class="path-name" id="accordionPathName_${pathId}" title="${data.path}">${data.path}</span>
                    <div class="stat-info">
                        <span><i class="bi bi-folder"></i> <span id="accordionStatFolders_${pathId}">${data.folders ? data.folders.length : 0}</span></span>
                        <span><i class="bi bi-hdd"></i> <span id="accordionStatSize_${pathId}">${data.total_size_str || '0'}</span></span>
                        <span><i class="bi bi-clock-history"></i> <span id="accordionStatScans_${pathId}">${data.scans_count || 0}</span></span>
                    </div>
                </div>
                <div class="header-right">
                    <button class="btn btn-sm btn-success" onclick="event.stopPropagation(); exportExcelForPath('${pathId}', '${encodedPath}')" style="font-size:0.7rem;padding:2px 10px;">
                        <i class="bi bi-file-earmark-excel"></i> Excel
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); removeOpenPath('${pathId}')" title="Закрыть каталог" style="font-size:0.7rem;padding:2px 10px;">
                        <i class="bi bi-x-lg"></i>
                    </button>
                    <span class="accordion-toggle" id="accordionToggle_${pathId}">
                        <i class="bi bi-chevron-down"></i>
                    </span>
                </div>
            </div>
            <div class="accordion-body" id="accordionBody_${pathId}">
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
                        <button class="btn btn-sm btn-success ms-auto" onclick="exportExcelForPath('${pathId}', '${encodedPath}')" style="font-size:0.7rem;padding:2px 10px;">
                            <i class="bi bi-file-earmark-excel"></i> Excel (L1)
                        </button>
                    </div>
                    <div class="chart-card">
                        <h6><i class="bi bi-graph-up"></i> График динамики</h6>
                        <div class="chart-wrapper">
                            <div id="level1ChartDiv_${pathId}"></div>
                        </div>
                    </div>
                    <div class="chart-card">
                        <h6><i class="bi bi-layers"></i> Гистограмма по папкам</h6>
                        <div class="histogram-wrapper-scroll">
                            <div id="level1HistogramDiv_${pathId}"></div>
                        </div>
                        <small class="text-muted">Каждая подгистограмма - одна папка, столбцы внутри - сканирования (ВПРИТЫК)</small>
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
                            <button class="btn btn-sm btn-success ms-auto" onclick="exportExcelForPath('${pathId}', document.getElementById('level2Path_${pathId}').textContent)" style="font-size:0.7rem;padding:2px 10px;">
                                <i class="bi bi-file-earmark-excel"></i> Excel (L2)
                            </button>
                        </div>
                        <div class="chart-card">
                            <h6><i class="bi bi-graph-up"></i> График динамики</h6>
                            <div class="chart-wrapper">
                                <div id="level2ChartDiv_${pathId}"></div>
                            </div>
                        </div>
                        <div class="chart-card">
                            <h6><i class="bi bi-layers"></i> Гистограмма по папкам</h6>
                            <div class="histogram-wrapper-scroll">
                                <div id="level2HistogramDiv_${pathId}"></div>
                            </div>
                            <small class="text-muted">Каждая подгистограмма - одна папка, столбцы внутри - сканирования (ВПРИТЫК)</small>
                        </div>
                    </div>

                    <div class="folders-section level-2">
                        <div class="folders-header">
                            <h6><i class="bi bi-folder2-open"></i> Содержимое (Уровень 2) - <span id="level2ItemsCount_${pathId}">0</span> папок</h6>
                            <div class="folders-nav" id="navContainerLevel2_${pathId}"></div>
                        </div>
                        <div id="itemsContainerLevel2_${pathId}" class="list-group"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function updateExistingReport(pathId, data, sourceType) {
    console.log('🔄 Обновление существующего отчета для pathId:', pathId);
    
    var store = multipleDataStore[pathId];
    if (!store) {
        console.error('❌ Store не найден для pathId:', pathId);
        return;
    }
    
    store.rootPath = data.path;
    store.currentPath = data.path;
    store.items = data.folders || [];
    store.baseFolders = data.folders || [];
    store.scansCount = data.scans_count || 0;
    store.totalSizeStr = data.total_size_str || '0';
    store.chart = data.chart;
    store.sectionedHistogram = data.sectioned_histogram || null;
    store.folderHistory = data.folder_history || [];
    store.level = 0;
    
    updateAccordionHeader(pathId);
    
    var itemsEl = document.getElementById('statItems_' + pathId);
    if (itemsEl) itemsEl.textContent = data.folders ? data.folders.length : 0;
    
    var sizeEl = document.getElementById('statSize_' + pathId);
    if (sizeEl) sizeEl.textContent = data.total_size_str || '0';
    
    var scansEl = document.getElementById('statScans_' + pathId);
    if (scansEl) scansEl.textContent = data.scans_count || 0;
    
    var titleEl = document.getElementById('reportTitle_' + pathId);
    if (titleEl) titleEl.textContent = data.path;
    
    var pathNameEl = document.getElementById('accordionPathName_' + pathId);
    if (pathNameEl) pathNameEl.textContent = data.path;
    
    var level2Section = document.getElementById('level2Section_' + pathId);
    if (level2Section) {
        level2Section.classList.remove('active');
        level2Section.style.display = 'none';
    }
    
    renderFolderListLevel1(pathId, data.folders || [], data.path, data.path, data.path);
    
    buildFolderTree(pathId, data.folders || [], data.path, data.path, 0);
    
    var openItem = findOpenPathById(pathId);
    if (openItem) {
        openItem.type = sourceType || 'scheduler';
        updateOpenPathsList();
    }
    
    setTimeout(function() {
        var chartDiv1 = document.getElementById('level1ChartDiv_' + pathId);
        if (chartDiv1) {
            if (data.chart) {
                renderChart(data.chart, 'level1ChartDiv_' + pathId, pathId);
            } else {
                chartDiv1.innerHTML = `
                    <div class="text-center text-muted py-3">
                        <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                        <p style="font-size:0.9rem;">Нет данных для графика</p>
                        <small>Нужно минимум 2 сканирования</small>
                    </div>
                `;
            }
        }
        
        var histDiv1 = document.getElementById('level1HistogramDiv_' + pathId);
        if (histDiv1) {
            if (data.sectioned_histogram) {
                renderSectionedHistogram(data.sectioned_histogram, 'level1HistogramDiv_' + pathId, pathId);
            } else {
                histDiv1.innerHTML = `
                    <div class="text-center text-muted py-3">
                        <i class="bi bi-bar-chart" style="font-size:2rem;display:block;margin-bottom:6px;"></i>
                        <p style="font-size:0.9rem;">Нет данных для гистограммы</p>
                        <small>Нужно минимум 2 сканирования</small>
                    </div>
                `;
            }
        }
        
        updateSidebar();
    }, 300);
    
    showToast('🔄 Отчет обновлен для: ' + data.path, 'info');
}

// ============================================================
// ОТКРЫТИЕ / ЗАКРЫТИЕ ОТЧЕТА
// ============================================================

function openReport(path) {
    var normalizedPath = normalizeUncPath(path);
    
    var existing = findOpenPathByPath(normalizedPath);
    if (existing) {
        showToast('ℹ️ Каталог уже открыт: ' + normalizedPath, 'info');
        var accordion = document.getElementById('accordion-' + existing.pathId);
        if (accordion) {
            accordion.scrollIntoView({ behavior: 'smooth', block: 'start' });
            var body = document.getElementById('accordionBody_' + existing.pathId);
            var toggle = document.getElementById('accordionToggle_' + existing.pathId);
            if (body) body.classList.add('show');
            if (toggle) toggle.classList.remove('collapsed');
        }
        return;
    }
    
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
        showMultipleReports([data], 'history');
    })
    .catch(function(e) {
        document.getElementById('loading').style.display = 'none';
        showToast('❌ Ошибка: ' + e.message, 'error');
    });
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
        setTimeout(function() { if (flash.parentElement) flash.remove(); }, 400);
        
        var shockwave = document.createElement('div');
        shockwave.className = 'shockwave';
        document.body.appendChild(shockwave);
        setTimeout(function() { if (shockwave.parentElement) shockwave.remove(); }, 1200);
        
        document.body.classList.add('shake');
        setTimeout(function() { document.body.classList.remove('shake'); }, 900);
        
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
            setTimeout(function(el) { if (el && el.parentElement) el.remove(); }, 1500, spark);
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
            setTimeout(function(el) { if (el && el.parentElement) el.remove(); }, 4500, confetti);
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
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Сканирование...';
    }
    if (progress) progress.style.display = 'block';

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
            showMultipleReports(valid, 'scan');
        })
        .finally(function() {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-play-fill"></i> Сканировать';
            }
            if (progress) progress.style.display = 'none';
        });
});

// ============================================================
// АВТООБНОВЛЕНИЕ СТАТУСА ПЛАНИРОВЩИКА
// ============================================================

setInterval(function() {
    var paths = getSchedulerPaths();
    paths.forEach(function(path) {
        fetch('/api/scheduler/path_status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path })
        })
        .then(function(response) { return response.json(); })
        .then(function(data) {
            var pathId = 'scheduler_' + path.replace(/[\\:]/g, '_');
            var dot = document.getElementById('schedulerDot_' + pathId);
            var badge = document.getElementById('schedulerStatusBadge_' + pathId);
            var startBtn = document.getElementById('startSchedulerBtn_' + pathId);
            var stopBtn = document.getElementById('stopSchedulerBtn_' + pathId);
            
            if (data.active) {
                if (dot) dot.className = 'status-dot running';
                if (badge) badge.innerHTML = '🟢 ' + getIntervalLabel(data.interval);
                if (startBtn) startBtn.classList.add('hidden');
                if (stopBtn) stopBtn.classList.remove('hidden');
            } else {
                if (dot) dot.className = 'status-dot stopped';
                if (badge) badge.innerHTML = '⚪ Не активен';
                if (startBtn) startBtn.classList.remove('hidden');
                if (stopBtn) stopBtn.classList.add('hidden');
            }
        })
        .catch(function(e) {
            console.error('Ошибка обновления статуса', e);
        });
    });
}, 30000);

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================

updatePathTags();
loadPaths();

setTimeout(function() {
    initScheduler();
}, 500);

console.log('✅ Приложение загружено.');
console.log('✅ Добавлены выпадающие вкладки (аккордеон) для каждого пути');
console.log('✅ Исправлена работа уровня 2');
console.log('✅ Добавлены проверки на существование элементов');
console.log('⏰ Добавлен ОТДЕЛЬНЫЙ ПЛАНИРОВЩИК сканирования');
console.log('⏰ Добавлено поле ввода пути и кнопка "Открыть" для открытия отчета');
console.log('⏰ Добавлен интервал "1 мин" для тестирования');
console.log('🔄 Кнопка интервала горит синим пока планировщик активен');
console.log('🔄 Графики обновляются автоматически при каждом сканировании');
console.log('📊 Гистограмма сохраняет горизонтальный скролл при обновлении');
console.log('💥 Пасхалка: нажми F2 для ЭПИЧНОГО взрыва "ЖАХ!"');

window.addEventListener('scroll', function() {
    var btn = document.getElementById('scrollTopBtn');
    if (btn) {
        if (window.scrollY > 300) {
            btn.classList.add('show');
        } else {
            btn.classList.remove('show');
        }
    }
});