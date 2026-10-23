# D&D Стол: игрок на Android

Отдельное приложение для телефона и планшета. Это не Electron: WebView
показывает тот же renderer, что и настольная версия, а Kotlin-туннель iroh
прокладывает socket.io до стола мастера. Мастер по-прежнему работает на
компьютере, игрок вставляет P2P-билет и садится за стол.

## Что умеет

* Вход за игрока по билету мастера, тот же протокол `dnd-table-p2p/1`.
* Билет вставляется кнопкой из буфера обмена или сканируется QR-кодом с экрана
  мастера.
* Карта, фишки, чат, кубики, порядок боя, свет, туман и лист персонажа.
* Лист можно заполнить до подключения и выбрать при входе.
* Темы, звук и настройки работают как на компьютере.
* На телефоне стол складывается в один столбец: карта сверху, вкладки снизу.
  Участники открываются поверх стола кнопкой в шапке.
* Пока игрок за столом, foreground service держит процесс живым, а в шторке
  висит уведомление. Выход из-за стола останавливает службу.

## Чего нет

* Мастерских экранов: кампании, импорт, карты и фишки создаёт ДМ на компьютере.
* Отдельного окна листа: лист правится во вкладке стола.
* Служба не переживает выгрузку задачи из недавних приложений: после этого
  подключение поднимается заново.

## Сборка

Нужны JDK 21, Android SDK 35 и build-tools 35.0.0. Путь к SDK берётся из
`ANDROID_HOME` или `local.properties` (файл не коммитится).

```bash
cd android
./gradlew assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

Release-сборка подписывается ключом из переменных окружения. Без них
`assembleRelease` собирается debug-ключом, чтобы локальная проверка не падала.

```bash
export ANDROID_KEYSTORE_FILE=/path/to/release.keystore
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_ALIAS=...
export ANDROID_KEY_PASSWORD=...
./gradlew assembleRelease
```

CI берёт ключ из секретов `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` и `ANDROID_KEY_PASSWORD`,
собирает `assembleRelease` на теге и прикрепляет APK к релизу. Keystore в
репозиторий не попадает.

Проверка моста без Android:

```bash
node test/android-bridge.js
```

Проверка мобильной раскладки после `assembleDebug`:

```bash
npx electron test/android-layout.js
```

## Как устроено

* `app/src/main/java/ru/dndstol/player/IrohTunnel.kt` повторяет
  `server/iroh-manager.js`: одно iroh-соединение, на каждый TCP-сокет свой
  bi-stream, локальный порт на `127.0.0.1`.
* `app/src/main/assets/android-bridge.js` определяет `window.desktop` и
  переводит вызовы renderer в методы Kotlin через `window.Android`.
* `app/src/main/java/ru/dndstol/player/TunnelService.kt` — foreground service:
  не даёт Android выгрузить процесс, пока игрок за столом. Туннель остаётся в
  Activity, служба только держит процесс и показывает уведомление.
* Renderer не копируется вручную: Gradle-задача `copyRenderer` берёт
  `../renderer` и добавляет в `index.html` одну строку с мостом.
* AAR `computer.iroh:iroh-android` содержит `libiroh_ffi.so` под ARM и x86.
  Обычный `computer.iroh:iroh` для Android не подходит: в нём только
  нативные библиотеки десктопа.

## Если меняется протокол

ALPN `dnd-table-p2p/1` записан в двух местах: `server/iroh-manager.js` и
`IrohTunnel.kt`. Менять их нужно вместе, иначе туннель молча не соединится.
