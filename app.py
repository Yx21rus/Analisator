import matplotlib
matplotlib.use('Agg')

from flask import Flask, render_template, request, jsonify, send_file
import os
import datetime
import psycopg2
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import io
import base64
import json
import traceback
import subprocess
import re
import plotly.graph_objects as go
from decimal import Decimal
from io import BytesIO
import xlsxwriter

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'

# ============================================================
# НАСТРОЙКА ПАПКИ ДЛЯ ОТЧЕТОВ
# ============================================================

# Создаем папку для отчетов, если ее нет
REPORTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'reports')
if not os.path.exists(REPORTS_DIR):
    os.makedirs(REPORTS_DIR)
    print(f"📁 Создана папка для отчетов: {REPORTS_DIR}")

plt.rcParams['font.sans-serif'] = ['Arial', 'Tahoma', 'Verdana', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

DB_CONFIG = {
    'host': 'localhost',
    'port': '5432',
    'database': 'disk_analyzer',
    'user': 'postgres',
    'password': ',fyfy,fyfy'
}

# ========================================================================
# ФУНКЦИИ РАБОТЫ С БАЗОЙ ДАННЫХ
# ========================================================================

def get_db_connection():
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        return conn
    except Exception as e:
        print(f"❌ Ошибка подключения: {e}")
        return None

def init_db():
    conn = get_db_connection()
    if not conn:
        return False
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'scans'
            )
        """)
        if not cursor.fetchone()[0]:
            cursor.execute('''
                CREATE TABLE scans (
                    id SERIAL PRIMARY KEY,
                    scan_date TIMESTAMP NOT NULL,
                    disk_path VARCHAR(255) NOT NULL,
                    item_name VARCHAR(255) NOT NULL,
                    item_type VARCHAR(20) NOT NULL,
                    parent_path TEXT NOT NULL,
                    level INTEGER DEFAULT 1,
                    size_gb NUMERIC(15, 6) NOT NULL,
                    size_bytes BIGINT NOT NULL
                )
            ''')
            cursor.execute('CREATE INDEX idx_scans_date ON scans(scan_date)')
            cursor.execute('CREATE INDEX idx_scans_disk ON scans(disk_path)')
            cursor.execute('CREATE INDEX idx_scans_parent ON scans(parent_path)')
            cursor.execute('CREATE INDEX idx_scans_level ON scans(level)')
            print("✅ Таблица scans создана")
        
        cursor.execute("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'folder_size_history'
            )
        """)
        if not cursor.fetchone()[0]:
            cursor.execute('''
                CREATE TABLE folder_size_history (
                    id SERIAL PRIMARY KEY,
                    scan_date TIMESTAMP NOT NULL,
                    folder_path TEXT NOT NULL,
                    total_size_gb NUMERIC(15, 6) NOT NULL,
                    total_size_bytes BIGINT NOT NULL
                )
            ''')
            cursor.execute('CREATE INDEX idx_folder_history_path ON folder_size_history(folder_path)')
            cursor.execute('CREATE INDEX idx_folder_history_date ON folder_size_history(scan_date)')
            print("✅ Таблица folder_size_history создана")
        
        conn.commit()
        return True
    except Exception as e:
        print(f"❌ Ошибка инициализации БД: {e}")
        return False
    finally:
        cursor.close()
        conn.close()

# ========================================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ========================================================================

def get_size(path):
    total = 0
    try:
        for entry in os.scandir(path):
            if entry.is_file(follow_symlinks=False):
                total += entry.stat().st_size
            elif entry.is_dir(follow_symlinks=False):
                total += get_size(entry.path)
    except (PermissionError, OSError):
        pass
    return total

def format_size_auto(bytes_size):
    if bytes_size >= 1024**3:
        return f"{bytes_size / (1024**3):.2f} ГБ"
    elif bytes_size >= 1024**2:
        return f"{bytes_size / (1024**2):.2f} МБ"
    elif bytes_size >= 1024:
        return f"{bytes_size / 1024:.2f} КБ"
    else:
        return f"{bytes_size} Б"

def format_size_gb(bytes_size):
    return bytes_size / (1024**3)

def normalize_path(path):
    if not path:
        return path
    path = path.strip()
    if path.endswith('\\') and not path.endswith(':\\'):
        if path.startswith('\\\\') and path.count('\\') >= 3:
            if path.endswith('\\'):
                path = path[:-1]
        else:
            path = path[:-1]
    return path

def fix_path(path):
    if not path:
        return path
    
    if path.startswith('\\\\'):
        path = normalize_path(path)
        return path
    
    if len(path) >= 2 and path[1] == ':':
        if len(path) == 2 or path[2] != '\\':
            path = path[:2] + '\\' + path[2:]
    
    path = path.replace('/', '\\')
    path = normalize_path(path)
    return path

def get_disk_path(path):
    if not path:
        return ''
    
    path = normalize_path(path)
    
    if path.startswith('\\\\'):
        parts = path.split('\\')
        if len(parts) >= 4:
            return f"\\\\{parts[2]}\\{parts[3]}"
        elif len(parts) >= 3:
            return f"\\\\{parts[2]}"
        return path
    
    if len(path) >= 2 and path[1] == ':':
        return path[:3]
    
    return path

def detect_level(path, base_path):
    if not path or not base_path:
        return 1
    
    path = normalize_path(path)
    base_path = normalize_path(base_path)
    
    if path == base_path:
        return 1
    
    if path.startswith('\\\\'):
        clean_path = path[2:]
        parts = clean_path.split('\\')
        if len(parts) >= 2:
            level = len(parts) - 1
            return max(1, level)
        return 1
    
    if ':' in path:
        path_without_drive = path.split(':', 1)[1].strip('\\')
        if not path_without_drive:
            return 1
        level = path_without_drive.count('\\') + 1
        return level
    
    if path.startswith(base_path):
        relative = path[len(base_path):].strip('\\')
        if not relative:
            return 1
        level = relative.count('\\') + 1
        return level
    
    return 1

# ========================================================================
# ФУНКЦИИ СКАНИРОВАНИЯ
# ========================================================================

def scan_directory_with_levels(base_path, base_for_level=None):
    base_path = fix_path(base_path)
    base_for_level = fix_path(base_for_level) if base_for_level else base_path
    path = Path(base_path)
    
    print(f"🔍 Сканирование: {path}")
    print(f"📏 Базовый путь для расчета уровня: {base_for_level}")
    
    if str(path).startswith('\\\\') and str(path).count('\\') == 2:
        server = str(path).replace('\\\\', '')
        shares = get_network_shares(server)
        
        if not shares:
            print(f"❌ Не найдено доступных папок на {server}")
            return None, None
        
        folders = []
        total_size = 0
        for share in shares:
            try:
                size = get_size(share['path'])
                level = detect_level(share['path'], base_for_level)
                folders.append({
                    'name': share['name'],
                    'size': size,
                    'size_gb': round(format_size_gb(size), 4),
                    'size_str': format_size_auto(size),
                    'path': share['path'],
                    'level': level
                })
                total_size += size
                print(f"  📁 {share['name']}: {format_size_auto(size)} (уровень {level})")
            except Exception as e:
                print(f"  ⚠️ Нет доступа к {share['name']}: {e}")
                folders.append({
                    'name': share['name'],
                    'size': 0,
                    'size_gb': 0,
                    'size_str': 'НЕТ ДОСТУПА',
                    'path': share['path'],
                    'level': 1
                })
        
        return folders, (len(folders), total_size)
    
    if not path.exists():
        print(f"❌ Путь не существует: {path}")
        return None, None
    
    if not path.is_dir():
        print(f"❌ Не является директорией: {path}")
        return None, None
    
    folders = []
    total_size = 0
    folders_count = 0
    
    try:
        for item in path.iterdir():
            if item.is_dir():
                try:
                    size = get_size(item)
                    level = detect_level(str(item), base_for_level)
                    
                    folders.append({
                        'name': item.name,
                        'size': size,
                        'size_gb': round(format_size_gb(size), 4),
                        'size_str': format_size_auto(size),
                        'path': str(item),
                        'level': level
                    })
                    total_size += size
                    folders_count += 1
                    print(f"  📁 {item.name}: {format_size_auto(size)} (уровень {level})")
                except (PermissionError, OSError) as e:
                    print(f"  ⚠️ Нет доступа к {item.name}: {e}")
                    pass
    except (PermissionError, OSError) as e:
        print(f"❌ Ошибка доступа к каталогу: {e}")
        return None, None
    
    print(f"✅ Найдено папок: {folders_count}, Общий размер: {format_size_auto(total_size)}")
    return folders, (folders_count, total_size)

def get_network_shares(server):
    shares = []
    try:
        server_clean = server.replace('\\\\', '')
        result = subprocess.run(
            ['net', 'view', f'\\\\{server_clean}'], 
            capture_output=True, 
            text=True, 
            encoding='cp866',
            timeout=10
        )
        if result.returncode == 0:
            lines = result.stdout.split('\n')
            for line in lines:
                if '\\\\' in line and ('Диск' in line or 'Disk' in line):
                    match = re.search(r'\\\\[^\\]+\\[^\\]+', line)
                    if match:
                        share_path = match.group(0)
                        share_name = share_path.split('\\')[-1]
                        shares.append({
                            'name': share_name,
                            'path': share_path,
                            'type': 'folder'
                        })
    except Exception as e:
        print(f"⚠️ Ошибка получения шаров: {e}")
    
    if not shares:
        try:
            unc_path = f"\\\\{server}"
            for entry in os.scandir(unc_path):
                if entry.is_dir():
                    shares.append({
                        'name': entry.name,
                        'path': f"{unc_path}\\{entry.name}",
                        'type': 'folder'
                    })
        except Exception as e:
            print(f"⚠️ Ошибка сканирования: {e}")
    
    return shares

def scan_directory(base_path):
    base_path = fix_path(base_path)
    path = Path(base_path)
    if not path.exists():
        return None, None
    
    items = []
    total_size = 0
    
    try:
        for item in path.iterdir():
            try:
                if item.is_dir():
                    size = get_size(item)
                    items.append({
                        'name': item.name,
                        'size': size,
                        'size_str': format_size_auto(size),
                        'path': str(item),
                        'type': 'folder',
                        'level': 0
                    })
                    total_size += size
                elif item.is_file():
                    size = item.stat().st_size
                    items.append({
                        'name': item.name,
                        'size': size,
                        'size_str': format_size_auto(size),
                        'path': str(item),
                        'type': 'file',
                        'level': 0
                    })
                    total_size += size
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError):
        return None, None
    
    items.sort(key=lambda x: (x['type'] != 'folder', x['name'].lower()))
    return items, total_size

# ========================================================================
# ФУНКЦИИ СОХРАНЕНИЯ В БД
# ========================================================================

def save_scan_to_db(folders, scan_path, disk_path="", level=1):
    if not folders:
        return True
    
    conn = get_db_connection()
    if not conn:
        print("❌ Нет подключения к БД")
        return False
    
    cursor = conn.cursor()
    timestamp = datetime.datetime.now()
    scan_path = normalize_path(scan_path)
    disk_path = normalize_path(disk_path)
    
    print(f"💾 Сохранение в БД: disk_path={disk_path}, parent_path={scan_path}")
    print(f"📊 Сохраняется {len(folders)} папок")
    
    try:
        for folder in folders:
            size_gb = folder['size'] / (1024**3)
            folder_level = folder.get('level', level)
            
            if folder_level == 1:
                parent = scan_path
            else:
                parent = folder.get('parent_path', scan_path)
            
            print(f"  📝 {folder['name']}: level={folder_level}, parent={parent}")
            
            cursor.execute('''
                INSERT INTO scans (scan_date, disk_path, item_name, item_type, parent_path, level, size_gb, size_bytes)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ''', (timestamp, disk_path, folder['name'], 'ПАПКА', parent, folder_level, size_gb, folder['size']))
        conn.commit()
        print(f"✅ Сохранено {len(folders)} папок в БД")
        return True
    except Exception as e:
        print(f"❌ Ошибка сохранения: {e}")
        conn.rollback()
        return False
    finally:
        cursor.close()
        conn.close()

def save_folder_size_history(folder_path, total_size_bytes):
    conn = get_db_connection()
    if not conn:
        return False
    
    cursor = conn.cursor()
    timestamp = datetime.datetime.now()
    folder_path = normalize_path(folder_path)
    total_size_gb = total_size_bytes / (1024**3)
    
    try:
        cursor.execute('''
            INSERT INTO folder_size_history (scan_date, folder_path, total_size_gb, total_size_bytes)
            VALUES (%s, %s, %s, %s)
        ''', (timestamp, folder_path, total_size_gb, total_size_bytes))
        conn.commit()
        print(f"✅ Сохранена история размера {folder_path}: {format_size_auto(total_size_bytes)}")
        return True
    except Exception as e:
        print(f"❌ Ошибка сохранения истории: {e}")
        conn.rollback()
        return False
    finally:
        cursor.close()
        conn.close()

# ========================================================================
# ФУНКЦИИ ПОЛУЧЕНИЯ ДАННЫХ ИЗ БД
# ========================================================================

def get_folder_size_history(folder_path):
    conn = get_db_connection()
    if not conn:
        return []
    
    folder_path = normalize_path(folder_path)
    
    try:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT scan_date, total_size_gb
            FROM folder_size_history
            WHERE folder_path = %s
            ORDER BY scan_date
        ''', (folder_path,))
        data = cursor.fetchall()
        cursor.close()
        
        result = []
        for row in data:
            result.append({
                'date': row[0].strftime('%Y-%m-%d %H:%M'),
                'size_gb': float(row[1])
            })
        print(f"📊 Найдено {len(result)} записей истории для {folder_path}")
        return result
    except Exception as e:
        print(f"❌ Ошибка получения истории: {e}")
        return []
    finally:
        conn.close()

def get_folder_history(disk_path, parent_path):
    conn = get_db_connection()
    if not conn:
        return pd.DataFrame()
    
    disk_path = normalize_path(disk_path)
    parent_path = normalize_path(parent_path)
    
    print(f"📊 get_folder_history: disk_path={disk_path}, parent_path={parent_path}")
    
    try:
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT COUNT(*) 
            FROM scans 
            WHERE disk_path = %s 
            AND parent_path = %s 
            AND item_type = 'ПАПКА'
        ''', (disk_path, parent_path))
        count = cursor.fetchone()[0]
        
        if count > 0:
            cursor.execute('''
                SELECT scan_date, item_name, size_gb, level
                FROM scans 
                WHERE disk_path = %s 
                AND parent_path = %s 
                AND item_type = 'ПАПКА'
                ORDER BY scan_date, item_name
            ''', (disk_path, parent_path))
        else:
            path_parts = parent_path.split('\\')
            if len(path_parts) >= 2:
                folder_name = path_parts[-1]
                parent_of_parent = '\\'.join(path_parts[:-1])
                
                print(f"📊 Ищем данные для папки '{folder_name}' в parent_path='{parent_of_parent}'")
                
                cursor.execute('''
                    SELECT scan_date, item_name, size_gb, level
                    FROM scans 
                    WHERE disk_path = %s 
                    AND parent_path = %s 
                    AND item_name = %s
                    AND item_type = 'ПАПКА'
                    ORDER BY scan_date, item_name
                ''', (disk_path, parent_of_parent, folder_name))
            else:
                cursor.execute('''
                    SELECT scan_date, item_name, size_gb, level
                    FROM scans 
                    WHERE disk_path = %s 
                    AND parent_path = %s 
                    AND item_type = 'ПАПКА'
                    ORDER BY scan_date, item_name
                ''', (disk_path, parent_path))
        
        data = cursor.fetchall()
        cursor.close()
        
        print(f"📊 Найдено {len(data)} записей для {parent_path}")
        
        if not data:
            return pd.DataFrame()
        
        df = pd.DataFrame(data, columns=['scan_date', 'item_name', 'size_gb', 'level'])
        df['scan_date'] = pd.to_datetime(df['scan_date'])
        
        unique_dates = df['scan_date'].unique()
        print(f"📊 Уникальных дат: {len(unique_dates)}")
        for d in unique_dates:
            print(f"   📅 {d}")
        
        return df
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        return pd.DataFrame()
    finally:
        conn.close()

def get_all_paths():
    conn = get_db_connection()
    if not conn:
        return []
    try:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT DISTINCT disk_path, parent_path 
            FROM scans 
            WHERE item_type = 'ПАПКА'
            ORDER BY parent_path
        ''')
        paths = cursor.fetchall()
        cursor.close()
        return [{'disk': p[0], 'path': p[1]} for p in paths]
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        return []
    finally:
        conn.close()

def get_current_folders(disk_path, parent_path):
    conn = get_db_connection()
    if not conn:
        return []
    try:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT DISTINCT item_name, size_gb, size_bytes, level
            FROM scans 
            WHERE disk_path = %s 
            AND parent_path = %s 
            AND item_type = 'ПАПКА'
            AND scan_date = (
                SELECT MAX(scan_date) 
                FROM scans 
                WHERE disk_path = %s AND parent_path = %s AND item_type = 'ПАПКА'
            )
            ORDER BY size_bytes DESC
        ''', (disk_path, parent_path, disk_path, parent_path))
        data = cursor.fetchall()
        cursor.close()
        return [{'name': row[0], 'size_gb': round(float(row[1]), 4), 'size_bytes': row[2], 'level': row[3]} for row in data]
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        return []
    finally:
        conn.close()

def get_folder_contents(disk_path, parent_path):
    conn = get_db_connection()
    if not conn:
        return []
    try:
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT DISTINCT item_name, size_gb, size_bytes, level
            FROM scans 
            WHERE disk_path = %s 
            AND parent_path = %s 
            AND item_type = 'ПАПКА'
            AND scan_date = (
                SELECT MAX(scan_date) 
                FROM scans 
                WHERE disk_path = %s AND parent_path = %s AND item_type = 'ПАПКА'
            )
            ORDER BY size_bytes DESC
        ''', (disk_path, parent_path, disk_path, parent_path))
        
        data = cursor.fetchall()
        
        if not data:
            path_parts = parent_path.split('\\')
            if len(path_parts) >= 2:
                folder_name = path_parts[-1]
                parent_of_parent = '\\'.join(path_parts[:-1])
                
                cursor.execute('''
                    SELECT item_name, size_gb, size_bytes, level
                    FROM scans 
                    WHERE disk_path = %s 
                    AND parent_path = %s 
                    AND item_name = %s
                    AND item_type = 'ПАПКА'
                    AND scan_date = (
                        SELECT MAX(scan_date) 
                        FROM scans 
                        WHERE disk_path = %s AND parent_path = %s AND item_type = 'ПАПКА'
                    )
                ''', (disk_path, parent_of_parent, folder_name, disk_path, parent_of_parent))
                folder_data = cursor.fetchone()
                
                if folder_data:
                    cursor.execute('''
                        SELECT DISTINCT item_name, size_gb, size_bytes, level
                        FROM scans 
                        WHERE disk_path = %s 
                        AND parent_path = %s 
                        AND item_type = 'ПАПКА'
                        AND scan_date = (
                            SELECT MAX(scan_date) 
                            FROM scans 
                            WHERE disk_path = %s AND parent_path = %s AND item_type = 'ПАПКА'
                        )
                        ORDER BY size_bytes DESC
                    ''', (disk_path, parent_path, disk_path, parent_path))
                    data = cursor.fetchall()
        
        cursor.close()
        return [{'name': row[0], 'size_gb': round(float(row[1]), 4), 'size_bytes': row[2], 'level': row[3]} for row in data]
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        return []
    finally:
        conn.close()

# ========================================================================
# ФУНКЦИЯ ПОСТРОЕНИЯ ГРАФИКОВ
# ========================================================================

def create_chart_plotly(history_df, disk_path, parent_path, level=1):
    if history_df.empty:
        print("⚠️ history_df пустой")
        return None
    
    folders = history_df['item_name'].unique()
    if len(folders) == 0:
        print("⚠️ Нет уникальных папок")
        return None
    
    try:
        latest_sizes = history_df[history_df['scan_date'] == history_df['scan_date'].max()]
        folder_sizes = latest_sizes.set_index('item_name')['size_gb'].to_dict()
        sorted_folders = sorted(folders, key=lambda x: float(folder_sizes.get(x, 0)), reverse=True)
        
        if len(sorted_folders) > 20:
            top_folders = sorted_folders[:20]
            other_folders = sorted_folders[20:]
            
            other_data = history_df[history_df['item_name'].isin(other_folders)]
            other_total = other_data.groupby('scan_date')['size_gb'].sum().reset_index()
            other_total['item_name'] = '📁 Остальные папки'
            
            filtered_df = history_df[history_df['item_name'].isin(top_folders)]
            filtered_df = pd.concat([filtered_df, other_total], ignore_index=True)
            all_folders = filtered_df['item_name'].unique()
            print(f"📊 Показываем {len(all_folders)} групп папок (топ-20 + остальные)")
        else:
            all_folders = sorted_folders
            filtered_df = history_df
            print(f"📊 Показываем {len(all_folders)} папок")
        
        colors = [
            '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB', '#0ABDE3',
            '#10AC84', '#EE5A24', '#5F27CD', '#341F97', '#00D2D3',
            '#FF6B6B', '#F368E0', '#FF9F43', '#54A0FF', '#5F27CD',
            '#E67E22', '#1A5276'
        ]
        
        fig = go.Figure()
        
        for idx, folder_name in enumerate(all_folders):
            folder_data = filtered_df[filtered_df['item_name'] == folder_name]
            folder_data = folder_data.sort_values('scan_date')
            
            dates = folder_data['scan_date'].tolist()
            sizes = [float(s) for s in folder_data['size_gb'].tolist()]
            
            color = colors[idx % len(colors)]
            dash = 'dash' if folder_name == '📁 Остальные папки' else 'solid'
            line_width = 2 if folder_name == '📁 Остальные папки' else 3
            
            fig.add_trace(go.Scatter(
                x=dates,
                y=sizes,
                mode='lines+markers',
                name=folder_name[:30] + ('...' if len(folder_name) > 30 else ''),
                line=dict(color=color, width=line_width, dash=dash),
                marker=dict(size=8, color=color),
                customdata=[folder_name] * len(dates),
                hovertemplate=(
                    "<b>%{customdata}</b><br>" +
                    "📅 Дата: %{x|%d.%m.%Y %H:%M}<br>" +
                    "📊 Размер: %{y:.2f} ГБ<br>" +
                    "<extra></extra>"
                )
            ))
        
        total_per_date = filtered_df.groupby('scan_date')['size_gb'].sum().reset_index()
        total_per_date = total_per_date.sort_values('scan_date')
        
        fig.add_trace(go.Scatter(
            x=total_per_date['scan_date'],
            y=[float(s) for s in total_per_date['size_gb']],
            mode='lines+markers',
            name='📊 Общий размер',
            line=dict(color='#2C3E50', width=4),
            marker=dict(size=12, color='#E74C3C', symbol='diamond'),
            customdata=['Общий размер'] * len(total_per_date),
            hovertemplate=(
                "<b>Общий размер</b><br>" +
                "📅 Дата: %{x|%d.%m.%Y %H:%M}<br>" +
                "📊 Размер: %{y:.2f} ГБ<br>" +
                "<extra></extra>"
            )
        ))
        
        path_name = Path(parent_path).name if parent_path else disk_path
        level_text = f"Уровень {level}"
        
        fig.update_layout(
            title=dict(
                text=f'📈 Динамика изменения размера папок<br><span style="font-size:16px;font-weight:normal;">{path_name} ({level_text})</span>',
                font=dict(size=20, family='Arial, sans-serif'),
                x=0.5
            ),
            xaxis=dict(
                title='Дата сканирования',
                title_font=dict(size=14),
                tickformat='%d.%m.%Y %H:%M',
                tickangle=-45,
                gridcolor='#f0f0f0',
                showgrid=True,
                zeroline=False,
                rangeslider=dict(visible=True, thickness=0.05, bgcolor='#f8f9fa'),
                rangeselector=dict(
                    buttons=[
                        dict(count=1, label='1д', step='day', stepmode='backward'),
                        dict(count=3, label='3д', step='day', stepmode='backward'),
                        dict(count=7, label='1н', step='day', stepmode='backward'),
                        dict(count=1, label='1м', step='month', stepmode='backward'),
                        dict(count=3, label='3м', step='month', stepmode='backward'),
                        dict(step='all', label='Всё')
                    ],
                    bgcolor='#e9ecef',
                    activecolor='#0d6efd'
                )
            ),
            yaxis=dict(
                title='Размер (ГБ)',
                title_font=dict(size=14),
                gridcolor='#f0f0f0',
                showgrid=True,
                zeroline=False,
                tickformat='.2f'
            ),
            hovermode='x unified',
            legend=dict(
                x=1.02,
                y=1,
                xanchor='left',
                yanchor='top',
                bgcolor='rgba(255,255,255,0.9)',
                bordercolor='#ddd',
                borderwidth=1,
                font=dict(size=11),
                itemsizing='constant'
            ),
            margin=dict(l=60, r=150, t=80, b=80),
            plot_bgcolor='white',
            paper_bgcolor='white',
            height=550,
            dragmode='zoom'
        )
        
        chart_json = fig.to_json()
        print(f"✅ Интерактивный график создан для {len(all_folders)} папок")
        return chart_json
        
    except Exception as e:
        print(f"❌ Ошибка создания графика: {e}")
        traceback.print_exc()
        return None

# ========================================================================
# ФУНКЦИЯ СОЗДАНИЯ ГИСТОГРАММЫ
# ========================================================================

def create_sectioned_histogram(history_data, path, level=1):
    if not history_data or len(history_data) == 0:
        print("⚠️ create_sectioned_histogram: Нет данных для гистограммы")
        return None
    
    print(f"📊 create_sectioned_histogram: Получено {len(history_data)} записей")
    
    try:
        all_dates = []
        for item in history_data:
            date = item.get('date', '')
            if date and date not in all_dates:
                all_dates.append(date)
        all_dates.sort()
        
        print(f"📊 Найдено дат: {len(all_dates)}")
        
        if len(all_dates) == 0:
            print("⚠️ Нет дат в данных")
            return None
        
        all_folder_names = []
        for item in history_data:
            name = item.get('name', '')
            if name and name not in all_folder_names:
                all_folder_names.append(name)
        
        print(f"📊 Найдено папок: {len(all_folder_names)}")
        
        if len(all_folder_names) == 0:
            print("⚠️ Нет папок в данных")
            return None
        
        folder_avg_sizes = []
        for name in all_folder_names:
            total = 0
            count = 0
            for item in history_data:
                if item.get('name') == name:
                    size = float(item.get('size_gb', 0))
                    total += size
                    count += 1
            avg = total / count if count > 0 else 0
            folder_avg_sizes.append({'name': name, 'avg': avg})
        
        folder_avg_sizes.sort(key=lambda x: x['avg'], reverse=True)
        sorted_folder_names = [f['name'] for f in folder_avg_sizes]
        
        MAX_FOLDERS = 15
        truncated = len(sorted_folder_names) > MAX_FOLDERS
        
        if truncated:
            display_folders = sorted_folder_names[:MAX_FOLDERS]
            other_folders = sorted_folder_names[MAX_FOLDERS:]
        else:
            display_folders = sorted_folder_names
            other_folders = []
        
        print(f"📊 Отображаем папок: {len(display_folders)}")
        
        folder_colors = [
            '#E67E22', '#2980B9', '#27AE60', '#F1C40F', '#8E44AD',
            '#E74C3C', '#1ABC9C', '#2C3E50', '#F39C12', '#3498DB',
            '#2ECC71', '#9B59B6'
        ]
        
        fig = go.Figure()
        
        max_height = 0
        folder_count = len(display_folders)
        
        for idx, folder_name in enumerate(display_folders):
            x_values = []
            y_values = []
            custom_data = []
            text_labels = []
            
            color = folder_colors[idx % len(folder_colors)]
            
            values_by_date = []
            for date in all_dates:
                found = None
                for item in history_data:
                    if item.get('date') == date and item.get('name') == folder_name:
                        found = item
                        break
                
                val = float(found.get('size_gb', 0)) if found else 0
                values_by_date.append({
                    'date': date,
                    'value': val,
                    'found': found
                })
                if val > max_height:
                    max_height = val
            
            i = 0
            while i < len(values_by_date):
                current_val = values_by_date[i]['value']
                j = i
                while j < len(values_by_date) and abs(values_by_date[j]['value'] - current_val) < 0.001:
                    j += 1
                
                count_same = j - i
                
                for k in range(i, j):
                    date_data = values_by_date[k]
                    date = date_data['date']
                    val = date_data['value']
                    
                    date_parts = date.split(' ')
                    if len(date_parts) >= 2:
                        date_parts2 = date_parts[0].split('-')
                        if len(date_parts2) >= 3:
                            display_date = f"{date_parts2[2]}.{date_parts2[1]}"
                            time_part = date_parts[1][:5] if len(date_parts[1]) >= 5 else date_parts[1]
                            display_date = f"{display_date}\n{time_part}"
                        else:
                            display_date = date_parts[0]
                    else:
                        display_date = date
                    
                    x_values.append(display_date)
                    y_values.append(val)
                    custom_data.append(f'{folder_name}\n{date}')
                    
                    if k == i and count_same > 1:
                        text_labels.append(f'{val:.2f}')
                    elif k == i:
                        text_labels.append(f'{val:.2f}')
                    else:
                        text_labels.append('')
                
                i = j
            
            display_name = folder_name
            if len(display_name) > 20:
                display_name = display_name[:17] + '...'
            
            axis_num = idx + 1
            
            fig.add_trace(go.Bar(
                x=x_values,
                y=y_values,
                name=display_name,
                legendgroup=folder_name,
                text=text_labels,
                textposition='outside',
                textfont={
                    'size': 8,
                    'color': '#2c3e50',
                    'weight': 'bold'
                },
                marker={
                    'color': color,
                    'line': {
                        'color': 'rgba(0,0,0,0.15)',
                        'width': 0.5
                    }
                },
                customdata=custom_data,
                hovertemplate=(
                    '<b>%{customdata}</b><br>' +
                    '📊 Размер: %{y:.2f} ГБ<br>' +
                    '<extra></extra>'
                ),
                width=0.95,
                showlegend=False,
                orientation='v',
                yaxis=f'y{axis_num}',
                xaxis=f'x{axis_num}'
            ))
        
        print(f"📊 Создано {len(display_folders)} подгистограмм")
        
        if truncated and other_folders:
            x_values = []
            y_values = []
            custom_data = []
            text_labels = []
            
            values_by_date = []
            for date in all_dates:
                total = 0
                for item in history_data:
                    if item.get('date') == date and item.get('name') in other_folders:
                        total += float(item.get('size_gb', 0))
                values_by_date.append({
                    'date': date,
                    'value': total
                })
                if total > max_height:
                    max_height = total
            
            i = 0
            while i < len(values_by_date):
                current_val = values_by_date[i]['value']
                j = i
                while j < len(values_by_date) and abs(values_by_date[j]['value'] - current_val) < 0.001:
                    j += 1
                
                count_same = j - i
                
                for k in range(i, j):
                    date_data = values_by_date[k]
                    date = date_data['date']
                    val = date_data['value']
                    
                    date_parts = date.split(' ')
                    if len(date_parts) >= 2:
                        date_parts2 = date_parts[0].split('-')
                        if len(date_parts2) >= 3:
                            display_date = f"{date_parts2[2]}.{date_parts2[1]}\n{date_parts[1][:5]}"
                        else:
                            display_date = date_parts[0]
                    else:
                        display_date = date
                    
                    x_values.append(display_date)
                    y_values.append(val)
                    custom_data.append(f'Остальные папки\n{date}')
                    
                    if k == i and count_same > 1:
                        text_labels.append(f'{val:.2f}')
                    elif k == i:
                        text_labels.append(f'{val:.2f}')
                    else:
                        text_labels.append('')
                
                i = j
            
            axis_num = folder_count + 1
            
            fig.add_trace(go.Bar(
                x=x_values,
                y=y_values,
                name=f'📦 Остальные ({len(other_folders)})',
                legendgroup='Остальные',
                text=text_labels,
                textposition='outside',
                textfont={
                    'size': 8,
                    'color': '#7f8c8d',
                    'weight': 'normal'
                },
                marker={
                    'color': '#95A5A6',
                    'opacity': 0.7,
                    'line': {
                        'color': 'rgba(0,0,0,0.1)',
                        'width': 0.5
                    }
                },
                customdata=custom_data,
                hovertemplate=(
                    '<b>📦 Остальные папки</b><br>' +
                    '📅 %{customdata}<br>' +
                    '📊 Размер: %{y:.2f} ГБ<br>' +
                    '<extra></extra>'
                ),
                width=0.95,
                showlegend=False,
                orientation='v',
                yaxis=f'y{axis_num}',
                xaxis=f'x{axis_num}'
            ))
            
            print(f"📊 Добавлена подгистограмма 'Остальные'")
            folder_count += 1
        
        path_name = path.split('\\')[-1] if path else 'Папка'
        level_text = f'Уровень {level}'
        
        y_max = max_height * 1.25 if max_height > 0 else 1.5
        
        date_count = len(all_dates)
        min_width = 600
        calculated_width = max(min_width, date_count * 70 + 200)
        plot_width = min(1200, max(800, calculated_width))
        
        layout_dict = {
            'title': {
                'text': (
                    f'📊 Динамика размера папок<br>' +
                    f'<span style="font-size:13px;font-weight:normal;color:#555;">'
                    f'{path_name} ({level_text}) | Папок: {len(display_folders)}'
                    f'{f" (показаны топ-{MAX_FOLDERS})" if truncated else ""}'
                    f' | Сканирований: {len(all_dates)}'
                    f'</span>'
                ),
                'font': {'size': 18, 'weight': 'bold', 'color': '#2c3e50'},
                'x': 0.5
            },
            'height': 100 + folder_count * 210,
            'width': plot_width,
            'margin': {'l': 80, 'r': 30, 't': 80, 'b': 40},
            'plot_bgcolor': '#ffffff',
            'paper_bgcolor': '#ffffff',
            'hovermode': 'closest',
            'showlegend': True,
            'legend': {
                'orientation': 'v',
                'x': 1.02,
                'y': 1,
                'xanchor': 'left',
                'yanchor': 'top',
                'bgcolor': 'rgba(255,255,255,0.95)',
                'bordercolor': '#e0e0e0',
                'borderwidth': 1,
                'font': {'size': 9, 'color': '#2c3e50'},
                'itemsizing': 'constant',
                'itemwidth': 30,
                'traceorder': 'normal',
                'itemclick': 'toggle',
                'itemdoubleclick': 'toggleothers'
            },
            'barmode': 'group',
            'bargap': 0.25,
            'bargroupgap': 0.0
        }
        
        for i in range(folder_count):
            axis_num = i + 1
            yaxis_key = f'yaxis{axis_num}'
            xaxis_key = f'xaxis{axis_num}'
            
            domain_start = (folder_count - i - 1) / folder_count
            domain_end = (folder_count - i) / folder_count
            
            show_title = (i == folder_count - 1)
            
            layout_dict[yaxis_key] = {
                'title': {
                    'text': 'Размер (ГБ)' if show_title else '',
                    'font': {'size': 9, 'color': '#2c3e50'}
                },
                'domain': [domain_start + 0.05, domain_end - 0.02],
                'range': [0, y_max],
                'gridcolor': '#ecf0f1',
                'gridwidth': 0.5,
                'tickformat': '.2f',
                'tickfont': {'size': 7, 'color': '#2c3e50'},
                'zeroline': True,
                'zerolinecolor': '#bdc3c7',
                'zerolinewidth': 1,
                'showgrid': True,
                'showline': True,
                'linecolor': '#dfe6e9',
                'linewidth': 0.5,
                'anchor': f'x{axis_num}',
                'matches': None
            }
            
            layout_dict[xaxis_key] = {
                'title': {
                    'text': 'Даты сканирования' if show_title else '',
                    'font': {'size': 8, 'color': '#2c3e50'}
                },
                'domain': [0.12, 0.92],
                'tickangle': -90,
                'tickfont': {'size': 7, 'family': 'Arial, sans-serif', 'color': '#2c3e50'},
                'gridcolor': '#ecf0f1',
                'gridwidth': 0.5,
                'automargin': True,
                'type': 'category',
                'showticklabels': True,
                'tickmode': 'array',
                'anchor': f'y{axis_num}',
                'matches': None,
                'side': 'bottom',
                'showline': True,
                'linecolor': '#dfe6e9',
                'linewidth': 0.5
            }
        
        annotations = []
        for i, folder_name in enumerate(display_folders):
            display_name = folder_name
            if len(display_name) > 20:
                display_name = display_name[:17] + '...'
            
            y_pos = (folder_count - i - 0.5) / folder_count
            
            annotations.append({
                'x': 0.02,
                'y': y_pos,
                'xref': 'paper',
                'yref': 'paper',
                'text': f'<b>{display_name}</b>',
                'showarrow': False,
                'font': {'size': 9, 'color': '#2c3e50'},
                'align': 'left',
                'bgcolor': 'rgba(255,255,255,0.8)',
                'borderpad': 2
            })
        
        if truncated and other_folders:
            annotations.append({
                'x': 0.02,
                'y': 0.5 / folder_count,
                'xref': 'paper',
                'yref': 'paper',
                'text': f'<b>📦 Остальные ({len(other_folders)})</b>',
                'showarrow': False,
                'font': {'size': 9, 'color': '#7f8c8d'},
                'align': 'left',
                'bgcolor': 'rgba(255,255,255,0.8)',
                'borderpad': 2
            })
        
        layout_dict['annotations'] = annotations
        
        fig.update_layout(**layout_dict)
        
        chart_json = fig.to_json()
        
        print(f"✅ Создана гистограмма: {len(display_folders)} подгистограмм, {len(all_dates)} сканирований")
        return chart_json
        
    except Exception as e:
        print(f"❌ Ошибка создания гистограммы: {e}")
        traceback.print_exc()
        return None

# ========================================================================
# ФУНКЦИЯ ЭКСПОРТА В EXCEL
# ========================================================================

def generate_and_save_excel_report(path, disk_path, history_df, current_folders, level=1):
    """Генерация Excel отчета и сохранение в папку reports"""
    
    import re
    
    path_parts = path.split('\\')
    folder_name = path_parts[-1] if path_parts else path
    
    clean_name = re.sub(r'[^\w\-_.]', '_', folder_name)
    clean_name = re.sub(r'_+', '_', clean_name)
    clean_name = clean_name.strip('_')
    
    if not clean_name or len(clean_name) > 50:
        clean_name = re.sub(r'[^\w\-_.]', '_', path.replace('\\', '_').replace(':', ''))
        clean_name = re.sub(r'_+', '_', clean_name).strip('_')
        if len(clean_name) > 50:
            clean_name = clean_name[:50]
    
    timestamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"report_{clean_name}_{timestamp}.xlsx"
    filepath = os.path.join(REPORTS_DIR, filename)
    
    print(f"📊 Генерация Excel отчета для уровня {level}: {filepath}")
    
    workbook = xlsxwriter.Workbook(filepath)
    
    header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#2C3E50',
        'font_color': 'white',
        'border': 1,
        'align': 'center',
        'valign': 'vcenter'
    })
    
    cell_format = workbook.add_format({
        'border': 1,
        'align': 'left',
        'valign': 'vcenter'
    })
    
    number_format = workbook.add_format({
        'border': 1,
        'align': 'right',
        'valign': 'vcenter',
        'num_format': '#,##0.00'
    })
    
    date_format = workbook.add_format({
        'border': 1,
        'align': 'center',
        'valign': 'vcenter',
        'num_format': 'yyyy-mm-dd hh:mm'
    })
    
    level_text = f"Уровень {level}"
    
    # ЛИСТ 1: Текущее состояние
    sheet1 = workbook.add_worksheet('Текущие папки')
    
    headers1 = ['Папка', 'Размер (ГБ)', 'Размер (байт)', 'Уровень']
    for col, header in enumerate(headers1):
        sheet1.write(0, col, header, header_format)
    
    row = 1
    total_size = 0
    for folder in current_folders:
        sheet1.write(row, 0, folder['name'], cell_format)
        sheet1.write(row, 1, float(folder['size_gb']), number_format)
        sheet1.write(row, 2, folder['size_bytes'], number_format)
        sheet1.write(row, 3, folder.get('level', level), cell_format)
        total_size += folder['size_bytes']
        row += 1
    
    sheet1.write(row, 0, 'ИТОГО:', header_format)
    sheet1.write(row, 1, round(total_size / (1024**3), 2), number_format)
    sheet1.write(row, 2, total_size, number_format)
    
    sheet1.set_column('A:A', 35)
    sheet1.set_column('B:B', 15)
    sheet1.set_column('C:C', 18)
    sheet1.set_column('D:D', 10)
    
    # ЛИСТ 2: Секционированные гистограммы
    if not history_df.empty and history_df['scan_date'].nunique() >= 2:
        sheet2 = workbook.add_worksheet('Гистограммы папок')
        
        sheet2.write(0, 0, f'📊 Секционированные гистограммы - {level_text}', header_format)
        sheet2.write(0, 1, f'Путь: {path}', cell_format)
        sheet2.write(0, 2, f'Папок: {len(current_folders)}', cell_format)
        sheet2.write(0, 3, f'Сканирований: {history_df["scan_date"].nunique()}', cell_format)
        
        all_folders = history_df['item_name'].unique()
        
        folder_avg_sizes = []
        for name in all_folders:
            folder_data = history_df[history_df['item_name'] == name]
            avg_size = folder_data['size_gb'].mean()
            folder_avg_sizes.append({'name': name, 'avg': avg_size})
        
        folder_avg_sizes.sort(key=lambda x: x['avg'], reverse=True)
        sorted_folders = [f['name'] for f in folder_avg_sizes]
        
        MAX_FOLDERS = 15
        display_folders = sorted_folders[:MAX_FOLDERS]
        
        all_dates = sorted(history_df['scan_date'].unique())
        date_strs = [d.strftime('%Y-%m-%d %H:%M') for d in all_dates]
        
        folder_colors = [
            '#E67E22', '#2980B9', '#27AE60', '#F1C40F', '#8E44AD',
            '#E74C3C', '#1ABC9C', '#2C3E50', '#F39C12', '#3498DB',
            '#2ECC71', '#9B59B6', '#D35400', '#16A085', '#C0392B'
        ]
        
        current_row = 2
        chart_height = 250
        chart_width = 900
        
        for idx, folder_name in enumerate(display_folders):
            sheet2.write(current_row, 0, f'{idx+1}. 📁 {folder_name}', header_format)
            sheet2.write(current_row, 1, f'Средний размер: {folder_avg_sizes[idx]["avg"]:.2f} ГБ', cell_format)
            
            folder_data = history_df[history_df['item_name'] == folder_name]
            
            size_map = {}
            for _, row_data in folder_data.iterrows():
                date_key = row_data['scan_date'].strftime('%Y-%m-%d %H:%M')
                size_map[date_key] = float(row_data['size_gb'])
            
            data_start_row = current_row + 1
            col_offset = 3
            
            sheet2.write(data_start_row, 0, 'Дата', header_format)
            sheet2.write(data_start_row, 1, 'Размер (ГБ)', header_format)
            
            data_row = data_start_row + 1
            max_val = 0
            for date_str in date_strs:
                val = size_map.get(date_str, 0)
                sheet2.write(data_row, 0, date_str, date_format)
                sheet2.write(data_row, 1, val, number_format)
                if val > max_val:
                    max_val = val
                data_row += 1
            
            chart = workbook.add_chart({'type': 'column'})
            
            color = folder_colors[idx % len(folder_colors)]
            
            chart.add_series({
                'name': folder_name,
                'categories': f'=Гистограммы папок!$A${data_start_row + 1}:$A${data_row - 1}',
                'values': f'=Гистограммы папок!$B${data_start_row + 1}:$B${data_row - 1}',
                'fill': {'color': color},
                'border': {'color': color},
                'data_labels': {
                    'value': True,
                    'num_format': '0.00',
                    'position': 'outside'
                },
                'gap': 30
            })
            
            chart.set_title({'name': f'{folder_name} (max: {max_val:.2f} ГБ)'})
            chart.set_x_axis({
                'name': 'Дата сканирования',
                'name_font': {'size': 9},
                'num_font': {'size': 8, 'rotation': -45},
                'label_position': 'low'
            })
            chart.set_y_axis({
                'name': 'Размер (ГБ)',
                'name_font': {'size': 9},
                'num_font': {'size': 8}
            })
            chart.set_legend({'position': 'none'})
            chart.set_size({'width': chart_width, 'height': chart_height})
            
            sheet2.insert_chart(data_start_row, col_offset, chart)
            
            sheet2.set_column('A:A', 20)
            sheet2.set_column('B:B', 15)
            
            current_row = data_row + 4
            sheet2.set_row(current_row, 10)
        
        info_row = current_row + 2
        sheet2.write(info_row, 0, f'📊 Всего папок: {len(display_folders)} (показаны топ-{MAX_FOLDERS} из {len(all_folders)})', cell_format)
        sheet2.write(info_row + 1, 0, f'📅 Сканирований: {len(date_strs)}', cell_format)
        sheet2.write(info_row + 2, 0, f'📂 Путь: {path}', cell_format)
        sheet2.write(info_row + 3, 0, f'📌 Уровень: {level_text}', cell_format)
    
    # ЛИСТ 3: График динамики
    if not history_df.empty and history_df['scan_date'].nunique() >= 2:
        sheet3 = workbook.add_worksheet('График динамики')
        
        sheet3.write(0, 0, f'📈 График динамики - {level_text}', header_format)
        sheet3.write(0, 1, f'Путь: {path}', cell_format)
        
        sheet3.write(2, 0, 'Дата', header_format)
        
        folders = history_df['item_name'].unique()
        folder_colors_line = [
            '#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6',
            '#1ABC9C', '#E67E22', '#2980B9', '#27AE60', '#8E44AD'
        ]
        
        for col, folder in enumerate(folders):
            sheet3.write(2, col + 1, folder, header_format)
        
        dates = sorted(history_df['scan_date'].unique())
        
        row = 3
        for date in dates:
            date_str = date.strftime('%Y-%m-%d %H:%M')
            sheet3.write(row, 0, date_str, date_format)
            
            for col, folder in enumerate(folders):
                val = history_df[(history_df['scan_date'] == date) & (history_df['item_name'] == folder)]
                if not val.empty:
                    sheet3.write(row, col + 1, float(val['size_gb'].iloc[0]), number_format)
                else:
                    sheet3.write(row, col + 1, 0, number_format)
            row += 1
        
        chart_line = workbook.add_chart({'type': 'line'})
        
        for col, folder in enumerate(folders):
            color = folder_colors_line[col % len(folder_colors_line)]
            chart_line.add_series({
                'name': folder,
                'categories': f'=График динамики!$A$3:$A${row - 1}',
                'values': f'=График динамики!${chr(66 + col)}$3:${chr(66 + col)}${row - 1}',
                'line': {'color': color, 'width': 2},
                'marker': {'type': 'circle', 'size': 6, 'fill': {'color': color}},
            })
        
        chart_line.set_title({'name': f'Динамика размера папок ({level_text})\n{path}'})
        chart_line.set_x_axis({'name': 'Дата сканирования'})
        chart_line.set_y_axis({'name': 'Размер (ГБ)'})
        chart_line.set_legend({'position': 'right'})
        chart_line.set_size({'width': 900, 'height': 450})
        
        sheet3.insert_chart('H3', chart_line)
        sheet3.set_column('A:A', 20)
        for col in range(1, len(folders) + 1):
            sheet3.set_column(col, col, 15)
    
    # ЛИСТ 4: Информация
    sheet4 = workbook.add_worksheet('Информация')
    
    info_format = workbook.add_format({'bold': True, 'bg_color': '#ecf0f1', 'border': 1})
    
    info_data = [
        ['Путь', path],
        ['Диск', disk_path],
        ['Уровень', level_text],
        ['Всего папок', len(current_folders)],
        ['Общий размер', f"{round(total_size / (1024**3), 2)} ГБ ({total_size} байт)"],
        ['Количество сканирований', history_df['scan_date'].nunique() if not history_df.empty else 0],
        ['Первое сканирование', history_df['scan_date'].min().strftime('%Y-%m-%d %H:%M') if not history_df.empty else 'Нет данных'],
        ['Последнее сканирование', history_df['scan_date'].max().strftime('%Y-%m-%d %H:%M') if not history_df.empty else 'Нет данных'],
        ['Дата экспорта', datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')]
    ]
    
    for row, (label, value) in enumerate(info_data):
        sheet4.write(row, 0, label, info_format)
        sheet4.write(row, 1, str(value), cell_format)
    
    sheet4.set_column('A:A', 25)
    sheet4.set_column('B:B', 50)
    
    workbook.close()
    
    print(f"✅ Excel отчет сохранен: {filepath}")
    return filepath, filename

# ========================================================================
# РОУТЫ FLASK
# ========================================================================

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/scan', methods=['POST'])
def scan():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Нет данных'}), 400
        
        path = data.get('path', 'C:\\')
        path = fix_path(path)
        base_for_level = data.get('base_path', path)
        base_for_level = fix_path(base_for_level)
        
        print(f"📡 Сканирование: {path}")
        print(f"📏 Базовый путь для уровней: {base_for_level}")
        
        folders, stats = scan_directory_with_levels(path, base_for_level)
        if folders is None:
            return jsonify({'error': f'Не удалось просканировать: {path}'}), 400
        
        disk_path = get_disk_path(path)
        print(f"📌 disk_path: {disk_path}")
        
        if path == base_for_level:
            save_level = 1
        else:
            save_level = detect_level(path, base_for_level)
        
        print(f"📊 Сохраняем с уровнем: {save_level}")
        
        save_scan_to_db(folders, path, disk_path, save_level)
        save_folder_size_history(path, stats[1])
        
        print("📊 Сканирование папок второго уровня...")
        for folder in folders:
            try:
                sub_path = Path(folder['path'])
                if sub_path.exists() and sub_path.is_dir():
                    sub_folders = []
                    for sub_item in sub_path.iterdir():
                        if sub_item.is_dir():
                            try:
                                sub_size = get_size(sub_item)
                                sub_folders.append({
                                    'name': sub_item.name,
                                    'size': sub_size,
                                    'size_gb': round(format_size_gb(sub_size), 4),
                                    'size_str': format_size_auto(sub_size),
                                    'path': str(sub_item),
                                    'level': 2,
                                    'parent_path': folder['path']
                                })
                                print(f"    📁 {sub_item.name}: {format_size_auto(sub_size)} (уровень 2)")
                            except (PermissionError, OSError):
                                pass
                    
                    if sub_folders:
                        save_scan_to_db(sub_folders, folder['path'], disk_path, 2)
            except Exception as e:
                print(f"  ⚠️ Ошибка сканирования подпапок {folder['name']}: {e}")
        
        folder_history = get_folder_size_history(path)
        history_df = get_folder_history(disk_path, path)
        chart_json = None
        scans_count = 0
        
        if not history_df.empty:
            scans_count = history_df['scan_date'].nunique()
            print(f"📊 Количество сканирований для {path}: {scans_count}")
            if scans_count > 1:
                chart_json = create_chart_plotly(history_df, disk_path, path, save_level)
            else:
                print(f"⚠️ Недостаточно данных для графика (нужно >= 2 сканирований) для {path}")
        
        histogram_data = []
        if not history_df.empty:
            history_df_sorted = history_df.sort_values('scan_date')
            for _, row in history_df_sorted.iterrows():
                date_str = row['scan_date'].strftime('%Y-%m-%d %H:%M')
                histogram_data.append({
                    'date': date_str,
                    'name': row['item_name'],
                    'size_gb': float(row['size_gb'])
                })
            print(f"📊 Подготовлено {len(histogram_data)} записей для гистограммы для {path}")
        else:
            current_date = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
            for folder in folders:
                histogram_data.append({
                    'date': current_date,
                    'name': folder['name'],
                    'size_gb': float(folder['size_gb'])
                })
            print(f"📊 Создано {len(histogram_data)} записей для гистограммы из текущих папок для {path}")
        
        sectioned_histogram = None
        if histogram_data and len(histogram_data) > 0:
            sectioned_histogram = create_sectioned_histogram(histogram_data, path, save_level)
        else:
            print(f"⚠️ Нет данных для гистограммы для {path}")
        
        parent_path = None
        parent_chart = None
        parent_folder_history = []
        
        if save_level > 1:
            path_obj = Path(path)
            parent_path = str(path_obj.parent) if path_obj.parent != path_obj else None
            
            if parent_path and parent_path != path:
                print(f"📡 Получение данных для родительского уровня: {parent_path}")
                parent_history_df = get_folder_history(get_disk_path(parent_path), parent_path)
                if not parent_history_df.empty and parent_history_df['scan_date'].nunique() > 1:
                    parent_chart = create_chart_plotly(parent_history_df, get_disk_path(parent_path), parent_path, 1)
                    parent_folder_history = get_folder_size_history(parent_path)
        
        return jsonify({
            'success': True,
            'path': path,
            'folders_count': stats[0],
            'total_size': stats[1],
            'total_size_str': format_size_auto(stats[1]),
            'folders': folders,
            'chart': chart_json,
            'scans_count': scans_count,
            'folder_history': folder_history,
            'histogram_data': histogram_data,
            'sectioned_histogram': sectioned_histogram,
            'level': save_level,
            'parent_path': parent_path,
            'parent_chart': parent_chart,
            'parent_folder_history': parent_folder_history
        })
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/load_from_db', methods=['POST'])
def load_from_db():
    """Загрузка данных из БД для указанных путей (без сканирования)"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Нет данных'}), 400
        
        paths = data.get('paths', [])
        if not paths:
            return jsonify({'error': 'Пути не указаны'}), 400
        
        results = []
        for path in paths:
            path = fix_path(path)
            print(f"📡 Загрузка из БД для: {path}")
            
            conn = get_db_connection()
            if not conn:
                results.append({
                    'path': path,
                    'error': 'Ошибка подключения к БД',
                    'success': False
                })
                continue
            
            try:
                disk_path = get_disk_path(path)
                
                cursor = conn.cursor()
                
                # Проверяем, есть ли данные для этого пути
                cursor.execute('''
                    SELECT COUNT(*) 
                    FROM scans 
                    WHERE parent_path = %s AND item_type = 'ПАПКА'
                ''', (path,))
                count = cursor.fetchone()[0]
                
                if count == 0:
                    # Попробуем найти данные для родительского пути
                    path_parts = path.split('\\')
                    if len(path_parts) >= 2:
                        parent_path = '\\'.join(path_parts[:-1])
                        folder_name = path_parts[-1]
                        
                        cursor.execute('''
                            SELECT COUNT(*) 
                            FROM scans 
                            WHERE parent_path = %s AND item_name = %s AND item_type = 'ПАПКА'
                        ''', (parent_path, folder_name))
                        count = cursor.fetchone()[0]
                        
                        if count == 0:
                            conn.close()
                            results.append({
                                'path': path,
                                'error': 'Нет данных в БД для этого пути',
                                'success': False
                            })
                            continue
                
                # Получаем последнюю дату сканирования для этого пути
                cursor.execute('''
                    SELECT MAX(scan_date) 
                    FROM scans 
                    WHERE parent_path = %s AND item_type = 'ПАПКА'
                ''', (path,))
                last_scan = cursor.fetchone()[0]
                
                if not last_scan:
                    conn.close()
                    results.append({
                        'path': path,
                        'error': 'Нет данных в БД для этого пути',
                        'success': False
                    })
                    continue
                
                # Получаем папки
                cursor.execute('''
                    SELECT DISTINCT item_name, size_gb, size_bytes, level
                    FROM scans 
                    WHERE parent_path = %s 
                    AND item_type = 'ПАПКА'
                    AND scan_date = %s
                    ORDER BY size_bytes DESC
                ''', (path, last_scan))
                
                folders_data = cursor.fetchall()
                
                folders = []
                total_size = 0
                for row in folders_data:
                    size_bytes = row[2]
                    folders.append({
                        'name': row[0],
                        'size': size_bytes,
                        'size_gb': float(row[1]),
                        'size_str': format_size_auto(size_bytes),
                        'path': f"{path}\\{row[0]}",
                        'level': row[3]
                    })
                    total_size += size_bytes
                
                # Получаем уровень
                cursor.execute('''
                    SELECT DISTINCT level 
                    FROM scans 
                    WHERE parent_path = %s AND item_type = 'ПАПКА'
                    ORDER BY level DESC
                    LIMIT 1
                ''', (path,))
                level_row = cursor.fetchone()
                current_level = level_row[0] if level_row else 1
                
                cursor.close()
                conn.close()
                
                # Получаем историю для графиков
                history_df = get_folder_history(disk_path, path)
                
                chart_json = None
                scans_count = 0
                
                if not history_df.empty:
                    scans_count = history_df['scan_date'].nunique()
                    if scans_count > 1:
                        chart_json = create_chart_plotly(history_df, disk_path, path, current_level)
                
                # Подготавливаем данные для гистограммы
                histogram_data = []
                if not history_df.empty:
                    history_df_sorted = history_df.sort_values('scan_date')
                    for _, row in history_df_sorted.iterrows():
                        date_str = row['scan_date'].strftime('%Y-%m-%d %H:%M')
                        histogram_data.append({
                            'date': date_str,
                            'name': row['item_name'],
                            'size_gb': float(row['size_gb'])
                        })
                else:
                    # Если нет истории, используем текущие данные
                    current_date = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
                    for folder in folders:
                        histogram_data.append({
                            'date': current_date,
                            'name': folder['name'],
                            'size_gb': float(folder['size_gb'])
                        })
                
                sectioned_histogram = None
                if histogram_data and len(histogram_data) > 0:
                    sectioned_histogram = create_sectioned_histogram(histogram_data, path, current_level)
                
                folder_history = get_folder_size_history(path)
                
                results.append({
                    'success': True,
                    'path': path,
                    'folders_count': len(folders),
                    'total_size': total_size,
                    'total_size_str': format_size_auto(total_size),
                    'folders': folders,
                    'chart': chart_json,
                    'scans_count': scans_count,
                    'folder_history': folder_history,
                    'histogram_data': histogram_data,
                    'sectioned_histogram': sectioned_histogram,
                    'level': current_level,
                    'last_scan': last_scan.strftime('%Y-%m-%d %H:%M:%S'),
                    'disk_path': disk_path
                })
                
            except Exception as e:
                print(f"❌ Ошибка загрузки для {path}: {e}")
                traceback.print_exc()
                if conn:
                    conn.close()
                results.append({
                    'path': path,
                    'error': str(e),
                    'success': False
                })
        
        # Фильтруем успешные результаты
        valid_results = [r for r in results if r.get('success', False)]
        errors = [r for r in results if not r.get('success', False)]
        
        return jsonify({
            'results': valid_results,
            'errors': errors,
            'total': len(results),
            'success_count': len(valid_results),
            'error_count': len(errors)
        })
        
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/browse_from_db', methods=['POST'])
def browse_from_db():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Нет данных'}), 400
        
        path = data.get('path')
        if not path:
            return jsonify({'error': 'Путь не указан'}), 400
        
        path = fix_path(path)
        print(f"📡 Просмотр из БД: {path}")
        
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Ошибка подключения к БД'}), 500
        
        disk_path = get_disk_path(path)
        
        cursor = conn.cursor()
        cursor.execute('''
            SELECT DISTINCT level
            FROM scans 
            WHERE parent_path = %s AND item_type = 'ПАПКА'
            ORDER BY level DESC
            LIMIT 1
        ''', (path,))
        level_row = cursor.fetchone()
        current_level = level_row[0] if level_row else 1
        
        cursor.execute('''
            SELECT DISTINCT item_name, size_gb, size_bytes, level
            FROM scans 
            WHERE parent_path = %s AND item_type = 'ПАПКА'
            AND scan_date = (
                SELECT MAX(scan_date) 
                FROM scans 
                WHERE parent_path = %s AND item_type = 'ПАПКА'
            )
            ORDER BY size_bytes DESC
        ''', (path, path))
        
        folders_data = cursor.fetchall()
        cursor.close()
        
        items = []
        total_size = 0
        
        for row in folders_data:
            size_bytes = row[2]
            level = row[3] if len(row) > 3 else current_level
            items.append({
                'name': row[0],
                'size': size_bytes,
                'size_gb': float(row[1]),
                'size_str': format_size_auto(size_bytes),
                'path': f"{path}\\{row[0]}",
                'type': 'folder',
                'level': level
            })
            total_size += size_bytes
        
        if not items:
            path_parts = path.split('\\')
            if len(path_parts) >= 2:
                folder_name = path_parts[-1]
                parent_of_parent = '\\'.join(path_parts[:-1])
                
                cursor = conn.cursor()
                cursor.execute('''
                    SELECT item_name, size_gb, size_bytes, level
                    FROM scans 
                    WHERE disk_path = %s 
                    AND parent_path = %s 
                    AND item_name = %s
                    AND item_type = 'ПАПКА'
                    AND scan_date = (
                        SELECT MAX(scan_date) 
                        FROM scans 
                        WHERE disk_path = %s AND parent_path = %s AND item_type = 'ПАПКА'
                    )
                ''', (disk_path, parent_of_parent, folder_name, disk_path, parent_of_parent))
                folder_data = cursor.fetchone()
                cursor.close()
                
                if folder_data:
                    cursor = conn.cursor()
                    cursor.execute('''
                        SELECT DISTINCT item_name, size_gb, size_bytes, level
                        FROM scans 
                        WHERE disk_path = %s 
                        AND parent_path = %s 
                        AND item_type = 'ПАПКА'
                        AND scan_date = (
                            SELECT MAX(scan_date) 
                            FROM scans 
                            WHERE disk_path = %s AND parent_path = %s AND item_type = 'ПАПКА'
                        )
                        ORDER BY size_bytes DESC
                    ''', (disk_path, path, disk_path, path))
                    folders_data = cursor.fetchall()
                    cursor.close()
                    
                    for row in folders_data:
                        size_bytes = row[2]
                        level = row[3] if len(row) > 3 else 2
                        items.append({
                            'name': row[0],
                            'size': size_bytes,
                            'size_gb': float(row[1]),
                            'size_str': format_size_auto(size_bytes),
                            'path': f"{path}\\{row[0]}",
                            'type': 'folder',
                            'level': level
                        })
                        total_size += size_bytes
        
        conn.close()
        
        folder_history = get_folder_size_history(path)
        history_df = get_folder_history(disk_path, path)
        
        chart_json = None
        scans_count = 0
        
        if not history_df.empty:
            scans_count = history_df['scan_date'].nunique()
            print(f"📊 Количество сканирований для {path}: {scans_count}")
            if scans_count > 1:
                chart_json = create_chart_plotly(history_df, disk_path, path, current_level)
            else:
                print(f"⚠️ Недостаточно данных для графика (нужно >= 2 сканирований) для {path}")
        
        histogram_data = []
        if not history_df.empty:
            history_df_sorted = history_df.sort_values('scan_date')
            for _, row in history_df_sorted.iterrows():
                date_str = row['scan_date'].strftime('%Y-%m-%d %H:%M')
                histogram_data.append({
                    'date': date_str,
                    'name': row['item_name'],
                    'size_gb': float(row['size_gb'])
                })
            print(f"📊 Подготовлено {len(histogram_data)} записей для гистограммы из истории для {path}")
        elif items and len(items) > 0:
            current_date = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
            for item in items:
                histogram_data.append({
                    'date': current_date,
                    'name': item['name'],
                    'size_gb': item['size_gb']
                })
            print(f"📊 Создано {len(histogram_data)} записей для гистограммы из текущих папок для {path}")
        else:
            print(f"📊 Папка {path} пуста или не сканировалась")
        
        sectioned_histogram = None
        if histogram_data and len(histogram_data) > 0:
            sectioned_histogram = create_sectioned_histogram(histogram_data, path, current_level)
        else:
            print(f"⚠️ Нет данных для гистограммы для {path}")
        
        parent_path = None
        parent_chart = None
        parent_folder_history = []
        
        if current_level > 1:
            path_obj = Path(path)
            parent_path = str(path_obj.parent) if path_obj.parent != path_obj else None
            
            if parent_path and parent_path != path:
                print(f"📡 Получение данных для родительского уровня: {parent_path}")
                parent_history_df = get_folder_history(get_disk_path(parent_path), parent_path)
                if not parent_history_df.empty and parent_history_df['scan_date'].nunique() > 1:
                    parent_chart = create_chart_plotly(parent_history_df, get_disk_path(parent_path), parent_path, 1)
                    parent_folder_history = get_folder_size_history(parent_path)
        
        return jsonify({
            'path': path,
            'items': items,
            'items_count': len(items),
            'total_size': total_size,
            'total_size_str': format_size_auto(total_size),
            'scans_count': scans_count,
            'chart': chart_json,
            'histogram_data': histogram_data,
            'sectioned_histogram': sectioned_histogram,
            'folder_history': folder_history,
            'level': current_level,
            'parent_path': parent_path,
            'parent_chart': parent_chart,
            'parent_folder_history': parent_folder_history
        })
        
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/paths', methods=['GET'])
def get_paths():
    try:
        paths = get_all_paths()
        return jsonify(paths)
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        return jsonify([])

@app.route('/api/parent_data', methods=['POST'])
def get_parent_data():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Нет данных'}), 400
        
        path = data.get('path')
        if not path:
            return jsonify({'error': 'Путь не указан'}), 400
        
        path = fix_path(path)
        print(f"📡 Получение данных родительского уровня для: {path}")
        
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Ошибка БД'}), 500
        
        disk_path = get_disk_path(path)
        
        cursor = conn.cursor()
        cursor.execute('''
            SELECT DISTINCT level 
            FROM scans 
            WHERE parent_path = %s AND item_type = 'ПАПКА'
            ORDER BY level DESC
            LIMIT 1
        ''', (path,))
        level_row = cursor.fetchone()
        current_level = level_row[0] if level_row else 1
        cursor.close()
        
        history_df = get_folder_history(disk_path, path)
        chart_json = None
        
        if not history_df.empty and history_df['scan_date'].nunique() > 1:
            chart_json = create_chart_plotly(history_df, disk_path, path, current_level)
        
        folder_history = get_folder_size_history(path)
        current_folders = get_current_folders(disk_path, path)
        
        histogram_data = []
        if not history_df.empty:
            history_df_sorted = history_df.sort_values('scan_date')
            for _, row in history_df_sorted.iterrows():
                date_str = row['scan_date'].strftime('%Y-%m-%d %H:%M')
                histogram_data.append({
                    'date': date_str,
                    'name': row['item_name'],
                    'size_gb': float(row['size_gb'])
                })
        
        sectioned_histogram = None
        if histogram_data and len(histogram_data) > 0:
            sectioned_histogram = create_sectioned_histogram(histogram_data, path, current_level)
        else:
            print(f"⚠️ Нет данных для гистограммы для {path}")
        
        conn.close()
        
        return jsonify({
            'path': path,
            'level': current_level,
            'chart': chart_json,
            'folder_history': folder_history,
            'folders': current_folders,
            'histogram_data': histogram_data,
            'sectioned_histogram': sectioned_histogram,
            'folders_count': len(current_folders),
            'total_size': sum(float(f['size_bytes']) for f in current_folders) if current_folders else 0,
            'total_size_str': format_size_auto(sum(float(f['size_bytes']) for f in current_folders) if current_folders else 0),
            'scans_count': history_df['scan_date'].nunique() if not history_df.empty else 0
        })
        
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/report', methods=['POST'])
def report():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Нет данных'}), 400
        
        path = data.get('path')
        if not path:
            return jsonify({'error': 'Путь не указан'}), 400
        
        path = fix_path(path)
        print(f"📡 Отчёт для: {path}")
        
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Ошибка БД'}), 500
        
        folder_history = get_folder_size_history(path)
        
        cursor = conn.cursor()
        cursor.execute('''
            SELECT DISTINCT disk_path 
            FROM scans 
            WHERE parent_path = %s AND item_type = 'ПАПКА'
        ''', (path,))
        disk_data = cursor.fetchone()
        cursor.close()
        
        if not disk_data:
            conn.close()
            return jsonify({
                'path': path,
                'disk': '',
                'folders': [],
                'history': [],
                'chart': None,
                'scans_count': 0,
                'total_folders': 0,
                'total_size_gb': 0,
                'total_size_str': '0',
                'folder_history': folder_history,
                'histogram_data': [],
                'sectioned_histogram': None,
                'level': 1,
                'parent_path': None,
                'parent_chart': None,
                'parent_folder_history': []
            })
        
        disk_path = disk_data[0]
        print(f"📌 disk_path: {disk_path}")
        
        cursor = conn.cursor()
        cursor.execute('''
            SELECT DISTINCT level 
            FROM scans 
            WHERE parent_path = %s AND item_type = 'ПАПКА'
            ORDER BY level DESC
            LIMIT 1
        ''', (path,))
        level_row = cursor.fetchone()
        current_level = level_row[0] if level_row else 1
        cursor.close()
        
        history_df = get_folder_history(disk_path, path)
        
        if history_df.empty:
            conn.close()
            return jsonify({
                'path': path,
                'disk': disk_path,
                'folders': [],
                'history': [],
                'chart': None,
                'scans_count': 0,
                'total_folders': 0,
                'total_size_gb': 0,
                'total_size_str': '0',
                'folder_history': folder_history,
                'histogram_data': [],
                'sectioned_histogram': None,
                'level': current_level,
                'parent_path': None,
                'parent_chart': None,
                'parent_folder_history': []
            })
        
        current_folders = get_current_folders(disk_path, path)
        
        chart_json = None
        if not history_df.empty and history_df['scan_date'].nunique() > 1:
            chart_json = create_chart_plotly(history_df, disk_path, path, current_level)
        
        histogram_data = []
        if not history_df.empty:
            history_df_sorted = history_df.sort_values('scan_date')
            for _, row in history_df_sorted.iterrows():
                date_str = row['scan_date'].strftime('%Y-%m-%d %H:%M')
                histogram_data.append({
                    'date': date_str,
                    'name': row['item_name'],
                    'size_gb': float(row['size_gb'])
                })
            print(f"📊 Подготовлено {len(histogram_data)} записей для гистограммы из истории для {path}")
        
        sectioned_histogram = None
        if histogram_data and len(histogram_data) > 0:
            sectioned_histogram = create_sectioned_histogram(histogram_data, path, current_level)
        else:
            print(f"⚠️ Нет данных для гистограммы для {path}")
        
        parent_path = None
        parent_chart = None
        parent_folder_history = []
        
        if current_level > 1:
            path_obj = Path(path)
            parent_path = str(path_obj.parent) if path_obj.parent != path_obj else None
            
            if parent_path and parent_path != path:
                print(f"📡 Получение данных для родительского уровня: {parent_path}")
                parent_history_df = get_folder_history(get_disk_path(parent_path), parent_path)
                if not parent_history_df.empty and parent_history_df['scan_date'].nunique() > 1:
                    parent_chart = create_chart_plotly(parent_history_df, get_disk_path(parent_path), parent_path, 1)
                    parent_folder_history = get_folder_size_history(parent_path)
        
        history_data = []
        history_sorted = history_df.sort_values(['scan_date', 'item_name'], ascending=[False, True])
        for _, row in history_sorted.head(50).iterrows():
            history_data.append({
                'date': row['scan_date'].strftime('%Y-%m-%d %H:%M'),
                'name': row['item_name'],
                'size_gb': round(float(row['size_gb']), 4),
                'level': int(row['level']) if 'level' in row else 1
            })
        
        total_folders = len(current_folders)
        total_size = sum(float(f['size_bytes']) for f in current_folders) if current_folders else 0
        
        conn.close()
        
        return jsonify({
            'path': path,
            'disk': disk_path,
            'folders': current_folders,
            'history': history_data,
            'chart': chart_json,
            'scans_count': history_df['scan_date'].nunique(),
            'total_folders': total_folders,
            'total_size_gb': round(total_size / (1024**3), 2),
            'total_size_str': format_size_auto(total_size),
            'folder_history': folder_history,
            'histogram_data': histogram_data,
            'sectioned_histogram': sectioned_histogram,
            'level': current_level,
            'parent_path': parent_path,
            'parent_chart': parent_chart,
            'parent_folder_history': parent_folder_history
        })
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/export_excel', methods=['POST'])
def export_excel():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Нет данных'}), 400
        
        path = data.get('path')
        if not path:
            return jsonify({'error': 'Путь не указан'}), 400
        
        path = fix_path(path)
        print(f"📊 Экспорт Excel для: {path}")
        
        conn = get_db_connection()
        if not conn:
            return jsonify({'error': 'Ошибка БД'}), 500
        
        disk_path = get_disk_path(path)
        
        history_df = get_folder_history(disk_path, path)
        
        if history_df.empty:
            conn.close()
            return jsonify({'error': 'Нет данных для экспорта'}), 400
        
        current_folders = get_current_folders(disk_path, path)
        
        cursor = conn.cursor()
        cursor.execute('''
            SELECT DISTINCT level 
            FROM scans 
            WHERE parent_path = %s AND item_type = 'ПАПКА'
            ORDER BY level DESC
            LIMIT 1
        ''', (path,))
        level_row = cursor.fetchone()
        current_level = level_row[0] if level_row else 1
        cursor.close()
        conn.close()
        
        filepath, filename = generate_and_save_excel_report(
            path, 
            disk_path, 
            history_df, 
            current_folders, 
            current_level
        )
        
        return send_file(
            filepath,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=filename
        )
        
    except Exception as e:
        print(f"❌ Ошибка экспорта Excel: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# ========================================================================
# ЗАПУСК
# ========================================================================

if __name__ == '__main__':
    init_db()
    print("\n" + "=" * 60)
    print("🚀 ЗАПУСК ВЕБ-ИНТЕРФЕЙСА")
    print("=" * 60)
    print(f"📁 Папка для отчетов: {REPORTS_DIR}")
    print("🌐 Откройте: http://localhost:5000")
    print("📂 Поддерживается сканирование любого количества путей")
    print("📊 Для каждого пути свои графики")
    print("📊 Добавлен экспорт в Excel с сохранением в папку reports")
    print("📊 Добавлена кнопка 'Загрузить из БД' для быстрой загрузки данных")
    print("=" * 60 + "\n")
    app.run(debug=True, host='0.0.0.0', port=5000)