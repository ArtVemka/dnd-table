# Сводка по версии 1.8.0

Рабочая заметка для следующего захода. Не пользовательская документация.

## Что сделано

* Структурированный журнал кампании: НПС, места, задания, фракции, предметы,
  теги и поиск. Панель мастера в левой колонке и отдельное окно.
* Общий склад партии: количество, вес, владелец, настройка, заметки. Мастер
  правит, игроки читают.
* Просьбы мастера о бросках: карточка у игрока, кнопка «Бросить», результат в
  чате.
* Отмена действий мастера: фишки, прочность, состояния, шаблоны, туман, карты.
  Снимки хранятся в памяти, до 20 шагов.
* Общий поиск по журналу, чату и складу, `Ctrl+K`.
* Доступность: масштаб, высокий контраст, палитра для дальтоников. Английский
  интерфейс отложен.
* В релиз также вошли хендауты картинками, квадратные шаблоны с цветом, QR-билет
  и планшетная раскладка Android из предыдущего этапа.

## Где смотреть

* `server/state.js`: `journalEntries`, `inventory`, `rollRequests`, `undoStack`,
  нормализация и CRUD.
* `server/socket.js`: события `saveJournalEntry`, `deleteJournalEntry`,
  `journalRequest`, `saveInventoryItem`, `deleteInventoryItem`, `rollRequest`,
  `rollRequestClear`, `undoDmAction`, `broadcastSnapshot`.
* `renderer/app.js`: `roomFromState`, `stateReload`, панели журнала и склада,
  проверки, отмена, поиск, доступность.
* `renderer/table.js`: картинки-хендауты и шаблоны.
* `main.js`, `preload-journal.js`, `renderer/journal-window.*`: отдельное окно
  журнала.
* `test/integration.js`, `test/renderer-assertions.js`: поведение и интерфейс.
* `test/packaged-smoke.js`: собранное приложение и архив из `release/`.
* `test/android-layout.js`: телефон и два планшетных размера.

## Проверки

* `npm test`: 280 интеграционных проверок, 0 ошибок.
* `npx electron test/smoke-main.js`: 396 проверок, 0 ошибок.
* `node test/packaged-smoke.js`: успешно.
* `npx electron test/android-layout.js`: телефон, планшет в альбоме и портрете.
* `android/gradlew.bat assembleDebug`: успешно, versionCode 4.

## Релиз

* Версия в `package.json` и Android: 1.8.0.
* Тег `v1.8.0` указывает на коммит релиза.
* CI на теге собирает Windows, Linux и Android, затем создаёт GitHub Release
  с файлами `DND-Table-1.8.0-windows-x64.zip`,
  `DND-Table-1.8.0-linux-x64.zip` и `DND-Table-1.8.0-android-debug.apk`.

## Ограничения

* APK подписан debug-ключом. Для магазина нужен release-keystore в секретах
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD`.
* Реального телефона или планшета под рукой нет. Раскладка проверена в Electron
  на 412x900, 1024x768 и 800x1024.
* Проверка собранного приложения запускает временную копию `dist-final`, потому
  что Chromium на этой машине падает при старте из папки с запретом удаления
  дочерних файлов. Архив из `release/` проверяется как у получателя.
* Тег `v1.7.0` остался на старом коммите. Не переписывать.
