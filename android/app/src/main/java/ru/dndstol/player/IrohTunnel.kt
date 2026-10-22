package ru.dndstol.player

import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointOptions
import computer.iroh.EndpointTicket
import computer.iroh.presetN0
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Локальный TCP-туннель до стола мастера поверх iroh.
 *
 * Повторяет server/iroh-manager.js: одно iroh-соединение, а на каждый входящий
 * TCP-сокет открывается свой bi-stream. Renderer ходит в socket.io на
 * 127.0.0.1:<localPort> и не знает, что под ним P2P.
 */
class IrohTunnel(private val scope: CoroutineScope) {
    companion object {
        private val ALPN = "dnd-table-p2p/1".toByteArray()
        private const val CHUNK = 64 * 1024
    }

    private var endpoint: Endpoint? = null
    private var connection: Connection? = null
    private var server: ServerSocket? = null
    private val jobs = CopyOnWriteArrayList<Job>()
    private val lock = Any()

    @Throws(Exception::class)
    suspend fun start(ticket: String): Int = withContext(Dispatchers.IO) {
        shutdown()
        val ep = Endpoint.bind(EndpointOptions(preset = presetN0(), alpns = listOf(ALPN)))
        endpoint = ep
        val conn = try {
            ep.connect(EndpointTicket.fromString(ticket).endpointAddr(), ALPN)
        } catch (t: Throwable) {
            runCatching { ep.close() }
            endpoint = null
            throw t
        }
        connection = conn
        val listener = try {
            ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        } catch (t: Throwable) {
            runCatching { conn.close(0L, "bye".toByteArray()) }
            runCatching { ep.close() }
            connection = null
            endpoint = null
            throw t
        }
        server = listener
        jobs += scope.launch(Dispatchers.IO) {
            while (isActive) {
                val socket = try {
                    listener.accept()
                } catch (_: Throwable) {
                    break
                }
                jobs += scope.launch(Dispatchers.IO) { bridge(socket, conn) }
            }
        }
        listener.localPort
    }

    private suspend fun bridge(socket: Socket, conn: Connection) {
        try {
            coroutineScope {
                val bi = conn.openBi()
                val send = bi.send()
                val recv = bi.recv()
                val writer = launch(Dispatchers.IO) {
                    try {
                        socket.getInputStream().use { input ->
                            val buffer = ByteArray(CHUNK)
                            while (isActive) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                if (count > 0) send.writeAll(buffer.copyOf(count))
                            }
                        }
                    } finally {
                        runCatching { send.finish() }
                    }
                }
                val reader = launch(Dispatchers.IO) {
                    socket.getOutputStream().use { output ->
                        while (isActive) {
                            val chunk = recv.read(CHUNK.toUInt())
                            if (chunk.isEmpty()) break
                            output.write(chunk)
                            output.flush()
                        }
                    }
                }
                writer.join()
                reader.join()
            }
        } catch (_: Throwable) {
            // Сокет закрылся или поток сбросили: соединение уже не нужно.
        } finally {
            runCatching { socket.close() }
        }
    }

    fun shutdown() {
        synchronized(lock) {
            runCatching { server?.close() }
            server = null
            for (job in jobs) job.cancel()
            jobs.clear()
        }
        connection?.let { runCatching { it.close(0L, "bye".toByteArray()) } }
        connection = null
        endpoint?.let { runCatching { it.close() } }
        endpoint = null
    }
}
