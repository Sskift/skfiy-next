"""Loopback-only RFB 3.3 test screen for the real macOS Screen Sharing client.

Implements raw framebuffer updates and records wire-level key/pointer events
(RFC 6143). No real desktop is exported. The dummy VNC challenge accepts any
response; this fixture must never bind to a non-loopback address.
"""
import socket
import struct
import threading


class RFBFixture:
    width, height = 640, 480

    def __init__(self, name='skfiy Screen Sharing Fixture'):
        self.name = name
        self.events = []
        self.stage = "listening"
        self.errors = []
        self.ready = threading.Event()
        self.stopped = threading.Event()
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.port = self.server.getsockname()[1]
        self.server.listen(1)
        self.server.settimeout(.2)
        self.connections = []
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stopped.is_set():
            try:
                client, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            connection = RFBConnection(self, client)
            self.connections.append(connection)
            connection.thread.start()

    def close(self):
        self.stopped.set()
        self.server.close()
        for connection in self.connections:
            try:
                connection.client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.thread.join(timeout=3)
        for connection in self.connections:
            connection.thread.join(timeout=3)


class RFBConnection:
    width, height = RFBFixture.width, RFBFixture.height

    def __init__(self, fixture, client):
        self.name = fixture.name
        self.client = client
        self.events, self.errors = fixture.events, fixture.errors
        self.stopped, self.ready = fixture.stopped, fixture.ready
        self.format = struct.pack('>BBBBHHHBBBxxx', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
        self.generation = 0
        self.drawn = -1
        self.pending = False
        self.thread = threading.Thread(target=self.run, daemon=True)

    def read(self, n):
        data = bytearray()
        while len(data) < n and not self.stopped.is_set():
            try:
                part = self.client.recv(n - len(data))
            except socket.timeout:
                continue
            if not part:
                raise EOFError()
            data.extend(part)
        if len(data) != n:
            raise EOFError()
        return bytes(data)

    def draw(self):
        bpp, _, big, true, rm, gm, bm, rs, gs, bs = struct.unpack('>BBBBHHHBBBxxx', self.format)
        if not true or bpp not in (16, 32):
            raise ValueError('fixture needs true-color 16/32-bit pixels')
        def pixel(r, g, b):
            value = ((r * rm // 255) << rs) | ((g * gm // 255) << gs) | ((b * bm // 255) << bs)
            return value.to_bytes(bpp // 8, 'big' if big else 'little')
        color = pixel(30 + (self.generation % 8) * 20, 90, 140)
        # Large bright target plus a changing background, independently visible
        # in the native client's screenshot after received input.
        normal = color * self.width
        target = color * 240 + pixel(230, 210, 80) * 160 + color * 240
        pixels = normal * 180 + target * 120 + normal * 180
        self.client.sendall(struct.pack('>BBHHHHHi', 0, 0, 1, 0, 0, self.width, self.height, 0) + pixels)
        self.drawn = self.generation
        self.pending = False

    def run(self):
        try:
            self.client.settimeout(.2)
            self.stage = 'version'
            self.client.sendall(b'RFB 003.003\n')
            self.read(12)
            self.client.sendall(struct.pack('>I', 2) + bytes(range(16)))
            self.stage = 'authentication'
            self.read(16)  # Dummy challenge response, deliberately not logged.
            self.client.sendall(bytes(4))
            self.stage = 'client-init'
            self.read(1)
            name = self.name.encode()
            self.client.sendall(struct.pack('>HH', self.width, self.height) + self.format + struct.pack('>I', len(name)) + name)
            self.stage = 'connected'
            self.ready.set()
            while not self.stopped.is_set():
                kind = self.read(1)[0]
                if kind == 0:
                    self.read(3)
                    self.format = self.read(16)
                elif kind == 2:
                    self.read(1)
                    n, = struct.unpack('>H', self.read(2))
                    self.read(n * 4)  # Raw is mandatory; do not offer extensions.
                elif kind == 3:
                    incremental, _, _, _, _ = struct.unpack('>BHHHH', self.read(9))
                    self.pending = True
                    if not incremental or self.drawn != self.generation:
                        self.draw()
                elif kind == 4:
                    down, key = struct.unpack('>BxxI', self.read(7))
                    self.events.append(('key', down, key))
                    self.generation += 1
                elif kind == 5:
                    mask, x, y = struct.unpack('>BHH', self.read(5))
                    self.events.append(('pointer', mask, x, y))
                    self.generation += 1
                elif kind == 6:
                    self.read(3)
                    n, = struct.unpack('>I', self.read(4))
                    if n > 1_000_000:
                        raise ValueError('clipboard too large')
                    self.read(n)  # Never retain the user's clipboard.
                    self.events.append(('clipboard', n))
                else:
                    raise ValueError(f'unsupported client message {kind}')
                if self.pending and self.drawn != self.generation:
                    self.draw()
        except (EOFError, OSError):
            pass
        except Exception as error:
            self.errors.append(str(error))
        finally:
            if self.client:
                self.client.close()

