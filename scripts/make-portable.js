'use strict';

/**
 * Готовит папку, которую можно целиком отправить друзьям.
 *
 *   release/
 *   ├── D&D Стол/              <- эту папку и отправляем
 *   │   ├── D&D Стол.exe       <- игра
 *   │   ├── resources/, locales/, *.dll ...   (всё, что нужно приложению)
 *   │   ├── portable.txt       <- переключает хранение данных на ./data
 *   │   ├── ПРОЧТИ МЕНЯ.txt    <- инструкция для друзей
 *   │   └── data/              <- сюда сложатся кампании, карты и картинки
 *   └── D&D Стол.zip           <- тот же комплект архивом
 *
 * Запуск: npm run dist && npm run dist:portable
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appName = packageJson.build.productName;
const outputDir = (packageJson.build && packageJson.build.directories && packageJson.build.directories.output) || 'dist';
const distUnpacked = path.join(root, outputDir, 'win-unpacked');
const releaseDir = path.join(root, 'release');

const releaseApp = path.join(releaseDir, appName);
const zipPath = path.join(releaseDir, `${appName}.zip`);

const READ_ME = `D&D Стол — как играть
========================================================

1. ЗАПУСК
   Дважды щёлкните «${appName}.exe».
   Установка не нужна, права администратора тоже.

   ЭТУ ПАПКУ НУЖНО РАСПАКОВАТЬ ЦЕЛИКОМ, а не вытаскивать из неё один exe:
   рядом с ним лежат служебные папки, без них игра не запустится.

2. ДАННЫЕ
   Всё, что вы создадите — кампании, карты, картинки фишек — сохраняется в
   подпапку data внутри этой же папки. Ничего не пишется в Windows.
   Хотите перенести игру на другой компьютер — просто скопируйте папку целиком.

3. КАК СОБРАТЬСЯ ЗА СТОЛОМ
   Один человек — Мастер (ДМ). Он запускает игру, создаёт кампанию и
   нажимает «Создать и запустить стол». На экране появятся адреса.

   Остальные запускают игру у себя, выбирают «Подключиться к столу», вводят
   адрес, который дал ДМ (целиком, вместе с портом), и своё имя.

4. ПРО СЕТЬ — ВАЖНО
   Игра НЕ создаёт сеть и НЕ настраивает VPN. Она только использует ту сеть,
   которая у вас уже есть. Все участники должны быть в одной из сетей:

   * одна домашняя локальная сеть (Wi-Fi или кабель);
   * одна виртуальная сеть: Hamachi, Radmin VPN или ZeroTier —
     её нужно установить и подключиться к общей комнате заранее;
   * либо Porthole (Local Port Sharing) из Steam: ДМ делится в нём портом
     стола, друзья принимают порт у себя, и в приложении вводят адрес
     http://127.0.0.1:<порт стола> (он показан в панели адресов).

   На экране ДМ адреса разложены по группам: «Локальная сеть» и
   «Виртуальная сеть». Нажмите «Скопировать адрес» и отправьте нужный
   адрес игрокам.

5. ЕСЛИ ВЫ РАЗНЫЕ СЕТИ — ПОДКЛЮЧЕНИЕ ПО P2P
   Общая сеть не нужна. ДМ копирует на экране стола в панели адресов блок
   «P2P-адрес (кроме сети)» и отправляет игрокам. Каждый вставляет этот
   билет на экране «Подключиться к столу» в поле «P2P-билет от ДМ» и
   жмёт «Подключиться по P2P».

   Нужен доступ в интернет и разрешение на сеть в брандмауэре: iroh сам
   пробивает NAT — напрямую, а если не выйдет, через публичный relay.

6. ЕСЛИ НЕ ПОДКЛЮЧАЕТСЯ
   * Проверьте, что адрес введён целиком, вместе с портом (например
     http://192.168.1.10:32100).
   * Убедитесь, что все в одной сети — сравните адреса на экране ДМ.
   * Разрешите игру в брандмауэре Windows: при первом запуске система
     спросит про доступ к сети — нужно разрешить. Если окно пропустили,
     откройте «Брандмауэр Защитника Windows» -> «Разрешить работу с
     приложением» и поставьте галочки для «${appName}».

7. ЧТО ЕСТЬ В ИГРЕ
   * лист персонажа по D&D 5e (2014) с автоматическим расчётом
     модификаторов, бонуса мастерства, спасбросков, навыков и
     пассивной Внимательности;
   * свой лист персонажа у каждого игрока: чужие листы не видны,
     а ДМ может открыть любой в режиме просмотра;
   * лист можно вынести в отдельное окно (кнопка «Отдельным окном») —
     удобно держать рядом или на втором мониторе;
   * три вкладки карт: общая, карта локации/битвы и «Рисунок» — в каждой
     вкладке можно держать несколько карт и переключаться между ними;
   * карту можно нарисовать самому, а подложкой взять уже загруженную;
   * приближение карты: колесо мыши и кнопки «-/+» в углу карты, карту
     можно таскать мышью; у каждого своё приближение;
   * сетка на карте: включается ДМ, клетка ровно по размеру фишки;
   * панели стола можно свернуть, чтобы стол был больше;
   * фишки: ДМ создаёт и назначает их игрокам, игрок двигает свою и
     может поставить ей картинку;
   * кубики от d1 до d20 и общий чат;
   * сохранение кампании кнопкой, автосохранение раз в минуту и при выходе.

8. СТОЛ БЕЗ СЕТИ (ЕСЛИ ИГРАТЬ ПОКА НЕ С КЕМ)
   В настройках («Настройки» на главном экране) есть кнопка «Запустить стол
   без сервера». Она открывает стол от лица игрока, но без сети: сервер не
   поднимается, порт никто не слушает. Так можно заранее заполнить лист
   персонажа и спокойно осмотреть игру — лист при этом сохраняется на вашем
   компьютере.

   Когда позже подключитесь к настоящему столу ДМ, приложение предложит
   отправить эту заготовку на стол — но только если лист вашего персонажа там
   ещё пуст. Отказаться тоже можно: тогда заготовка останется только у вас.

   Карты, фишки и чат в этом режиме нужны для проверки и до закрытия окна: они
   никуда не сохраняются. Лист персонажа — сохраняется.

Правила: D&D 5e, базовые правила 2014 года.
Версия игры: 0.9b.
`;

function findExe(dir) {
  const name = fs.readdirSync(dir).find((file) => file.toLowerCase().endsWith('.exe'));
  if (!name) throw new Error(`В ${dir} нет exe`);
  return name;
}

/**
 * Если приложение запущено из этой папки, файлы заняты: обновлять сборку нельзя,
 * иначе часть файлов не заменится и останется «полусобранное» состояние.
 */
function assertAppNotRunning() {
  const exePath = path.join(releaseApp, `${appName}.exe`);
  if (!fs.existsSync(exePath)) return;
  try {
    const handle = fs.openSync(exePath, 'r+');
    fs.closeSync(handle);
  } catch {
    throw new Error(
      `Файл «${exePath}» занят: приложение уже запущено. Закройте «${appName}» и повторите сборку.`
    );
  }
}

function copyApp() {
  if (!fs.existsSync(distUnpacked)) {
    throw new Error(`Нет папки ${distUnpacked}. Сначала выполните: npm run dist`);
  }
  assertAppNotRunning();

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(releaseApp, { recursive: true });
  // Копируем файлы поверх, НЕ удаляя папку: внутри лежит data с кампаниями,
  // картами и картинками фишек. Обновление сборки не должно их терять.
  fs.cpSync(distUnpacked, releaseApp, { recursive: true, force: true });
}

const DATA_NOTE = 'Сюда игра складывает кампании и все загруженные картинки.\r\n'
  + 'Чтобы перенести игру на другой компьютер, копируйте папку с игрой целиком.\r\n'
  + 'Внутри появится папка campaigns с папками кампаний.\r\n';

function preparePortableBits() {
  fs.writeFileSync(
    path.join(releaseApp, 'portable.txt'),
    'Этот файл включает портативный режим: данные хранятся в папке data рядом с игрой.\r\n',
    'utf8'
  );
  fs.writeFileSync(path.join(releaseApp, 'ПРОЧТИ МЕНЯ.txt'), READ_ME, 'utf8');

  const dataDir = path.join(releaseApp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dataNote();
}

function dataNote() {
  fs.writeFileSync(path.join(releaseApp, 'data', 'ЧТО ЗДЕСЬ.txt'), DATA_NOTE, 'utf8');
}

/** Синхронная пауза: сборка — последовательный скрипт, async здесь не нужен. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Упаковка архива с повторами.
 *
 * Сразу после копирования сборки exe ещё держат Windows и антивирус (файл
 * только что перезаписан), и Compress-Archive падает с «used by another
 * process». Через несколько секунд файл освобождается, поэтому пробуем ещё раз,
 * а не заставляем человека запускать сборку повторно.
 */
function compressArchive(attempts = 3, delayMs = 5000) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // -ErrorAction Stop: без него PowerShell сообщает о занятом файле, но
        // возвращает код 0, и на выходе получается молча испорченный архив.
        `Compress-Archive -LiteralPath '${releaseApp}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force -ErrorAction Stop`
      ], { stdio: 'inherit' });
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.log(`Архивация не удалась — файлы ещё заняты. Повтор ${attempt + 1} из ${attempts}…`);
      fs.rmSync(zipPath, { force: true });
      sleepSync(delayMs);
    }
  }
}

/**
 * Упаковывает папку в архив, НЕ включая в него кампании ДМ: получателю нужна
 * чистая игра. Папку data на время упаковки убираем в сторону (переименование
 * внутри того же диска мгновенное) и обязательно возвращаем обратно.
 */
function makeZip() {
  fs.rmSync(zipPath, { force: true });
  const dataDir = path.join(releaseApp, 'data');
  const stash = path.join(releaseDir, `${appName}-data-stash`);
  let stashed = false;

  try {
    if (fs.existsSync(dataDir)) {
      fs.rmSync(stash, { recursive: true, force: true });
      fs.renameSync(dataDir, stash);
      stashed = true;
    }
    fs.mkdirSync(dataDir, { recursive: true });
    dataNote();

    compressArchive();
  } finally {
    if (stashed) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.renameSync(stash, dataDir);
    }
  }
  return fs.existsSync(zipPath);
}

/**
 * Проверяет архив так, как его увидит получатель: распаковывает во временную
 * папку и убеждается, что exe, portable.txt и служебные папки не испортились
 * (это ловит и проблемы с кодировкой имён внутри zip).
 */
function verifyZip() {
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-zip-check-'));
  const problems = [];
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${checkDir}' -Force`
    ], { stdio: 'ignore' });

    const unpacked = path.join(checkDir, appName);
    if (!fs.existsSync(unpacked)) {
      problems.push(`в архиве нет папки «${appName}»`);
      return problems;
    }
    const exeName = findExe(unpacked);
    if (exeName !== `${appName}.exe`) {
      problems.push(`имя exe испортилось: «${exeName}» вместо «${appName}.exe»`);
    }
    for (const required of ['portable.txt', 'ПРОЧТИ МЕНЯ.txt', 'resources', 'locales', 'data']) {
      if (!fs.existsSync(path.join(unpacked, required))) problems.push(`в архиве нет «${required}»`);
    }
    const campaigns = path.join(unpacked, 'data', 'campaigns');
    if (fs.existsSync(campaigns) && fs.readdirSync(campaigns).length) {
      problems.push('в архив попали кампании ДМ — получателю должна уходить чистая игра');
    }
    const entries = fs.readdirSync(unpacked);
    if (entries.length < 20) problems.push(`в архиве подозрительно мало файлов: ${entries.length}`);
  } finally {
    try {
      fs.rmSync(checkDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch { /* временная папка */ }
  }
  return problems;
}

function main() {
  if (!fs.existsSync(distUnpacked)) {
    throw new Error('Сначала соберите приложение: npm run dist');
  }
  const campaignsDir = path.join(releaseApp, 'data', 'campaigns');
  const campaignsBefore = fs.existsSync(campaignsDir) ? fs.readdirSync(campaignsDir).length : 0;

  copyApp();
  preparePortableBits();
  makeZip();

  const exeName = findExe(releaseApp);
  const problems = verifyZip();
  const zipSize = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);

  console.log('\nГотово к отправке\n');
  console.log(`  Папка:  ${releaseApp}`);
  console.log(`  Игра:   ${path.join(releaseApp, exeName)}`);
  console.log(`  Архив:  ${zipPath} (${zipSize} МБ)`);
  console.log(`  Данные: ${path.join(releaseApp, 'data')} — поедут вместе с папкой`);
  if (campaignsBefore) {
    console.log(`          ваши кампании сохранены: ${campaignsBefore} шт. (папка data не очищается)`);
  }

  if (problems.length) {
    console.log('\nПроблемы с архивом:');
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nАрхив распаковывается корректно (проверено распаковкой во временную папку).');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    process.exit(1);
  }
}
