import json
import sqlite3

connection = sqlite3.connect(':memory:')
connection.execute('CREATE VIRTUAL TABLE standard USING fts5(text)')
connection.execute("CREATE VIRTUAL TABLE grams USING fts5(text, tokenize='trigram')")
text = '一二期服务器部署配置，pi-agent 使用 memory.search。'
for table in ('standard', 'grams'):
    connection.execute(f'INSERT INTO {table}(text) VALUES (?)', (text,))
results = []
for query in ('服务器', '配置', 'pi', 'pi-agent'):
    quoted = '"' + query.replace('"', '""') + '"'
    results.append({
        'query': query,
        'default_fts_matches': bool(connection.execute('SELECT rowid FROM standard WHERE standard MATCH ?', (quoted,)).fetchall()),
        'trigram_matches': bool(connection.execute('SELECT rowid FROM grams WHERE grams MATCH ?', (quoted,)).fetchall()),
        'literal_alias_matches': query.casefold() in text.casefold(),
    })
print(json.dumps({'sqlite_version': sqlite3.sqlite_version, 'synthetic_text': text, 'results': results}, ensure_ascii=False, indent=2))
