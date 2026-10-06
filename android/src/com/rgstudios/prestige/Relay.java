// Prestige for Android by R.G. Studios · developed by Ryan B. Gyles.
// The relay: a port on this phone (127.0.0.1 only) that passes every connection straight through to Prestige's phone
// server on the PC. The app's page is loaded from here, so to the WebView it comes from this phone itself: a secure
// page, where the camera and the microphone are allowed. Pairing, the event stream, photos and video seeking all work
// unchanged, because the bytes are passed through as they are.
package com.rgstudios.prestige;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class Relay {
    private final int port;
    private ServerSocket server;
    private volatile String host = "";
    private volatile int target = 8765;
    private final Set<Socket> open = ConcurrentHashMap.newKeySet();

    Relay(int port) {
        this.port = port;
    }

    /** Where connections go: the PC's address and phone-access port. */
    void target(String host, int port) {
        this.host = host;
        this.target = port;
        // Connections the WebView keeps open still lead to the old PC: close them so the next request reconnects.
        for (Socket s : open) close(s);
        open.clear();
    }

    void start() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    new Thread(() -> pass(s), "relay").start();
                } catch (IOException e) {
                    if (server.isClosed()) return;
                }
            }
        }, "relay-accept");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
    }

    private void pass(Socket phone) {
        Socket pc = new Socket();
        open.add(phone);
        try {
            phone.setTcpNoDelay(true);
            pc.setTcpNoDelay(true);
            pc.connect(new InetSocketAddress(host, target), 6000);
        } catch (IOException e) {
            unreachable(phone);
            close(pc);
            open.remove(phone);
            return;
        }
        Thread up = new Thread(() -> copy(phone, pc), "relay-up");
        up.setDaemon(true);
        up.start();
        copy(pc, phone);
        open.remove(phone);
    }

    private static void copy(Socket from, Socket to) {
        byte[] buf = new byte[16384];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                out.flush(); // the event stream has to arrive as it's written
            }
        } catch (IOException ignored) {
        } finally {
            close(from);
            close(to);
        }
    }

    /** The PC didn't answer: a page that says so (with a way back to the setup screen). */
    private void unreachable(Socket phone) {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;background:#0a0707;color:#efe4d6;font:15px/1.5 system-ui;display:grid;place-items:center;height:100vh;text-align:center'>"
                + "<div style='padding:24px;max-width:340px'><img src='http://127.0.0.1:" + MainActivity.SETUP_PORT + "/icon.png' width=72 style='border-radius:16px'>"
                + "<h2 style='font-family:Georgia,serif;font-weight:400'>Can't reach your PC</h2>"
                + "<p style='color:#9c8a7f'>Prestige didn't answer at " + esc(host) + ":" + target + ". Check that Prestige is open on the PC with "
                + "<b>Settings → Phone access</b> on, and that this phone is on the same Wi-Fi (or Tailscale).</p>"
                + "<p><a href='' style='display:inline-block;padding:10px 16px;border-radius:8px;background:#d6202b;color:#fff;text-decoration:none'>Try again</a></p>"
                + "<p><a href='http://127.0.0.1:" + MainActivity.SETUP_PORT + "/' style='color:#d9a441'>Change the PC address</a></p></div>";
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: "
                + body.length + "\r\nConnection: close\r\n\r\n";
        try {
            OutputStream out = phone.getOutputStream();
            out.write(head.getBytes(StandardCharsets.US_ASCII));
            out.write(body);
            out.flush();
        } catch (IOException ignored) {
        } finally {
            close(phone);
        }
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;");
    }

    private static void close(Socket s) {
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }
}
