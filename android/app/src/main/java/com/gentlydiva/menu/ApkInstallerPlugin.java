package com.gentlydiva.menu;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// アプリ内で APK をダウンロードし、Android 標準インストーラを起動する
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("URL がありません");
            return;
        }

        // Android 8+ は「提供元不明アプリのインストール」の許可が必要。
        // 未許可なら設定画面を開き、PERMISSION_REQUIRED で返す（許可後に再実行してもらう）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception ignored) { /* 設定画面が開けない端末でも続行不可 */ }
            call.reject("PERMISSION_REQUIRED");
            return;
        }

        new Thread(() -> download(call, url)).start();
    }

    private void download(PluginCall call, String urlStr) {
        HttpURLConnection conn = null;
        try {
            File apk = new File(getContext().getCacheDir(), "update.apk");
            if (apk.exists() && !apk.delete()) {
                // 消せなくても上書きは可能なので続行
            }

            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(60000);
            conn.connect();

            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                call.reject("ダウンロード失敗 (HTTP " + code + ")");
                return;
            }

            long total = conn.getContentLengthLong();
            long downloaded = 0;
            int lastPct = -1;
            try (InputStream in = conn.getInputStream();
                 OutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[8192];
                int read;
                while ((read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                    downloaded += read;
                    if (total > 0) {
                        int pct = (int) (downloaded * 100 / total);
                        if (pct != lastPct) {
                            lastPct = pct;
                            JSObject ev = new JSObject();
                            ev.put("progress", pct);
                            notifyListeners("downloadProgress", ev);
                        }
                    }
                }
                out.flush();
            }

            // 途中で切れた不完全な APK でインストーラを起動しない
            // （通信断で read が -1 を返して正常終了に見えるケース対策）
            if (total > 0 && downloaded != total) {
                call.reject("INCOMPLETE_DOWNLOAD");
                return;
            }
            if (downloaded < 1024 * 100) {   // 100KB 未満は APK として異常
                call.reject("INCOMPLETE_DOWNLOAD");
                return;
            }

            launchInstall(call, apk);
        } catch (Exception e) {
            call.reject("ダウンロードエラー: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void launchInstall(PluginCall call, File apk) {
        // startActivity はワーカースレッドから呼ぶと端末によって黙って失敗するため
        // 必ず UI スレッドで実行し、失敗はエラーとして JS 側へ返す
        getActivity().runOnUiThread(() -> {
            try {
                Uri uri = FileProvider.getUriForFile(getContext(),
                        getContext().getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getContext().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("INSTALL_LAUNCH_FAILED: " + e.getMessage());
            }
        });
    }
}
