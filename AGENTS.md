# Правила проекта D&D Стол

## Установщик и обновления

- Установленная (non-portable) Windows-версия обязана проверять обновления на GitHub и ставить их. Не убирай `electron-updater`, IPC `update:check` и кнопку «Проверить обновления».
- Перед сборкой установщика поднимай версию в `package.json` выше последнего релиза (`gh release list -R ArtVemka/dnd-table`). С одинаковой версией автообновление не сработает.
- После сборки проверяй, что версия в `dist-final/latest.yml` и имя `DND-Table-Setup-*.exe` совпадают с `package.json`.
- Портативную версию автоматически не обновляй: она запускается с `portable.txt`, и данные лежат рядом с exe.
- Установщик для проверки запускай из папки, куда обычный пользователь может писать: `Downloads`, рабочий стол. В `dist-final` ACL мастерской может быть только на чтение, и NSIS покажет «Error writing temporary file. Make sure your temp folder is valid».
