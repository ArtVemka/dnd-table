const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Промежуточные версии существуют только в описаниях: отдельная история
// коммитов не сохранилась (один общий релизный коммит), поэтому релизы
// вешаются на коммит 1.14.1 и прилагают только описание.
const VERSIONS = [
  '1.11.0', '1.12.0', '1.13.0', '1.13.1', '1.13.2',
  '1.13.3', '1.13.4', '1.13.5', '1.13.6', '1.14.0'
];
const HEAD = require('child_process').execSync('git rev-parse c92f86e', { encoding: 'utf8' }).trim();
const HEADER = 'Предупреждение: сборки этой версии не сохранились в истории Git — правки между релизами от 1.10.3 до 1.14.1 пришли в репозиторий одним релизным коммитом (c92f86e). На этой странице только описание: установщики и архивы берите в соседних релизах (1.10.3 или новее).\n\n';

for (const version of VERSIONS) {
  const notesPath = path.join(__dirname, '..', 'docs', `release-notes-${version}.md`);
  const body = HEADER + fs.readFileSync(notesPath, 'utf8');
  const tempPath = path.join(__dirname, 'notes-temp.md');
  fs.writeFileSync(tempPath, body, 'utf8');
  execFileSync('gh', [
    'release', 'create', `v${version}`,
    '--title', `D&D Стол ${version}`,
    '--target', HEAD,
    '--notes-file', tempPath
  ], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  console.log(`сделан release v${version}`);
}
console.log('все релизы созданы');
