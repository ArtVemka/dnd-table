# iroh P2P — API для D&D стола

## 📌 Краткое резюме

**iroh-p2p** — это Node.js binding (N-API) к Rust-библиотеке `iroh` для построения P2P приложений. В проекте уже есть готовый код с примерами, которые можно использовать как основу.

## 🔑 Основные API

### 1. Endpoint (точка соединения)

```javascript
const b = Endpoint.builder();
b.bind_addr('0.0.0.0:4000');
const ep = await b.bind();  // создаёт и bindит endpoint
```

**Endpoint** — это локальная точка подключения, которая знает свой IP/порт.

### 2. BiStream (двусторонний стрим)

```javascript
// На стороне DM (клиент):
const dmEp = await Endpoint.bind({ bind_addr: '0.0.0.0:4000' });
const streams = await dmEp.open_bi();  // открываем bi-streams

// На стороне игрока (сервер):
const incoming = await dmEp.accept_next();  // incoming connection
const accepting = await incoming.accept();  // handshake complete
const conn = await accepting.connect();      // active QUIC connection
const biStreams = await conn.open_bi();       // открываем bi-streams
```

**BiStream** — это пара `SendStream` + `RecvStream`, которая живёт на стороне клиента и сервера одновременно.

### 3. SendStream / RecvStream

#### SendStream (отправка данных):
```javascript
await stream.send.write([/* socket.io event */]);
await stream.send.write_all(data);
await stream.send.finish();  // завершаем стрим
```

#### RecvStream (получение данных):
```javascript
const response = await stream.recv.read(4096);
const response = await stream.recv.read_exact(size);
const response = await stream.recv.read_to_end(limit);
```

## 🔧 Tunnelling layer (слой туннелирования)

**Задача:** обернуть socket.io события в iroh bi-streams.

### Архитектура:

```
[DM-приложение]
    ↓ Socket.IO events
[iroh-manager.js — tunnel layer]  ← создаёт/управляет iroh endpoint
    ↓ send.write() / recv.read()
[iroh QUIC connection]
    ↓ TCP → сеть
```

### Пример кода туннель-слоя:

```javascript
// DM (клиент)
const dmEp = await Endpoint.bind({ bind_addr: '0.0.0.0:4000' });
const streams = await dmEp.open_bi();

// Игрок подключается к http://<DM-localUrl>
// socket.io события → iroh bi-streams → сеть
```

## 📂 Существующие файлы

| Файл | Описание |
|------|----------|
| `node_modules/@number0/iroh/src/*.rs` | Rust-исходник с API |
| `src/main.js` | Точка входа приложения |
| `src/preload.js` | Экспортированные методы |

## 🚀 Следующие шаги

1. **Прочитать существующий код** — проверить, есть ли уже что-то на iroh
2. **Создать tunnel-слой** — обернуть socket.io в iroh bi-streams
3. **Реализовать подключение игрока** — `accept_next()` → `open_bi()` → стримы
4. **Тестирование** — проверить, что данные идут с DM на игрока и обратно

## 📖 Полезные ссылки

- [iroh docs](https://docs.iroh.io)
- [iroh github](https://github.com/ipld/iroh)