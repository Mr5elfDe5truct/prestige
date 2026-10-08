// Prestige for Android by R.G. Studios · developed by Ryan B. Gyles.
// The app is a window onto Prestige's phone page, served by the desktop app over your own network (phone.rs). The page
// is loaded through a relay on this phone (Relay.java), which makes it a secure page: that's what lets the camera and
// microphone work for voice chat, Live calls, dictation and photos, which a browser blocks on a plain network address.
// Everything runs on the PC; the app adds the permissions, keeping the screen on in a call, and saving renders.
package com.rgstudios.prestige;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    static final int RELAY_PORT = 18765;
    static final int SETUP_PORT = 18764;
    private static final String RELAY = "http://127.0.0.1:" + RELAY_PORT + "/";
    private static final String SETUP = "http://127.0.0.1:" + SETUP_PORT + "/";
    private static final int ASK_PERMISSIONS = 1;
    private static final int PICK_FILES = 2;

    private WebView web;
    private SharedPreferences prefs;
    private final Relay relay = new Relay(RELAY_PORT);
    private SetupServer setup;
    private PermissionRequest pending;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("prestige", MODE_PRIVATE);
        setup = new SetupServer(SETUP_PORT, getAssets());
        try {
            relay.start();
            setup.start();
        } catch (IOException e) {
            Toast.makeText(this, "Prestige couldn't open its local port: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
        String pc = prefs.getString("pc", "");
        if (!pc.isEmpty()) aim(pc);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(10, 7, 7));
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false); // replies are spoken as they stream in
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);
        ws.setSupportMultipleWindows(false);
        web.addJavascriptInterface(new Bridge(), "PrestigeApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                // Links in replies open in the browser, not in place of the chat.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest req) {
                runOnUiThread(() -> permission(req));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                // Pictures for photos; any file when the page asks for documents too (Knowledge).
                boolean images = true;
                for (String t : params.getAcceptTypes()) if (!t.isEmpty() && !t.startsWith("image/")) images = false;
                i.setType(images ? "image/*" : "*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(i, images ? "Choose a photo" : "Choose a file"), PICK_FILES);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);
        web.loadUrl(pc.isEmpty() ? SETUP : RELAY);
    }

    /** Points the relay at "host:port". */
    private void aim(String pc) {
        int colon = pc.lastIndexOf(':');
        String host = colon > 0 ? pc.substring(0, colon) : pc;
        int port = 8765;
        try {
            if (colon > 0) port = Integer.parseInt(pc.substring(colon + 1));
        } catch (NumberFormatException ignored) {
        }
        relay.target(host.replace("[", "").replace("]", ""), port);
    }

    /** The page asks for the camera or microphone: only our own pages get them, and Android asks the user first. */
    private void permission(PermissionRequest req) {
        String origin = req.getOrigin().toString();
        if (!origin.startsWith("http://127.0.0.1:")) {
            req.deny();
            return;
        }
        List<String> need = new ArrayList<>();
        for (String r : req.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.CAMERA);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (need.isEmpty()) {
            grantWhatWeHave(req);
            return;
        }
        if (pending != null) pending.deny();
        pending = req;
        requestPermissions(need.toArray(new String[0]), ASK_PERMISSIONS);
    }

    private void grantWhatWeHave(PermissionRequest req) {
        List<String> ok = new ArrayList<>();
        for (String r : req.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) ok.add(r);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) ok.add(r);
        }
        if (ok.isEmpty()) req.deny();
        else req.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == ASK_PERMISSIONS && pending != null) {
            grantWhatWeHave(pending);
            pending = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code != PICK_FILES || fileCallback == null) {
            super.onActivityResult(code, result, data);
            return;
        }
        Uri[] picked = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = Math.min(4, data.getClipData().getItemCount());
                picked = new Uri[n];
                for (int i = 0; i < n; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) picked = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        relay.stop();
        setup.stop();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** What the pages can ask of the app (window.PrestigeApp). */
    final class Bridge {
        /** The setup page: the PC's address ("192.168.1.20:8765"), checked by connecting to it. "" when it answers. */
        @JavascriptInterface
        public String connect(String pc) {
            pc = pc.trim();
            if (pc.isEmpty()) return "Type the address shown in Prestige's Settings on the PC.";
            if (!pc.matches("^[\\[\\]0-9A-Za-z.:%-]+$")) return "That doesn't look like an address. It's like 192.168.1.20:8765.";
            if (pc.indexOf(':') < 0 || pc.endsWith("]")) pc = pc + ":8765";
            int colon = pc.lastIndexOf(':');
            String host = pc.substring(0, colon).replace("[", "").replace("]", "");
            int port;
            try {
                port = Integer.parseInt(pc.substring(colon + 1));
            } catch (NumberFormatException e) {
                return "The port (after the colon) should be a number, like 8765.";
            }
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(host, port), 4000);
            } catch (IOException e) {
                return "Prestige didn't answer at " + host + ":" + port + ". Check that Phone access is on in Prestige's Settings, and that this phone is on the same Wi-Fi (or Tailscale).";
            }
            prefs.edit().putString("pc", host.contains(":") ? "[" + host + "]:" + port : host + ":" + port).apply();
            aim(host + ":" + port);
            return "";
        }

        /** The saved PC address, for the setup page. */
        @JavascriptInterface
        public String current() {
            return prefs.getString("pc", "");
        }

        /** Back to the setup page (the drawer's "Connect to another PC"). */
        @JavascriptInterface
        public void setup() {
            runOnUiThread(() -> web.loadUrl(SETUP));
        }

        /** The name this phone pairs as: its name from Android's settings, like "Galaxy S23 Ultra". */
        @JavascriptInterface
        public String deviceName() {
            String n = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME);
            return n != null && !n.isEmpty() ? n : Build.MODEL;
        }

        /** Keeps the screen on through a call. */
        @JavascriptInterface
        public void keepAwake(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        /** Saves a render to the phone: Pictures, Movies (videos), Music (songs) or Download (3D models), in Prestige. */
        @JavascriptInterface
        public void save(String url, String name) {
            if (!url.startsWith(RELAY)) return;
            new Thread(() -> {
                String msg;
                try {
                    msg = download(url, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                } catch (Exception e) {
                    msg = "Couldn't save it: " + e.getMessage();
                }
                String m = msg;
                runOnUiThread(() -> Toast.makeText(MainActivity.this, m, Toast.LENGTH_SHORT).show());
            }).start();
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (PackageManager.NameNotFoundException e) {
                return "";
            }
        }
    }

    /** Saves a render into the phone's own folders: pictures, videos, songs (Music) or 3D models (Download). */
    private String download(String url, String name) throws IOException {
        String lower = name.toLowerCase();
        String ext = lower.substring(lower.lastIndexOf('.') + 1);
        String mime, folder;
        Uri collection;
        switch (ext) {
            case "mp4": case "webm": case "mov":
                mime = ext.equals("webm") ? "video/webm" : ext.equals("mov") ? "video/quicktime" : "video/mp4";
                folder = Environment.DIRECTORY_MOVIES;
                collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                break;
            case "mp3": case "flac": case "ogg": case "opus": case "wav":
                mime = ext.equals("mp3") ? "audio/mpeg" : ext.equals("flac") ? "audio/flac" : ext.equals("wav") ? "audio/wav" : "audio/ogg";
                folder = Environment.DIRECTORY_MUSIC;
                collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
                break;
            case "png": case "jpg": case "jpeg": case "webp": case "gif":
                mime = ext.equals("png") ? "image/png" : ext.equals("webp") ? "image/webp" : ext.equals("gif") ? "image/gif" : "image/jpeg";
                folder = Environment.DIRECTORY_PICTURES;
                collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                break;
            default: // a 3D model (.glb) and anything else
                mime = ext.equals("glb") ? "model/gltf-binary" : "application/octet-stream";
                folder = Environment.DIRECTORY_DOWNLOADS;
                collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Prestige");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        ContentResolver cr = getContentResolver();
        Uri dest = cr.insert(collection, v);
        if (dest == null) throw new IOException("no room in the gallery");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try (InputStream in = c.getInputStream(); OutputStream out = cr.openOutputStream(dest)) {
            if (c.getResponseCode() != 200) throw new IOException("the PC answered " + c.getResponseCode());
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
        } catch (IOException e) {
            cr.delete(dest, null, null);
            throw e;
        } finally {
            c.disconnect();
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(dest, v, null, null);
        return "Saved to " + folder + "/Prestige";
    }
}
