// Prestige for Android by R.G. Studios · developed by Ryan B. Gyles.
// Serves the app's own setup page (assets/setup.html: the PC's address, or its QR code) on a port on this phone, so the
// page can use the camera to scan the QR code. Answers 127.0.0.1 only, one request per connection.
package com.rgstudios.prestige;

import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

final class SetupServer {
    private final int port;
    private final AssetManager assets;
    private ServerSocket server;

    SetupServer(int port, AssetManager assets) {
        this.port = port;
        this.assets = assets;
    }

    void start() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    new Thread(() -> serve(s), "setup").start();
                } catch (IOException e) {
                    if (server.isClosed()) return;
                }
            }
        }, "setup-accept");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
    }

    private void serve(Socket s) {
        try (Socket sock = s) {
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.US_ASCII));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            String path = parts.length > 1 ? parts[1].split("[?#]")[0] : "/";
            // (The rest of the request isn't needed.)
            String name;
            String type;
            switch (path) {
                case "/":
                case "/setup.html":
                    name = "setup.html";
                    type = "text/html; charset=utf-8";
                    break;
                case "/jsQR.js":
                    name = "jsQR.js";
                    type = "text/javascript; charset=utf-8";
                    break;
                case "/icon.png":
                    name = "icon.png";
                    type = "image/png";
                    break;
                default:
                    name = null;
                    type = "text/plain";
            }
            byte[] body = name == null ? "not found".getBytes(StandardCharsets.UTF_8) : read(name);
            String head = (name == null ? "HTTP/1.1 404 Not Found" : "HTTP/1.1 200 OK") + "\r\nContent-Type: " + type
                    + "\r\nCache-Control: no-store\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
            OutputStream out = sock.getOutputStream();
            out.write(head.getBytes(StandardCharsets.US_ASCII));
            out.write(body);
            out.flush();
        } catch (IOException ignored) {
        }
    }

    private byte[] read(String name) throws IOException {
        try (InputStream is = assets.open(name)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) >= 0) b.write(buf, 0, n);
            return b.toByteArray();
        }
    }
}
