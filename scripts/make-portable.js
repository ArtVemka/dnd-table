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
 * Запуск: npm run dist:portable
 *
 * Скрипт только пакует уже собранное приложение, поэтому при запуске вручную
 * без npm run dist он честно скажет об этом и остановится. Обычно запускают
 * через npm run dist:portable — он сначала собирает, потом пакует.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appName = packageJson.build.productName;
/**
 * Версия для текстов: из 0.10.0-b получается 0.10b. Раньше она была вписана
 * руками и со временем разошлась с package.json.
 */
const versionLabel = (() => {
  const [core] = String(packageJson.version || '0.0.0').split('-');
  return `${core.replace(/\.0$/, '')}b`;
  })();
/**
 * Имя запускаемого файла. На Windows это название продукта, на Linux — то,
 * что задано в build.linux.executableName: кириллица вместе с «&» и пробелами
 * там превращается в неожиданные имена, и скрипт перестаёт находить игру.
 */
const exeBase = process.platform === 'win32'
  ? appName
  : ((packageJson.build.linux && packageJson.build.linux.executableName) || appName);
const outputDir = (packageJson.build && packageJson.build.directories && packageJson.build.directories.output) || 'dist';
// electron-builder называет папку сборки по платформе: win-unpacked, linux-unpacked…
const unpackedDirName = process.platform === 'win32' ? 'win-unpacked' : `${process.platform}-unpacked`;
// Папку сборки можно указать первым аргументом. Это нужно, когда прежняя
// папка занята: Windows не даёт перезаписать файл, который держит антивирус
// или запущенная копия игры, и сборка в том же месте падает с EBUSY. Тогда
// electron-builder собирает в новую папку, а этот скрипт берёт её оттуда.
const distUnpacked = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, outputDir, unpackedDirName);
const releaseDir = path.join(root, 'release');

const releaseApp = path.join(releaseDir, appName);
const zipPath = path.join(releaseDir, `${appName}.zip`);

const launchHint = process.platform === 'win32'
  ? `   Дважды щёлкните «${exeBase}.exe». Установка не нужна, права администратора тоже.`
  : `   Откройте папку и запустите файл «${exeBase}»: двойной клик, либо в терминале\n   ./${exeBase} — если файловый менеджер не запускает его сам. Если он не стартует,\n   сделайте его исполняемым: правый клик → «Свойства» → «Разрешить выполнение\n   как программу».`;

const READ_ME = `D&D Стол — как играть
========================================================

1. ЗАПУСК
   ${launchHint}

   ЭТУ ПАПКУ НУЖНО РАСПАКОВАТЬ ЦЕЛИКОМ, а не вытаскивать из неё один файл:
   рядом с ним лежат служебные папки, без них игра не запустится.

2. ДАННЫЕ
   Всё, что вы создадите — кампании, карты, картинки фишек — сохраняется в
   подпапку data внутри этой же папки. Ничего не пишется в систему.
   Хотите перенести игру на другой компьютер — просто скопируйте папку целиком.

3. КАК СОБРАТЬСЯ ЗА СТОЛОМ
   Один человек — Мастер (ДМ). Он запускает игру, создаёт кампанию и
   нажимает «Создать и запустить стол». На экране появится P2P-билет.

   Остальные запускают игру у себя, выбирают «Подключиться к столу»,
   вставляют этот билет, своё имя и жмут «Подключиться по P2P».

4. ПРО СЕТЬ
   Общая сеть не нужна: ни VPN, ни Hamachi / Radmin / ZeroTier, ни проброс
   портов. Игра соединяет компьютеры напрямую через iroh — он сам пробивает
   NAT, а если прямое соединение не выйдет, идёт через публичный relay.

   Нужны доступ в интернет (iroh использует relay и discovery n0) и
   разрешение приложению на доступ к сети в брандмауэре Windows.

5. ЕСЛИ НЕ ПОДКЛЮЧАЕТСЯ
   * Убедитесь, что билет скопирован целиком и вставлен без изменений.
   * Разрешите игру в брандмауэре Windows: при первом запуске система
     спросит про доступ к сети — нужно разрешить. Если окно пропустили,
     откройте «Брандмауэр Защитника Windows» -> «Разрешить работу с
     приложением» и поставьте галочки для «${appName}».
   * Проверьте, что интернет есть: без него не работает ни relay, ни поиск
     адреса ДМ в сети.

6. ЧТО ЕСТЬ В ИГРЕ
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
   * туман войны: мастер закрывает карту и открывает её участки кистью,
     видят все участники, у игроков туман заметно плотнее, чем у мастера;
   * панели стола можно свернуть, чтобы стол был больше;
    * фишки: ДМ создаёт и назначает их игрокам, игрок двигает свою и
      может поставить ей картинку;
    * аватар игрока: ставится в его листе, виден в списке участников и у
      бросков кубика в чате. Портрет автоматически переезжает на фишку,
      выведенную из листа, — и перестаёт её трогать, если картинку фишки
      задали руками. У мастера, пока он не поставил свой, есть портрет
      мудрого старца-архимага;
    * фишка прямо из листа: кнопка «Вывести» у игрока в списке
      участников и в панели фишек выводит фишку с именем персонажа
      и аватаром;
     * настоящие кости: d4, d6, d8, d10, d12, d20 и сотня для процентов,
       и общий чат;
     * скрытие фишек: новая фишка появляется скрытой от игроков, мастер
       открывает её кнопкой «Видна» или разом кнопкой «Показать все»;
     * импорт приключений из Foundry VTT: на экране стола в панели приглашения
       есть кнопка «Импортировать приключение…». Подойдёт выгрузка приключения из
      Foundry в JSON или ZIP: сначала покажут, что нашли и что можно перенести,
      вы отмечаете нужное галочками и жмёте «Импортировать». Сцены становятся
      картами, их фишки — фишками, персонажи, предметы и заметки — справочником
      приключения. Макросы не переносятся и никогда не выполняются;
    * сохранение кампании кнопкой, автосохранение раз в минуту и при выходе.

7. СТОЛ БЕЗ СЕТИ (ЕСЛИ ИГРАТЬ ПОКА НЕ С КЕМ)
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
Версия игры: ${versionLabel}.
`;

/**
 * Ищет запускаемый файл игры в папке сборки. На Windows это «<name>.exe», на
 * Linux и macOS — файл с тем же именем, но без расширения.
 */
function findExe(dir) {
  const entries = fs.readdirSync(dir).filter((file) => {
    if (process.platform === 'win32') return file.toLowerCase().endsWith('.exe');
    // В папке сборки Linux лежит ровно один файл без расширения — сама игра.
    try {
      return fs.statSync(path.join(dir, file)).isFile();
    } catch {
      return false;
    }
  });
  const name = entries.find((file) => path.parse(file).name === exeBase);
  if (!name) {
    // Раньше здесь был запасной вариант «первый файл по алфавиту» — он молча
    // подставлял LICENSE.electron.txt и прятал настоящую проблему.
    throw new Error(`В ${dir} нет файла «${exeBase}». Есть: ${entries.join(', ') || '—'}`);
  }
  return name;
}

/**
 * Если приложение запущено из этой папки, файлы заняты: обновлять сборку нельзя,
 * иначе часть файлов не заменится и останется «полусобранное» состояние.
 */
function assertAppNotRunning() {
  const exePath = path.join(releaseApp, `${appName}${process.platform === 'win32' ? '.exe' : ''}`);
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

/**
 * Рекурсивное копирование папки.
 *
 * Раньше здесь стоял fs.cpSync — на Windows-раннере GitHub Actions он отрабатывал
 * без ошибки, но не переносил ни одного файла, и падение приходило позже и
 * совсем в другом месте. Копируем сами: так любая проблема видна сразу, а
 * счётчик перенесённых файлов попадает в отчёт сборки.
 */
/**
 * Копирует папку сборки в комплект для отправки.
 *
 * Файл пропускается, если он уже того же размера и той же давности: сборка
 * меняет единицы файлов, а переписывание всех остальных заново каждый раз
 * заставляло антивирус заново брать их в свои руки. Ровно та же причина была у
 * падения упаковки с «used by another process»: файл перезаписывали за секунду
 * до неё, и Windows отдавал его антивирусу, а не упаковщику.
 *
 * @param {string} src Откуда копируем.
 * @param {string} dest Куда.
 * @returns {number} Сколько файлов переписано.
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += copyDir(from, to);
    } else if (entry.isFile() && !isSameFile(from, to)) {
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

/**
 * Тот же файл или нет: размер совпадает, и запись не менялась.
 *
 * Время округляется до секунды: у copyFileSync и у исходника разная точность
 * метки, и при сравнении «как есть» файл никогда не считался бы тем же самым.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isSameFile(from, to) {
  try {
    const source = fs.statSync(from);
    const target = fs.statSync(to);
    return source.size === target.size
      && Math.floor(source.mtimeMs / 1000) === Math.floor(target.mtimeMs / 1000);
  } catch {
    return false;
  }
}

/**
 * Сколько файлов в папке.
 * @param {string} dir
 * @returns {number}
 */
function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(from);
    else if (entry.isFile()) total += 1;
  }
  return total;
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
  //
  // Переписанных файлов может оказаться ноль, и это нормально: комплект уже
  // совпадает с последней сборкой. Пустой папкой сборка считается только по
  // числу найденных в ней файлов, а не по числу скопированных.
  const seen = countFiles(distUnpacked);
  if (!seen) {
    throw new Error(
      `Копировать нечего: в папке сборки ${distUnpacked} нет ни одного файла.`
    );
  }
  const copied = copyDir(distUnpacked, releaseApp);
  return { copied, seen };
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

/**
 * Оставляет только нужные локали Chromium.
 *
 * Интерфейс игры русский, а en-US нужен как запасной язык для системных
 * элементов Electron. Остальные пятьдесят с лишним .pak весят десятки
 * мегабайт и в портативной сборке не используются.
 * @returns {{removed: number, freed: number}}
 */
function pruneLocales() {
  const dir = path.join(releaseApp, 'locales');
  if (!fs.existsSync(dir)) return { removed: 0, freed: 0 };
  const keep = new Set(['en-US.pak', 'ru.pak']);
  let removed = 0;
  let freed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (keep.has(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      fs.rmSync(file, { force: true });
      removed += 1;
      freed += stat.size;
    } catch {
      // Файл занят или уже удалён: сборка не должна падать из-за локали.
    }
  }
  return { removed, freed };
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
 * process». Файл освобождается не через несколько секунд, а через десятки: на
 * этой машине held-файл возвращался только через минуту. Поэтому ждём дольше и
 * делаем больше попыток, а не заставляем человека запускать сборку повторно.
 */
function compressArchive(attempts = 5, delayMs = 15000) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (process.platform === 'win32') {
        execFileSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // -ErrorAction Stop: без него PowerShell сообщает о занятом файле, но
          // возвращает код 0, и на выходе получается молча испорченный архив.
          `Compress-Archive -LiteralPath '${releaseApp}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force -ErrorAction Stop`
        ], { stdio: 'inherit' });
      } else {
        // На Linux и macOS PowerShell нет — упаковываем системным zip.
        execFileSync('zip', ['-r', '-q', '-9', zipPath, appName], {
          cwd: releaseDir,
          stdio: 'inherit'
        });
      }
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
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${checkDir}' -Force`
      ], { stdio: 'ignore' });
    } else {
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', checkDir], { stdio: 'ignore' });
    }

    const unpacked = path.join(checkDir, appName);
    if (!fs.existsSync(unpacked)) {
      problems.push(`в архиве нет папки «${appName}»`);
      return problems;
    }
    const exeName = findExe(unpacked);
    // На Windows игра запускается из .exe, на Linux — из одноимённого файла без
    // расширения, поэтому сверяем только имя, а не суффикс.
    if (path.parse(exeName).name !== exeBase) {
      problems.push(`имя запускаемого файла испортилось: «${exeName}» вместо «${exeBase}»`);
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

  const copied = copyApp();
  preparePortableBits();
  const locales = pruneLocales();
  makeZip();

  const exeName = findExe(releaseApp);
  const problems = verifyZip();
  const zipSize = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);

  console.log('\nГотово к отправке\n');
  console.log(`  Папка:  ${releaseApp}`);
  console.log(`  Файлов в сборке: ${copied.seen}, перенесено заново: ${copied.copied}`);
  console.log(`  Игра:   ${path.join(releaseApp, exeName)}`);
  console.log(`  Архив:  ${zipPath} (${zipSize} МБ)`);
  console.log(`  Данные: ${path.join(releaseApp, 'data')} — поедут вместе с папкой`);
  if (locales.removed) {
    console.log(`  Языки:   оставлено 2, удалено ${locales.removed} (${(locales.freed / 1048576).toFixed(1)} МБ)`);
  }
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
