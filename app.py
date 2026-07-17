import matplotlib
matplotlib.use('Agg')

from flask import Flask, render_template, request, jsonify
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

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'

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
        return [{'name': row[0], 'size_gb': round(row[1], 4), 'size_bytes': row[2], 'level': row[3]} for row in data]
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
        return [{'name': row[0], 'size_gb': round(row[1], 4), 'size_bytes': row[2], 'level': row[3]} for row in data]
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        return []
    finally:
        conn.close()

# ========================================================================
# ФУНКЦИЯ ПОСТРОЕНИЯ ГРАФИКОВ - ИСПРАВЛЕННАЯ
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
        sorted_folders = sorted(folders, key=lambda x: folder_sizes.get(x, 0), reverse=True)
        
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
            sizes = folder_data['size_gb'].tolist()
            
            color = colors[idx % len(colors)]
            dash = 'dash' if folder_name == '📁 Остальные папки' else 'solid'
            line_width = 2 if folder_name == '📁 Остальные папки' else 3
            
            # ИСПРАВЛЕНО: передаем имя папки в customdata
            fig.add_trace(go.Scatter(
                x=dates,
                y=sizes,
                mode='lines+markers',
                name=folder_name[:30] + ('...' if len(folder_name) > 30 else ''),
                line=dict(color=color, width=line_width, dash=dash),
                marker=dict(size=8, color=color),
                customdata=[folder_name] * len(dates),
                # ИСПРАВЛЕНО: используем %{customdata}
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
            y=total_per_date['size_gb'],
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
                    'size_gb': folder['size_gb']
                })
            print(f"📊 Создано {len(histogram_data)} записей для гистограммы из текущих папок для {path}")
        
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
            'level': save_level,
            'parent_path': parent_path,
            'parent_chart': parent_chart,
            'parent_folder_history': parent_folder_history
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
        
        conn.close()
        
        return jsonify({
            'path': path,
            'level': current_level,
            'chart': chart_json,
            'folder_history': folder_history,
            'folders': current_folders,
            'histogram_data': histogram_data,
            'folders_count': len(current_folders),
            'total_size': sum(f['size_bytes'] for f in current_folders) if current_folders else 0,
            'total_size_str': format_size_auto(sum(f['size_bytes'] for f in current_folders) if current_folders else 0),
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
                'size_gb': round(row['size_gb'], 4),
                'level': int(row['level']) if 'level' in row else 1
            })
        
        total_folders = len(current_folders)
        total_size = sum(f['size_bytes'] for f in current_folders) if current_folders else 0
        
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
            'level': current_level,
            'parent_path': parent_path,
            'parent_chart': parent_chart,
            'parent_folder_history': parent_folder_history
        })
    except Exception as e:
        print(f"❌ Ошибка: {e}")
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
    print("🌐 Откройте: http://localhost:5000")
    print("📂 Поддерживается сканирование любого количества путей")
    print("📊 Для каждого пути свои 4 графика (2 уровня 1 + 2 уровня 2)")
    print("📊 Навигация работает независимо для каждого пути")
    print("📊 Данные для гистограмм берутся из истории сканирований")
    print("📊 Папки второго уровня сканируются и сохраняются автоматически")
    print("📊 Во всплывающих подсказках отображаются названия папок")
    print("=" * 60 + "\n")
    app.run(debug=True, host='0.0.0.0', port=5000)