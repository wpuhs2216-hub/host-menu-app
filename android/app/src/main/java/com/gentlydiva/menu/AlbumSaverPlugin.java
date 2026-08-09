package com.gentlydiva.menu;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

// 画像を端末のアルバム（写真ギャラリー）へ保存する。
// Android 10 以降は MediaStore 経由なので権限不要。9 以下だけ WRITE_EXTERNAL_STORAGE を要求する。
@CapacitorPlugin(
    name = "AlbumSaver",
    permissions = {
        @Permission(alias = "storage", strings = { android.Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class AlbumSaverPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        // Android 10+ は MediaStore へ書くだけなので権限不要
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q || getPermissionState("storage") == PermissionState.GRANTED) {
            doSave(call);
        } else {
            requestPermissionForAlias("storage", call, "storagePermsCallback");
        }
    }

    @PermissionCallback
    private void storagePermsCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) {
            doSave(call);
        } else {
            call.reject("PERMISSION_DENIED");
        }
    }

    private void doSave(PluginCall call) {
        String dataUrl = call.getString("data");
        String fileName = call.getString("fileName", "image.jpg");
        String album = call.getString("album", "HostMenu");

        if (dataUrl == null || dataUrl.isEmpty()) {
            call.reject("画像データがありません");
            return;
        }

        try {
            // "data:image/jpeg;base64,...." から本体を取り出す
            String base64 = dataUrl.contains(",") ? dataUrl.substring(dataUrl.indexOf(',') + 1) : dataUrl;
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            String mime = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";

            Uri saved;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saved = saveViaMediaStore(bytes, fileName, mime, album);
            } else {
                saved = saveLegacy(bytes, fileName, album);
            }

            JSObject ret = new JSObject();
            ret.put("uri", saved != null ? saved.toString() : "");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("保存に失敗しました: " + e.getMessage());
        }
    }

    // Android 10+ : Pictures/<album> に MediaStore 経由で書く（Scoped Storage 対応・権限不要）
    private Uri saveViaMediaStore(byte[] bytes, String fileName, String mime, String album) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
        values.put(MediaStore.Images.Media.MIME_TYPE, mime);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + File.separator + album);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("MediaStore に登録できません");

        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new Exception("書き込み先を開けません");
            out.write(bytes);
        }

        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        return uri;
    }

    // Android 9 以下 : 直接ファイルへ書き、ギャラリーにスキャンさせる
    private Uri saveLegacy(byte[] bytes, String fileName, String album) throws Exception {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), album);
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("保存先を作成できません");

        File file = new File(dir, fileName);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }

        Uri uri = Uri.fromFile(file);
        getContext().sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, uri));
        return uri;
    }
}
